import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthenticationError, signInWithPassword } from "@/server/auth";
import { hashPassword } from "@/server/auth/password";
import { getTaskHistory } from "@/server/audit";
import {
  BOARD_STATUSES,
  InvalidBoardInputError,
  approveFromBoard,
  buildBoardModel,
  describeBoardError,
  loadBoard,
  rejectFromBoard,
  reviseFromBoard,
  type BoardModel,
} from "@/server/board";
import { TEST_ACTION_TYPES as T, TestRecordStore, registerTestApprovalHandlers, unregisterTestApprovalHandlers } from "@/server/approvals";
import { NotFoundError, withTenant, type Caller } from "@/server/dal";
import { closeAllPools, withTenantSession } from "@/server/db";
import { numberEquality, registerCheckerPack, unregisterCheckerPack } from "@/server/checker";
import { createModelGateway } from "@/server/gateway";
import { activatePlaybook } from "@/server/playbook";
import { TASK_STATUSES, type TaskRow, type TaskStatus } from "@/server/tasks";
import { checkedTransition } from "../support/checked-transition";
import { createFakeAdapter } from "../support/fake-adapter";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Task 9.2: board data and owner actions. Columns/stack rendering per viewport is covered in tests/e2e/board.spec.ts.
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const store = new TestRecordStore();
const tenants = ["a", "b"].map((n) => ({
  n,
  caller: { tenantId: randomUUID(), actor: "agent", actorId: `board-agent-${n}-${run}` } as Caller,
  email: `board-${n}-${run}@unit.example`,
  token: "",
}));
const [A, B] = tenants;
// Re-check of a revised draft: a test-only pack (qty must equal the source's 3) and the fake provider adapter.
const PACK = `board-pack-${run}`;
const OK = { kind: "success", text: JSON.stringify({ verdict: "ok", issues: [] }) } as const;
const deps = (fake: ReturnType<typeof createFakeAdapter>) => ({ gateway: createModelGateway(fake), check: { packId: PACK } });
const SYSTEM = (c: Caller): Caller => ({ ...c, actor: "system", actorId: `board-system-${run}` });

beforeAll(async () => {
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  for (const t of tenants) {
    trackTenant(t.caller.tenantId);
    await withTenantSession(
      t.caller.tenantId,
      async (cl) => {
        await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [t.caller.tenantId, `Board ${t.n} ${run}`]);
      },
      "service",
    );
    await withTenant(SYSTEM(t.caller), async (tx) => tx.insert("profiles", { email: t.email, password_hash: await hashPassword(password), role: "owner" }), "service");
    expect((await activatePlaybook(SYSTEM(t.caller), doc)).ok).toBe(true);
    t.token = (await signInWithPassword(t.email, password))!.sessionToken;
  }
  registerTestApprovalHandlers(store);
  registerCheckerPack({ packId: PACK, rules: [numberEquality("qty", [{ field: "qty", source: "line.qty" }])], loadSources: async () => ({ line: { qty: 3 } }) });
}, 90_000);

beforeEach(() => {
  store.effects.length = 0;
});
afterAll(async () => {
  unregisterCheckerPack(PACK);
  unregisterTestApprovalHandlers();
  await closeAllPools();
});

type Tenant = (typeof tenants)[number];
/** A task driven to `status` through the state machine (with the passing check the gate requires). */
async function task(t: Tenant, title: string, status: TaskStatus, fields: Record<string, unknown> = {}): Promise<{ id: string; recordId: string }> {
  const recordId = randomUUID();
  store.put(recordId, { state: "pending" });
  const payload = { action_type: T.bookingConfirm, fields: { record_id: recordId, ...fields } };
  const id = await withTenant(t.caller, async (tx) => {
    const r = await tx.insert<{ id: string }>("tasks", { title, origin: "direct", agent: "booking", created_by: t.caller.actorId, payload: JSON.stringify(payload) });
    const path: Partial<Record<TaskStatus, TaskStatus[]>> = {
      queued: [],
      working: ["working"],
      in_review: ["working", "in_review"],
      pending_approval: ["working", "in_review", "pending_approval"],
      done: ["working", "in_review", "done"],
      expired: ["working", "in_review", "pending_approval"],
    };
    for (const s of path[status] ?? []) await checkedTransition(tx, r.id, s);
    if (status === "failed") {
      await checkedTransition(tx, r.id, "working");
      await checkedTransition(tx, r.id, "failed", { error: "model unavailable" });
    }
    if (status === "expired") await tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [r.id]);
    return r.id;
  });
  return { id, recordId };
}
const row = (t: Tenant, id: string) => withTenant(t.caller, (tx) => tx.getById<TaskRow>("tasks", id));
const titles = (m: BoardModel, s: TaskStatus) => m.columns[s].map((c) => c.title);
const decisions = (t: Tenant, id: string) => withTenant(t.caller, async (tx) => (await getTaskHistory(tx, id)).filter((e) => e.type === "approval.decision"));

