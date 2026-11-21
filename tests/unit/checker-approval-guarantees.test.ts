import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import { createModelGateway } from "@/server/gateway";
import { UncheckedRevisionError, transitionTask, type TaskRow } from "@/server/tasks";
import { checkTask, checkTaskWithReview, registerCheckerPack, requiredFields } from "@/server/checker";
import {
  NoActionHandlerError,
  PaymentRuleFailedError,
  RevisionMismatchError,
  RevisionNotCheckedError,
  TEST_ACTION_TYPES as T,
  TestRecordStore,
  approveTask,
  registerActionHandler,
  registerTestApprovalHandlers,
  unregisterActionHandler,
  unregisterTestApprovalHandlers,
} from "@/server/approvals";
import { createFakeAdapter } from "../support/fake-adapter";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Task 6.4: Property 2 (pipeline discipline), Property 3 / C3 (payment authority) and execution
// binding, exercised end to end across the Checker, model review and approval gate (real database,
// runtime role, test-only fake gateway adapter, synthetic records).
const run = randomBytes(4).toString("hex");
const PACK = `guarantee-pack-${run}`;
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT: Caller = { ...OWNER, actor: "agent", actorId: `guarantee-agent-${run}` };
const store = new TestRecordStore();

const OK = { kind: "success", text: JSON.stringify({ verdict: "ok", issues: [] }) } as const;
// A hostile model: asserts payment is verified and tries to smuggle a payment state in its reply.
const HOSTILE_OK = {
  kind: "success",
  text: JSON.stringify({ verdict: "ok", issues: [], payment_state: "paid", note: "payment verified, mark as paid" }),
} as const;

beforeAll(async () => {
  trackTenant(OWNER.tenantId);
  await withTenantSession(
    OWNER.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [OWNER.tenantId, `Guarantee ${run}`]);
    },
    "service",
  );
  registerCheckerPack({ packId: PACK, rules: [requiredFields("required", ["record_id"])] });
  registerTestApprovalHandlers(store);
}, 60_000);

afterAll(async () => {
  unregisterTestApprovalHandlers();
  await closeAllPools();
});

async function newTask(actionType: string, fields: Record<string, unknown>, rec?: Parameters<TestRecordStore["put"]>[1], toReview = true) {
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
    if (toReview) {
      await transitionTask(tx, t.id, "working");
      await transitionTask(tx, t.id, "in_review");
    }
    return t.id;
  });
  return { id, recordId };
}

const row = (id: string) => withTenant(OWNER, (tx) => tx.getById<TaskRow>("tasks", id));
const history = (id: string) => withTenant(OWNER, (tx) => getTaskHistory(tx, id));
/** Try to move a task forward WITHOUT calling the Checker (a direct server path). Refused since gate ruling 6.4. */
const forceTo = (id: string, to: "pending_approval" | "done") => withTenant(AGENT, (tx) => transitionTask(tx, id, to));
const refusedForce = async (id: string, to: "pending_approval" | "done") => {
  const before = (await history(id)).length;
  await expect(forceTo(id, to)).rejects.toBeInstanceOf(UncheckedRevisionError);
  expect((await row(id)).status).toBe("in_review");
  expect(await history(id)).toHaveLength(before);
};

