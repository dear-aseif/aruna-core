import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, NotFoundError, type Caller } from "@/server/dal";
import { AuthenticationError } from "@/server/auth/service";
import { hashPassword, signInWithPassword } from "@/server/auth";
import { recordApprovalDecision, recordCheckerResult } from "@/server/audit";
import {
  InvalidTaskInputError,
  TASK_ORIGINS,
  createTask,
  getTaskDetail,
  listTasks,
  transitionTask,
  type TaskOrigin,
} from "@/server/tasks";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Synthetic fixtures only; tenants are tracked and removed by the shared teardown.
const run = randomBytes(4).toString("hex");
interface Fx { tenant: string; user: string; email: string; password: string; token: string }
const mk = (l: string): Fx => ({ tenant: randomUUID(), user: randomUUID(), email: `ops-${l}-${run}@example.test`, password: `pw-${randomBytes(6).toString("hex")}`, token: "" });
const A = mk("a");
const B = mk("b");
const agentOf = (f: Fx): Caller => ({ tenantId: f.tenant, actor: "agent", actorId: `ops-agent-${run}` });
async function provision(f: Fx, label: string) {
  trackTenant(f.tenant);
  const hash = await hashPassword(f.password);
  await withTenantSession(
    f.tenant,
    async (c) => {
      await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [f.tenant, `Ops ${label} ${run}`]);
      await c.query("insert into profiles (user_id, tenant_id, email, password_hash, role) values ($1, $2, $3, $4, 'owner')", [f.user, f.tenant, f.email, hash]);
    },
    "service",
  );
  f.token = (await signInWithPassword(f.email, f.password))!.sessionToken;
}
beforeAll(async () => {
  await provision(A, "A");
  await provision(B, "B");
}, 60_000);
afterAll(async () => {
  await closeAllPools();
});
const move = (f: Fx, id: string, ...to: Parameters<typeof transitionTask>[2][]) =>
  withTenant(agentOf(f), async (tx) => {
    for (const s of to) await transitionTask(tx, id, s);
  });

describe("create", () => {
  it.each(TASK_ORIGINS)("creates an origin=%s task in Queued, audited, for the caller's tenant", async (origin: TaskOrigin) => {
    const t = await createTask(A.token, { title: `Task ${origin}`, origin, agent: "booking", payload: { note: origin } });
    expect(t.status).toBe("queued");
    expect(t.origin).toBe(origin);
    expect(t.tenant_id).toBe(A.tenant);
    expect(t.created_by).toBe(A.user);
    expect(t.payload).toEqual({ note: origin });
    const d = await getTaskDetail(A.token, t.id);
    expect(d.history).toHaveLength(1);
    expect(d.history[0]).toMatchObject({ type: "task.created", actor: "owner", actorId: A.user, payload: { origin, agent: "booking" } });
  });

  it("refuses malformed input without writing anything", async () => {
    const before = (await listTasks(A.token, { limit: 200 })).length;
    const bad = [
      { title: "  ", origin: "direct", agent: "x" },
      { title: "ok", origin: "email", agent: "x" },
      { title: "ok", origin: "direct", agent: "" },
      { title: "x".repeat(201), origin: "direct", agent: "x" },
      { title: "ok", origin: "direct", agent: "x", payload: [] },
    ];
    for (const b of bad) await expect(createTask(A.token, b as never)).rejects.toBeInstanceOf(InvalidTaskInputError);
    expect((await listTasks(A.token, { limit: 200 })).length).toBe(before);
  });

  it("needs an authenticated caller and takes no tenant from the input", async () => {
    await expect(createTask("not-a-token", { title: "t", origin: "direct", agent: "x" })).rejects.toBeInstanceOf(AuthenticationError);
    const t = await createTask(A.token, { title: "spoof", origin: "direct", agent: "x", tenant_id: B.tenant } as never);
    expect(t.tenant_id).toBe(A.tenant);
  });
});