describe("board model", () => {
  it("groups cards by status in pipeline order, with the draft and deadline on Pending Approval only", () => {
    const base = { tenant_id: "t", origin: "direct", agent: "booking", anomaly: null, error: null, created_by: "u", created_at: new Date(), updated_at: new Date(), payload_revision: 3 };
    const rows = [
      { ...base, id: "1", title: "p", status: "pending_approval", payload: { action_type: "x.y", fields: { n: 2, s: "a", nested: { z: 1 } } }, approval_expires_at: new Date("2026-11-20T06:30:00Z") },
      { ...base, id: "2", title: "d", status: "done", payload: { action_type: "x.y", fields: { n: 2 } }, approval_expires_at: null },
    ] as unknown as TaskRow[];
    const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    const m = buildBoardModel(rows, counts, "Asia/Makassar", "en");
    expect(m.statuses).toEqual([...BOARD_STATUSES]);
    expect(m.columns.pending_approval[0]).toMatchObject({ revision: 3, deadline: "14:30", draft: { actionType: "x.y", fields: { n: 2, s: "a" } } });
    expect(m.columns.done[0]).toMatchObject({ deadline: null, draft: null });
  });
});

describe("board data (tasks via the 4.4 operations, lazy expiry on read)", () => {
  it("lists a tenant's tasks by status and never another tenant's", async () => {
    await task(A, `A-queued-${run}`, "queued");
    await task(A, `A-pending-${run}`, "pending_approval");
    await task(A, `A-done-${run}`, "done");
    await task(A, `A-failed-${run}`, "failed");
    await task(B, `B-secret-${run}`, "pending_approval");
    const m = await loadBoard(A.token);
    expect(titles(m, "queued")).toContain(`A-queued-${run}`);
    expect(titles(m, "pending_approval")).toContain(`A-pending-${run}`);
    expect(titles(m, "done")).toContain(`A-done-${run}`);
    expect(m.columns.failed.find((c) => c.title === `A-failed-${run}`)?.error).toBe("model unavailable");
    const all = TASK_STATUSES.flatMap((s) => titles(m, s));
    expect(all.some((x) => x.startsWith("B-"))).toBe(false);
    const mb = await loadBoard(B.token);
    expect(TASK_STATUSES.flatMap((s) => titles(mb, s)).some((x) => x.startsWith("A-"))).toBe(false);
    expect(titles(mb, "pending_approval")).toContain(`B-secret-${run}`);
  });

  it("an overdue Pending Approval task reads as Expired (audited), never as awaiting approval", async () => {
    const { id } = await task(A, `A-overdue-${run}`, "expired");
    expect((await row(A, id)).status).toBe("pending_approval"); // not yet swept: only the read expires it
    const m = await loadBoard(A.token);
    expect(titles(m, "pending_approval")).not.toContain(`A-overdue-${run}`);
    expect(titles(m, "expired")).toContain(`A-overdue-${run}`);
    expect((await row(A, id)).status).toBe("expired");
    const history = await withTenant(A.caller, (tx) => getTaskHistory(tx, id));
    expect(history.some((e) => e.type === "task.transition" && e.payload.to === "expired" && e.actor === "system")).toBe(true);
  });

  it("requires an owner session", async () => {
    await expect(loadBoard(undefined)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(approveFromBoard("not-a-session", randomUUID(), 1)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("board actions go through the approval gate", () => {
  it("approve executes once and moves the task to Done; a repeat executes nothing", async () => {
    const { id, recordId } = await task(A, `A-approve-${run}`, "pending_approval");
    const first = await approveFromBoard(A.token, id, 1);
    const again = await approveFromBoard(A.token, id, 1);
    expect([first.executed, again.executed]).toEqual([true, false]);
    expect(first.status).toBe("done");
    expect(store.effectsFor(id)).toHaveLength(1);
    expect(store.get(recordId)!.state).toBe("confirmed");
    expect(await decisions(A, id)).toHaveLength(1);
  });

  it("reject moves to Rejected without executing", async () => {
    const { id, recordId } = await task(A, `A-reject-${run}`, "pending_approval");
    expect((await rejectFromBoard(A.token, id, "not today")).status).toBe("rejected");
    expect(store.effectsFor(id)).toHaveLength(0);
    expect(store.get(recordId)!.state).toBe("pending");
    const [d] = await decisions(A, id);
    expect(d.payload).toMatchObject({ decision: "reject", reason: "not today" });
  });

  it("an expired task can no longer be approved or rejected", async () => {
    const { id } = await task(A, `A-late-${run}`, "expired");
    const err = await approveFromBoard(A.token, id, 1).catch((e) => e);
    expect(describeBoardError(err)).toEqual({ status: 409, code: "expired" });
    expect(describeBoardError(await rejectFromBoard(A.token, id).catch((e) => e))?.code).toMatch(/expired|not_awaiting/);
    expect((await row(A, id)).status).toBe("expired");
    expect(store.effectsFor(id)).toHaveLength(0);
  });

  it("another tenant's task cannot be decided from this session", async () => {
    const { id } = await task(B, `B-foreign-${run}`, "pending_approval");
    await expect(approveFromBoard(A.token, id, 1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(rejectFromBoard(A.token, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(B, id)).status).toBe("pending_approval");
    expect(store.effectsFor(id)).toHaveLength(0);
  });

  it("a stale revision is refused and bad input is rejected before anything runs", async () => {
    const { id } = await task(A, `A-stale-${run}`, "pending_approval");
    expect(describeBoardError(await approveFromBoard(A.token, id, 2).catch((e) => e))?.code).toBe("revision_changed");
    await expect(approveFromBoard(A.token, id, "1")).rejects.toBeInstanceOf(InvalidBoardInputError);
    await expect(approveFromBoard(A.token, "nope", 1)).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(A, id)).status).toBe("pending_approval");
  });

  it("revising a Pending Approval draft uses reviseDraft, re-checks it, and returns it to Pending Approval at the new revision", async () => {
    const { id } = await task(A, `A-revise-${run}`, "pending_approval", { note: "before", qty: 2 });
    const fake = createFakeAdapter(OK);
    const out = await reviseFromBoard(A.token, id, { note: "after", qty: 3 }, deps(fake));
    expect(out).toMatchObject({ status: "pending_approval", revision: 2, anomaly: null });
    expect(fake.calls).toHaveLength(1); // model review ran after the deterministic pass
    const r = await row(A, id);
    expect(r.payload).toMatchObject({ action_type: T.bookingConfirm, fields: { note: "after", qty: 3 } });
    expect(r.approval_expires_at).not.toBeNull(); // a fresh deadline for the new revision
    const history = await withTenant(A.caller, (tx) => getTaskHistory(tx, id));
    expect(history.map((e) => e.type)).toEqual(expect.arrayContaining(["task.draft_revised", "approval.voided", "checker.result"]));
    expect(history.filter((e) => e.type === "checker.result").at(-1)!.payload).toMatchObject({ outcome: "pass", revision: 2, route: "pending_approval" });
    // The old approval is void: revision 1 cannot be approved, revision 2 can.
    expect(describeBoardError(await approveFromBoard(A.token, id, 1).catch((e) => e))?.code).toBe("revision_changed");
    expect(store.effectsFor(id)).toHaveLength(0);
    expect((await approveFromBoard(A.token, id, 2)).status).toBe("done");
  });

  it("a revised draft that fails the checks goes to Working with the anomaly, never stranded In Review", async () => {
    const { id } = await task(A, `A-revise-bad-${run}`, "pending_approval", { note: "before", qty: 3 });
    const fake = createFakeAdapter(OK);
    const out = await reviseFromBoard(A.token, id, { qty: 5 }, deps(fake));
    expect(out).toMatchObject({ status: "working", revision: 2 });
    expect(out.anomaly).toContain("qty");
    expect(fake.calls).toHaveLength(0); // a deterministic failure never reaches the model
    const r = await row(A, id);
    expect(r.status).toBe("working");
    expect(r.anomaly).toBe(out.anomaly);
    expect(describeBoardError(await approveFromBoard(A.token, id, 2).catch((e) => e))?.code).toBe("not_awaiting");
    expect(store.effectsFor(id)).toHaveLength(0);
  });

  it("revision refuses unknown fields, type changes, and tasks that are not Pending Approval", async () => {
    const { id } = await task(A, `A-badrev-${run}`, "pending_approval", { qty: 2 });
    await expect(reviseFromBoard(A.token, id, { nope: "x" }, deps(createFakeAdapter(OK)))).rejects.toBeInstanceOf(InvalidBoardInputError);
    await expect(reviseFromBoard(A.token, id, { qty: "many" }, deps(createFakeAdapter(OK)))).rejects.toBeInstanceOf(InvalidBoardInputError);
    expect((await row(A, id)).payload_revision).toBe(1);
    const q = await task(A, `A-queued2-${run}`, "queued", { qty: 1 });
    expect(describeBoardError(await reviseFromBoard(A.token, q.id, { qty: 2 }, deps(createFakeAdapter(OK))).catch((e) => e))?.code).toBe("not_awaiting");
  });
});
