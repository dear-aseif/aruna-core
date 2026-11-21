import { withCaller, withTenant, type Caller, type TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { MAESTRO_AGENT } from "../agents";
import { listTasksTx, readTask } from "../tasks";
import { MAX_MESSAGE_LENGTH, postMessageTx, type MessageRow, type ThreadRow } from "../threads";
import {
  NOT_FOUND_TASK,
  classifyQuestion,
  renderAgentActivity,
  renderPendingApprovals,
  renderRecentActivity,
  renderStatusCounts,
  renderUnknownAgent,
  renderUnsupported,
  type Intent,
} from "./answers";
import {
  queryAgentActivityTx,
  queryKnownAgentsTx,
  queryPendingApprovalsTx,
  queryRecentActivityTx,
  queryStatusCountsTx,
  queryTaskDetailTx,
} from "./queries";
import { STATUS_LABELS } from "./answers";

/**
 * Maestro live-data answers (task 8.3, design §2.6, R4.3).
 *
 * A status question in the Maestro thread is answered by typed server query functions over the
 * caller's live tasks and audit entries (queries.ts). The reply text is a template over those
 * results (answers.ts); no model is involved, so no number, name or status can be invented or
 * altered (amendment #11). A question the query functions cannot answer gets a bounded reply
 * that says what the Maestro can answer.
 *
 * Before reading, overdue Pending Approval tasks are expired through the task 4.3 lazy check, so
 * an expired task is reported Expired on the very next question. Everything runs through the DAL
 * for the caller's tenant: another tenant's data is simply not visible.
 */
export class QuestionNotPermittedError extends Error {
  constructor(readonly actor: string) {
    super("only the owner can ask the Maestro");
    this.name = "QuestionNotPermittedError";
  }
}

/** The thread given is not the Maestro thread of this tenant. Nothing was written. */
export class NotMaestroThreadError extends Error {
  constructor() {
    super("live-data answers are given in the Maestro thread");
    this.name = "NotMaestroThreadError";
  }
}

export interface MaestroAnswer {
  intent: Intent["kind"];
  /** The reply text, composed only from query results. */
  text: string;
}

export interface AskResult extends MaestroAnswer {
  threadId: string;
  questionMessageId: string;
  answerMessageId: string;
}

/** Expire overdue Pending Approval tasks first (task 4.3 lazy check), so answers reflect them. */
async function applyLazyExpiry(caller: Caller): Promise<void> {
  const pending = await withTenant(caller, (tx) => listTasksTx(tx, { status: "pending_approval", limit: 200 }));
  for (const t of pending) await readTask(caller, t.id);
}

/** Compose the answer to one question on an open DAL transaction. Writes nothing. */
export async function composeAnswerTx(tx: TenantTx, question: string): Promise<MaestroAnswer> {
  const agents = await queryKnownAgentsTx(tx);
  const intent = classifyQuestion(question, agents);
  switch (intent.kind) {
    case "task_status": {
      const detail = await queryTaskDetailTx(tx, intent.taskId);
      if (!detail) return { intent: intent.kind, text: NOT_FOUND_TASK };
      const last = detail.history[detail.history.length - 1];
      const t = detail.task;
      const expiry = t.status === "pending_approval" && t.approval_expires_at ? `; approval expires at ${t.approval_expires_at.toISOString()}` : "";
      const lastText = last ? `; last activity: ${last.type} by ${last.actor} (${last.actorId}) at ${last.createdAt.toISOString()}` : "";
      return { intent: intent.kind, text: `"${t.title}" (${t.agent}): ${STATUS_LABELS[t.status]}${expiry}${lastText}.` };
    }
    case "pending_approvals":
      return { intent: intent.kind, text: renderPendingApprovals(await queryPendingApprovalsTx(tx)) };
    case "status_counts":
      return { intent: intent.kind, text: renderStatusCounts(await queryStatusCountsTx(tx), intent.status) };
    case "agent_activity":
      return { intent: intent.kind, text: renderAgentActivity(await queryAgentActivityTx(tx, intent.agent)) };
    case "recent_activity":
      return { intent: intent.kind, text: renderRecentActivity(await queryRecentActivityTx(tx)) };
    case "unknown_agent":
      return { intent: intent.kind, text: renderUnknownAgent(intent.name, agents) };
    default:
      return { intent: "unsupported", text: renderUnsupported(agents) };
  }
}

/** Keep a reply inside the message limit by dropping whole trailing lines, never by cutting a fact. */
function fitMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const note = "\n(The list was shortened to fit.)";
  const lines = text.split("\n");
  while (lines.length > 1 && lines.join("\n").length + note.length > MAX_MESSAGE_LENGTH) lines.pop();
  return lines.join("\n") + note;
}

/**
 * The owner asks the Maestro a question in the Maestro thread. The question and the answer are
 * both recorded as messages of that thread (one transaction); the answer comes from live data.
 * A question is not a command: it creates no task.
 */
export async function askMaestro(caller: Caller, input: { threadId: string; body: string }): Promise<AskResult> {
  if (caller.actor !== "owner") throw new QuestionNotPermittedError(caller.actor);
  await applyLazyExpiry(caller);
  return withTenant(caller, async (tx) => {
    if (typeof input?.threadId !== "string") throw new NotFoundError("threads");
    const thread = await tx.getById<ThreadRow>("threads", input.threadId); // another tenant's thread is invisible
    if (thread.kind !== "maestro" || thread.agent !== MAESTRO_AGENT) throw new NotMaestroThreadError();
    const question: MessageRow = await postMessageTx(tx, { threadId: thread.id, sender: "owner", body: input.body });
    const answer = await composeAnswerTx(tx, question.body);
    const reply = await postMessageTx(tx, { threadId: thread.id, sender: "agent", body: fitMessage(answer.text) });
    return { ...answer, threadId: thread.id, questionMessageId: question.id, answerMessageId: reply.id };
  });
}

/** Session-token form of `askMaestro`. */
export async function askMaestroWithToken(token: unknown, input: { threadId: string; body: string }): Promise<AskResult> {
  const caller: Caller = await withCaller(token, async (tx) => tx.caller);
  return askMaestro(caller, input);
}
