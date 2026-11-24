import type { TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { getActivePlaybook, NoActivePlaybookError } from "../playbook";
/**
 * Task state machine (task 4.2, design §2.3 and amendment #1).
 *
 * This is the ONLY module allowed to change `tasks.status`. A database trigger enforces the
 * same rule: a status change is refused unless this module's transaction-local marker is set.
 * Every transition writes its audit entry on the same DAL transaction handle, so the status
 * change and its audit entry commit or roll back together. Timestamps use database time.
 */
export const TASK_STATUSES = [
  "queued",
  "working",
  "in_review",
  "pending_approval",
  "done",
  "rejected",
  "expired",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Statuses with no outgoing automatic transition. Only `failed` can leave, through the owner retry. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "rejected", "expired", "failed"];
/**
 * The transition table (design §2.3, as amended by gate ruling 6.3). Retry (failed -> queued) is deliberately NOT here:
 * it is a separate, owner-only operation (`retryTask`).
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["working"],
  working: ["in_review", "failed"],
  in_review: ["pending_approval", "done", "working", "failed"],
  // Amended by gate ruling 6.3: pending_approval -> in_review exists, but ONLY via the draft-revision
  // path (`returnToReviewOnRevision`). The general `transitionTask` refuses it.
  pending_approval: ["done", "rejected", "expired", "in_review"],
  done: [],
  rejected: [],
  expired: [],
  failed: [],
};
export const TASK_AUDIT_TYPES = {
  transition: "task.transition",
  retry: "task.retry",
} as const;
export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
/** A requested move the state machine does not allow. Nothing was changed or audited. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`illegal task transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}
/** Retry is an owner action; any other actor is refused. Nothing was changed or audited. */
export class RetryNotPermittedError extends Error {
  constructor(readonly actor: string) {
    super("only the owner can retry a failed task");
    this.name = "RetryNotPermittedError";
  }
}
export interface TaskRow {
  id: string;
  tenant_id: string;
  title: string;
  origin: string;
  agent: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  payload_revision: number;
  anomaly: string | null;
  error: string | null;
  approval_expires_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}
export interface TransitionOptions {
  /** Required when moving to `failed`: the recorded error carried by the task. */
  error?: string;
  /** Optional short note stored in the audit payload. */
  reason?: string;
}
function isStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}
/** Lock the task row for the caller's tenant. Another tenant's task is invisible (NotFoundError). */
async function lockTask(tx: TenantTx, taskId: string): Promise<TaskRow> {
  const row = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [taskId]);
  if (!row) throw new NotFoundError("tasks");
  return row;
}
/** The one place that writes `tasks.status`. Caller has already validated the move. */
async function writeStatus(
  tx: TenantTx,
  taskId: string,
  to: TaskStatus,
  error: string | null,
  expiryMinutes: number | null = null,
  clearExpiry = false,
): Promise<TaskRow> {
  await tx.query("select set_config('aruna.task_transition', 'on', true)");
  // No `finally`: if the update fails the transaction is aborted (and the setting is transaction-local), and a
  // further query here would replace the real error (for example the deactivated-tenant refusal) with
  // "current transaction is aborted".
  const rows = await tx.query<TaskRow>(
    `update tasks set status = $2, error = $3, updated_at = now(),
       approval_expires_at = case when $4::int is not null then now() + make_interval(mins => $4::int)
                                  when $5::boolean then null else approval_expires_at end
     where id = $1 returning *`,
    [taskId, to, error, expiryMinutes, clearExpiry],
  );
  await tx.query("select set_config('aruna.task_transition', '', true)");
  return rows[0];
}
/** Used when the active Playbook does not set thresholds.approvalExpiryMinutes (design: default 15). */
export const DEFAULT_APPROVAL_EXPIRY_MINUTES = 15;
/**
 * The expiry window, read from the tenant's active Playbook at the moment of entering Pending
 * Approval. A tenant with no active Playbook gets the default (a task cannot be left without a deadline).
 */
