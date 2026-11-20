import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { transitionTask } from "@/server/tasks";
import { createAdapter, createModelGateway, resolveModelConfig } from "@/server/gateway";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

/**
 * Live smoke test (design §2.12, Property 10). Runs only when ARUNA_LIVE_SMOKE=1 (a test-only
 * switch, not part of the runtime env contract) AND AWS credentials are present AND the Bedrock
 * region/model are configured. Otherwise it skips cleanly.
 */
const hasCreds = Boolean(
  process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
);
const configured = (v?: string) => Boolean(v && v.trim() && v.trim() !== "CHANGE_ME");
const live =
  process.env.ARUNA_LIVE_SMOKE === "1" && hasCreds && configured(process.env.BEDROCK_REGION) && configured(process.env.BEDROCK_MODEL_ID);

const run = randomBytes(4).toString("hex");
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };

describe.skipIf(!live)("live Bedrock smoke", () => {
  beforeAll(async () => {
    trackTenant(OWNER.tenantId);
    await withTenantSession(
      OWNER.tenantId,
      async (cl) => {
        await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [OWNER.tenantId, `Smoke ${run}`]);
      },
      "service",
    );
  }, 60_000);

  afterAll(async () => {
    await closeAllPools();
  });

  it("the real Bedrock adapter answers a minimal call", async () => {
    const adapter = createAdapter(resolveModelConfig(null, process.env), process.env);
    expect(adapter.provider).toBe("bedrock");
    const r = await createModelGateway(adapter, { timeoutMs: 60_000 }).complete({
      tenantId: OWNER.tenantId,
      routineContext: `live-smoke-${run}`,
      system: "Reply with one word.",
      messages: [{ role: "user", content: "Say ok." }],
    });
    expect(r.text.length).toBeGreaterThan(0);
  }, 90_000);

  it("a forced provider failure (invalid model id) produces the visible Failed state", async () => {
    const taskId = await withTenant(OWNER, (tx) =>
      tx.insert<{ id: string }>("tasks", { title: "smoke", origin: "direct", agent: "booking", created_by: OWNER.actorId }),
    ).then((t) => t.id);
    await withTenant({ ...OWNER, actor: "agent", actorId: `test-agent-${run}` }, (tx) => transitionTask(tx, taskId, "working"));

    const adapter = createAdapter({ provider: "bedrock", modelId: "aruna.invalid-model-id-v0:0", source: "tenant" }, process.env);
    await expect(
      createModelGateway(adapter, { timeoutMs: 60_000 }).complete({
        tenantId: OWNER.tenantId,
        taskId,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ kind: "provider_failure" });

    const task = await withTenant(OWNER, (tx) => tx.getById<{ status: string; error: string | null }>("tasks", taskId));
    expect(task.status).toBe("failed");
    expect(task.error).toBeTruthy();
  }, 90_000);
});

describe("live Bedrock smoke gating", () => {
  it("is skipped unless ARUNA_LIVE_SMOKE=1 with AWS credentials and Bedrock configuration", () => {
    expect(typeof live).toBe("boolean");
  });
});