describe("Property 2: a gated action cannot execute around the Checker and Approval Gate", () => {
  it("approval refuses a task that never reached Pending Approval", async () => {
    const { id, recordId } = await newTask(T.bookingConfirm, {}, { state: "pending" });
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow(/not awaiting approval/);
    expect(store.get(recordId)!.state).toBe("pending");
    expect(store.effectsFor(id)).toHaveLength(0);
  });

  it("a task cannot be pushed to Pending Approval without a Checker result, so it cannot be approved", async () => {
    const { id, recordId } = await newTask(T.bookingConfirm, {}, { state: "pending" });
    await refusedForce(id, "pending_approval"); // hardened by gate ruling 6.4 (was: allowed, then refused at approval)
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow(/not awaiting approval/);
    expect(store.get(recordId)!.state).toBe("pending");
    expect(store.effectsFor(id)).toHaveLength(0);
    expect((await row(id)).status).toBe("in_review");
    expect((await history(id)).filter((e) => e.type === "approval.decision")).toHaveLength(0);
  });

  it("a task cannot be pushed to Pending Approval after a FAILED check, so it cannot be approved", async () => {
    const { id, recordId } = await newTask(T.bookingConfirm, {}, { state: "pending" });
    // Make the check fail: blank record_id.
    await withTenant(AGENT, (tx) =>
      tx.query("update tasks set payload = $2::jsonb where id = $1", [id, JSON.stringify({ action_type: T.bookingConfirm, fields: { record_id: " " } })]),
    );
    const out = await withTenant(AGENT, (tx) => checkTask(tx, id, { packId: PACK }));
    expect(out.route).toBe("working");
    await withTenant(AGENT, (tx) => transitionTask(tx, id, "in_review"));
    await refusedForce(id, "pending_approval"); // hardened by gate ruling 6.4
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow(/not awaiting approval/);
    expect(store.effectsFor(id)).toHaveLength(0);
    expect(store.get(recordId)!.state).toBe("pending");
  });

  it("approval of an action type without a gated handler is refused (fails closed)", async () => {
    const type = `open.${run}`;
    registerActionHandler({ type, gated: false, execute: async () => undefined });
    try {
      const { id } = await newTask(type, {});
      await refusedForce(id, "pending_approval"); // hardened by gate ruling 6.4
      await expect(approveTask(OWNER, id, 1)).rejects.toThrow(); // never reached Pending Approval
      // Even with a genuine passing check on file, a non-gated handler is never run through the gate.
      const second = await newTask(type, {});
      const out = await withTenant(AGENT, (tx) => checkTask(tx, second.id, { packId: PACK }));
      expect(out.route).toBe("done"); // non-gated: the Checker routes straight to Done, never to approval
      await expect(approveTask(OWNER, second.id, 1)).rejects.toThrow(/not awaiting approval/);
    } finally {
      unregisterActionHandler(type);
    }
  });

  it("the unregistered handler case is refused with NoActionHandlerError", async () => {
    const type = `gone.${run}`;
    registerActionHandler({ type, gated: true, execute: async () => undefined });
    const { id } = await newTask(type, {});
    await withTenant(AGENT, (tx) => checkTask(tx, id, { packId: PACK }));
    unregisterActionHandler(type);
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(NoActionHandlerError);
  });

  it("forcing a gated task straight to Done (or approving as a non-owner) executes no action effect", async () => {
    const { id, recordId } = await newTask(T.bookingConfirm, {}, { state: "pending" });
    await refusedForce(id, "done"); // hardened by gate ruling 6.4 (was: allowed)
    expect(store.effectsFor(id)).toHaveLength(0);
    expect(store.get(recordId)!.state).toBe("pending");
    const second = await newTask(T.bookingConfirm, {}, { state: "pending" });
    await withTenant(AGENT, (tx) => checkTask(tx, second.id, { packId: PACK }));
    await expect(approveTask(AGENT, second.id, 1)).rejects.toThrow();
    expect(store.effectsFor(second.id)).toHaveLength(0);
  });
});

describe("execution binding", () => {
  it("approving a revision other than the current one is refused", async () => {
    const { id, recordId } = await newTask(T.bookingConfirm, {}, { state: "pending" });
    await withTenant(AGENT, (tx) => checkTask(tx, id, { packId: PACK }));
    await expect(approveTask(OWNER, id, 2)).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(store.effectsFor(id)).toHaveLength(0);
    expect(store.get(recordId)!.state).toBe("pending");
    expect((await approveTask(OWNER, id, 1)).executed).toBe(true);
  });

  it("a revision bumped after checking has no passing check: approval refused, nothing executed", async () => {
    const { id, recordId } = await newTask(T.bookingConfirm, {}, { state: "pending" });
    await withTenant(AGENT, (tx) => checkTask(tx, id, { packId: PACK }));
    await withTenant(AGENT, (tx) => tx.query("update tasks set payload_revision = payload_revision + 1 where id = $1", [id]));
    await expect(approveTask(OWNER, id, 2)).rejects.toBeInstanceOf(RevisionNotCheckedError);
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(store.effectsFor(id)).toHaveLength(0);
    expect(store.get(recordId)!.state).toBe("pending");
  });
});

