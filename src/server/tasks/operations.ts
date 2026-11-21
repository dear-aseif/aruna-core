import { withCaller, withTenant, type Caller, type TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { AUDIT_TYPES, getTaskHistory, type AuditEntry } from "../audit";
import { readTask } from "./expiry";
import { TASK_STATUSES, type TaskRow, type TaskStatus } from "./state-machine";
/**
 * Task operations (task 4.4, design §2.3): create, list by status, detail with check and
 * approval history. Service-level only; HTTP routes arrive with their consumers (groups 8, 9).
 *
 * Each operation has a transaction-level form (`*Tx`, for server code that already holds a DAL
 * handle, such as the agent runtime) and a session-token form that resolves the caller with
 * `withCaller`. The tenant always comes from the caller; no operation accepts a tenant id.
 * Status is never written here: a task is inserted as Queued and only the state machine moves it.
 */
export const TASK_ORIGINS = ["routine", "maestro", "direct", "intake"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TASK_OPS_AUDIT_TYPES = { created: "task.created" } as const;
export const MAX_TITLE_LENGTH = 200;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 200;
/** The input to create a task was malformed. Nothing was written. */
export class InvalidTaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskInputError";
  }
}
export interface CreateTaskInput {
  title: string;
  origin: TaskOrigin;
  /** The responsible agent (for example "booking", "stock", "maestro"). */
  agent: string;
  /** Optional structured draft payload; defaults to an empty object. */
  payload?: Record<string, unknown>;
}
export interface ListTasksOptions {
  /** One status or several. Omitted: all statuses. */
  status?: TaskStatus | readonly TaskStatus[];
  limit?: number;
}
export interface TaskDetail {
  task: TaskRow;
  /** Every audit entry of the task, oldest first. */
  history: AuditEntry[];
  /** Checker results (`checker.result`), oldest first. Producer arrives in group 6. */
  checks: AuditEntry[];
  /** Approval decisions (`approval.decision`), oldest first. Producer arrives in group 6. */
  approvals: AuditEntry[];
}
function validateCreate(input: CreateTaskInput): { title: string; origin: TaskOrigin; agent: string; payload: Record<string, unknown> } {
  const i = input as Partial<CreateTaskInput> | null;
  if (!i || typeof i !== "object") throw new InvalidTaskInputError("task input is required");
  const title = typeof i.title === "string" ? i.title.trim() : "";
  if (!title) throw new InvalidTaskInputError("title is required");
  if (title.length > MAX_TITLE_LENGTH) throw new InvalidTaskInputError(`title is longer than ${MAX_TITLE_LENGTH} characters`);
  if (typeof i.origin !== "string" || !(TASK_ORIGINS as readonly string[]).includes(i.origin))
    throw new InvalidTaskInputError(`origin must be one of: ${TASK_ORIGINS.join(", ")}`);
  const agent = typeof i.agent === "string" ? i.agent.trim() : "";
  if (!agent) throw new InvalidTaskInputError("agent is required");
  const payload = i.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new InvalidTaskInputError("payload must be an object");
  return { title, origin: i.origin as TaskOrigin, agent, payload };
}
/** Create a task in Queued for the caller's tenant, audited in the same transaction (`task.created`). */
export async function createTaskTx(tx: TenantTx, input: CreateTaskInput): Promise<TaskRow> {
  const v = validateCreate(input);
  const task = await tx.insert<TaskRow>("tasks", {
    title: v.title,
    origin: v.origin,
    agent: v.agent,
    payload: JSON.stringify(v.payload),
    created_by: tx.caller.actorId,
  });
  await tx.audit(TASK_OPS_AUDIT_TYPES.created, { origin: v.origin, agent: v.agent, title: v.title }, task.id);
  return task;
}
/** The caller's tenant's tasks, newest first, optionally filtered by status. */
export async function listTasksTx(tx: TenantTx, opts: ListTasksOptions = {}): Promise<TaskRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  let statuses: readonly TaskStatus[] | null = null;
  if (opts.status !== undefined) {
    statuses = typeof opts.status === "string" ? [opts.status] : opts.status;
    if (statuses.some((s) => !(TASK_STATUSES as readonly string[]).includes(s))) throw new InvalidTaskInputError("unknown task status filter");
  }
  return statuses
    ? tx.query<TaskRow>("select * from tasks where status = any($1::text[]) order by created_at desc, id limit $2", [statuses, limit])
    : tx.query<TaskRow>("select * from tasks order by created_at desc, id limit $1", [limit]);
}
/** Exact task counts per status for the caller's tenant (every status present, zero when none). Added for 8.3. */
export async function countTasksByStatusTx(tx: TenantTx): Promise<Record<TaskStatus, number>> {
  const rows = await tx.query<{ status: TaskStatus; n: number }>("select status, count(*)::int as n from tasks group by status");
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

/** One task with its audit history. Another tenant's task, or an unknown id, is NotFoundError (not audited). */
export async function getTaskDetailTx(tx: TenantTx, taskId: string): Promise<TaskDetail> {
  if (typeof taskId !== "string" || !UUID.test(taskId)) throw new NotFoundError("tasks");
  const task = await tx.getById<TaskRow>("tasks", taskId);
  return detailFor(tx, task);
}
async function detailFor(tx: TenantTx, task: TaskRow): Promise<TaskDetail> {
  const history = await getTaskHistory(tx, task.id);
  return {
    task,
    history,
    checks: history.filter((e) => e.type === AUDIT_TYPES.checkerResult),
    approvals: history.filter((e) => e.type === AUDIT_TYPES.approvalDecision),
  };
}
export const createTask = (token: unknown, input: CreateTaskInput): Promise<TaskRow> => withCaller(token, (tx) => createTaskTx(tx, input));
export const listTasks = (token: unknown, opts: ListTasksOptions = {}): Promise<TaskRow[]> => withCaller(token, (tx) => listTasksTx(tx, opts));
/**
 * Detail for the authenticated caller. A Pending Approval task past its deadline is first
 * expired by the lazy check (task 4.3), so the detail reflects it.
 */
export async function getTaskDetail(token: unknown, taskId: string): Promise<TaskDetail> {
  const caller: Caller = await withCaller(token, async (tx) => tx.caller);
  return getTaskDetailForCaller(caller, taskId);
}
export async function getTaskDetailForCaller(caller: Caller, taskId: string): Promise<TaskDetail> {
  if (typeof taskId !== "string" || !UUID.test(taskId)) throw new NotFoundError("tasks");
  const task = await readTask(caller, taskId);
  return withTenant(caller, (tx) => detailFor(tx, task));
}
