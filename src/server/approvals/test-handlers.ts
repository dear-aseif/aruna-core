import { registerActionHandler, unregisterActionHandler, type ActionContext, type PaymentState } from "./actions";

/**
 * TEST handlers for the approval gate (task 6.3). They operate on synthetic in-memory test
 * records, not on real pack tables; the real booking, goods-receipt and follow-up handlers land
 * with groups 12 and 13. Nothing here is registered unless `registerTestApprovalHandlers` is called.
 *
 * Draft fields used (synthetic):
 *   booking:   { record_id }                       confirms a pending booking record
 *   receipt:   { record_id, qty }                  records a goods receipt
 *   follow-up: { record_id }                       marks a follow-up draft sendable (in-app only)
 *   payment:   { record_id, amount_due, amount_paid }  marks an invoice paid when amounts match
 *   refund:    { record_id }                       exists only to show registration is refused
 */
export const TEST_ACTION_TYPES = {
  bookingConfirm: "test.booking.confirm",
  receiptRecord: "test.goods_receipt.record",
  followupSendable: "test.followup.mark_sendable",
  paymentMarkPaid: "test.payment.mark_paid",
  paymentRefund: "test.payment.refund",
} as const;

export interface TestRecord {
  state: string;
  qty?: number;
  amountDue?: number;
  paymentState?: PaymentState | "unpaid";
}

/** Synthetic records plus a log of every effect, so tests can count executions. */
export class TestRecordStore {
  readonly records = new Map<string, TestRecord>();
  readonly effects: { type: string; recordId: string; taskId: string; revision: number }[] = [];
  /** Test hook: make the next handler run throw after it has applied its effect. */
  failNextAfterEffect = false;
  cancelled = 0;
  put(id: string, rec: TestRecord): void {
    this.records.set(id, { ...rec });
  }
  get(id: string): TestRecord | undefined {
    return this.records.get(id);
  }
  effectsFor(taskId: string) {
    return this.effects.filter((e) => e.taskId === taskId);
  }
}

function recordId(ctx: ActionContext): string {
  const id = ctx.fields.record_id;
  if (typeof id !== "string" || !id) throw new Error("draft has no record_id");
  return id;
}

export function registerTestApprovalHandlers(store: TestRecordStore): void {
  const apply = (ctx: ActionContext, mutate: (rec: TestRecord) => void) => {
    const id = recordId(ctx);
    const rec = store.get(id);
    if (!rec) throw new Error(`test record not found: ${id}`);
    mutate(rec);
    store.effects.push({ type: ctx.actionType, recordId: id, taskId: ctx.task.id, revision: ctx.revision });
    if (store.failNextAfterEffect) {
      store.failNextAfterEffect = false;
      throw new Error("injected failure after effect");
    }
    return { recordId: id };
  };
  const cancel = async () => {
    store.cancelled++;
    return 1;
  };
  registerActionHandler({
    type: TEST_ACTION_TYPES.bookingConfirm,
    gated: true,
    execute: async (ctx) => apply(ctx, (r) => (r.state = "confirmed")),
    cancel,
  });
  registerActionHandler({
    type: TEST_ACTION_TYPES.receiptRecord,
    gated: true,
    execute: async (ctx) => {
      const qty = ctx.fields.qty;
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) throw new Error("draft has no valid qty");
      return apply(ctx, (r) => {
        r.state = "received";
        r.qty = (r.qty ?? 0) + qty;
      });
    },
    cancel,
  });
  registerActionHandler({
    type: TEST_ACTION_TYPES.followupSendable,
    gated: true,
    execute: async (ctx) => apply(ctx, (r) => (r.state = "sendable")),
    cancel,
  });
  registerActionHandler({
    type: TEST_ACTION_TYPES.paymentMarkPaid,
    gated: true,
    payment: {
      targetState: "paid",
      // Deterministic rule: the checked amount paid must equal the invoice's recorded amount due.
      rule: (ctx) => {
        const rec = store.get(recordId(ctx));
        if (!rec || typeof rec.amountDue !== "number") return { ok: false, reason: "no invoice record" };
        return ctx.fields.amount_paid === rec.amountDue ? { ok: true } : { ok: false, reason: `amount paid does not equal amount due (${rec.amountDue})` };
      },
      apply: async (ctx, state) => {
        apply(ctx, (r) => (r.paymentState = state));
      },
    },
    cancel,
  });
}

export function unregisterTestApprovalHandlers(): void {
  for (const t of Object.values(TEST_ACTION_TYPES)) unregisterActionHandler(t);
}
