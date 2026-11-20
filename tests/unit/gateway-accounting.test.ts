import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory, listAuditEntries } from "@/server/audit";
import { transitionTask, type TaskStatus } from "@/server/tasks";
import {
  bindGateway,
  createModelGateway,
  DEFAULT_CALL_TIMEOUT_MS,
  type AdapterRequest,
  type ProviderAdapter,
} from "@/server/gateway";
import { createBedrockClient } from "@/server/gateway/adapters/bedrock";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

const run = randomBytes(4).toString("hex");
const OWNER_A: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const OWNER_B: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };

async function provision(c: Caller, label: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `Gateway ${label} ${run}`]);
    },
    "service",
  );
}

beforeAll(async () => {
  await provision(OWNER_A, "A");
  await provision(OWNER_B, "B");
}, 60_000);

afterAll(async () => {
  await closeAllPools();
});

// Test-local provider stub (the dedicated fake adapter is task 5.4).
function stub(respond: (r: AdapterRequest) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>) {
  const calls: AdapterRequest[] = [];
  const adapter: ProviderAdapter = {
    provider: "stub",
    model: "stub-1",
    generate: (r) => {
      calls.push(r);
      return respond(r);
    },
  };
  return { adapter, calls };
}

const messages = [{ role: "user" as const, content: "hi" }];
const ok = { text: "fine", usage: { inputTokens: 7, outputTokens: 4 } };

async function newTask(c: Caller, status: TaskStatus = "working"): Promise<string> {
  const id = await withTenant(c, (tx) =>
    tx.insert<{ id: string }>("tasks", { title: "fixture", origin: "direct", agent: "booking", created_by: c.actorId }),
  ).then((t) => t.id);
  const agent: Caller = { ...c, actor: "agent", actorId: `test-agent-${run}` };
  if (status === "working" || status === "in_review") await withTenant(agent, (tx) => transitionTask(tx, id, "working"));
  if (status === "in_review") await withTenant(agent, (tx) => transitionTask(tx, id, "in_review"));
  return id;
}

const taskRow = (c: Caller, id: string) =>
  withTenant(c, (tx) => tx.getById<{ status: string; error: string | null }>("tasks", id));
const entries = (c: Caller, type: string) => withTenant(c, (tx) => listAuditEntries(tx, { type, limit: 500 }));
const usageFor = async (c: Caller, taskId: string) =>
  (await withTenant(c, (tx) => getTaskHistory(tx, taskId))).filter((e) => e.type === "model.usage");
const attemptsFor = async (c: Caller, taskId: string) =>
  (await withTenant(c, (tx) => getTaskHistory(tx, taskId))).filter((e) => e.type === "model.attempt");

describe("gateway accounting: success", () => {
  it("writes model.attempt before the call and model.usage with tenant, task, provider, model and tokens", async () => {
    const taskId = await newTask(OWNER_A);
    const { adapter } = stub(async () => ok);
    const r = await createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, taskId, system: "s", messages });
    expect(r.text).toBe("fine");

    const history = await withTenant(OWNER_A, (tx) => getTaskHistory(tx, taskId));
    const types = history.map((e) => e.type);
    expect(types.indexOf("model.attempt")).toBeGreaterThan(-1);
    expect(types.indexOf("model.attempt")).toBeLessThan(types.indexOf("model.usage"));

    const [usage] = await usageFor(OWNER_A, taskId);
    expect(usage.tenantId).toBe(OWNER_A.tenantId);
    expect(usage.taskId).toBe(taskId);
    expect(usage.actorId).toBe("model-gateway");
    expect(usage.payload).toMatchObject({
      outcome: "success",
      provider: "stub",
      model: "stub-1",
      association: "task",
      input_tokens: 7,
      output_tokens: 4,
    });
    expect((await taskRow(OWNER_A, taskId)).status).toBe("working");
  });

  it("records a named routine context with tenant and context, and omits tokens the provider did not report", async () => {
    const ctxName = `briefing-${run}`;
    const { adapter } = stub(async () => ({ text: "ok" }));
    await createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, routineContext: ctxName, system: "s", messages });
    const hit = (await entries(OWNER_A, "model.usage")).find((e) => e.payload.routine_context === ctxName);
    expect(hit).toBeDefined();
    expect(hit!.taskId).toBeNull();
    expect(hit!.tenantId).toBe(OWNER_A.tenantId);
    expect(hit!.payload).toMatchObject({ outcome: "success", association: "routine", provider: "stub", model: "stub-1" });
    expect(hit!.payload).not.toHaveProperty("input_tokens");
  });
});

