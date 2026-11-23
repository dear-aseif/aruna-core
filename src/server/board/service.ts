import "../approvals"; // registers the expiry canceller, so lazy expiry on a board read cancels pending actions
import { AuthenticationError, resolveSession } from "../auth/service";
import { callerFromAuth, withTenant, type Caller, type TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { NoActivePlaybookError, getActivePlaybook } from "../playbook";
import { getEntriesForTasks } from "../audit";
import { CARD_HISTORY_TYPES, formatTimestamp, groupCardHistory, toTrailEntry, type ApprovalItem, type CheckItem, type TrailEntry } from "./history";
import { getUiLanguage } from "../settings";
import {
  ApprovalExpiredError,
  NotAwaitingApprovalError,
  TASK_STATUSES,
  getTaskDetailForCaller,
  countTasksByStatusTx,
  listTasksTx,
  readTask,
  transitionTask,
  type TaskRow,
  type TaskStatus,
} from "../tasks";
import {
  ApprovalNotPermittedError,
  DraftNotRevisableError,
  NoActionHandlerError,
  PaymentRuleFailedError,
  RevisionMismatchError,
  RevisionNotCheckedError,
  approveTask,
  rejectTask,
  reviseDraft,
} from "../approvals";
import { NoCheckerRulesError, checkTaskWithReview } from "../checker";
import { GatewayError } from "../gateway";
import { resolveReviseCheckDeps, type ReviseCheckDeps } from "./check-deps";
import { ShellForbiddenError } from "../workspace/shell";
import type { Language } from "../../i18n/strings";

/**
 * Task board operations (task 9.2, design §2.12, R3.1/R3.2). The board reads tasks only through the
 * task 4.4 operations (`listTasksTx`, `countTasksByStatusTx`) after the lazy expiry check (4.3) has
 * run on every Pending Approval task, so an overdue task is read as Expired, never as awaiting
 * approval. Approve and reject call the group 6 approval service unchanged; revising a Pending
 * Approval draft calls `reviseDraft`. The tenant always comes from the session.
 */

/** Pipeline order, left to right. */
export const BOARD_STATUSES: readonly TaskStatus[] = TASK_STATUSES;
export const BOARD_PAGE_LIMIT = 100;

export type DraftValue = string | number | boolean;

export interface BoardTask {
  id: string;
  title: string;
  agent: string;
  /** Where the task came from: routine, maestro, direct or intake. */
  origin: string;
  status: TaskStatus;
  /** The payload revision the owner is shown; approval binds to it. */
  revision: number;
  createdAt: string;
  /** Pending Approval only: the decision deadline as a clock time in the business timezone. */
  deadline: string | null;
  /** Pending Approval only: what approving would do, from the checked draft. */
  draft: { actionType: string | null; fields: Record<string, DraftValue> } | null;
  error: string | null;
  /** Checker results, oldest first. */
  checks: CheckItem[];
  /** Owner approval and rejection decisions, oldest first. */
  approvals: ApprovalItem[];
}

export interface BoardModel {
  statuses: TaskStatus[];
  counts: Record<TaskStatus, number>;
  columns: Record<TaskStatus, BoardTask[]>;
}

export class InvalidBoardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBoardInputError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function scalarFields(v: unknown): Record<string, DraftValue> {
  const out: Record<string, DraftValue> = {};
  if (!isRecord(v)) return out;
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
  return out;
}

export function formatDeadline(at: Date, timeZone: string, lang: Language): string {
  try {
    return new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/** Pure: one row to the board's card shape. */
export function toBoardTask(row: TaskRow, timeZone: string, lang: Language, history: { checks: CheckItem[]; approvals: ApprovalItem[] } = { checks: [], approvals: [] }): BoardTask {
  const pending = row.status === "pending_approval";
  const payload = isRecord(row.payload) ? row.payload : {};
  return {
    id: row.id,
    title: row.title,
    agent: row.agent,
    origin: row.origin,
    status: row.status,
    revision: row.payload_revision,
    createdAt: new Date(row.created_at).toISOString(),
    deadline: pending && row.approval_expires_at ? formatDeadline(new Date(row.approval_expires_at), timeZone, lang) : null,
    draft: pending ? { actionType: typeof payload.action_type === "string" ? payload.action_type : null, fields: scalarFields(payload.fields) } : null,
    error: row.error,
    checks: history.checks,
    approvals: history.approvals,
  };
}

/** Pure: group cards by status, in pipeline order. */
export function buildBoardModel(
  rows: readonly TaskRow[],
  counts: Record<TaskStatus, number>,
  timeZone: string,
  lang: Language,
  history: ReadonlyMap<string, { checks: CheckItem[]; approvals: ApprovalItem[] }> = new Map(),
): BoardModel {
  const columns = Object.fromEntries(BOARD_STATUSES.map((s) => [s, [] as BoardTask[]])) as Record<TaskStatus, BoardTask[]>;
  for (const r of rows) columns[r.status].push(toBoardTask(r, timeZone, lang, history.get(r.id)));
  return { statuses: [...BOARD_STATUSES], counts, columns };
}

export async function ownerCaller(token: unknown): Promise<Caller> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  return callerFromAuth(auth);
}

function taskIdOrNotFound(taskId: unknown): string {
  if (typeof taskId !== "string" || !UUID.test(taskId)) throw new NotFoundError("tasks");
  return taskId;
}

/** Lazy expiry (4.3) on every Pending Approval task of the caller's tenant. Returns how many were checked. */
async function expireOverdue(caller: Caller): Promise<void> {
  const pending = await withTenant(caller, (tx) => listTasksTx(tx, { status: "pending_approval", limit: BOARD_PAGE_LIMIT }));
  for (const t of pending) await readTask(caller, t.id);
}

async function readColumns(tx: TenantTx): Promise<{ rows: TaskRow[]; counts: Record<TaskStatus, number>; overdue: boolean; timeZone: string; lang: Language; history: ReturnType<typeof groupCardHistory> }> {
  const rows: TaskRow[] = [];
  for (const s of BOARD_STATUSES) rows.push(...(await listTasksTx(tx, { status: s, limit: BOARD_PAGE_LIMIT })));
  const counts = await countTasksByStatusTx(tx);
  const now = (await tx.maybeOne<{ t: Date }>("select clock_timestamp() as t"))!.t;
  const overdue = rows.some((r) => r.status === "pending_approval" && r.approval_expires_at !== null && new Date(r.approval_expires_at) <= now);
  const timeZone = (await getActivePlaybook(tx)).business.timezone;
  const lang = await getUiLanguage(tx);
  const entries = await getEntriesForTasks(tx, rows.map((r) => r.id), CARD_HISTORY_TYPES);
  return { rows, counts, overdue, timeZone, lang, history: groupCardHistory(entries, timeZone, lang) };
}

/** The board for the caller's tenant. An overdue Pending Approval task is expired before it is listed. */
export async function loadBoardForCaller(caller: Caller): Promise<BoardModel> {
  await expireOverdue(caller);
  let read = await withTenant(caller, readColumns);
  if (read.overdue) {
    // A deadline passed between the expiry pass and the read: expire again so the board never shows it as pending.
    await expireOverdue(caller);
    read = await withTenant(caller, readColumns);
  }
  return buildBoardModel(read.rows, read.counts, read.timeZone, read.lang, read.history);
}

export async function loadBoard(token: unknown): Promise<BoardModel> {
  return loadBoardForCaller(await ownerCaller(token));
}

export interface TaskDetailModel {
  task: BoardTask;
  /** The checked draft fields (scalars), in every status. */
  fields: Record<string, DraftValue>;
  actionType: string | null;
  /** Creation time in the business timezone. */
  created: string;
  timeZone: string;
  /** The full audit trail of the task, oldest first. Read only. */
  trail: TrailEntry[];
}
/**
 * One task with its complete audit trail for the session's tenant (task 9.3, R3.3). Reads through the
 * task 4.4 detail operation (lazy expiry first). Another tenant's task, or an unknown id, is
 * NotFoundError. Times are shown in the Playbook timezone.
 */
export async function loadTaskDetail(token: unknown, taskId: unknown): Promise<TaskDetailModel> {
  const caller = await ownerCaller(token);
  const id = taskIdOrNotFound(taskId);
  const detail = await getTaskDetailForCaller(caller, id);
  const { timeZone, lang } = await withTenant(caller, async (tx) => ({ timeZone: (await getActivePlaybook(tx)).business.timezone, lang: await getUiLanguage(tx) }));
  const grouped = groupCardHistory([...detail.checks, ...detail.approvals], timeZone, lang).get(detail.task.id) ?? { checks: [], approvals: [] };
  const payload = isRecord(detail.task.payload) ? detail.task.payload : {};
  return {
    task: toBoardTask(detail.task, timeZone, lang, grouped),
    fields: scalarFields(payload.fields),
    actionType: typeof payload.action_type === "string" ? payload.action_type : null,
    created: formatTimestamp(new Date(detail.task.created_at), timeZone, lang),
    timeZone,
    trail: detail.history.map((e) => toTrailEntry(e, timeZone, lang)),
  };
}
export interface BoardDecision {
  taskId: string;
  decision: "approved" | "rejected";
  /** False when the task had already been approved and nothing ran again. */
  executed: boolean;
  status: TaskStatus;
}

/** Owner approval of the revision the owner saw, through the approval gate. */
export async function approveFromBoard(token: unknown, taskId: unknown, revision: unknown): Promise<BoardDecision> {
  const caller = await ownerCaller(token);
  const id = taskIdOrNotFound(taskId);
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) throw new InvalidBoardInputError("revision must be a positive integer");
  const r = await approveTask(caller, id, revision);
  return { taskId: r.taskId, decision: r.decision, executed: r.executed, status: r.task.status };
}

export async function rejectFromBoard(token: unknown, taskId: unknown, reason?: unknown): Promise<BoardDecision> {
  const caller = await ownerCaller(token);
  const id = taskIdOrNotFound(taskId);
  if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 500)) throw new InvalidBoardInputError("reason must be short text");
  const r = await rejectTask(caller, id, typeof reason === "string" && reason.trim() ? reason.trim() : undefined);
  return { taskId: r.taskId, decision: r.decision, executed: r.executed, status: r.task.status };
}

