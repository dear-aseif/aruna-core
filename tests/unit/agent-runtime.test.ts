import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, NotFoundError, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import { createModelGateway } from "@/server/gateway";
import { registerActionType, registerCheckerPack, requiredFields } from "@/server/checker";
import { ensureThreadsTx, listThreadsTx, listMessagesTx } from "@/server/threads";
import {
  AttemptNotStaleError,
  IllegalTransitionError,
  MAX_STALE_RECOVERIES,
  StaleRecoveryNotPermittedError,
  recoverStaleAttempt,
  sweepStaleAttempts,
  transitionTask,
  type TaskRow,
} from "@/server/tasks";
import { CommandNotPermittedError, NotQueuedError, executeTask, registerAgentExecutor, submitCommand } from "@/server/runtime";
import { createFakeAdapter } from "../support/fake-adapter";
import { trackTenant } from "../support/ledger";
import { registerTestSpecialists } from "../support/test-specialists";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Agent runtime tests (task 8.2). Synthetic tenants; model calls go to the test-only fake adapter.
const run = randomBytes(4).toString("hex");
const PACK = `rt-pack-${run}`;
const GATED = `rt.gated.${run}`;
const OPEN = `rt.open.${run}`;
const A = { id: randomUUID(), name: "Alma" };
const B = { id: randomUUID(), name: "Bima" };
const owner = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "owner", actorId: `rt-owner-${run}` });
const system = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "system", actorId: `rt-system-${run}` });
const draft = (action_type: string, fields: Record<string, unknown>) => ({ kind: "success", text: JSON.stringify({ action_type, fields }) }) as const;
const REVIEW_OK = { kind: "success", text: JSON.stringify({ verdict: "ok", issues: [] }) } as const;
const opts = { packId: PACK };
let threadsA: Record<string, string> = {};
let threadsB: Record<string, string> = {};
beforeAll(async () => {
  registerTestSpecialists();
  registerAgentExecutor("test_scribe", { system: "You draft services tasks." });
  registerActionType({ type: GATED, gated: true });
  registerActionType({ type: OPEN, gated: false });
  registerCheckerPack({ packId: PACK, rules: [requiredFields("required", ["item"])] });
  for (const t of [A, B]) {
    trackTenant(t.id);
    await withTenantSession(
      t.id,
      async (c) => {
        await c.query("insert into tenants (id, name, type, active_pack, status) values ($1, $2, 'test', 'services', 'active')", [t.id, `Runtime ${t.name} ${run}`]);
        await c.query("insert into settings (tenant_id, assistant_name) values ($1, $2)", [t.id, t.name]);
      },
      "service",
    );
  }
  const ids = async (t: { id: string }) => {
    await withTenant(owner(t), (tx) => ensureThreadsTx(tx));
    return Object.fromEntries((await withTenant(owner(t), (tx) => listThreadsTx(tx))).map((th) => [th.agent, th.id]));
  };
  threadsA = await ids(A);
  threadsB = await ids(B);
}, 60_000);
afterAll(async () => {
  await closeAllPools();
});
const history = (t: { id: string }, taskId: string) => withTenant(owner(t), (tx) => getTaskHistory(tx, taskId));
const row = (t: { id: string }, taskId: string) => withTenant(owner(t), (tx) => tx.getById<TaskRow>("tasks", taskId));
const gw = (fake: ReturnType<typeof createFakeAdapter>) => createModelGateway(fake);
/** A Working task of tenant A, optionally with its last activity pushed back by `ageMinutes`. */
async function workingTask(t: { id: string }, ageMinutes = 0): Promise<string> {
  return withTenant(owner(t), async (tx) => {
    const task = await tx.insert<TaskRow>("tasks", { title: "fixture", origin: "direct", agent: "test_scribe", created_by: `rt-owner-${run}` });
    await transitionTask(tx, task.id, "working");
    if (ageMinutes) await tx.query("update tasks set updated_at = now() - make_interval(mins => $2::int) where id = $1", [task.id, ageMinutes]);
    return task.id;
  });
}
describe("commands", () => {
  it("a Maestro-thread command creates an audited task with origin maestro and runs the pipeline", async () => {
    const fake = createFakeAdapter(draft(OPEN, { item: "Facial" }), REVIEW_OK);
    const r = await submitCommand(owner(A), gw(fake), { threadId: threadsA.maestro, body: "  Please note the Facial order  " }, opts);
    expect(r.task).toMatchObject({ origin: "maestro", agent: "maestro", status: "done", payload_revision: 2 });
    expect(r.task.created_by).toBe(`rt-owner-${run}`);
    const h = await history(A, r.task.id);
    const created = h.find((e) => e.type === "task.created")!;
    const cmd = h.find((e) => e.type === "command.received")!;
    expect(created).toMatchObject({ actor: "owner", payload: { origin: "maestro" } });
    expect(cmd).toMatchObject({ actor: "owner", payload: { origin: "maestro", thread_agent: "maestro", command: "Please note the Facial order" } });
    const msgs = await withTenant(owner(A), (tx) => listMessagesTx(tx, threadsA.maestro));
    expect(msgs.find((m) => m.id === r.messageId)).toMatchObject({ sender: "owner", taskId: r.task.id });
  });
  it("a specialist-thread command creates a task with origin direct for that agent", async () => {
    const fake = createFakeAdapter(draft(OPEN, { item: "Facial" }), REVIEW_OK);
    const r = await submitCommand(owner(A), gw(fake), { threadId: threadsA.test_scribe, body: "Book a facial" }, opts);
    expect(r.task).toMatchObject({ origin: "direct", agent: "test_scribe", status: "done" });
    const h = await history(A, r.task.id);
    expect(h.find((e) => e.type === "command.received")!.payload).toMatchObject({ origin: "direct", thread_agent: "test_scribe" });
  });
  it("only the owner can command, and an empty command creates nothing", async () => {
    const fake = createFakeAdapter();
    await expect(submitCommand(system(A), gw(fake), { threadId: threadsA.maestro, body: "x" }, opts)).rejects.toBeInstanceOf(CommandNotPermittedError);
    await expect(submitCommand(owner(A), gw(fake), { threadId: threadsA.maestro, body: "   " }, opts)).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});
describe("execution", () => {
  it("a valid output becomes the checked draft (revision increments) and the Checker routes the task", async () => {
    const fake = createFakeAdapter(draft(GATED, { item: "Facial", note: "afternoon" }), REVIEW_OK);
    const r = await submitCommand(owner(A), gw(fake), { threadId: threadsA.test_scribe, body: "Confirm the Facial" }, opts);
    expect(r.execution).toMatchObject({ status: "pending_approval", draftAttached: true });
    const task = await row(A, r.task.id);
    expect(task.payload).toEqual({ action_type: GATED, fields: { item: "Facial", note: "afternoon" } });
    expect(task.payload_revision).toBe(2);
    expect(task.approval_expires_at).not.toBeNull();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].association).toEqual({ kind: "task", taskId: r.task.id });
    const h = await history(A, r.task.id);
    const types = h.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["task.created", "command.received", "model.attempt", "model.usage", "task.draft_revised", "checker.result"]));
    const actions = h.filter((e) => e.type === "agent.action").map((e) => [e.actor, e.actorId, e.payload.action]);
    expect(actions).toEqual([["agent", "test_scribe", "attempt_started"], ["agent", "test_scribe", "draft_attached"]]);
    expect(h.find((e) => e.type === "checker.result")!.payload).toMatchObject({ outcome: "pass", revision: 2, route: "pending_approval" });
  });
  it("a deterministic failure routes the draft back to Working with the anomaly (never past the Checker)", async () => {
    const fake = createFakeAdapter(draft(GATED, { qty: 3 }));
    const r = await submitCommand(owner(A), gw(fake), { threadId: threadsA.test_scribe, body: "Draft without an item" }, opts);
    expect(r.execution).toMatchObject({ status: "working", draftAttached: true });
    expect((await row(A, r.task.id)).anomaly).toMatch(/item/);
    expect(fake.calls).toHaveLength(1); // the model review is never called after a deterministic failure
  });
  it("malformed output fails the task and fabricates nothing", async () => {
    for (const behavior of [
      { kind: "malformed" } as const, // not JSON
      { kind: "success", text: JSON.stringify({ action_type: OPEN }) } as const, // missing fields
      { kind: "success", text: JSON.stringify({ action_type: OPEN, fields: { item: "x" }, extra: 1 }) } as const, // not the binding shape
    ]) {
      const fake = createFakeAdapter(behavior);
      const r = await submitCommand(owner(A), gw(fake), { threadId: threadsA.test_scribe, body: "Make a draft" }, opts);
      expect(r.execution).toMatchObject({ status: "failed", draftAttached: false });
      expect(r.execution.error).toMatch(/malformed_output/);
      const task = await row(A, r.task.id);
      expect(task).toMatchObject({ status: "failed", payload: {}, payload_revision: 1 });
      expect(task.error).toMatch(/Model call failed/);
      const h = await history(A, r.task.id);
      expect(h.some((e) => e.type === "task.draft_revised" || e.type === "checker.result")).toBe(false);
    }
  });
  it("a gateway failure fails the task with the error visible (5.3)", async () => {
    const fake = createFakeAdapter({ kind: "provider_error", message: "boom" });
    const r = await submitCommand(owner(A), gw(fake), { threadId: threadsA.maestro, body: "Do something" }, opts);
    expect(r.execution).toMatchObject({ status: "failed", draftAttached: false });
    const task = await row(A, r.task.id);
    expect(task.payload).toEqual({});
    expect(task.error).toMatch(/provider_failure/);
    const usage = (await history(A, r.task.id)).find((e) => e.type === "model.usage")!;
    expect(usage.payload).toMatchObject({ outcome: "provider_failure", task_state: "failed" });
  });
  it("an agent with no registered executor fails visibly and never calls the model", async () => {
    const fake = createFakeAdapter();
    const id = await withTenant(owner(A), async (tx) => (await tx.insert<TaskRow>("tasks", { title: "orphan", origin: "direct", agent: "no_such_agent", created_by: "rt" })).id);
    const r = await executeTask(A.id, gw(fake), id, opts);
    expect(r).toMatchObject({ status: "failed", draftAttached: false });
    expect(r.error).toMatch(/no executor/);
    expect(fake.calls).toHaveLength(0);
  });
  it("an attempt starts only from Queued", async () => {
    const id = await workingTask(A);
    await expect(executeTask(A.id, gw(createFakeAdapter()), id, opts)).rejects.toBeInstanceOf(NotQueuedError);
  });
});
describe("stale-attempt recovery", () => {
  it("returns a stale Working task to Queued, audited as the system actor, and a fresh attempt can run", async () => {
    const id = await workingTask(A, 10);
    const t = await withTenant(system(A), (tx) => recoverStaleAttempt(tx, id));
    expect(t.status).toBe("queued");
    const e = (await history(A, id)).filter((x) => x.type === "task.transition").pop()!;
    expect(e).toMatchObject({ actor: "system", payload: { from: "working", to: "queued", reason: "stale_attempt_recovered", recoveries: 1 } });
    const fake = createFakeAdapter(draft(OPEN, { item: "Facial" }), REVIEW_OK);
    expect(await executeTask(A.id, gw(fake), id, opts)).toMatchObject({ status: "done" });
  });
  it("refuses a non-system actor, a fresh attempt, and any task that is not Working", async () => {
    const stale = await workingTask(A, 10);
    for (const actor of ["owner", "agent", "operator"] as const)
      await expect(withTenant({ ...owner(A), actor }, (tx) => recoverStaleAttempt(tx, stale))).rejects.toBeInstanceOf(StaleRecoveryNotPermittedError);
    expect((await row(A, stale)).status).toBe("working");
    const fresh = await workingTask(A);
    await expect(withTenant(system(A), (tx) => recoverStaleAttempt(tx, fresh))).rejects.toBeInstanceOf(AttemptNotStaleError);
    const queued = await withTenant(owner(A), async (tx) => (await tx.insert<TaskRow>("tasks", { title: "q", origin: "direct", agent: "test_scribe", created_by: "rt" })).id);
    await expect(withTenant(system(A), (tx) => recoverStaleAttempt(tx, queued, { staleAfterSeconds: 0 }))).rejects.toBeInstanceOf(IllegalTransitionError);
    // the general transition API still refuses the edge
    await expect(withTenant(system(A), (tx) => transitionTask(tx, stale, "queued"))).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await row(A, stale)).status).toBe("working");
  });
  it("past the failure bound the stale task is marked Failed instead", async () => {
    const id = await workingTask(A, 10);
    for (let i = 0; i < MAX_STALE_RECOVERIES; i++) {
      expect((await withTenant(system(A), (tx) => recoverStaleAttempt(tx, id, { staleAfterSeconds: 0 }))).status).toBe("queued");
      await withTenant(owner(A), (tx) => transitionTask(tx, id, "working"));
    }
    const t = await withTenant(system(A), (tx) => recoverStaleAttempt(tx, id, { staleAfterSeconds: 0 }));
    expect(t).toMatchObject({ status: "failed" });
    expect(t.error).toMatch(/recovery bound/);
    expect((await history(A, id)).pop()!.payload).toMatchObject({ to: "failed", reason: "stale_attempt_exhausted" });
  });
  it("the sweep recovers only stale Working tasks, in every tenant, and leaves fresh ones alone", async () => {
    const staleA = await workingTask(A, 10);
    const freshA = await workingTask(A);
    const staleB = await workingTask(B, 10);
    const r = await sweepStaleAttempts();
    expect(r.errors).toEqual([]);
    expect(r.requeued).toBeGreaterThanOrEqual(2);
    expect((await row(A, staleA)).status).toBe("queued");
    expect((await row(A, freshA)).status).toBe("working");
    expect((await row(B, staleB)).status).toBe("queued");
  }, 180_000); // walks every active tenant over the remote database
});
describe("tenant isolation", () => {
  it("another tenant's thread and task can be neither seen nor affected", async () => {
    const fake = createFakeAdapter(draft(OPEN, { item: "x" }), REVIEW_OK);
    const before = await withTenant(owner(A), async (tx) => (await tx.query("select id from tasks")).length);
    await expect(submitCommand(owner(B), gw(fake), { threadId: threadsA.maestro, body: "Cross-tenant" }, opts)).rejects.toBeInstanceOf(NotFoundError);
    expect(await withTenant(owner(A), async (tx) => (await tx.query("select id from tasks")).length)).toBe(before);
    expect(await withTenant(owner(B), async (tx) => (await tx.query("select id from tasks where title = 'Cross-tenant'")).length)).toBe(0);
    const queuedA = await withTenant(owner(A), async (tx) => (await tx.insert<TaskRow>("tasks", { title: "a-only", origin: "direct", agent: "test_scribe", created_by: "rt" })).id);
    await expect(executeTask(B.id, gw(fake), queuedA, opts)).rejects.toBeInstanceOf(NotFoundError);
    const staleA = await workingTask(A, 10);
    await expect(withTenant(system(B), (tx) => recoverStaleAttempt(tx, staleA, { staleAfterSeconds: 0 }))).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(A, queuedA)).status).toBe("queued");
    expect((await row(A, staleA)).status).toBe("working");
    expect(fake.calls).toHaveLength(0);
    expect(threadsA.maestro).not.toBe(threadsB.maestro);
  });
});
