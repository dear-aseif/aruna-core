import { withTenant, type Caller, type TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { AUDIT_TYPES, getTaskHistory, recordApprovalDecision } from "../audit";
import { NotAwaitingApprovalError, registerExpiryActionCanceller, transitionTask, withApprovalAction, type TaskRow } from "../tasks";
import { returnToReviewOnRevision } from "../tasks/state-machine";
import { readPath } from "../checker/rules";
import { getActionHandler, NoActionHandlerError, type ActionContext, type ActionHandler } from "./actions";

/**
 * Approval gate (task 6.3, design §2.5, amendments #7 and #8).
 *
 * approve / reject are explicit owner actions. Approval executes exactly the revision that passed
 * the Checker, inside one transaction under the task's row lock (via `withApprovalAction`, which
 * also applies the database-time deadline check): status check, deadline check, revision binding,
 * action execution, transition to Done, and the `approval.decision` audit entry commit together
 * or not at all. A second approval finds the task Done and returns the recorded result without
 * executing again.
 */
export const APPROVAL_AUDIT_TYPES = {
  draftRevised: "task.draft_revised",
  approvalVoided: "approval.voided",
} as const;

/** Only the owner may approve or reject. Nothing was changed or audited. */
export class ApprovalNotPermittedError extends Error {
  constructor(readonly actor: string) {
    super("only the owner can approve or reject");
    this.name = "ApprovalNotPermittedError";
  }
}

/** The revision the owner approved is not the task's current revision. Nothing was executed. */
export class RevisionMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly current: number,
  ) {
    super(`the draft changed: approval was for revision ${expected}, current revision is ${current}`);
    this.name = "RevisionMismatchError";
  }
}

/** The current revision has no passing Checker result (it changed after checking). Nothing was executed. */
export class RevisionNotCheckedError extends Error {
  constructor(
    readonly revision: number,
    readonly checkedRevision: number | null,
  ) {
    super(
      checkedRevision === null
        ? `revision ${revision} has no passing Checker result`
        : `revision ${revision} was not the revision that passed the Checker (last passing check: revision ${checkedRevision})`,
    );
    this.name = "RevisionNotCheckedError";
  }
}

/** The payment rule refused. Nothing was executed. */
export class PaymentRuleFailedError extends Error {
  constructor(readonly reason: string) {
    super(`payment rule refused: ${reason}`);
    this.name = "PaymentRuleFailedError";
  }
}

/** The draft cannot be revised in its current status (terminal). */
export class DraftNotRevisableError extends Error {
  constructor(readonly status: string) {
    super(`a ${status} task's draft can no longer be changed`);
    this.name = "DraftNotRevisableError";
  }
}

export interface ApprovalResult {
  taskId: string;
  decision: "approved" | "rejected";
  revision: number;
  /** False when this call found the task already approved and executed nothing (idempotent replay). */
  executed: boolean;
  /** What the handler returned, when it executed. */
  result?: Record<string, unknown>;
  task: TaskRow;
}

