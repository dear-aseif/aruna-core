import type { TenantTx } from "../dal";
import { getActionType, registerActionType, unregisterActionType } from "../checker/registry";
import type { TaskRow } from "../tasks";

/**
 * Approval-action interface (task 6.3, design §2.5).
 *
 * An action handler is the code that runs when the owner approves a gated draft. The action
 * registry declares per action type whether it is gated (the declaration itself lives in the
 * Checker's action-type registry, which routes a passing draft to Pending Approval or Done);
 * this module adds the handler. Real pack handlers register here in groups 12 and 13.
 *
 * Payment authority (C3, R5.5): a handler that changes payment state does NOT write it itself.
 * It declares a `payment` spec: a deterministic rule plus an `apply` function. The approval gate
 * calls `apply` only after (a) the rule passed on the checked revision's fields and (b) the
 * caller is the owner giving an explicit approval in the same transaction. No model output
 * reaches either step, and a refund target is refused at registration: no refund execution path.
 */
export const PAYMENT_STATES = ["paid", "settled", "refunded"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export interface ActionContext {
  /** The caller's transaction. Holds the task row lock. */
  tx: TenantTx;
  /** The task row as locked in this transaction. */
  task: TaskRow;
  actionType: string;
  /** The checked, immutable revision being executed. */
  revision: number;
  /** `payload.fields` of that revision. */
  fields: Record<string, unknown>;
  /** Stable id of the owner who approved. */
  decidedBy: string;
}

export interface PaymentRuleResult {
  ok: boolean;
  /** Why the rule refused (recorded in the audit entry and the error). */
  reason?: string;
}

export interface PaymentSpec {
  /** The payment state this action moves a record to. `refunded` can never be registered. */
  targetState: PaymentState;
  /** Deterministic rule over the checked fields and records. Pure code; never a model. */
  rule: (ctx: ActionContext) => Promise<PaymentRuleResult> | PaymentRuleResult;
  /** Writes the new payment state. Called only after the rule passed and the owner approved. */
  apply: (ctx: ActionContext, state: PaymentState) => Promise<void>;
}

export interface ActionHandler {
  type: string;
  /** Gated actions run only after the Checker and an explicit owner approval. */
  gated: boolean;
  /** Runs the checked revision inside the approval transaction. Mutually exclusive with `payment`. */
  execute?: (ctx: ActionContext) => Promise<Record<string, unknown> | void>;
  /** Payment-adjacent actions (C3). Mutually exclusive with `execute`. Must be gated. */
  payment?: PaymentSpec;
  /**
   * Cancels this action's pending effect when its task is rejected or expires. Runs in the same
   * transaction as the transition. Returns the number of cancelled actions (default 0).
   */
  cancel?: (tx: TenantTx, task: TaskRow) => Promise<number | void>;
}

/** Registration broke a rule (bad shape, duplicate, refund target, ungated payment...). */
export class InvalidActionHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidActionHandlerError";
  }
}

/** A refund (or any payment spec targeting `refunded`) is never executable by the system. */
export class RefundNotExecutableError extends InvalidActionHandlerError {
  constructor(type: string) {
    super(`action "${type}" targets refunded: refunds are always the owner's own decision and are never executed by the system`);
    this.name = "RefundNotExecutableError";
  }
}

/** The draft's action type has no registered handler. Nothing was executed. */
export class NoActionHandlerError extends Error {
  constructor(readonly actionType: unknown) {
    super(typeof actionType === "string" ? `no approval handler registered for action type: ${actionType}` : "the draft has no action type");
    this.name = "NoActionHandlerError";
  }
}

const handlers = new Map<string, ActionHandler>();

export function registerActionHandler(def: ActionHandler): void {
  if (!def || typeof def.type !== "string" || !def.type) throw new InvalidActionHandlerError("action type is required");
  if (handlers.has(def.type)) throw new InvalidActionHandlerError(`action handler already registered: ${def.type}`);
  if (!!def.execute === !!def.payment) throw new InvalidActionHandlerError(`action "${def.type}" needs exactly one of execute or payment`);
  if (def.payment) {
    if (!(PAYMENT_STATES as readonly string[]).includes(def.payment.targetState))
      throw new InvalidActionHandlerError(`action "${def.type}" has an unknown payment state`);
    if (def.payment.targetState === "refunded") throw new RefundNotExecutableError(def.type);
    if (!def.gated) throw new InvalidActionHandlerError(`payment-adjacent action "${def.type}" must be gated`);
    if (typeof def.payment.rule !== "function" || typeof def.payment.apply !== "function")
      throw new InvalidActionHandlerError(`payment-adjacent action "${def.type}" needs a deterministic rule and an apply function`);
  }
  const declared = getActionType(def.type);
  if (declared && declared.gated !== def.gated) throw new InvalidActionHandlerError(`action type "${def.type}" is already declared with gated=${declared.gated}`);
  if (!declared) registerActionType({ type: def.type, gated: def.gated });
  handlers.set(def.type, def);
}

export function getActionHandler(type: unknown): ActionHandler | null {
  return typeof type === "string" ? (handlers.get(type) ?? null) : null;
}

/** Test support: remove a handler and its action-type declaration. */
export function unregisterActionHandler(type: string): void {
  if (handlers.delete(type)) unregisterActionType(type);
}
