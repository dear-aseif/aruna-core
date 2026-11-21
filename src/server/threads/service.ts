import { withCaller, type TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { MAESTRO_AGENT, getSpecialist, listSpecialistsForPack } from "../agents";
import { getAssistantName } from "../settings";

/**
 * Threads and messages (task 8.1, design §2.6). Service-level only; HTTP routes arrive with the
 * chat UI (9.4) and the agent runtime (8.2) is what turns a message into a task.
 *
 * Every operation has a transaction form (`*Tx`) and, for the owner-facing reads and the owner's
 * own message, a session-token form. The tenant always comes from the caller.
 *
 * The assistant display name is resolved live from settings by every read in this module (through
 * getAssistantName) and is never written to a thread or message row.
 */
export const THREAD_AUDIT_TYPES = { created: "thread.created" } as const;
export const MAX_MESSAGE_LENGTH = 4000;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageError";
  }
}

export interface ThreadRow {
  id: string;
  tenant_id: string;
  kind: "maestro" | "specialist";
  agent: string;
  title: string | null;
  created_at: Date;
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  thread_id: string;
  sender: "owner" | "agent";
  body: string;
  task_id: string | null;
  seq: string;
  created_at: Date;
}

/** Read model: a thread as the owner sees it. `displayName` is resolved live; it is not a column. */
export interface ThreadView {
  id: string;
  kind: ThreadRow["kind"];
  agent: string;
  /** Maestro: the current assistant name from settings. Specialist: its role label. */
  displayName: string;
  /** False for a specialist whose pack is no longer the tenant's active pack (history is kept). */
  active: boolean;
}

/** Read model: a message with its sender's display name resolved live. */
export interface MessageView {
  id: string;
  threadId: string;
  sender: "owner" | "agent";
  /** "Owner" for the owner; for an agent, the live assistant name (Maestro) or the specialist label. */
  senderName: string;
  body: string;
  taskId: string | null;
  createdAt: Date;
}

function labelFor(thread: Pick<ThreadRow, "kind" | "agent" | "title">, assistantName: string): string {
  return thread.kind === "maestro" ? assistantName : (thread.title ?? thread.agent);
}

/**
 * Create the tenant's missing threads: Maestro, plus one per specialist of the tenant's active
 * pack. Idempotent and race-safe (the database holds unique (tenant_id, agent)); returns only
 * the threads this call created. Each creation is audited in the same transaction.
 */
export async function ensureThreadsTx(tx: TenantTx): Promise<ThreadRow[]> {
  const tenant = await tx.maybeOne<{ active_pack: string | null }>("select active_pack from tenants where id = $1", [tx.tenantId]);
  if (!tenant) throw new NotFoundError("tenants");
  const wanted: { kind: ThreadRow["kind"]; agent: string; title: string | null }[] = [
    { kind: "maestro", agent: MAESTRO_AGENT, title: null },
    ...listSpecialistsForPack(tenant.active_pack).map((s) => ({ kind: "specialist" as const, agent: s.id, title: s.label })),
  ];
  const created: ThreadRow[] = [];
  for (const w of wanted) {
    const rows = await tx.query<ThreadRow>(
      `insert into threads (tenant_id, kind, agent, title) values ($1, $2, $3, $4)
       on conflict (tenant_id, agent) do nothing returning *`,
      [tx.tenantId, w.kind, w.agent, w.title],
    );
    if (rows[0]) {
      created.push(rows[0]);
      await tx.audit(THREAD_AUDIT_TYPES.created, { kind: w.kind, agent: w.agent });
    }
  }
  return created;
}

/** The tenant's threads: Maestro first, then specialists by agent id. Names are resolved live. */
export async function listThreadsTx(tx: TenantTx): Promise<ThreadView[]> {
  const assistantName = await getAssistantName(tx);
  const tenant = await tx.maybeOne<{ active_pack: string | null }>("select active_pack from tenants where id = $1", [tx.tenantId]);
  const activeAgents = new Set(listSpecialistsForPack(tenant?.active_pack ?? null).map((s) => s.id));
  const rows = await tx.query<ThreadRow>("select * from threads order by (kind = 'maestro') desc, agent");
  return rows.map((t) => ({
    id: t.id,
    kind: t.kind,
    agent: t.agent,
    displayName: labelFor(t, assistantName),
    active: t.kind === "maestro" || activeAgents.has(t.agent),
  }));
}

