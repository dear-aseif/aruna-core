import { z } from "zod";
import { withCaller, withTenant, type Caller } from "../dal";
import { NotFoundError } from "../dal/errors";
import { recordAgentAction } from "../audit";
import { GatewayError, type ModelGateway } from "../gateway";
import { reviseDraft } from "../approvals";
import { NoCheckerRulesError, checkTaskWithReview, type CheckOptions, type ReviewedCheckOutcome } from "../checker";
import { createTaskTx, MAX_TITLE_LENGTH, transitionTask, type TaskRow, type TaskOrigin } from "../tasks";
import { InvalidMessageError, MAX_MESSAGE_LENGTH, postMessageTx, type MessageRow, type ThreadRow } from "../threads";
import { OUTPUT_CONTRACT, getAgentExecutor } from "./executors";
/**
 * Agent runtime (task 8.2, design §2.3 Executor / §2.6 Commands, R4.2, amendment #14).
 *
 * `submitCommand`: a command in ANY thread creates a task through the task 4.4 operation and is
 * audited (`command.received`). The thread of origin only sets the origin (maestro | direct); the
 * pipeline is the same. Then `executeTask` runs in the same request:
 *   Queued -> Working (attempt audited) -> Model Gateway call associated with the task, output
 *   schema-validated -> draft attached through `reviseDraft` (revision increments) -> Working ->
 *   In Review -> `checkTaskWithReview`, which routes the task (Pending Approval, Done, Working, Failed).
 * A failed or malformed call fails the task with the error visible (the gateway does this, 5.3);
 * no draft is ever fabricated. Model calls run outside any database transaction.
 * The task's work is attributed to the agent actor (stable id = the agent's id); the command and
 * the owner message are attributed to the owner.
 */
