import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import { ApprovalExpiredError, NotAwaitingApprovalError, expireTaskIfOverdue, transitionTask, type TaskRow } from "@/server/tasks";
import { checkTask, registerCheckerPack, requiredFields } from "@/server/checker";
import {
  ApprovalNotPermittedError,
  DraftNotRevisableError,
  InvalidActionHandlerError,
  NoActionHandlerError,
  PaymentRuleFailedError,
  RefundNotExecutableError,
  TEST_ACTION_TYPES as T,
  TestRecordStore,
  approveTask,
  getActionHandler,
  registerActionHandler,
  registerTestApprovalHandlers,
  rejectTask,
  reviseDraft,
  unregisterActionHandler,
  unregisterTestApprovalHandlers,
} from "@/server/approvals";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

const run = randomBytes(4).toString("hex");
const PACK = `approval-pack-${run}`;
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT: Caller = { ...OWNER, actor: "agent", actorId: `approval-agent-${run}` };
const OPERATOR: Caller = { ...OWNER, actor: "operator", actorId: `approval-operator-${run}` };
const SYSTEM: Caller = { ...OWNER, actor: "system", actorId: `approval-system-${run}` };
const store = new TestRecordStore();

beforeAll(async () => {
  trackTenant(OWNER.tenantId);
  await withTenantSession(
    OWNER.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [OWNER.tenantId, `Approval ${run}`]);
    },
    "service",
  );
  registerCheckerPack({ packId: PACK, rules: [requiredFields("required", ["record_id"])] });
  registerTestApprovalHandlers(store);
}, 60_000);

beforeEach(() => {
  store.effects.length = 0;
  store.cancelled = 0;
  store.failNextAfterEffect = false;
});

afterAll(async () => {
  unregisterTestApprovalHandlers();
  await closeAllPools();
});

/** A task that has passed the Checker and is Pending Approval. */
async function pending(actionType: string, fields: Record<string, unknown>, rec?: Parameters<TestRecordStore["put"]>[1]): Promise<{ id: string; recordId: string }> {
  const recordId = randomUUID();
  if (rec) store.put(recordId, rec);
  const id = await withTenant(AGENT, async (tx) => {
    const t = await tx.insert<{ id: string }>("tasks", {
      title: "fixture",
      origin: "direct",
      agent: "booking",
      created_by: AGENT.actorId,
      payload: JSON.stringify({ action_type: actionType, fields: { record_id: recordId, ...fields } }),
    });
    await transitionTask(tx, t.id, "working");
    await transitionTask(tx, t.id, "in_review");
    const out = await checkTask(tx, t.id, { packId: PACK });
    expect(out.route).toBe("pending_approval");
    return t.id;
  });
  return { id, recordId };
}

const row = (id: string) => withTenant(OWNER, (tx) => tx.getById<TaskRow>("tasks", id));
const history = (id: string) => withTenant(OWNER, (tx) => getTaskHistory(tx, id));
const decisions = async (id: string) => (await history(id)).filter((e) => e.type === "approval.decision");

