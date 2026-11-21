import type { TenantTx } from "../dal";
import { getTaskHistory, listAuditEntries, type AuditEntry } from "../audit";
import { MAESTRO_AGENT, listSpecialistsForPack } from "../agents";
import { getAssistantName } from "../settings";
import { countTasksByStatusTx, getTaskDetailTx, listTasksTx, MAX_LIST_LIMIT, type TaskDetail, type TaskStatus } from "../tasks";
import { NotFoundError } from "../dal/errors";

/**
 * Typed query functions behind the Maestro's live-data answers (task 8.3, design §2.6, R4.3).
 *
 * Every function runs on the caller's DAL transaction (tenant bound, RLS applies) and is built
 * only from the task 4.4 operations (`listTasksTx`, `countTasksByStatusTx`, `getTaskDetailTx`) and
 * the task 4.1 audit queries (`getTaskHistory`, `listAuditEntries`). They return plain facts; the
 * renderer turns facts into text. No function accepts a tenant id.
 */
export const OPEN_STATUSES: readonly TaskStatus[] = ["queued", "working", "in_review", "pending_approval"];
/** Tasks listed per agent in an answer. The total is always the exact count of what was read. */
export const TASKS_SHOWN_PER_AGENT = 3;
export const RECENT_ACTIVITY_LIMIT = 10;

export interface KnownAgent {
  id: string;
  /** Maestro: the live assistant name. Specialist: its role label. */
  label: string;
}

export interface ActivityMark {
  type: string;
  actor: string;
  actorId: string;
  at: Date;
}

export interface OpenTaskFact {
  id: string;
  title: string;
  status: TaskStatus;
  approvalExpiresAt: Date | null;
  /** The newest audit entry of the task. */
  lastActivity: ActivityMark | null;
}

export interface AgentActivityFact {
  agent: KnownAgent;
  /** Exact number of open tasks of this agent among the tasks read. */
  openTotal: number;
  /** The newest open tasks, at most TASKS_SHOWN_PER_AGENT. */
  shown: OpenTaskFact[];
}

export interface AgentActivityFacts {
  agents: AgentActivityFact[];
  /** True when more open tasks exist than were read; counts are then lower bounds. */
  truncated: boolean;
}

const mark = (e: AuditEntry | undefined): ActivityMark | null => (e ? { type: e.type, actor: e.actor, actorId: e.actorId, at: e.createdAt } : null);

/** The agents of the caller's workspace: the Maestro plus the specialists of the tenant's active pack. */
export async function queryKnownAgentsTx(tx: TenantTx): Promise<KnownAgent[]> {
  const tenant = await tx.maybeOne<{ active_pack: string | null }>("select active_pack from tenants where id = $1", [tx.tenantId]);
  return [
    { id: MAESTRO_AGENT, label: await getAssistantName(tx) },
    ...listSpecialistsForPack(tenant?.active_pack ?? null).map((s) => ({ id: s.id, label: s.label })),
  ];
}

/** Open tasks per agent (all agents, or one), each with its newest audit entry. */
export async function queryAgentActivityTx(tx: TenantTx, agentId: string | null): Promise<AgentActivityFacts> {
  const known = await queryKnownAgentsTx(tx);
  const wanted = agentId ? known.filter((a) => a.id === agentId) : known;
  const open = await listTasksTx(tx, { status: OPEN_STATUSES, limit: MAX_LIST_LIMIT });
  const agents: AgentActivityFact[] = [];
  for (const agent of wanted) {
    const mine = open.filter((t) => t.agent === agent.id);
    const shown: OpenTaskFact[] = [];
    for (const t of mine.slice(0, TASKS_SHOWN_PER_AGENT)) {
      const history = await getTaskHistory(tx, t.id);
      shown.push({ id: t.id, title: t.title, status: t.status, approvalExpiresAt: t.approval_expires_at, lastActivity: mark(history[history.length - 1]) });
    }
    agents.push({ agent, openTotal: mine.length, shown });
  }
  return { agents, truncated: open.length >= MAX_LIST_LIMIT };
}

export interface PendingApprovalFacts {
  total: number;
  shown: OpenTaskFact[];
}

/** Tasks waiting for the owner's approval, soonest deadline first among the newest read. */
export async function queryPendingApprovalsTx(tx: TenantTx): Promise<PendingApprovalFacts> {
  const rows = await listTasksTx(tx, { status: "pending_approval", limit: MAX_LIST_LIMIT });
  const shown: OpenTaskFact[] = [];
  for (const t of rows.slice(0, TASKS_SHOWN_PER_AGENT * 2)) {
    const history = await getTaskHistory(tx, t.id);
    shown.push({ id: t.id, title: t.title, status: t.status, approvalExpiresAt: t.approval_expires_at, lastActivity: mark(history[history.length - 1]) });
  }
  return { total: rows.length, shown };
}

/** Exact counts by status (all statuses). */
export const queryStatusCountsTx = (tx: TenantTx): Promise<Record<TaskStatus, number>> => countTasksByStatusTx(tx);

export interface RecentActivityFact {
  type: string;
  actor: string;
  actorId: string;
  at: Date;
  taskTitle: string | null;
  taskId: string | null;
}

/** The newest audit entries of the tenant, each with its task's title when it has one. */
export async function queryRecentActivityTx(tx: TenantTx): Promise<RecentActivityFact[]> {
  const entries = await listAuditEntries(tx, { limit: RECENT_ACTIVITY_LIMIT });
  const titles = new Map<string, string | null>();
  const out: RecentActivityFact[] = [];
  for (const e of entries) {
    let title: string | null = null;
    if (e.taskId) {
      if (!titles.has(e.taskId)) titles.set(e.taskId, (await queryTaskDetailTx(tx, e.taskId))?.task.title ?? null);
      title = titles.get(e.taskId) ?? null;
    }
    out.push({ type: e.type, actor: e.actor, actorId: e.actorId, at: e.createdAt, taskTitle: title, taskId: e.taskId });
  }
  return out;
}

/** One task's detail, or null when it is not visible in this tenant. */
export async function queryTaskDetailTx(tx: TenantTx, taskId: string): Promise<TaskDetail | null> {
  try {
    return await getTaskDetailTx(tx, taskId);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}