async function approvalExpiryMinutes(tx: TenantTx): Promise<number> {
  try {
    return (await getActivePlaybook(tx)).thresholds.approvalExpiryMinutes ?? DEFAULT_APPROVAL_EXPIRY_MINUTES;
  } catch (e) {
    if (e instanceof NoActivePlaybookError) return DEFAULT_APPROVAL_EXPIRY_MINUTES;
    throw e;
  }
}
/**
 * Gate ruling 6.4: In Review -> Done / Pending Approval was requested for a revision with no passing
 * deterministic `checker.result`. Nothing was changed or audited.
 */
export class UncheckedRevisionError extends Error {
  constructor(
    readonly taskId: string,
    readonly revision: number,
    readonly to: TaskStatus,
  ) {
    super(`task has no passing deterministic check for revision ${revision}; cannot move in_review -> ${to}`);
    this.name = "UncheckedRevisionError";
  }
}

/**
 * True when the task's audit history (same transaction) holds a passing checker.result for exactly
 * this revision whose deterministic stage passed (a model_review entry carries `deterministic: "pass"`).
 */
async function hasPassingCheck(tx: TenantTx, taskId: string, revision: number): Promise<boolean> {
  const rows = await tx.query<{ n: number }>(
    `select 1 as n from audit_log
      where task_id = $1 and type = 'checker.result'
        and payload->>'outcome' = 'pass'
        and (payload->>'revision')::int = $2
        and (payload->>'stage' = 'deterministic' or payload->>'deterministic' = 'pass')
      limit 1`,
    [taskId, revision],
  );
  return rows.length > 0;
}

/**
 * Move a task along the legal flow, auditing the transition (`task.transition`: from, to,
 * actor from the caller) in the same transaction. Throws IllegalTransitionError, with no
 * change and no audit entry, for any move not in TRANSITIONS.
 */
export async function transitionTask(tx: TenantTx, taskId: string, to: TaskStatus, opts: TransitionOptions = {}): Promise<TaskRow> {
  if (!isStatus(to)) throw new Error(`unknown task status: ${String(to)}`);
  const task = await lockTask(tx, taskId);
  if (!isLegalTransition(task.status, to)) throw new IllegalTransitionError(task.status, to);
  // Gate ruling 6.3: the one amended edge is reserved for the draft-revision path.
  if (task.status === "pending_approval" && to === "in_review") throw new IllegalTransitionError(task.status, to);
  // Gate ruling 6.4: leaving In Review forward needs a passing deterministic check for THIS revision.
  if (task.status === "in_review" && (to === "done" || to === "pending_approval") && !(await hasPassingCheck(tx, taskId, task.payload_revision))) {
    throw new UncheckedRevisionError(taskId, task.payload_revision, to);
  }
  let error: string | null = null;
  if (to === "failed") {
    error = opts.error?.trim() ?? "";
    if (!error) throw new Error("moving a task to failed requires a recorded error");
  }
  const expiryMinutes = to === "pending_approval" ? await approvalExpiryMinutes(tx) : null;
  const updated = await writeStatus(tx, taskId, to, error, expiryMinutes);
  await tx.audit(
    TASK_AUDIT_TYPES.transition,
    { from: task.status, to, ...(expiryMinutes !== null ? { approval_expiry_minutes: expiryMinutes } : {}), ...(error ? { error } : {}), ...(opts.reason ? { reason: opts.reason } : {}) },
    taskId,
  );
  return updated;
}
/**
 * Explicit owner retry: failed -> queued, audited as `task.retry` (with the error being
 * retried). The system never calls this on its own; any actor other than `owner` is refused.
 */
export async function retryTask(tx: TenantTx, taskId: string): Promise<TaskRow> {
  if (tx.caller.actor !== "owner") throw new RetryNotPermittedError(tx.caller.actor);
  const task = await lockTask(tx, taskId);
  if (task.status !== "failed") throw new IllegalTransitionError(task.status, "queued");
  const updated = await writeStatus(tx, taskId, "queued", null);
  await tx.audit(TASK_AUDIT_TYPES.retry, { from: "failed", to: "queued", previous_error: task.error }, taskId);
  return updated;
}

/**
 * INTERNAL (gate ruling 6.3): pending_approval -> in_review, reason `draft_revised`. Called only by
 * `reviseDraft` (approvals/service.ts), in the same transaction as the revision. Not re-exported
 * from the tasks barrel and takes no reason, so no other caller can use the edge; the general
 * `transitionTask` refuses it. Clears `approval_expires_at`.
 */