describe("approve", () => {
  it("executes the checked revision once, moves to Done, and audits decider and timestamp", async () => {
    const { id, recordId } = await pending(T.bookingConfirm, {}, { state: "pending" });
    const out = await approveTask(OWNER, id, 1);
    expect(out).toMatchObject({ decision: "approved", revision: 1, executed: true });
    expect(store.get(recordId)!.state).toBe("confirmed");
    expect(store.effectsFor(id)).toEqual([{ type: T.bookingConfirm, recordId, taskId: id, revision: 1 }]);
    expect((await row(id)).status).toBe("done");
    const [d] = await decisions(id);
    expect(d).toMatchObject({ actor: "owner", actorId: OWNER.actorId });
    expect(d.payload).toMatchObject({ decision: "approve", revision: 1, action_type: T.bookingConfirm, decided_by: OWNER.actorId });
    expect(Number.isNaN(Date.parse(String(d.payload.decided_at)))).toBe(false);
  });

  it("covers goods-receipt recording and follow-up sendable marking", async () => {
    const g = await pending(T.receiptRecord, { qty: 5 }, { state: "ordered", qty: 2 });
    await approveTask(OWNER, g.id, 1);
    expect(store.get(g.recordId)).toMatchObject({ state: "received", qty: 7 });
    const f = await pending(T.followupSendable, {}, { state: "draft" });
    await approveTask(OWNER, f.id, 1);
    expect(store.get(f.recordId)!.state).toBe("sendable");
  });

  it("approving twice (sequential and concurrent) executes once", async () => {
    const a = await pending(T.bookingConfirm, {}, { state: "pending" });
    const first = await approveTask(OWNER, a.id, 1);
    const second = await approveTask(OWNER, a.id, 1);
    expect([first.executed, second.executed]).toEqual([true, false]);
    expect(store.effectsFor(a.id)).toHaveLength(1);
    expect(await decisions(a.id)).toHaveLength(1);

    const b = await pending(T.bookingConfirm, {}, { state: "pending" });
    const results = await Promise.all([approveTask(OWNER, b.id, 1), approveTask(OWNER, b.id, 1), approveTask(OWNER, b.id, 1)]);
    expect(results.filter((r) => r.executed)).toHaveLength(1);
    expect(store.effectsFor(b.id)).toHaveLength(1);
    expect(await decisions(b.id)).toHaveLength(1);
  });

  it("only the owner may approve or reject; nothing changes otherwise", async () => {
    const { id } = await pending(T.bookingConfirm, {}, { state: "pending" });
    for (const c of [AGENT, OPERATOR, SYSTEM]) {
      await expect(approveTask(c, id, 1)).rejects.toBeInstanceOf(ApprovalNotPermittedError);
      await expect(rejectTask(c, id)).rejects.toBeInstanceOf(ApprovalNotPermittedError);
    }
    expect((await row(id)).status).toBe("pending_approval");
    expect(store.effects).toHaveLength(0);
    expect(await decisions(id)).toHaveLength(0);
  });

  it("a failing handler rolls everything back: still Pending Approval, no decision, retry succeeds", async () => {
    const { id, recordId } = await pending(T.bookingConfirm, {}, { state: "pending" });
    store.failNextAfterEffect = true;
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow("injected failure");
    expect((await row(id)).status).toBe("pending_approval");
    expect(await decisions(id)).toHaveLength(0);
    expect((await approveTask(OWNER, id, 1)).executed).toBe(true);
    expect(store.get(recordId)!.state).toBe("confirmed");
  });

  it("fails closed when the action type has no handler", async () => {
    registerActionHandler({ type: `tmp.${run}`, gated: true, execute: async () => undefined });
    const { id } = await pending(`tmp.${run}`, {});
    unregisterActionHandler(`tmp.${run}`);
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(NoActionHandlerError);
    expect((await row(id)).status).toBe("pending_approval");
  });
});

describe("revision binding", () => {
  it("a draft changed after checking cannot be approved on the old check", async () => {
    const { id, recordId } = await pending(T.bookingConfirm, {}, { state: "pending" });
    const other = randomUUID();
    store.put(other, { state: "pending" });
    const revised = await withTenant(AGENT, (tx) => reviseDraft(tx, id, { action_type: T.bookingConfirm, fields: { record_id: other } }));
    expect(revised.payload_revision).toBe(2);
    // Gate ruling 6.3: the task is back In Review, so neither the stale approval nor the unchecked revision can run.
    expect(revised.status).toBe("in_review");
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(NotAwaitingApprovalError);
    await expect(approveTask(OWNER, id, 2)).rejects.toBeInstanceOf(NotAwaitingApprovalError);
    expect(store.effects).toHaveLength(0);
    expect(store.get(recordId)!.state).toBe("pending");
    expect(store.get(other)!.state).toBe("pending");
    const types = (await history(id)).map((e) => e.type);
    expect(types).toContain("task.draft_revised");
    expect(types).toContain("approval.voided");
    expect(await decisions(id)).toHaveLength(0);
  });

  it("revising a Pending Approval task returns it to In Review, voids the approval, and a fresh check restores Pending Approval with a fresh expiry", async () => {
    const { id, recordId } = await pending(T.bookingConfirm, {}, { state: "pending" });
    const first = (await row(id)).approval_expires_at!;
    const revised = await withTenant(AGENT, (tx) => reviseDraft(tx, id, { action_type: T.bookingConfirm, fields: { record_id: recordId } }));
    expect(revised).toMatchObject({ status: "in_review", payload_revision: 2, approval_expires_at: null });
    const tr = (await history(id)).filter((e) => e.type === "task.transition").at(-1)!;
    expect(tr.payload).toMatchObject({ from: "pending_approval", to: "in_review", reason: "draft_revised" });
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow();
    expect(store.effects).toHaveLength(0);
    const out = await withTenant(AGENT, (tx) => checkTask(tx, id, { packId: PACK }));
    expect(out.route).toBe("pending_approval");
    const again = await row(id);
    expect(again.status).toBe("pending_approval");
    expect(again.approval_expires_at!.getTime()).toBeGreaterThan(first.getTime());
    expect((await approveTask(OWNER, id, 2)).executed).toBe(true);
    expect(store.effectsFor(id)).toHaveLength(1);
  });
  it("a terminal task's draft cannot be revised", async () => {
    const { id } = await pending(T.bookingConfirm, {}, { state: "pending" });
    await approveTask(OWNER, id, 1);
    await expect(withTenant(AGENT, (tx) => reviseDraft(tx, id, { action_type: T.bookingConfirm, fields: {} }))).rejects.toBeInstanceOf(DraftNotRevisableError);
  });
});