async function readThreadRow(tx: TenantTx, threadId: unknown): Promise<ThreadRow> {
  if (typeof threadId !== "string" || !UUID.test(threadId)) throw new NotFoundError("threads");
  return tx.getById<ThreadRow>("threads", threadId);
}

/**
 * Append a message to a thread of the caller's tenant. `taskId` (optional) must be a task of the
 * same tenant: a command links to the task it created (R4.2). Another tenant's thread or task
 * is invisible and is NotFoundError. Messages are immutable once written.
 */
export async function postMessageTx(
  tx: TenantTx,
  input: { threadId: string; sender: "owner" | "agent"; body: string; taskId?: string | null },
): Promise<MessageRow> {
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!body) throw new InvalidMessageError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) throw new InvalidMessageError(`message is longer than ${MAX_MESSAGE_LENGTH} characters`);
  if (input.sender !== "owner" && input.sender !== "agent") throw new InvalidMessageError("sender must be owner or agent");
  const thread = await readThreadRow(tx, input.threadId);
  let taskId: string | null = null;
  if (input.taskId != null) {
    if (typeof input.taskId !== "string" || !UUID.test(input.taskId)) throw new NotFoundError("tasks");
    taskId = (await tx.getById<{ id: string }>("tasks", input.taskId)).id;
  }
  return tx.insert<MessageRow>("messages", { thread_id: thread.id, sender: input.sender, body, task_id: taskId });
}

/**
 * The messages of one thread, oldest first. Order is (created_at, seq): seq is the insertion-order
 * identity column, so messages written in one transaction (equal created_at) keep a stable order.
 * When `limit` is smaller than the thread, the NEWEST `limit` messages are returned, still oldest first.
 */
export async function listMessagesTx(
  tx: TenantTx,
  threadId: string,
  opts: { limit?: number } = {},
): Promise<MessageView[]> {
  const thread = await readThreadRow(tx, threadId);
  const assistantName = await getAssistantName(tx);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_MESSAGE_LIMIT), 1), MAX_MESSAGE_LIMIT);
  const rows = await tx.query<MessageRow>(
    `select * from (
       select * from messages where thread_id = $1 order by created_at desc, seq desc limit $2
     ) m order by created_at, seq`,
    [thread.id, limit],
  );
  const agentName = thread.kind === "maestro" ? assistantName : (getSpecialist(thread.agent)?.label ?? thread.title ?? thread.agent);
  return rows.map((m) => ({
    id: m.id,
    threadId: m.thread_id,
    sender: m.sender,
    senderName: m.sender === "owner" ? "Owner" : agentName,
    body: m.body,
    taskId: m.task_id,
    createdAt: m.created_at,
  }));
}

/** The chat read model for one thread: the thread header and its messages, names resolved live. */
export async function getThreadViewTx(tx: TenantTx, threadId: string): Promise<{ thread: ThreadView; messages: MessageView[] }> {
  const thread = (await listThreadsTx(tx)).find((t) => t.id === threadId);
  if (!thread) throw new NotFoundError("threads");
  return { thread, messages: await listMessagesTx(tx, threadId) };
}

export const ensureThreads = (token: unknown): Promise<ThreadRow[]> => withCaller(token, (tx) => ensureThreadsTx(tx));
export const listThreads = (token: unknown): Promise<ThreadView[]> => withCaller(token, (tx) => listThreadsTx(tx));
export const getThreadView = (token: unknown, threadId: string) => withCaller(token, (tx) => getThreadViewTx(tx, threadId));
export const listMessages = (token: unknown, threadId: string, opts: { limit?: number } = {}): Promise<MessageView[]> =>
  withCaller(token, (tx) => listMessagesTx(tx, threadId, opts));
/** The owner's own message, from the authenticated session (the sender is fixed to owner). */
export const sendOwnerMessage = (token: unknown, input: { threadId: string; body: string; taskId?: string | null }): Promise<MessageRow> =>
  withCaller(token, (tx) => postMessageTx(tx, { ...input, sender: "owner" }));