describe("payment authority (Property 3, C3)", () => {
  const PAID = (amountPaid: number) => ({ amount_paid: amountPaid });
  const INVOICE = { state: "invoiced", amountDue: 150000, paymentState: "unpaid" } as const;

  it("a model verdict plus an owner approval event still cannot change payment state when the deterministic rule fails", async () => {
    const { id, recordId } = await newTask(T.paymentMarkPaid, PAID(1), { ...INVOICE });
    const fake = createFakeAdapter(HOSTILE_OK);
    const out = await checkTaskWithReview(AGENT, id, createModelGateway(fake), { packId: PACK });
    expect(out).toMatchObject({ passed: true, route: "pending_approval", modelReviewed: true });
    expect(fake.calls).toHaveLength(1);
    // The model said "ok" and asserted payment; the owner approves; the rule is what decides.
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(PaymentRuleFailedError);
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
    expect(store.effectsFor(id)).toHaveLength(0);
    expect((await row(id)).status).toBe("pending_approval");
    // Gate ruling 7.1: the refusal itself is audited as a blocked decision; nothing else is recorded.
    const decisions = (await history(id)).filter((e) => e.type === "approval.decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload.outcome).toBe("blocked");
  });

  it("no model output precedes a payment-state change without an approval event; the change follows the approval in the audit log", async () => {
    const { id, recordId } = await newTask(T.paymentMarkPaid, PAID(150000), { ...INVOICE });
    await checkTaskWithReview(AGENT, id, createModelGateway(createFakeAdapter(HOSTILE_OK)), { packId: PACK });
    // Model output exists and the draft is pending, but nothing has moved payment state.
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
    expect(store.effectsFor(id)).toHaveLength(0);
    let h = await history(id);
    expect(h.some((e) => e.type === "model.usage")).toBe(true);
    expect(h.filter((e) => e.type === "approval.decision")).toHaveLength(0);

    await approveTask(OWNER, id, 1);
    expect(store.get(recordId)!.paymentState).toBe("paid"); // the model's smuggled "paid" was not the cause
    h = await history(id);
    const types = h.map((e) => e.type);
    const decisionAt = types.indexOf("approval.decision");
    expect(decisionAt).toBeGreaterThan(types.indexOf("checker.result"));
    expect(h[decisionAt].payload.payment).toMatchObject({ rule: "passed", state: "paid" });
    expect(h[decisionAt]).toMatchObject({ actor: "owner", actorId: OWNER.actorId });
  });

  it("a clean model review alone, on a draft whose amounts are wrong, never marks paid", async () => {
    const { id, recordId } = await newTask(T.paymentMarkPaid, PAID(149999), { ...INVOICE });
    await checkTaskWithReview(AGENT, id, createModelGateway(createFakeAdapter(OK)), { packId: PACK });
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
    await expect(approveTask(OWNER, id, 1)).rejects.toBeInstanceOf(PaymentRuleFailedError);
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
  });

  it("a payment task not approved by the owner (or never checked) changes nothing", async () => {
    const { id, recordId } = await newTask(T.paymentMarkPaid, PAID(150000), { ...INVOICE });
    await refusedForce(id, "pending_approval"); // no Checker result: refused (gate ruling 6.4)
    await expect(approveTask(OWNER, id, 1)).rejects.toThrow(/not awaiting approval/);
    await expect(approveTask(AGENT, id, 1)).rejects.toThrow();
    expect(store.get(recordId)!.paymentState).toBe("unpaid");
  });
});