describe("reject and expiry", () => {
  it("reject cancels the action, moves to Rejected, and audits decider and timestamp", async () => {
    const { id } = await pending(T.bookingConfirm, {}, { state: "pending" });
    const out = await rejectTask(OWNER, id, "not now");
    expect(out).toMatchObject({ decision: "rejected", executed: false });
    expect((await row(id)).status).toBe("rejected");
    expect(store.effects).toHaveLength(0);
    expect(store.cancelled).toBe(1);
    const [d] = await decisions(id);
    expect(d.payload).toMatchObject({ decision: "reject", decided_by: OWNER.actorId, reason: "not now", cancelled_actions: 1 });
    expect(d.payload.decided_at).toBeTruthy();
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow(/not awaiting approval/);
  });

  it("approval after approval_expires_at finds the task Expired and executes nothing", async () => {
    const { id } = await pending(T.bookingConfirm, {}, { state: "pending" });
    await withTenant(OWNER, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 second' where id = $1", [id]));
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(ApprovalExpiredError);
    expect((await row(id)).status).toBe("expired");
    expect(store.effects).toHaveLength(0);
  });

  it("expiring a Pending Approval task cancels its pending action through the registered canceller", async () => {
    const { id } = await pending(T.followupSendable, {}, { state: "draft" });
    await withTenant(OWNER, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 second' where id = $1", [id]));
    const expired = await withTenant(SYSTEM, (tx) => expireTaskIfOverdue(tx, id));
    expect(expired?.status).toBe("expired");
    expect(store.cancelled).toBe(1);
    const e = (await history(id)).find((x) => x.type === "task.actions_cancelled")!;
    expect(e.payload.cancelled_actions).toBe(1);
  });
});

describe("payment authority (C3)", () => {
  it("marks paid only when the deterministic rule passes and the owner approves", async () => {
    const { id, recordId } = await pending(T.paymentMarkPaid, { amount_paid: 150000 }, { state: "invoiced", amountDue: 150000, paymentState: "unpaid" });
    const out = await approveTask(OWNER, id, 1);
    expect(out.executed).toBe(true);
    expect(store.get(recordId)!.paymentState).toBe("paid");
    const [d] = await decisions(id);
    expect(d.payload.payment).toMatchObject({ rule: "passed", state: "paid" });
  });

  it("a failing rule blocks the payment change even with owner approval; the task stays pending", async () => {
    const { id, recordId } = await pending(T.paymentMarkPaid, { amount_paid: 1 }, { state: "invoiced", amountDue: 150000, paymentState: "unpaid" });
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(PaymentRuleFailedError);
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
    expect((await row(id)).status).toBe("pending_approval");
  });

  it("no non-owner actor can change payment state", async () => {
    const { id, recordId } = await pending(T.paymentMarkPaid, { amount_paid: 150000 }, { state: "invoiced", amountDue: 150000, paymentState: "unpaid" });
    await expect(approveTask(AGENT, id, 1)).rejects.toBeInstanceOf(ApprovalNotPermittedError);
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
  });

  it("registration refuses refund execution, ungated payment actions, and ambiguous handlers", () => {
    const base = { rule: () => ({ ok: true }), apply: async () => undefined };
    expect(() => registerActionHandler({ type: T.paymentRefund, gated: true, payment: { targetState: "refunded", ...base } })).toThrow(RefundNotExecutableError);
    expect(() => registerActionHandler({ type: `x.${run}`, gated: false, payment: { targetState: "paid", ...base } })).toThrow(InvalidActionHandlerError);
    expect(() => registerActionHandler({ type: `y.${run}`, gated: true })).toThrow(InvalidActionHandlerError);
    expect(getActionHandler(T.paymentRefund)).toBeNull();
  });
});
