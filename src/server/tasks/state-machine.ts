import type { TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
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
 * The transition table (design §2.3). Retry (failed -> queued) is deliberately NOT here:
 * it is a separate, owner-only operation (`retryTask`).
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["working"],
  working: ["in_review", "failed"],
  in_review: ["pending_approval", "done", "working", "failed"],
  pending_approval: ["done", "rejected", "expired"],
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
async function writeStatus(tx: TenantTx, taskId: string, to: TaskStatus, error: string | null): Promise<TaskRow> {
  await tx.query("select set_config('aruna.task_transition', 'on', true)");
  try {
    const rows = await tx.query<TaskRow>(
      "update tasks set status = $2, error = $3, updated_at = now() where id = $1 returning *",
      [taskId, to, error],
    );
    return rows[0];
  } finally {
    await tx.query("select set_config('aruna.task_transition', '', true)");
  }
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
  let error: string | null = null;
  if (to === "failed") {
    error = opts.error?.trim() ?? "";
    if (!error) throw new Error("moving a task to failed requires a recorded error");
  }
  const updated = await writeStatus(tx, taskId, to, error);
  await tx.audit(
    TASK_AUDIT_TYPES.transition,
    { from: task.status, to, ...(error ? { error } : {}), ...(opts.reason ? { reason: opts.reason } : {}) },
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
