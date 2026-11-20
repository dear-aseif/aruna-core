import { withTenant, type Caller, type TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { listActiveTenantIds } from "../db";
import { transitionTask, type TaskRow } from "./state-machine";
/**
 * Approval expiry (task 4.3, design §2.3). Overdue Pending Approval tasks become Expired,
 * through the task state machine, audited as the system actor. Two triggers share one routine:
 *  - the sweep (`sweepExpiredApprovals`, per minute under system cron, deployment in group 14);
 *  - the lazy check (`readTask`, `withApprovalAction`) on read of, or action on, a task.
 * "Overdue" is judged by DATABASE time (clock_timestamp()): at or after approval_expires_at.
 * The row is locked (`for update`) before the check, so an approval and an expiry acting at
 * the same moment serialize and exactly one outcome wins.
 */
export const EXPIRY_AUDIT_TYPES = { actionsCancelled: "task.actions_cancelled" } as const;
export const SWEEP_ACTOR_ID = "expiry-sweep";
export const LAZY_ACTOR_ID = "expiry-lazy-check";
const systemCaller = (tenantId: string, actorId: string): Caller => ({ tenantId, actor: "system", actorId });
/** The approval deadline passed and the owner tried to act on the task. Nothing was executed. */
export class ApprovalExpiredError extends Error {
  constructor(readonly taskId: string) {
    super("the approval window has expired");
    this.name = "ApprovalExpiredError";
  }
}
/** The task is not awaiting approval (already decided, or never reached it). Nothing was executed. */
export class NotAwaitingApprovalError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: string,
  ) {
    super(`task is not awaiting approval (status: ${status})`);
    this.name = "NotAwaitingApprovalError";
  }
}
/**
 * INTEGRATION POINT for group 6. A pending action (booking, purchase order, follow-up, ...) must
 * not execute once its task has expired. Action records do not exist yet; when they arrive, each
 * action module registers a canceller here. Cancellers run on the SAME transaction as the
 * Pending Approval -> Expired transition, so cancellation and expiry commit or roll back together.
 */
export type ExpiryActionCanceller = (tx: TenantTx, task: TaskRow) => Promise<number | void>;
const cancellers: ExpiryActionCanceller[] = [];
export function registerExpiryActionCanceller(fn: ExpiryActionCanceller): void {
  if (!cancellers.includes(fn)) cancellers.push(fn); // idempotent: the same canceller never runs twice
}
export function clearExpiryActionCancellers(): void {
  cancellers.length = 0;
}
async function cancelPendingActions(tx: TenantTx, task: TaskRow): Promise<void> {
  let cancelled = 0;
  for (const fn of cancellers) cancelled += (await fn(tx, task)) ?? 0;
  await tx.audit(EXPIRY_AUDIT_TYPES.actionsCancelled, { reason: "approval_expired", cancelled_actions: cancelled }, task.id);
}
/**
 * Expire one task if, and only if, it is Pending Approval and its deadline has been reached.
 * Locks the row first; returns the expired task, or null when nothing needed doing (not pending,
 * not yet due, or already decided by someone else).
 */
export async function expireTaskIfOverdue(tx: TenantTx, taskId: string): Promise<TaskRow | null> {
  const row = await tx.maybeOne<{ status: string; overdue: boolean }>(
    `select status, (approval_expires_at is not null and approval_expires_at <= clock_timestamp()) as overdue
       from tasks where id = $1 for update`,
    [taskId],
  );
  if (!row) throw new NotFoundError("tasks");
  if (row.status !== "pending_approval" || !row.overdue) return null;
  const expired = await transitionTask(tx, taskId, "expired", { reason: "approval_deadline_passed" });
  await cancelPendingActions(tx, expired);
  return expired;
}
export interface SweepResult {
  tenants: number;
  expired: number;
  /** Per-task failures; one failing task or tenant never stops the sweep. */
  errors: { tenantId: string; taskId?: string; message: string }[];
}
/**
 * The expiry sweep. Service-role routine: tenants are enumerated through the narrow bootstrap
 * lookup (ids only), then each tenant is worked inside its own tenant session (RLS applies; no
 * BYPASSRLS). Each task expires in its own transaction.
 */
export async function sweepExpiredApprovals(): Promise<SweepResult> {
  const result: SweepResult = { tenants: 0, expired: 0, errors: [] };
  for (const tenantId of await listActiveTenantIds()) {
    result.tenants++;
    const caller = systemCaller(tenantId, SWEEP_ACTOR_ID);
    let ids: string[];
    try {
      ids = await withTenant(
        caller,
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              "select id from tasks where status = 'pending_approval' and approval_expires_at <= clock_timestamp() order by approval_expires_at",
            )
          ).map((r) => r.id),
        "service",
      );
    } catch (e) {
      result.errors.push({ tenantId, message: (e as Error).message });
      continue;
    }
    for (const taskId of ids) {
      try {
        if (await withTenant(caller, (tx) => expireTaskIfOverdue(tx, taskId), "service")) result.expired++;
      } catch (e) {
        result.errors.push({ tenantId, taskId, message: (e as Error).message });
      }
    }
  }
  return result;
}
/** Lazy check, in its own system-actor transaction so the Expired transition commits whatever the caller does next. */
async function lazyExpire(caller: Caller, taskId: string): Promise<void> {
  await withTenant(systemCaller(caller.tenantId, LAZY_ACTOR_ID), (tx) => expireTaskIfOverdue(tx, taskId));
}
/** Read a task. A Pending Approval task past its deadline is first moved to Expired (audited); the read reflects that. */
export async function readTask(caller: Caller, taskId: string): Promise<TaskRow> {
  await lazyExpire(caller, taskId);
  return withTenant(caller, (tx) => tx.getById<TaskRow>("tasks", taskId));
}
/**
 * Run an owner action (approve/reject) on a task. First the lazy check expires an overdue task.
 * Then, in the caller's transaction, the row is locked and re-checked against database time, so a
 * sweep that lands in between cannot be overridden: an expired or overdue task throws
 * ApprovalExpiredError, a task that is not Pending Approval throws NotAwaitingApprovalError, and
 * `work` runs (holding the row lock) only for a task still within its window.
 */
export async function withApprovalAction<T>(caller: Caller, taskId: string, work: (tx: TenantTx, task: TaskRow) => Promise<T>): Promise<T> {
  await lazyExpire(caller, taskId);
  return withTenant(caller, async (tx) => {
    const row = await tx.maybeOne<TaskRow & { overdue: boolean }>(
      "select *, (approval_expires_at is not null and approval_expires_at <= clock_timestamp()) as overdue from tasks where id = $1 for update",
      [taskId],
    );
    if (!row) throw new NotFoundError("tasks");
    if (row.status === "expired" || (row.status === "pending_approval" && row.overdue)) throw new ApprovalExpiredError(taskId);
    if (row.status !== "pending_approval") throw new NotAwaitingApprovalError(taskId, row.status);
    return work(tx, row);
  });
}
