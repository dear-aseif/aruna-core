import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory, listAuditEntries } from "@/server/audit";
import { transitionTask } from "@/server/tasks";
import {
  adapterForTenant,
  createAdapter,
  createModelGateway,
  loadTenantModelConfig,
  resolveModelConfig,
  SUPPORTED_PROVIDERS,
} from "@/server/gateway";
import { createFakeAdapter } from "../support/fake-adapter";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Gateway tests against the test-only fake adapter (task 5.4, R10.1-R10.4, Property 10).
const run = randomBytes(4).toString("hex");
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const CONFIG_OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const ENV = { BEDROCK_REGION: "us-east-1", BEDROCK_MODEL_ID: "test.default-model-v1:0" };
const messages = [{ role: "user" as const, content: "hi" }];

async function provision(c: Caller, label: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `GwFake ${label} ${run}`]);
      await cl.query("insert into settings (tenant_id, assistant_name) values ($1, $2)", [c.tenantId, `Assistant ${label}`]);
    },
    "service",
  );
}

beforeAll(async () => {
  await provision(OWNER, "main");
  await provision(CONFIG_OWNER, "config");
}, 60_000);

afterAll(async () => {
  await closeAllPools();
});

async function workingTask(): Promise<string> {
  const id = await withTenant(OWNER, (tx) =>
    tx.insert<{ id: string }>("tasks", { title: "fixture", origin: "direct", agent: "booking", created_by: OWNER.actorId }),
  ).then((t) => t.id);
  await withTenant({ ...OWNER, actor: "agent", actorId: `test-agent-${run}` }, (tx) => transitionTask(tx, id, "working"));
  return id;
}

const taskRow = (id: string) => withTenant(OWNER, (tx) => tx.getById<{ status: string; error: string | null }>("tasks", id));
const usageFor = async (taskId: string) =>
  (await withTenant(OWNER, (tx) => getTaskHistory(tx, taskId))).filter((e) => e.type === "model.usage");

describe("fake adapter is test-only and never deployed", () => {
  it("the deployed configuration resolves to the Bedrock adapter, never the fake", async () => {
    const cfg = resolveModelConfig(null, ENV);
    const adapter = createAdapter(cfg, ENV);
    expect(adapter.provider).toBe("bedrock");
    expect(adapter.model).toBe("test.default-model-v1:0");
    expect(SUPPORTED_PROVIDERS).toEqual(["bedrock"]);
    expect(createFakeAdapter().provider).not.toBe("bedrock");
    // tenant settings cannot select it either
    expect(() => resolveModelConfig({ model_provider: "fake-test-only", model_id: null }, ENV)).toThrow(/unknown model provider/);
  });

  it("no source file under src/ references the fake adapter or the test support folder", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /fake-adapter|tests\/support|fake-test-only/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });
});