describe("gateway accounting: failures", () => {
  it.each([
    ["provider error", async () => Promise.reject(new Error("unreachable")), undefined, "provider_failure"],
    ["malformed output", async () => ({ text: "not json", usage: { inputTokens: 2, outputTokens: 1 } }), z.object({ a: z.number() }), "malformed_output"],
  ] as const)("a %s is accounted and fails the working task", async (_n, respond, responseSchema, outcome) => {
    const taskId = await newTask(OWNER_A);
    const { adapter } = stub(respond as never);
    await expect(
      createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, taskId, system: "s", messages, responseSchema }),
    ).rejects.toMatchObject({ kind: outcome });

    const [usage] = await usageFor(OWNER_A, taskId);
    expect(usage.payload).toMatchObject({ outcome, task_state: "failed", provider: "stub", model: "stub-1" });
    const task = await taskRow(OWNER_A, taskId);
    expect(task.status).toBe("failed");
    expect(task.error).toContain(outcome);
    const history = await withTenant(OWNER_A, (tx) => getTaskHistory(tx, taskId));
    expect(history.some((e) => e.type === "task.transition" && e.payload.to === "failed")).toBe(true);
  });

  it("a timeout aborts the attempt, is accounted, and fails the task from In Review", async () => {
    const taskId = await newTask(OWNER_A, "in_review");
    let aborted = false;
    const { adapter, calls } = stub(
      (r) =>
        new Promise((_res, rej) => {
          r.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new Error("aborted"));
          });
        }),
    );
    await expect(
      createModelGateway(adapter, { timeoutMs: 50 }).complete({ tenantId: OWNER_A.tenantId, taskId, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(calls).toHaveLength(1);
    expect(aborted).toBe(true);
    const [usage] = await usageFor(OWNER_A, taskId);
    expect(usage.payload).toMatchObject({ outcome: "timeout", task_state: "failed" });
    expect((await taskRow(OWNER_A, taskId)).status).toBe("failed");
  });

  it("a failed routine-context call is accounted without any task transition", async () => {
    const ctxName = `fail-routine-${run}`;
    const { adapter } = stub(async () => Promise.reject(new Error("down")));
    await expect(
      createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, routineContext: ctxName, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "provider_failure" });
    const hit = (await entries(OWNER_A, "model.usage")).find((e) => e.payload.routine_context === ctxName);
    expect(hit!.payload).toMatchObject({ outcome: "provider_failure" });
    expect(hit!.payload).not.toHaveProperty("task_state");
  });

  it("a failed call on a task that cannot move to Failed still writes its usage entry", async () => {
    const taskId = await newTask(OWNER_A, "queued");
    const { adapter } = stub(async () => Promise.reject(new Error("down")));
    await expect(
      createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, taskId, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "provider_failure" });
    const [usage] = await usageFor(OWNER_A, taskId);
    expect(usage.payload).toMatchObject({ outcome: "provider_failure", task_state: "not_transitioned" });
    expect((await taskRow(OWNER_A, taskId)).status).toBe("queued");
  });
});

describe("gateway association and tenancy", () => {
  it("refuses a call without association: no provider call, no attempt entry", async () => {
    const before = (await entries(OWNER_A, "model.attempt")).length;
    const { adapter, calls } = stub(async () => ok);
    await expect(
      createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "association_missing" });
    expect(calls).toHaveLength(0);
    expect((await entries(OWNER_A, "model.attempt")).length).toBe(before);
  });

  it("refuses another tenant's task before the provider is called, writing no attempt", async () => {
    const foreignTask = await newTask(OWNER_B);
    const { adapter, calls } = stub(async () => ok);
    await expect(
      createModelGateway(adapter).complete({ tenantId: OWNER_A.tenantId, taskId: foreignTask, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toHaveLength(0);
    expect(await attemptsFor(OWNER_B, foreignTask)).toHaveLength(0);
    expect((await taskRow(OWNER_B, foreignTask)).status).toBe("working");
  });

  it("accounts under the trusted tenant even when the input names another", async () => {
    const taskId = await newTask(OWNER_A);
    const { adapter } = stub(async () => ok);
    const bound = bindGateway(createModelGateway(adapter), { tenantId: OWNER_A.tenantId });
    await bound.complete({ ...({ tenantId: OWNER_B.tenantId } as object), taskId, system: "s", messages });
    const [usage] = await usageFor(OWNER_A, taskId);
    expect(usage.tenantId).toBe(OWNER_A.tenantId);
    expect((await entries(OWNER_B, "model.usage")).some((e) => e.taskId === taskId)).toBe(false);
  });
});

describe("gateway timeout and client configuration", () => {
  it("defaults the per-call timeout to 60 seconds and rejects a non-positive override", () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(60_000);
    const { adapter } = stub(async () => ok);
    expect(() => createModelGateway(adapter, { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("constructs the Bedrock client with maxAttempts 1 (no SDK retries)", async () => {
    const client = createBedrockClient("us-east-1");
    expect(await client.config.maxAttempts()).toBe(1);
  });
});
