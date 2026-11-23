import { AuthenticationError, resolveSession } from "../auth/service";
import { callerFromAuth, withTenant, type Caller } from "../dal";
import { NotFoundError } from "../dal/errors";
import { InvalidMessageError, ensureThreadsTx, listMessagesTx, listThreadsTx, type ThreadRow } from "../threads";
import { askMaestro, queryKnownAgentsTx } from "../maestro";
import { submitCommand } from "../runtime";
import { adapterForTenant, createModelGateway, type ModelGateway } from "../gateway";
import { getActivePlaybook } from "../playbook";
import { getAssistantName, getUiLanguage } from "../settings";
import { ShellForbiddenError } from "../workspace/shell";
import { formatTimestamp } from "../board/history";
import { routeChatMessage, type ChatRoute } from "./routing";
import type { Language } from "../../i18n/strings";
/**
 * Chat operations (task 9.4, design §2.6 / §2.12, R4.1–R4.5). The tenant always comes from the
 * session. Threads are the 8.1 service; an owner message is routed by `routeChatMessage` to the 8.3
 * Maestro answer or the 8.2 command runtime. The assistant's name is read live from settings on
 * every call and is never stored in the model sent to the UI beyond this response.
 */
export interface ChatThread {
  id: string;
  kind: "maestro" | "specialist";
  agent: string;
  /** Maestro: the live assistant name. Specialist: its role label. */
  displayName: string;
}
export interface ChatMessage {
  id: string;
  sender: "owner" | "agent";
  /** Agent messages: the live sender name. Owner messages: null (the UI shows its own "You"). */
  senderName: string | null;
  body: string;
  taskId: string | null;
  at: string;
}
export interface ChatModel {
  assistantName: string;
  threads: ChatThread[];
  selectedThreadId: string;
  messages: ChatMessage[];
}
export interface ChatSendResult {
  route: ChatRoute;
  threadId: string;
  /** Command route only: the task the command created or continued, and its status when the call returned. */
  task: { id: string; status: string } | null;
}
async function ownerCaller(token: unknown): Promise<Caller> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  return callerFromAuth(auth);
}
/** The chat read model: active threads (Maestro first) and the selected thread's messages. Creates missing threads (idempotent). */
export async function loadChat(token: unknown, threadId?: string | null): Promise<ChatModel> {
  const caller = await ownerCaller(token);
  return withTenant(caller, async (tx) => {
    const tz = (await getActivePlaybook(tx)).business.timezone; // a tenant with no Playbook has no chat
    await ensureThreadsTx(tx);
    const threads = (await listThreadsTx(tx)).filter((t) => t.active);
    const selected = (threadId ? threads.find((t) => t.id === threadId) : null) ?? threads[0];
    if (!selected) throw new NotFoundError("threads");
    const lang: Language = await getUiLanguage(tx);
    const messages = await listMessagesTx(tx, selected.id);
    return {
      assistantName: await getAssistantName(tx),
      threads: threads.map((t) => ({ id: t.id, kind: t.kind, agent: t.agent, displayName: t.displayName })),
      selectedThreadId: selected.id,
      messages: messages.map((m) => ({
        id: m.id,
        sender: m.sender,
        senderName: m.sender === "owner" ? null : m.senderName,
        body: m.body,
        taskId: m.taskId,
        at: formatTimestamp(m.createdAt, tz, lang),
      })),
    };
  });
}
/** Builds the gateway for a tenant's model calls. Production: the tenant's configured adapter. Tests inject another. */
export type GatewayFactory = (tenantId: string) => Promise<ModelGateway>;
export const defaultGatewayFactory: GatewayFactory = async (tenantId) => createModelGateway(await adapterForTenant(tenantId));
/**
 * The owner sends a message in a thread. The route (see routing.ts) decides: a recognized question
 * is answered by the Maestro and creates no task; anything else is a command and creates a task.
 */
export async function sendChatMessage(
  token: unknown,
  input: { threadId: unknown; body: unknown },
  gatewayFor: GatewayFactory = defaultGatewayFactory,
): Promise<ChatSendResult> {
  const caller = await ownerCaller(token);
  if (typeof input?.body !== "string" || !input.body.trim()) throw new InvalidMessageError("message body is required");
  if (typeof input.threadId !== "string") throw new NotFoundError("threads");
  const threadId = input.threadId;
  const body = input.body;
  const route = await withTenant(caller, async (tx) => {
    const thread = await tx.getById<ThreadRow>("threads", threadId); // another tenant's thread is invisible
    return routeChatMessage({ threadAgent: thread.agent, body, agents: await queryKnownAgentsTx(tx) });
  });
  if (route === "question") {
    await askMaestro(caller, { threadId, body });
    return { route, threadId, task: null };
  }
  const result = await submitCommand(caller, await gatewayFor(caller.tenantId), { threadId, body });
  return { route, threadId, task: { id: result.task.id, status: result.task.status } };
}