describe("forced failure (R10.4)", () => {
  it("a provider error fails the task with a visible error, and the failure is audited", async () => {
    const taskId = await workingTask();
    const fake = createFakeAdapter({ kind: "provider_error", message: "forced failure" });
    await expect(
      createModelGateway(fake).complete({ tenantId: OWNER.tenantId, taskId, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "provider_failure" });

    expect(fake.calls).toHaveLength(1);
    const task = await taskRow(taskId);
    expect(task.status).toBe("failed");
    expect(task.error).toContain("provider_failure"); // visible to the owner
    const history = await withTenant(OWNER, (tx) => getTaskHistory(tx, taskId));
    expect(history.some((e) => e.type === "task.transition" && e.payload.to === "failed")).toBe(true);
    expect((await usageFor(taskId))[0].payload).toMatchObject({ outcome: "provider_failure", task_state: "failed" });
  });
});

describe("timeout (R10.4)", () => {
  it("a response delayed past the configured timeout fails the task the same way", async () => {
    const taskId = await workingTask();
    const fake = createFakeAdapter({ kind: "delay", ms: 5_000 });
    const started = Date.now();
    await expect(
      createModelGateway(fake, { timeoutMs: 50 }).complete({ tenantId: OWNER.tenantId, taskId, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(4_000);

    expect(fake.calls[0].signal?.aborted).toBe(true);
    const task = await taskRow(taskId);
    expect(task.status).toBe("failed");
    expect(task.error).toContain("timeout");
    expect((await usageFor(taskId))[0].payload).toMatchObject({ outcome: "timeout", task_state: "failed" });
  });
});

describe("call association (R10.3)", () => {
  it("a call with neither taskId nor routineContext is refused and the provider is never called", async () => {
    const fake = createFakeAdapter();
    const gw = createModelGateway(fake);
    for (const extra of [{}, { taskId: "  " }, { routineContext: "" }]) {
      await expect(
        gw.complete({ tenantId: OWNER.tenantId, system: "s", messages, ...extra }),
      ).rejects.toMatchObject({ kind: "association_missing" });
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("accounting: a model.usage entry exists for every outcome (R10.3, Property 10)", () => {
  it("success", async () => {
    const taskId = await workingTask();
    const fake = createFakeAdapter({ kind: "success", text: "fine", usage: { inputTokens: 11, outputTokens: 6 } });
    const r = await createModelGateway(fake).complete({ tenantId: OWNER.tenantId, taskId, system: "s", messages });
    expect(r.text).toBe("fine");
    const usage = await usageFor(taskId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ tenantId: OWNER.tenantId, taskId });
    expect(usage[0].payload).toMatchObject({
      outcome: "success",
      provider: "fake-test-only",
      model: "fake-model-1",
      input_tokens: 11,
      output_tokens: 6,
    });
  });

  it("provider error", async () => {
    const taskId = await workingTask();
    await expect(
      createModelGateway(createFakeAdapter({ kind: "provider_error" })).complete({ tenantId: OWNER.tenantId, taskId, system: "s", messages }),
    ).rejects.toMatchObject({ kind: "provider_failure" });
    const usage = await usageFor(taskId);
    expect(usage).toHaveLength(1);
    expect(usage[0].payload).toMatchObject({ outcome: "provider_failure" });
  });

  it("malformed output", async () => {
    const taskId = await workingTask();
    const fake = createFakeAdapter({ kind: "malformed" });
    await expect(
      createModelGateway(fake).complete({
        tenantId: OWNER.tenantId,
        taskId,
        system: "s",
        messages,
        responseSchema: z.object({ a: z.number() }),
      }),
    ).rejects.toMatchObject({ kind: "malformed_output" });
    const usage = await usageFor(taskId);
    expect(usage).toHaveLength(1);
    expect(usage[0].payload).toMatchObject({ outcome: "malformed_output", task_state: "failed" });
    expect((await taskRow(taskId)).status).toBe("failed");
  });

  it("a routine-context call is accounted with tenant and context", async () => {
    const ctx = `briefing-${run}`;
    await createModelGateway(createFakeAdapter()).complete({ tenantId: OWNER.tenantId, routineContext: ctx, system: "s", messages });
    const hit = (await withTenant(OWNER, (tx) => listAuditEntries(tx, { type: "model.usage", limit: 500 }))).find(
      (e) => e.payload.routine_context === ctx,
    );
    expect(hit).toMatchObject({ tenantId: OWNER.tenantId, taskId: null });
    expect(hit!.payload).toMatchObject({ outcome: "success", association: "routine" });
  });
});

describe("tenant model configuration read from the database (5.2 gate)", () => {
  it("loadTenantModelConfig returns the stored override, and the gateway adapter uses it", async () => {
    // no override stored yet: project default
    expect(await loadTenantModelConfig(CONFIG_OWNER.tenantId, ENV)).toEqual({
      provider: "bedrock",
      modelId: "test.default-model-v1:0",
      source: "default",
    });

    await withTenant(CONFIG_OWNER, (tx) =>
      tx.updateById("settings", CONFIG_OWNER.tenantId, { model_provider: "bedrock", model_id: "tenant.stored-model-v7:0" }, "tenant_id"),
    );

    expect(await loadTenantModelConfig(CONFIG_OWNER.tenantId, ENV)).toEqual({
      provider: "bedrock",
      modelId: "tenant.stored-model-v7:0",
      source: "tenant",
    });
    const adapter = await adapterForTenant(CONFIG_OWNER.tenantId, ENV);
    expect(adapter).toMatchObject({ provider: "bedrock", model: "tenant.stored-model-v7:0" });

    // another tenant's settings are not affected
    expect((await loadTenantModelConfig(OWNER.tenantId, ENV)).source).toBe("default");
  });
});
