import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import { transitionTask } from "@/server/tasks";
import { createModelGateway } from "@/server/gateway";
import {
  MAX_REWORK_RETURNS,
  checkTaskWithReview,
  numberEquality,
  registerActionType,
  registerCheckerPack,
  requiredFields,
} from "@/server/checker";
import { createFakeAdapter } from "../support/fake-adapter";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Model-review step tests (task 6.2, design §2.4 step 2), against the test-only fake adapter.
const run = randomBytes(4).toString("hex");
const PACK = `review-pack-${run}`;
const GATED = `review.gated.${run}`;
const OPEN = `review.open.${run}`;
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT: Caller = { ...OWNER, actor: "agent", actorId: `review-agent-${run}` };

const OK = { kind: "success", text: JSON.stringify({ verdict: "ok", issues: [] }) } as const;
const FLAG = { kind: "success", text: JSON.stringify({ verdict: "flag", issues: ["tone is too abrupt"] }) } as const;

beforeAll(async () => {
  trackTenant(OWNER.tenantId);
  await withTenantSession(
    OWNER.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [OWNER.tenantId, `Review ${run}`]);
    },
    "service",
  );
  registerActionType({ type: GATED, gated: true });
  registerActionType({ type: OPEN, gated: false });
  registerCheckerPack({
    packId: PACK,
    rules: [requiredFields("required", ["item"]), numberEquality("qty", [{ field: "qty", source: "po.qty" }])],
    loadSources: async () => ({ po: { qty: 12 } }),
  });
}, 60_000);

afterAll(async () => {
  await closeAllPools();
});

async function inReview(actionType: string, fields: Record<string, unknown>): Promise<string> {
  return withTenant(AGENT, async (tx) => {
    const t = await tx.insert<{ id: string }>("tasks", {
      title: "fixture",
      origin: "direct",
      agent: "stock",
      created_by: AGENT.actorId,
      payload: JSON.stringify({ action_type: actionType, fields }),
    });
    await transitionTask(tx, t.id, "working");
    await transitionTask(tx, t.id, "in_review");
    return t.id;
  });
}

const review = (id: string, fake: ReturnType<typeof createFakeAdapter>) =>
  checkTaskWithReview(AGENT, id, createModelGateway(fake), { packId: PACK });
const row = (id: string) =>
  withTenant(OWNER, (tx) => tx.getById<{ status: string; anomaly: string | null; error: string | null }>("tasks", id));
const history = (id: string) => withTenant(OWNER, (tx) => getTaskHistory(tx, id));

describe("model review", () => {
  it("a clean review lets the 6.1 routing proceed and is audited as a model-review result", async () => {
    const gated = await inReview(GATED, { item: "Kemeja SD", qty: 12 });
    const open = await inReview(OPEN, { item: "Kemeja SD", qty: 12 });
    const fake = createFakeAdapter(OK);
    expect(await review(gated, fake)).toMatchObject({ passed: true, route: "pending_approval", modelReviewed: true });
    expect(await review(open, fake)).toMatchObject({ route: "done" });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].association).toEqual({ kind: "task", taskId: gated });

    expect((await row(gated)).status).toBe("pending_approval");
    const h = await history(gated);
    const [r] = h.filter((e) => e.type === "checker.result");
    expect(r.payload).toMatchObject({ stage: "model_review", outcome: "pass", revision: 1, route: "pending_approval", review: { verdict: "ok" } });
    expect(h.filter((e) => e.type === "model.usage")).toHaveLength(1); // 5.3 accounting applies
  });

  it("a flag records the anomaly and returns the task to Working against the reviewed revision", async () => {
    const id = await inReview(GATED, { item: "Kemeja SD", qty: 12 });
    await withTenant(AGENT, (tx) => tx.query("update tasks set payload_revision = 3 where id = $1", [id]));
    const out = await review(id, createFakeAdapter(FLAG));
    expect(out).toMatchObject({ passed: false, route: "working", revision: 3, reworkReturns: 1, modelReviewed: true });
    const t = await row(id);
    expect(t.status).toBe("working");
    expect(t.anomaly).toContain("tone is too abrupt");
    const [r] = (await history(id)).filter((e) => e.type === "checker.result");
    expect(r.payload).toMatchObject({ stage: "model_review", outcome: "fail", revision: 3, route: "working", review: { verdict: "flag" } });
    expect((r.payload.anomalies as { rule: string }[])[0].rule).toBe("model_review");
  });

  it("flags count toward the same rework bound, then the task is Failed", async () => {
    const id = await inReview(GATED, { item: "x", qty: 12 });
    const fake = createFakeAdapter(FLAG);
    for (let cycle = 1; cycle <= MAX_REWORK_RETURNS; cycle++) {
      expect(await review(id, fake)).toMatchObject({ route: "working", reworkReturns: cycle });
      await withTenant(AGENT, (tx) => transitionTask(tx, id, "in_review"));
    }
    expect(await review(id, fake)).toMatchObject({ route: "failed" });
    const t = await row(id);
    expect(t.status).toBe("failed");
    expect(t.error).toContain("rework exhausted");
  });

  it("a deterministic failure never invokes the model and cannot be softened", async () => {
    const id = await inReview(GATED, { item: "x", qty: 13 });
    const fake = createFakeAdapter(OK); // would approve if asked
    const out = await review(id, fake);
    expect(out).toMatchObject({ passed: false, route: "working", modelReviewed: false });
    expect(fake.calls).toHaveLength(0);
    expect((await row(id)).anomaly).toContain('"qty" is 13');
    const h = await history(id);
    expect(h.filter((e) => e.type.startsWith("model."))).toHaveLength(0);
    expect(h.find((e) => e.type === "checker.result")!.payload.stage).toBe("deterministic");
  });

  it("a provider failure during review fails the task instead of flagging it", async () => {
    const id = await inReview(GATED, { item: "x", qty: 12 });
    const fake = createFakeAdapter({ kind: "provider_error", message: "forced" });
    await expect(review(id, fake)).rejects.toMatchObject({ kind: "provider_failure" });
    const t = await row(id);
    expect(t.status).toBe("failed");
    expect(t.anomaly).toBeNull();
    const h = await history(id);
    expect(h.filter((e) => e.type === "checker.result")).toHaveLength(0);
    expect(h.find((e) => e.type === "model.usage")!.payload).toMatchObject({ outcome: "provider_failure", task_state: "failed" });
  });

  it("an unparseable model verdict fails the task and is not treated as clean", async () => {
    const id = await inReview(GATED, { item: "x", qty: 12 });
    await expect(review(id, createFakeAdapter({ kind: "malformed" }))).rejects.toMatchObject({ kind: "malformed_output" });
    expect((await row(id)).status).toBe("failed");
  });
});
