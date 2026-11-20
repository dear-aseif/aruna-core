import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import { transitionTask } from "@/server/tasks";
import {
  MAX_REWORK_RETURNS,
  NoCheckerRulesError,
  NotInReviewError,
  checkTask,
  numberEquality,
  registerActionType,
  registerCheckerPack,
  requiredFields,
} from "@/server/checker";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

const run = randomBytes(4).toString("hex");
const PACK = `test-pack-${run}`;
const GATED = `test.gated.${run}`;
const OPEN = `test.open.${run}`;
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT: Caller = { ...OWNER, actor: "agent", actorId: `checker-agent-${run}` };

beforeAll(async () => {
  trackTenant(OWNER.tenantId);
  await withTenantSession(
    OWNER.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [OWNER.tenantId, `Checker ${run}`]);
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

/** A task parked in In Review with the given draft. */
async function inReview(actionType: string | null, fields: Record<string, unknown>): Promise<string> {
  return withTenant(AGENT, async (tx) => {
    const t = await tx.insert<{ id: string }>("tasks", {
      title: "fixture",
      origin: "direct",
      agent: "stock",
      created_by: AGENT.actorId,
      payload: JSON.stringify({ ...(actionType ? { action_type: actionType } : {}), fields }),
    });
    await transitionTask(tx, t.id, "working");
    await transitionTask(tx, t.id, "in_review");
    return t.id;
  });
}

const check = (id: string, packId = PACK) => withTenant(AGENT, (tx) => checkTask(tx, id, { packId }));
const row = (id: string) =>
  withTenant(OWNER, (tx) => tx.getById<{ status: string; anomaly: string | null; error: string | null; payload_revision: number }>("tasks", id));
const results = async (id: string) => (await withTenant(OWNER, (tx) => getTaskHistory(tx, id))).filter((e) => e.type === "checker.result");

describe("routing", () => {
  it("pass + gated action goes to Pending Approval and audits the checked revision", async () => {
    const id = await inReview(GATED, { item: "Kemeja SD", qty: 12 });
    const out = await check(id);
    expect(out).toMatchObject({ passed: true, route: "pending_approval", revision: 1 });
    const t = await row(id);
    expect(t.status).toBe("pending_approval");
    expect(t.anomaly).toBeNull();
    const [r] = await results(id);
    expect(r.payload).toMatchObject({ outcome: "pass", revision: 1, route: "pending_approval", action_type: GATED });
    expect(r.actorId).toBe(AGENT.actorId);
  });

  it("pass + non-gated action goes to Done", async () => {
    const id = await inReview(OPEN, { item: "Kemeja SD", qty: 12 });
    expect((await check(id)).route).toBe("done");
    expect((await row(id)).status).toBe("done");
  });

  it("fail writes the specific anomaly to the task, records the revision, and returns to Working", async () => {
    const id = await inReview(GATED, { item: "", qty: 13 });
    await withTenant(AGENT, (tx) => tx.query("update tasks set payload_revision = 4 where id = $1", [id]));
    const out = await check(id);
    expect(out).toMatchObject({ passed: false, route: "working", revision: 4, reworkReturns: 1 });
    const t = await row(id);
    expect(t.status).toBe("working");
    expect(t.anomaly).toContain('required field "item" is missing');
    expect(t.anomaly).toContain('"qty" is 13 but source "po.qty" is 12');
    const [r] = await results(id);
    expect(r.payload).toMatchObject({ outcome: "fail", revision: 4, route: "working" });
    expect((r.payload.anomalies as { rule: string }[]).map((a) => a.rule)).toEqual(["required", "qty"]);
  });

  it("a later passing check clears the anomaly", async () => {
    const id = await inReview(OPEN, { qty: 12 });
    await check(id);
    await withTenant(AGENT, async (tx) => {
      await tx.query("update tasks set payload = $2::jsonb, payload_revision = payload_revision + 1 where id = $1", [
        id,
        JSON.stringify({ action_type: OPEN, fields: { item: "Kemeja SD", qty: 12 } }),
      ]);
      await transitionTask(tx, id, "in_review");
    });
    const out = await check(id);
    expect(out).toMatchObject({ route: "done", revision: 2 });
    expect((await row(id)).anomaly).toBeNull();
  });
});

describe("fail closed", () => {
  it("an unregistered or missing action type fails the check", async () => {
    const a = await inReview("nope.unregistered", { item: "x", qty: 12 });
    expect((await check(a)).anomalies[0].rule).toBe("action_type");
    const b = await inReview(null, { item: "x", qty: 12 });
    expect((await check(b)).route).toBe("working");
  });

  it("refuses a task that is not in review and a pack with no rules, changing nothing", async () => {
    const id = await withTenant(AGENT, (tx) => tx.insert<{ id: string }>("tasks", { title: "q", origin: "direct", agent: "stock", created_by: AGENT.actorId }).then((t) => t.id));
    await expect(check(id)).rejects.toBeInstanceOf(NotInReviewError);
    const review = await inReview(GATED, { item: "x", qty: 12 });
    await expect(check(review, "no-such-pack")).rejects.toBeInstanceOf(NoCheckerRulesError);
    expect((await row(review)).status).toBe("in_review");
    expect(await results(review)).toHaveLength(0);
  });
});

describe("rework bound", () => {
  it("allows 3 returns to Working, then the next failure moves the task to Failed", async () => {
    const id = await inReview(GATED, { item: "x", qty: 99 });
    for (let cycle = 1; cycle <= MAX_REWORK_RETURNS; cycle++) {
      const out = await check(id);
      expect(out).toMatchObject({ route: "working", reworkReturns: cycle });
      await withTenant(AGENT, (tx) => transitionTask(tx, id, "in_review")); // agent redrafts, still wrong
    }
    const last = await check(id);
    expect(last).toMatchObject({ passed: false, route: "failed", reworkReturns: MAX_REWORK_RETURNS });
    const t = await row(id);
    expect(t.status).toBe("failed");
    expect(t.error).toContain("rework exhausted");
    expect(t.error).toContain('"qty" is 99');
    const rs = await results(id);
    expect(rs.map((r) => r.payload.route)).toEqual(["working", "working", "working", "failed"]);
    expect(rs.map((r) => r.payload.rework_returns)).toEqual([1, 2, 3, 3]);
  });
});
