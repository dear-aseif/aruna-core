import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthenticationError, resolveSession, signInWithPassword } from "@/server/auth";
import { hashPassword } from "@/server/auth/password";
import { storeBriefing } from "@/server/briefings";
import { withTenant, type Caller } from "@/server/dal";
import { closeAllPools, TenantDeactivatedError, withTenantSession } from "@/server/db";
import { requestOwnExport } from "@/server/exports";
import { buildZip, readZip } from "@/server/exports/archive";
import {
  AlreadyDeactivatedError,
  ExportNotVerifiedError,
  ExportStaleError,
  OPERATOR_AUDIT_TYPES,
  OperatorOnlyError,
  deactivateTenant,
  verifyExport,
} from "@/server/offboarding";
import { activatePlaybook } from "@/server/playbook";
import { ROUTINE_ACTOR_ID, runBriefingRoutines } from "@/server/routines";
import { createTask, createTaskTx } from "@/server/tasks";
import { checkedTransition } from "../support/checked-transition";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 10.4: offboarding order (export -> verify -> deactivate) and deactivation enforcement.
// Synthetic tenants only; everything runs through the real server modules and the real database.
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
interface T {
  id: string;
  email: string;
  token: string;
  owner: Caller;
  operator: Caller;
  pendingTaskId: string;
}
const sys = (id: string): Caller => ({ tenantId: id, actor: "system", actorId: `deact-system-${run}` });
async function mkTenant(n: string): Promise<T> {
  const id = randomUUID();
  const email = `deact-${n}-${run}@unit.example`;
  trackTenant(id);
  await withTenantSession(id, async (c) => void (await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [id, `Deact ${n} ${run}`])), "service");
  await withTenant(sys(id), async (tx) => tx.insert("profiles", { email, password_hash: await hashPassword(password), role: "owner" }), "service");
  expect((await activatePlaybook(sys(id), JSON.parse(readFileSync("playbooks/denana.json", "utf8")))).ok).toBe(true);
  const s = (await signInWithPassword(email, password))!;
  const owner: Caller = { tenantId: id, actor: "owner", actorId: s.context.userId };
  const pendingTaskId = await withTenant(sys(id), async (tx) => {
    await createTaskTx(tx, { title: `Deact ${n} plain`, origin: "direct", agent: "booking" });
    const t = await createTaskTx(tx, { title: `Deact ${n} pending`, origin: "direct", agent: "booking" });
    for (const to of ["working", "in_review", "pending_approval"] as const) await checkedTransition(tx, t.id, to);
    await storeBriefing(tx, { scheduleDate: "2026-11-20", sections: [{ id: "core", facts: { n } }] });
    return t.id;
  });
  return { id, email, token: s.sessionToken, owner, operator: { tenantId: id, actor: "operator", actorId: `deact-operator-${run}` }, pendingTaskId };
}
/** Owner export of the tenant, as the zip bytes. */
const exportOf = async (t: T) => (await requestOwnExport(t.token)).archive;
const statusOf = (t: T) => withTenant(t.operator, async (tx) => (await tx.getById<{ status: string }>("tenants", t.id)).status, "service");
const auditTypes = (t: T) => withTenant(t.operator, async (tx) => (await tx.query<{ type: string; actor: string; actor_id: string }>("select type, actor, actor_id from audit_log order by created_at, seq")), "service");
let A: T; // order and cutoff
let B: T; // full deactivation and enforcement
let C: T; // verification failures
let D: T; // a different tenant's archive
beforeAll(async () => {
  [A, B, C, D] = await Promise.all([mkTenant("a"), mkTenant("b"), mkTenant("c"), mkTenant("d")]);
}, 120_000);
afterAll(async () => {
  await closeAllPools();
});
describe("offboarding order: export -> verify -> deactivate", () => {
  it("refuses deactivation without a verification, changes nothing, and audits the refusal", async () => {
    await expect(deactivateTenant(A.operator)).rejects.toMatchObject({ name: "ExportNotVerifiedError", reason: "no_verification" });
    expect(await statusOf(A)).toBe("active");
    expect(await resolveSession(A.token)).not.toBeNull();
    expect((await auditTypes(A)).filter((e) => e.type === OPERATOR_AUDIT_TYPES.deactivationRefused)).toHaveLength(1);
  });
  it("an exported but unverified archive does not unlock deactivation", async () => {
    await exportOf(A);
    await expect(deactivateTenant(A.operator)).rejects.toBeInstanceOf(ExportNotVerifiedError);
    expect(await statusOf(A)).toBe("active");
  });
  it("owners can never verify or deactivate, not even their own tenant", async () => {
    const archive = await exportOf(A);
    await expect(verifyExport(A.owner, archive)).rejects.toBeInstanceOf(OperatorOnlyError);
    await expect(deactivateTenant(A.owner)).rejects.toBeInstanceOf(OperatorOnlyError);
    await expect(deactivateTenant({ ...A.owner, actor: "system" })).rejects.toBeInstanceOf(OperatorOnlyError);
    expect(await statusOf(A)).toBe("active");
  });
  it("refuses deactivation when data changed after the cutoff, until a fresh export and verification", async () => {
    const archive = await exportOf(A);
    const v = await verifyExport(A.operator, archive);
    expect(v.passed).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.entities.tasks).toBe(2);
    // a change after the cutoff: one new task
    await withTenant(sys(A.id), (tx) => createTaskTx(tx, { title: "after the cutoff", origin: "direct", agent: "booking" }));
    await expect(deactivateTenant(A.operator)).rejects.toSatisfy(
      (e) => e instanceof ExportStaleError && e.changed.includes("tasks") && e.changed.includes("audit_log"),
    );
    expect(await statusOf(A)).toBe("active");
    // the OLD verification stays stale even if asked again
    await expect(deactivateTenant(A.operator)).rejects.toBeInstanceOf(ExportStaleError);
    // fresh export + fresh verification -> allowed
    expect((await verifyExport(A.operator, await exportOf(A))).passed).toBe(true);
    const r = await deactivateTenant(A.operator);
    expect(r.expiredTaskIds).toEqual([A.pendingTaskId]);
    expect(await statusOf(A)).toBe("deactivated");
  });
  it("detects an edit to an existing record (not only new rows)", async () => {
    const t = await mkTenant("edit");
    expect((await verifyExport(t.operator, await exportOf(t))).passed).toBe(true);
    await withTenant(sys(t.id), (tx) => tx.updateById("settings", t.id, { assistant_name: "Renamed" }, "tenant_id"));
    await expect(deactivateTenant(t.operator)).rejects.toSatisfy((e) => e instanceof ExportStaleError && e.changed.includes("settings"));
    expect(await statusOf(t)).toBe("active");
  });
  it("the export, verification and refusal records written by offboarding do not count as changes", async () => {
    const t = await mkTenant("quiet");
    expect((await verifyExport(t.operator, await exportOf(t))).passed).toBe(true);
    await exportOf(t); // another export after the cutoff: audited, but not a data change
    await expect(deactivateTenant(t.operator)).resolves.toMatchObject({ expiredTaskIds: [t.pendingTaskId] });
  });
});
describe("archive verification", () => {
  it("records a failed result and a failed latest verification blocks deactivation", async () => {
    const archive = await exportOf(C);
    const files = readZip(archive);
    // Tamper: change one entity file's content but keep the manifest.
    const tampered = files.map((f) => (f.path === "tasks.json" ? { path: f.path, data: Buffer.from("[]\n") } : f));
    const bad = await verifyExport(C.operator, buildZip(tampered, new Date()));
    expect(bad.passed).toBe(false);
    expect(bad.problems.join("\n")).toMatch(/sha256 differs from the manifest: tasks\.json/);
    expect(bad.problems.join("\n")).toMatch(/byte size differs from the manifest: tasks\.json/);
    expect(bad.problems.join("\n")).toMatch(/entity count differs from the manifest: tasks/);
    await expect(deactivateTenant(C.operator)).rejects.toMatchObject({ reason: "verification_failed" });
    expect((await auditTypes(C)).map((e) => e.type)).toContain(OPERATOR_AUDIT_TYPES.verificationFailed);
    // A good verification afterwards makes it the latest passed one.
    expect((await verifyExport(C.operator, archive)).passed).toBe(true);
  });
  it("fails an archive whose manifest counts are wrong, or that carries an unlisted file, or is not a zip", async () => {
    const files = readZip(await exportOf(C));
    const manifest = JSON.parse(Buffer.from(files.find((f) => f.path === "manifest.json")!.data).toString("utf8"));
    manifest.entities.messages += 1;
    const wrongCount = files.map((f) => (f.path === "manifest.json" ? { path: f.path, data: Buffer.from(JSON.stringify(manifest)) } : f));
    expect((await verifyExport(C.operator, buildZip(wrongCount, new Date()))).problems.join("\n")).toMatch(/entity count differs from the manifest: messages/);
    const extra = [...files, { path: "extra.txt", data: Buffer.from("x") }];
    expect((await verifyExport(C.operator, buildZip(extra, new Date()))).problems).toContain("file is not listed in the manifest: extra.txt");
    expect((await verifyExport(C.operator, Buffer.from("not a zip"))).passed).toBe(false);
  });
  it("fails an archive whose manifest belongs to another tenant", async () => {
    const other = await verifyExport(C.operator, await exportOf(D));
    expect(other.passed).toBe(false);
    expect(other.problems).toContain("the manifest belongs to a different tenant");
  });
  it("audits both actions as operator actions with the operator's stable identity", async () => {
    const entries = (await auditTypes(C)).filter((e) => e.type.startsWith("operator."));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect([e.actor, e.actor_id]).toEqual(["operator", `deact-operator-${run}`]);
  });
});
describe("deactivation effects and enforcement", () => {
  let deactivated = false;
  const ensureDeactivated = async () => {
    if (deactivated) return;
    expect(await resolveSession(B.token)).not.toBeNull();
    expect((await verifyExport(B.operator, await exportOf(B))).passed).toBe(true);
    const r = await deactivateTenant(B.operator);
    expect(r.expiredTaskIds).toEqual([B.pendingTaskId]);
    expect(r.revokedSessions).toBe(1);
    deactivated = true;
  };
  it("sets the status, revokes sessions and expires pending approvals through the state machine", async () => {
    await ensureDeactivated();
    expect(await statusOf(B)).toBe("deactivated");
    expect(await resolveSession(B.token)).toBeNull();
    const rows = await withTenant(B.operator, (tx) => tx.query<{ revoked_at: Date | null }>("select revoked_at from sessions"), "service");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    const task = await withTenant(B.operator, (tx) => tx.getById<{ status: string }>("tasks", B.pendingTaskId), "service");
    expect(task.status).toBe("expired");
    const audit = await withTenant(
      B.operator,
      (tx) => tx.query<{ type: string; payload: { reason?: string } }>("select type, payload from audit_log where task_id = $1 order by created_at, seq", [B.pendingTaskId]),
      "service",
    );
    expect(audit.some((e) => e.type === "task.transition" && e.payload.reason === "tenant_deactivated")).toBe(true);
    expect(audit.map((e) => e.type)).toContain("task.actions_cancelled");
    expect(await auditTypes(B)).toContainEqual({ type: OPERATOR_AUDIT_TYPES.deactivated, actor: "operator", actor_id: `deact-operator-${run}` });
    await expect(deactivateTenant(B.operator)).rejects.toBeInstanceOf(AlreadyDeactivatedError);
  });
  it("refuses writes through an old session (and signing in again)", async () => {
    await ensureDeactivated();
    await expect(createTask(B.token, { title: "late", origin: "direct", agent: "booking" })).rejects.toBeInstanceOf(AuthenticationError);
    expect(await signInWithPassword(B.email, password)).toBeNull();
    // Even a caller that skipped the session lookup (a request already in flight) is stopped at the database.
    await expect(withTenant(B.owner, (tx) => createTaskTx(tx, { title: "in flight", origin: "direct", agent: "booking" }))).rejects.toBeInstanceOf(TenantDeactivatedError);
  });
  it("refuses writes arriving through the public intake path (an intake-origin task)", async () => {
    await ensureDeactivated();
    await expect(withTenant(sys(B.id), (tx) => createTaskTx(tx, { title: "intake request", origin: "intake", agent: "booking" }))).rejects.toBeInstanceOf(TenantDeactivatedError);
  });
  it("refuses routine work: the engine skips the tenant and a routine-actor write is refused", async () => {
    await ensureDeactivated();
    const r = await runBriefingRoutines({ now: new Date("2031-05-10T03:00:00Z"), onlyTenantIds: [B.id] });
    expect(r.tenants).toBe(0);
    const routine: Caller = { tenantId: B.id, actor: "system", actorId: ROUTINE_ACTOR_ID };
    await expect(withTenant(routine, (tx) => storeBriefing(tx, { scheduleDate: "2031-05-10", sections: [] }))).rejects.toBeInstanceOf(TenantDeactivatedError);
  });
  it("refuses executor work: moving a task is refused too", async () => {
    await ensureDeactivated();
    const queued = await withTenant(B.operator, async (tx) => (await tx.query<{ id: string }>("select id from tasks where status = 'queued' limit 1"))[0].id, "service");
    const agent: Caller = { tenantId: B.id, actor: "agent", actorId: "booking" };
    await expect(withTenant(agent, (tx) => checkedTransition(tx, queued, "working"))).rejects.toBeInstanceOf(TenantDeactivatedError);
  });
  it("keeps the data readable to the operator, and still audits (append-only) after deactivation", async () => {
    await ensureDeactivated();
    const n = await withTenant(B.operator, async (tx) => (await tx.query<{ n: number }>("select count(*)::int as n from tasks"))[0].n, "service");
    expect(n).toBe(2);
    await withTenant(B.operator, (tx) => tx.audit("operator.note", { after: "deactivation" }), "service");
  });
});
