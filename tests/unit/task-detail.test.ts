import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signInWithPassword, AuthenticationError } from "@/server/auth";
import { hashPassword } from "@/server/auth/password";
import { getTaskHistory, recordCheckerResult } from "@/server/audit";
import { type BoardModel, approveFromBoard, describeBoardError, formatTimestamp, loadBoard, loadTaskDetail, rejectFromBoard } from "@/server/board";
import { TEST_ACTION_TYPES as T, TestRecordStore, registerTestApprovalHandlers, unregisterTestApprovalHandlers } from "@/server/approvals";
import { NotFoundError, withTenant, type Caller } from "@/server/dal";
import { closeAllPools, withTenantSession } from "@/server/db";
import { activatePlaybook } from "@/server/playbook";
import { TASK_ORIGINS, TASK_STATUSES, type TaskStatus } from "@/server/tasks";
import { STRINGS } from "@/i18n/strings";
import { checkedTransition } from "../support/checked-transition";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 9.3: task cards (agent, origin, status, check and approval history) and the task detail with its audit trail.
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const store = new TestRecordStore();
const SYSTEM = (c: Caller): Caller => ({ ...c, actor: "system", actorId: `detail-system-${run}` });
const tenants = [
  { n: "a", tz: "Asia/Makassar", offset: "+8" },
  { n: "b", tz: "Asia/Jayapura", offset: "+9" },
].map((x) => ({
  ...x,
  caller: { tenantId: randomUUID(), actor: "agent", actorId: `detail-agent-${x.n}-${run}` } as Caller,
  email: `detail-${x.n}-${run}@unit.example`,
  token: "",
}));
const [A, B] = tenants;
type Tenant = (typeof tenants)[number];
beforeAll(async () => {
  for (const t of tenants) {
    const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
    doc.business.timezone = t.tz;
    trackTenant(t.caller.tenantId);
    await withTenantSession(
      t.caller.tenantId,
      async (cl) => {
        await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [t.caller.tenantId, `Detail ${t.n} ${run}`]);
      },
      "service",
    );
    await withTenant(SYSTEM(t.caller), async (tx) => tx.insert("profiles", { email: t.email, password_hash: await hashPassword(password), role: "owner" }), "service");
    expect((await activatePlaybook(SYSTEM(t.caller), doc)).ok).toBe(true);
    t.token = (await signInWithPassword(t.email, password))!.sessionToken;
  }
  registerTestApprovalHandlers(store);
}, 90_000);
beforeEach(() => {
  store.effects.length = 0;
});
afterAll(async () => {
  unregisterTestApprovalHandlers();
  await closeAllPools();
});
/** A task driven to `status` through the state machine; `overdue` = Pending Approval past its deadline (not yet swept). */
async function task(t: Tenant, title: string, status: TaskStatus | "overdue", origin = "direct"): Promise<string> {
  const recordId = randomUUID();
  store.put(recordId, { state: "pending" });
  const payload = { action_type: T.bookingConfirm, fields: { record_id: recordId, customer: "Contoh Pelanggan" } };
  return withTenant(t.caller, async (tx) => {
    const r = await tx.insert<{ id: string }>("tasks", { title, origin, agent: "booking", created_by: t.caller.actorId, payload: JSON.stringify(payload) });
    const path: Record<string, TaskStatus[]> = {
      queued: [],
      working: ["working"],
      in_review: ["working", "in_review"],
      pending_approval: ["working", "in_review", "pending_approval"],
      overdue: ["working", "in_review", "pending_approval"],
      done: ["working", "in_review", "done"],
      failed: ["working"],
    };
    for (const s of path[status] ?? []) await checkedTransition(tx, r.id, s);
    if (status === "failed") await checkedTransition(tx, r.id, "failed", { error: "model unavailable" });
    if (status === "overdue") await tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [r.id]);
    return r.id;
  });
}
const card = async (t: Tenant, id: string, board?: BoardModel) => {
  const m = board ?? (await loadBoard(t.token));
  const c = TASK_STATUSES.flatMap((s) => m.columns[s]).find((x) => x.id === id);
  expect(c, "task is on the board").toBeDefined();
  return c!;
};
describe("task cards: agent, origin, status, check and approval history", () => {
  it("each status class carries agent, origin, status and the history it has earned", { timeout: 120_000 }, async () => {
    const queued = await task(A, `q-${run}`, "queued", "routine");
    const working = await task(A, `w-${run}`, "working", "maestro");
    const inReview = await task(A, `r-${run}`, "in_review", "intake");
    const pending = await task(A, `p-${run}`, "pending_approval", "direct");
    const done = await task(A, `d-${run}`, "done", "routine");
    const failed = await task(A, `f-${run}`, "failed", "maestro");
    const overdue = await task(A, `o-${run}`, "overdue", "direct");
    const approved = await task(A, `ap-${run}`, "pending_approval");
    const rejected = await task(A, `rj-${run}`, "pending_approval");
    await approveFromBoard(A.token, approved, 1);
    await rejectFromBoard(A.token, rejected, "not today");
    const expected: [string, TaskStatus, string, number, number][] = [
      [queued, "queued", "routine", 0, 0],
      [working, "working", "maestro", 0, 0],
      [inReview, "in_review", "intake", 0, 0],
      [pending, "pending_approval", "direct", 1, 0],
      [done, "done", "routine", 1, 0],
      [failed, "failed", "maestro", 0, 0],
      [overdue, "expired", "direct", 1, 0], // read as Expired by the board's lazy expiry
      [approved, "done", "direct", 1, 1],
      [rejected, "rejected", "direct", 1, 1],
    ];
    const board = await loadBoard(A.token);
    for (const [id, status, origin, checks, approvals] of expected) {
      const c = await card(A, id, board);
      expect({ status: c.status, agent: c.agent, origin: c.origin, checks: c.checks.length, approvals: c.approvals.length }, status).toEqual({ status, agent: "booking", origin, checks, approvals });
    }
    expect((await card(A, approved, board)).approvals[0]).toMatchObject({ decision: "approve", blocked: false, revision: 1 });
    expect((await card(A, rejected, board)).approvals[0]).toMatchObject({ decision: "reject", reason: "not today" });
    expect((await card(A, pending, board)).checks[0]).toMatchObject({ outcome: "pass", stage: "deterministic", revision: 1 });
    expect((await card(A, failed, board)).error).toBe("model unavailable");
  });
  it("every origin value has an EN and ID label", () => {
    for (const lang of ["en", "id"] as const) for (const o of TASK_ORIGINS) expect(STRINGS[lang][`task.origin.${o}` as keyof (typeof STRINGS)["en"]]).toBeTruthy();
  });
  it("a failed check with its anomalies is part of the history, oldest first", async () => {
    const id = await task(A, `fc-${run}`, "in_review");
    await withTenant(A.caller, (tx) => recordCheckerResult(tx, id, { stage: "deterministic", outcome: "fail", revision: 1, anomalies: [{ message: "quantity differs from source" }] }));
    const c = await card(A, id);
    expect(c.checks).toHaveLength(1);
    expect(c.checks[0]).toMatchObject({ outcome: "fail", anomalies: ["quantity differs from source"] });
  });
});
describe("task detail: the complete audit trail", () => {
  it("lists every audit entry of the task in order, with checks and approvals in the header history", async () => {
    const id = await task(A, `trail-${run}`, "pending_approval", "intake");
    await approveFromBoard(A.token, id, 1);
    const stored = await withTenant(A.caller, (tx) => getTaskHistory(tx, id));
    const d = await loadTaskDetail(A.token, id);
    expect(d.trail.map((e) => e.id)).toEqual(stored.map((e) => e.id));
    expect(d.trail.map((e) => e.type)).toEqual(stored.map((e) => e.type));
    expect(d.trail.length).toBeGreaterThanOrEqual(5);
    const times = d.trail.map((e) => Date.parse(e.atIso));
    expect(times).toEqual([...times].sort((x, y) => x - y));
    const decision = d.trail.find((e) => e.type === "approval.decision")!;
    expect(decision).toMatchObject({ actor: "owner" });
    expect(decision.facts.find((f) => f.key === "decided_at")!.value).toContain("GMT+8"); // not raw UTC
    expect(d.trail.find((e) => e.type === "task.transition")!.facts.map((f) => f.key)).toEqual(expect.arrayContaining(["from", "to"]));
    expect(d.task).toMatchObject({ status: "done", origin: "intake", agent: "booking" });
    expect(d.task.checks).toHaveLength(1);
    expect(d.task.approvals).toHaveLength(1);
    expect(d.fields.customer).toBe("Contoh Pelanggan");
  });
  it("reading the detail writes nothing to the audit trail", async () => {
    const id = await task(A, `ro-${run}`, "done");
    const before = (await withTenant(A.caller, (tx) => getTaskHistory(tx, id))).length;
    await loadTaskDetail(A.token, id);
    await loadTaskDetail(A.token, id);
    expect((await withTenant(A.caller, (tx) => getTaskHistory(tx, id))).length).toBe(before);
  });
  it("an overdue task reads as Expired in the detail", async () => {
    const id = await task(A, `late-${run}`, "overdue");
    const d = await loadTaskDetail(A.token, id);
    expect(d.task.status).toBe("expired");
    expect(d.trail.some((e) => e.type === "task.transition" && e.facts.some((f) => f.key === "to" && f.value === "expired"))).toBe(true);
  });
});
describe("timestamps in the tenant's Playbook timezone", () => {
  it("formats a UTC instant in the given zone and language", () => {
    const at = new Date("2026-11-20T06:30:00Z");
    expect(formatTimestamp(at, "Asia/Makassar", "en")).toMatch(/14:30.*\+8/);
    expect(formatTimestamp(at, "Asia/Jayapura", "en")).toMatch(/15:30.*\+9/);
    expect(formatTimestamp(at, "Asia/Makassar", "id")).toMatch(/14[.:]30/);
    expect(formatTimestamp(at, "Not/AZone", "en")).toBe("2026-11-20T06:30:00.000Z");
  });
  it("cards and trail entries show each tenant's own zone, not UTC", async () => {
    for (const t of [A, B]) {
      const id = await task(t, `tz-${t.n}-${run}`, "pending_approval");
      const d = await loadTaskDetail(t.token, id);
      expect(d.timeZone).toBe(t.tz);
      const first = d.trail[0];
      expect(first.at).toBe(formatTimestamp(new Date(first.atIso), t.tz, "en"));
      expect(first.at).toContain(`GMT${t.offset}`);
      expect(d.created).toContain(`GMT${t.offset}`);
      const c = await card(t, id);
      expect(c.checks[0].at).toContain(`GMT${t.offset}`);
      expect(c.checks[0].atIso.endsWith("Z")).toBe(true); // the instant itself stays UTC
    }
  });
});
describe("task detail tenant isolation", () => {
  it("another tenant's task is not found, an unknown or malformed id is not found, and nothing leaks", async () => {
    const foreign = await task(B, `secret-${run}`, "pending_approval");
    const err = await loadTaskDetail(A.token, foreign).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(describeBoardError(err)).toEqual({ status: 404, code: "not_found" });
    expect(describeBoardError(await loadTaskDetail(A.token, randomUUID()).catch((e) => e))).toEqual({ status: 404, code: "not_found" });
    expect(describeBoardError(await loadTaskDetail(A.token, "not-a-uuid").catch((e) => e))?.status).toBe(404);
    expect((await loadTaskDetail(B.token, foreign)).task.title).toBe(`secret-${run}`);
    const m = await loadBoard(A.token);
    expect(TASK_STATUSES.flatMap((s) => m.columns[s]).some((c) => c.id === foreign)).toBe(false);
  });
  it("requires an owner session", async () => {
    await expect(loadTaskDetail(undefined, randomUUID())).rejects.toBeInstanceOf(AuthenticationError);
  });
});