export const COMMAND_AUDIT_TYPE = "command.received";
/** The binding payload shape (gate ruling 6.1). Strict: anything else is a malformed output. */
export const draftSchema = z
  .object({
    action_type: z.string().trim().min(1).max(100),
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;
/** Only the owner issues commands. Nothing was written. */
export class CommandNotPermittedError extends Error {
  constructor(readonly actor: string) {
    super("only the owner can issue a command");
    this.name = "CommandNotPermittedError";
  }
}
/** The task is not Queued, so no new attempt can start. Nothing was changed. */
export class NotQueuedError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: string,
  ) {
    super(`an attempt starts only from Queued (status: ${status})`);
    this.name = "NotQueuedError";
  }
}
export interface ExecutionResult {
  taskId: string;
  /** The task's status when this call returned. */
  status: TaskRow["status"];
  /** True when the model produced a valid draft that was attached. */
  draftAttached: boolean;
  /** Present when the Checker ran. */
  check?: ReviewedCheckOutcome;
  /** Present when the task ended Failed. */
  error?: string;
  /** True when a newer attempt took over while this one was running; this call wrote nothing. */
  superseded?: boolean;
  task: TaskRow;
}
export interface CommandResult {
  threadId: string;
  messageId: string;
  task: TaskRow;
  execution: ExecutionResult;
}
const agentCaller = (tenantId: string, agent: string): Caller => ({ tenantId, actor: "agent", actorId: agent });
const readTaskRow = (caller: Caller, taskId: string) => withTenant(caller, (tx) => tx.getById<TaskRow>("tasks", taskId));
function commandTitle(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_TITLE_LENGTH ? flat : `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}
/** Move an open (Working / In Review) task to Failed with a visible error. No-op if it is already settled. */
async function failIfOpen(caller: Caller, taskId: string, error: string, reason: string): Promise<void> {
  await withTenant(caller, async (tx) => {
    const t = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [taskId]);
    if (t && (t.status === "working" || t.status === "in_review")) await transitionTask(tx, taskId, "failed", { error, reason });
  });
}
/**
 * Create a task from an owner command in the given thread and run it. The task, the owner's
 * message (linked to the task) and the `command.received` audit entry commit together.
 */
export async function submitCommand(
  caller: Caller,
  gateway: ModelGateway,
  input: { threadId: string; body: string },
  opts: CheckOptions = {},
): Promise<CommandResult> {
  if (caller.actor !== "owner") throw new CommandNotPermittedError(caller.actor);
  const created = await withTenant(caller, async (tx) => {
    const body = typeof input?.body === "string" ? input.body.trim() : "";
    if (!body) throw new InvalidMessageError("message body is required");
    if (body.length > MAX_MESSAGE_LENGTH) throw new InvalidMessageError(`message is longer than ${MAX_MESSAGE_LENGTH} characters`);
    if (typeof input.threadId !== "string") throw new NotFoundError("threads");
    const thread = await tx.getById<ThreadRow>("threads", input.threadId); // another tenant's thread is invisible
    const origin: TaskOrigin = thread.kind === "maestro" ? "maestro" : "direct";
    const task = await createTaskTx(tx, { title: commandTitle(body), origin, agent: thread.agent });
    const message: MessageRow = await postMessageTx(tx, { threadId: thread.id, sender: "owner", body, taskId: task.id });
    await tx.audit(COMMAND_AUDIT_TYPE, { thread_id: thread.id, thread_agent: thread.agent, origin, message_id: message.id, command: body }, task.id);
    return { task, messageId: message.id, threadId: thread.id };
  });
  const execution = await executeTask(caller.tenantId, gateway, created.task.id, opts);
  return { threadId: created.threadId, messageId: created.messageId, task: execution.task, execution };
}
/** Session-token form of `submitCommand`. */
export async function sendCommand(token: unknown, gateway: ModelGateway, input: { threadId: string; body: string }, opts: CheckOptions = {}): Promise<CommandResult> {
  const caller: Caller = await withCaller(token, async (tx) => tx.caller);
  return submitCommand(caller, gateway, input, opts);
}
/**
 * Run one attempt for a Queued task. Server-trusted: the tenant comes from the caller's session
 * or the server routine, and the work is attributed to the task's agent. Also the entry point
 * for a task that stale-attempt recovery returned to Queued.
 */
export async function executeTask(tenantId: string, gateway: ModelGateway, taskId: string, opts: CheckOptions = {}): Promise<ExecutionResult> {
  // Read the agent under a system caller first, so the attempt itself is attributed to the agent.
  const probe = await readTaskRow({ tenantId, actor: "system", actorId: "agent-runtime" }, taskId);
  const caller = agentCaller(tenantId, probe.agent);
  const executor = getAgentExecutor(probe.agent);
  // Attempt start: Queued -> Working, audited with the attempt record.
  const started = await withTenant(caller, async (tx) => {
    const task = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [taskId]);
    if (!task) throw new NotFoundError("tasks");
    if (task.status !== "queued") throw new NotQueuedError(taskId, task.status);
    const working = await transitionTask(tx, taskId, "working", { reason: "attempt_started" });
    await recordAgentAction(tx, taskId, "attempt_started", { agent: task.agent, has_executor: executor !== null });
    if (!executor) {
      const error = `no executor is registered for agent "${task.agent}"`;
      const failed = await transitionTask(tx, taskId, "failed", { error, reason: "no_executor" });
      await recordAgentAction(tx, taskId, "attempt_failed", { error });
      return { failed };
    }
    const cmd = await tx.maybeOne<{ body: string }>("select body from messages where task_id = $1 and sender = 'owner' order by seq limit 1", [taskId]);
    return { working, command: cmd?.body ?? task.title, title: task.title };
  });
  if ("failed" in started && started.failed) {
    return { taskId, status: "failed", draftAttached: false, error: started.failed.error ?? undefined, task: started.failed };
  }
  const { working, command, title } = started as { working: TaskRow; command: string; title: string };
  const failed = async (error: string, reason: string, draftAttached = false): Promise<ExecutionResult> => {
    await failIfOpen(caller, taskId, error, reason);
    const task = await readTaskRow(caller, taskId);
    return { taskId, status: task.status, draftAttached, error: task.error ?? error, task };
  };
  // The model call: outside any transaction, associated with the task (5.3 accounting applies).
  let draft: Draft;
  try {
    const result = await gateway.complete({
      tenantId,
      taskId,
      system: `${executor!.system}\n${OUTPUT_CONTRACT}`,
      messages: [{ role: "user", content: JSON.stringify({ task_title: title, command }) }],
      responseSchema: draftSchema,
    });
    draft = draftSchema.parse(result.parsed); // never trust the seam: re-validate before attaching
  } catch (e) {
    // A GatewayError has already failed the task (5.3). Anything else must not leave it Working.
    const message = e instanceof GatewayError ? `Model call failed (${e.kind}): ${e.message}` : `Draft rejected: ${(e as Error).message}`;
    return failed(message, e instanceof GatewayError ? "model_call_failed" : "draft_invalid");
  }
  // Attach the draft through the draft-revision path and hand it to review, in one transaction.
  const attached = await withTenant(caller, async (tx) => {
    const task = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [taskId]);
    if (!task) throw new NotFoundError("tasks");
    // A newer attempt (after stale recovery) owns the task now: write nothing.
    if (task.status !== "working" || task.updated_at.getTime() !== working.updated_at.getTime()) return null;
    const revised = await reviseDraft(tx, taskId, { action_type: draft.action_type, fields: draft.fields });
    await transitionTask(tx, taskId, "in_review", { reason: "draft_attached" });
    await recordAgentAction(tx, taskId, "draft_attached", { action_type: draft.action_type, revision: revised.payload_revision });
    return revised.payload_revision;
  });
  if (attached === null) {
    const task = await readTaskRow(caller, taskId);
    return { taskId, status: task.status, draftAttached: false, superseded: true, task };
  }
  // The full pipeline: the Checker (deterministic first, then model review) routes the task.
  try {
    const check = await checkTaskWithReview(caller, taskId, gateway, opts);
    return { taskId, status: check.task.status, draftAttached: true, check, error: check.task.error ?? undefined, task: check.task };
  } catch (e) {
    if (e instanceof GatewayError) {
      const task = await readTaskRow(caller, taskId);
      return { taskId, status: task.status, draftAttached: true, error: task.error ?? e.message, task };
    }
    if (e instanceof NoCheckerRulesError) return failed(`Checker unavailable: ${e.message}`, "checker_unavailable", true);
    throw e;
  }
}