function requireOwner(caller: Caller): void {
  if (caller.actor !== "owner") throw new ApprovalNotPermittedError(caller.actor);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The last Checker result of the task, by audit order. */
async function lastCheck(tx: TenantTx, taskId: string): Promise<{ outcome: unknown; revision: number | null; route: unknown } | null> {
  const history = await getTaskHistory(tx, taskId);
  const checks = history.filter((e) => e.type === AUDIT_TYPES.checkerResult);
  const last = checks[checks.length - 1];
  if (!last) return null;
  return { outcome: last.payload.outcome, revision: typeof last.payload.revision === "number" ? last.payload.revision : null, route: last.payload.route };
}

async function decidedAt(tx: TenantTx): Promise<string> {
  const r = await tx.maybeOne<{ t: Date }>("select clock_timestamp() as t");
  return r!.t.toISOString();
}

async function runHandler(handler: ActionHandler, ctx: ActionContext): Promise<{ result?: Record<string, unknown>; payment?: Record<string, unknown> }> {
  if (handler.payment) {
    const verdict = await handler.payment.rule(ctx);
    if (!verdict || verdict.ok !== true) throw new PaymentRuleFailedError(verdict?.reason ?? "the deterministic rule did not pass");
    await handler.payment.apply(ctx, handler.payment.targetState);
    return { payment: { rule: "passed", state: handler.payment.targetState } };
  }
  const out = await handler.execute!(ctx);
  return { result: out ?? undefined };
}

/**
 * Approve a Pending Approval task. `expectedRevision` is the revision the owner was shown; it must
 * equal the task's current revision AND the revision of the latest passing Checker result.
 */
export async function approveTask(caller: Caller, taskId: string, expectedRevision: number): Promise<ApprovalResult> {
  requireOwner(caller);
  try {
    return await withApprovalAction(caller, taskId, async (tx, task) => {
      if (task.payload_revision !== expectedRevision) throw new RevisionMismatchError(expectedRevision, task.payload_revision);
      const check = await lastCheck(tx, task.id);
      if (!check || check.outcome !== "pass" || check.route !== "pending_approval" || check.revision !== task.payload_revision)
        throw new RevisionNotCheckedError(task.payload_revision, check && check.outcome === "pass" ? check.revision : null);

      const actionType = readPath(task.payload, "action_type");
      const handler = getActionHandler(actionType);
      if (!handler) throw new NoActionHandlerError(actionType);
      if (!handler.gated) throw new NoActionHandlerError(actionType); // fail closed: only gated actions pass this gate
      const rawFields = readPath(task.payload, "fields");
      const ctx: ActionContext = {
        tx,
        task,
        actionType: handler.type,
        revision: task.payload_revision,
        fields: isRecord(rawFields) ? rawFields : {},
        decidedBy: tx.caller.actorId,
      };
      const outcome = await runHandler(handler, ctx);
      const done = await transitionTask(tx, task.id, "done", { reason: "owner_approved" });
      await recordApprovalDecision(tx, task.id, {
        decision: "approve",
        revision: task.payload_revision,
        action_type: handler.type,
        decided_by: tx.caller.actorId,
        decided_at: await decidedAt(tx),
        ...(outcome.payment ? { payment: outcome.payment } : {}),
      });
      return { taskId: task.id, decision: "approved" as const, revision: task.payload_revision, executed: true, result: outcome.result, task: done };
    });
  } catch (e) {
    if (e instanceof NotAwaitingApprovalError && e.status === "done") {
      const replay = await withTenant(caller, async (tx) => {
        const history = await getTaskHistory(tx, taskId);
        const prior = history.find((h) => h.type === AUDIT_TYPES.approvalDecision && h.payload.decision === "approve" && h.payload.outcome !== "blocked");
        if (!prior) return null;
        const task = await tx.getById<TaskRow>("tasks", taskId);
        return { taskId, decision: "approved" as const, revision: Number(prior.payload.revision), executed: false, task } satisfies ApprovalResult;
      });
      if (replay) return replay;
    }
    if (e instanceof PaymentRuleFailedError) {
      // Gate ruling 7.1: the refusal rolled back with the execution transaction; record it in its
      // own short transaction under the task's tenant (same pattern as the DAL cross-tenant refusal).
      await withTenant(caller, async (tx) => {
        const task = await tx.maybeOne<TaskRow>("select * from tasks where id = $1", [taskId]);
        await recordApprovalDecision(
          tx,
          taskId,
          {
            decision: "approve",
            outcome: "blocked",
            reason: e.reason,
            revision: task?.payload_revision ?? expectedRevision,
            action_type: task ? (readPath(task.payload, "action_type") ?? null) : null,
            decided_by: tx.caller.actorId,
            decided_at: await decidedAt(tx),
          },
        );
      });
    }
    throw e;
  }
}

/** Reject a Pending Approval task. Cancels the pending action; nothing executes. */
export async function rejectTask(caller: Caller, taskId: string, reason?: string): Promise<ApprovalResult> {
  requireOwner(caller);
  return withApprovalAction(caller, taskId, async (tx, task) => {
    const handler = getActionHandler(readPath(task.payload, "action_type"));
    const cancelled = handler?.cancel ? ((await handler.cancel(tx, task)) ?? 0) : 0;
    const rejected = await transitionTask(tx, task.id, "rejected", { reason: "owner_rejected" });
    await recordApprovalDecision(tx, task.id, {
      decision: "reject",
      revision: task.payload_revision,
      action_type: readPath(task.payload, "action_type") ?? null,
      decided_by: tx.caller.actorId,
      decided_at: await decidedAt(tx),
      cancelled_actions: cancelled,
      ...(reason ? { reason } : {}),
    });
    return { taskId: task.id, decision: "rejected" as const, revision: task.payload_revision, executed: false, task: rejected };
  });
}

/**
 * Change a task's draft. The revision increments, so the previous Checker result no longer matches
 * the current revision and any pending approval is voided (recorded as `approval.voided`).
 * The revised draft must pass the Checker again; a Pending Approval task returns to In Review (gate ruling 6.3). A task already in a terminal status is refused.
 */
export async function reviseDraft(tx: TenantTx, taskId: string, payload: Record<string, unknown>): Promise<TaskRow> {
  if (!isRecord(payload)) throw new Error("payload must be an object");
  const task = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [taskId]);
  if (!task) throw new NotFoundError("tasks");
  if (["done", "rejected", "expired", "failed"].includes(task.status)) throw new DraftNotRevisableError(task.status);
  const rows = await tx.query<TaskRow>(
    "update tasks set payload = $2::jsonb, payload_revision = payload_revision + 1, anomaly = null, updated_at = now() where id = $1 returning *",
    [taskId, JSON.stringify(payload)],
  );
  const updated = rows[0];
  await tx.audit(APPROVAL_AUDIT_TYPES.draftRevised, { from_revision: task.payload_revision, to_revision: updated.payload_revision, status: task.status }, taskId);
  if (task.status === "pending_approval")
    await tx.audit(APPROVAL_AUDIT_TYPES.approvalVoided, { revision: task.payload_revision, reason: "draft_changed", requires: "new_checker_pass" }, taskId);
  // Gate ruling 6.3: a Pending Approval task returns to In Review in this same transaction. The
  // revision bump already voids the Checker result; this clears the deadline and the status.
  if (task.status === "pending_approval") return returnToReviewOnRevision(tx, taskId);
  return updated;
}

/** Expiry canceller (task 4.3 integration point): expiring a Pending Approval task cancels its pending action. */
export async function approvalExpiryCanceller(tx: TenantTx, task: TaskRow): Promise<number> {
  const handler = getActionHandler(readPath(task.payload, "action_type"));
  return handler?.cancel ? ((await handler.cancel(tx, task)) ?? 0) : 0;
}

/** Idempotent. Called at module load; callable again after `clearExpiryActionCancellers()`. */
export function registerApprovalExpiryCanceller(): void {
  registerExpiryActionCanceller(approvalExpiryCanceller);
}
registerApprovalExpiryCanceller();