/**
 * Change the draft fields of a Pending Approval task through `reviseDraft`. Only existing scalar
 * fields can change and the action type is kept; the revision increments, the approval is voided,
 * the task returns to In Review, and the Checker then runs on it in the same request: it ends in
 * Pending Approval at the new revision (checks pass) or in Working with the anomaly (checks fail).
 */
export async function reviseFromBoard(
  token: unknown,
  taskId: unknown,
  fields: unknown,
  deps?: ReviseCheckDeps,
): Promise<{ taskId: string; status: TaskStatus; revision: number; anomaly: string | null; error: string | null }> {
  const caller = await ownerCaller(token);
  const id = taskIdOrNotFound(taskId);
  if (!isRecord(fields) || Object.keys(fields).length === 0) throw new InvalidBoardInputError("fields must be a non-empty object");
  const current = await readTask(caller, id); // lazy expiry first
  if (current.status === "expired") throw new ApprovalExpiredError(id);
  if (current.status !== "pending_approval") throw new NotAwaitingApprovalError(id, current.status);
  const revised = await withTenant(caller, async (tx) => {
    const row = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [id]);
    if (!row) throw new NotFoundError("tasks");
    const existing = scalarFields(isRecord(row.payload) ? row.payload.fields : null);
    const next: Record<string, DraftValue> = { ...existing };
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in existing)) throw new InvalidBoardInputError(`unknown draft field: ${k}`);
      if (typeof v !== typeof existing[k]) throw new InvalidBoardInputError(`draft field ${k} must stay a ${typeof existing[k]}`);
      if (typeof v === "number" && !Number.isFinite(v)) throw new InvalidBoardInputError(`draft field ${k} must be a finite number`);
      next[k] = v as DraftValue;
    }
    const base = isRecord(row.payload) ? row.payload : {};
    return reviseDraft(tx, id, { ...base, fields: { ...(isRecord(base.fields) ? base.fields : {}), ...next } });
  });
  // The revised draft is In Review and nothing else would advance it: run the Checker (deterministic
  // first, then model review) on the same task in this request so it routes onward at once.
  const { gateway, check } = await resolveReviseCheckDeps(caller.tenantId, deps);
  let routed: TaskRow;
  try {
    routed = (await checkTaskWithReview(caller, revised.id, gateway, check)).task;
  } catch (e) {
    if (e instanceof NoCheckerRulesError) {
      // Nothing was checked, and a draft never passes unchecked: fail visibly rather than strand it In Review.
      routed = await withTenant(caller, async (tx) => {
        const t = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [revised.id]);
        if (!t) throw new NotFoundError("tasks");
        if (t.status !== "in_review") return t;
        return transitionTask(tx, revised.id, "failed", { error: `Checker unavailable: ${e.message}`, reason: "checker_unavailable" });
      });
    } else if (e instanceof GatewayError) {
      routed = await readTask(caller, revised.id); // the gateway has already failed the task, audited
    } else {
      throw e;
    }
  }
  return { taskId: routed.id, status: routed.status, revision: routed.payload_revision, anomaly: routed.anomaly, error: routed.error };
}

/** Map a board operation failure to an HTTP status and a stable code (shared by the thin route handlers). */
export function describeBoardError(e: unknown): { status: number; code: string } | null {
  if (e instanceof AuthenticationError) return { status: 401, code: "unauthenticated" };
  if (e instanceof ShellForbiddenError || e instanceof ApprovalNotPermittedError) return { status: 403, code: "forbidden" };
  if (e instanceof NoActivePlaybookError) return { status: 409, code: "no_active_playbook" };
  if (e instanceof NotFoundError) return { status: 404, code: "not_found" };
  if (e instanceof InvalidBoardInputError) return { status: 400, code: "invalid_input" };
  if (e instanceof ApprovalExpiredError) return { status: 409, code: "expired" };
  if (e instanceof NotAwaitingApprovalError || e instanceof DraftNotRevisableError) return { status: 409, code: "not_awaiting" };
  if (e instanceof RevisionMismatchError || e instanceof RevisionNotCheckedError) return { status: 409, code: "revision_changed" };
  if (e instanceof NoActionHandlerError || e instanceof PaymentRuleFailedError) return { status: 409, code: "cannot_approve" };
  return null;
}