export async function returnToReviewOnRevision(tx: TenantTx, taskId: string): Promise<TaskRow> {
  const task = await lockTask(tx, taskId);
  if (task.status !== "pending_approval") throw new IllegalTransitionError(task.status, "in_review");
  const updated = await writeStatus(tx, taskId, "in_review", null, null, true);
  await tx.audit(TASK_AUDIT_TYPES.transition, { from: "pending_approval", to: "in_review", reason: "draft_revised" }, taskId);
  return updated;
}

/**
 * Stale-attempt recovery (gate ruling 4.2, amendment #14): working -> queued. Like `retryTask`, this
 * edge is deliberately NOT in TRANSITIONS: the general `transitionTask` refuses it, and only this
 * function can take it. It is callable only by the system actor, only for a task that is Working and
 * whose attempt is stale (no change for `staleAfterSeconds`, judged by DATABASE time under the row
 * lock). Each recovery is audited (`task.transition`, reason `stale_attempt_recovered`). Once a task
 * has been recovered MAX_STALE_RECOVERIES times, the next stale attempt marks it Failed instead.
 */
export const STALE_RECOVERY_REASON = "stale_attempt_recovered";
export const STALE_EXHAUSTED_REASON = "stale_attempt_exhausted";
/** Policy values: the spec names the mechanism but not the numbers (flagged in the task 8.2 report). */
export const DEFAULT_STALE_ATTEMPT_SECONDS = 300;
export const MAX_STALE_RECOVERIES = 2;

/** Only the system actor may recover a stale attempt. Nothing was changed or audited. */
export class StaleRecoveryNotPermittedError extends Error {
  constructor(readonly actor: string) {
    super("only the system can recover a stale attempt");
    this.name = "StaleRecoveryNotPermittedError";
  }
}

/** The Working task's attempt is not stale yet. Nothing was changed or audited. */
export class AttemptNotStaleError extends Error {
  constructor(readonly taskId: string) {
    super("the task's attempt is not stale");
    this.name = "AttemptNotStaleError";
  }
}

export async function recoverStaleAttempt(
  tx: TenantTx,
  taskId: string,
  opts: { staleAfterSeconds?: number } = {},
): Promise<TaskRow> {
  if (tx.caller.actor !== "system") throw new StaleRecoveryNotPermittedError(tx.caller.actor);
  const staleAfter = opts.staleAfterSeconds ?? DEFAULT_STALE_ATTEMPT_SECONDS;
  if (!Number.isFinite(staleAfter) || staleAfter < 0) throw new Error("staleAfterSeconds must be a non-negative number");
  const row = await tx.maybeOne<TaskRow & { stale: boolean }>(
    "select *, (updated_at <= clock_timestamp() - make_interval(secs => $2::float8)) as stale from tasks where id = $1 for update",
    [taskId, staleAfter],
  );
  if (!row) throw new NotFoundError("tasks");
  if (row.status !== "working") throw new IllegalTransitionError(row.status, "queued");
  if (!row.stale) throw new AttemptNotStaleError(taskId);
  const prior = (
    await tx.query<{ n: string }>(
      "select count(*) as n from audit_log where task_id = $1 and type = $2 and payload->>'reason' = $3",
      [taskId, TASK_AUDIT_TYPES.transition, STALE_RECOVERY_REASON],
    )
  )[0];
  const recoveries = Number(prior?.n ?? 0);
  if (recoveries >= MAX_STALE_RECOVERIES) {
    const error = `execution attempt went stale and the recovery bound (${MAX_STALE_RECOVERIES}) was exhausted`;
    const failed = await writeStatus(tx, taskId, "failed", error);
    await tx.audit(TASK_AUDIT_TYPES.transition, { from: "working", to: "failed", error, reason: STALE_EXHAUSTED_REASON, recoveries }, taskId);
    return failed;
  }
  const queued = await writeStatus(tx, taskId, "queued", null);
  await tx.audit(
    TASK_AUDIT_TYPES.transition,
    { from: "working", to: "queued", reason: STALE_RECOVERY_REASON, recoveries: recoveries + 1, max_recoveries: MAX_STALE_RECOVERIES },
    taskId,
  );
  return queued;
}