describe("list", () => {
  it("filters by status (single and several) and orders newest first", async () => {
    const q = await createTask(A.token, { title: "list-queued", origin: "maestro", agent: "stock" });
    const w = await createTask(A.token, { title: "list-working", origin: "routine", agent: "stock" });
    const f = await createTask(A.token, { title: "list-failed", origin: "intake", agent: "stock" });
    await move(A, w.id, "working");
    await move(A, f.id, "working");
    await withTenant(agentOf(A), (tx) => transitionTask(tx, f.id, "failed", { error: "boom" }));

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const queued = await listTasks(A.token, { status: "queued" });
    expect(queued.every((r) => r.status === "queued")).toBe(true);
    expect(ids(queued)).toContain(q.id);
    expect(ids(queued)).not.toContain(w.id);
    expect(ids(await listTasks(A.token, { status: "working" }))).toContain(w.id);
    const both = await listTasks(A.token, { status: ["working", "failed"] });
    expect(ids(both)).toEqual(expect.arrayContaining([w.id, f.id]));
    expect(both.every((r) => r.status === "working" || r.status === "failed")).toBe(true);
    expect(await listTasks(A.token, { status: "done" })).toEqual([]);

    const all = await listTasks(A.token);
    const times = all.map((r) => r.created_at.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    await expect(listTasks(A.token, { status: "bogus" as never })).rejects.toBeInstanceOf(InvalidTaskInputError);
    expect(await listTasks(A.token, { limit: 1 })).toHaveLength(1);
  }, 60_000);

  it("never lists another tenant's tasks", async () => {
    const bt = await createTask(B.token, { title: "only-b", origin: "direct", agent: "x" });
    const a = await listTasks(A.token);
    expect(a.map((r) => r.id)).not.toContain(bt.id);
    expect(a.every((r) => r.tenant_id === A.tenant)).toBe(true);
    expect((await listTasks(B.token)).map((r) => r.id)).toEqual([bt.id]);
  });
});

describe("detail", () => {
  it("returns the task with its audit history oldest first, split into checks and approvals", async () => {
    const t = await createTask(A.token, { title: "detail", origin: "direct", agent: "booking" });
    await move(A, t.id, "working", "in_review");
    await withTenant(agentOf(A), (tx) => recordCheckerResult(tx, t.id, { stage: "deterministic", outcome: "pass", verdict: "pass", revision: 1 }));
    await move(A, t.id, "pending_approval");
    await withTenant({ tenantId: A.tenant, actor: "owner", actorId: A.user }, (tx) => recordApprovalDecision(tx, t.id, { decision: "approved", revision: 1 }));

    const d = await getTaskDetail(A.token, t.id);
    expect(d.task.id).toBe(t.id);
    expect(d.task.status).toBe("pending_approval");
    expect(d.history.map((e) => e.type)).toEqual([
      "task.created",
      "task.transition",
      "task.transition",
      "checker.result",
      "task.transition",
      "approval.decision",
    ]);
    expect(d.history.map((e) => e.payload.to).filter(Boolean)).toEqual(["working", "in_review", "pending_approval"]);
    expect(d.checks).toHaveLength(1);
    expect(d.checks[0].payload).toMatchObject({ verdict: "pass" });
    expect(d.approvals).toHaveLength(1);
    expect(d.approvals[0].payload).toMatchObject({ decision: "approved" });
  }, 60_000);

  it("returns an empty check/approval history when none exists yet", async () => {
    const t = await createTask(A.token, { title: "no-checks", origin: "intake", agent: "booking" });
    const d = await getTaskDetail(A.token, t.id);
    expect(d.checks).toEqual([]);
    expect(d.approvals).toEqual([]);
  });

  it("another tenant's task, an unknown id, and a malformed id are all NotFound, and nothing is audited", async () => {
    const bt = await createTask(B.token, { title: "b-secret", origin: "direct", agent: "x" });
    const count = () => withTenant({ tenantId: A.tenant, actor: "owner", actorId: A.user }, async (tx) => (await tx.query("select 1 from audit_log where type like 'security.%'")).length);
    const before = await count();
    for (const id of [bt.id, randomUUID(), "not-a-uuid"]) await expect(getTaskDetail(A.token, id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await count()).toBe(before);
  });
});
