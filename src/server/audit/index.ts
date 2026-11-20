import type { TenantTx } from "../dal";

/**
 * Audit service (task 4.1, design §2.3 amendment #5, R6.2).
 *
 * Appends run on the caller's DAL transaction handle (`tx.audit`), so an entry commits or
 * rolls back together with the mutation it records. There is no update or delete API; the
 * database grants and trigger from task 2.1 enforce append-only as well.
 * Actor and actor_id come from `tx.caller`, never from the arguments.
 */

export const AUDIT_TYPES = {
  agentAction: "agent.action",
  checkerResult: "checker.result",
  approvalDecision: "approval.decision",
  export: "export.created",
} as const;

const SECURITY_KIND = /^[a-z][a-z0-9_]{0,62}$/;

export type AuditPayload = Record<string, unknown>;

export interface AuditEntry {
  id: string;
  tenantId: string;
  taskId: string | null;
  actor: string;
  actorId: string;
  type: string;
  payload: AuditPayload;
  createdAt: Date;
}

interface Row {
  id: string;
  tenant_id: string;
  task_id: string | null;
  actor: string;
  actor_id: string;
  type: string;
  payload: AuditPayload;
  created_at: Date;
}

const COLUMNS = "id, tenant_id, task_id, actor, actor_id, type, payload, created_at";

function toEntry(r: Row): AuditEntry {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    actor: r.actor,
    actorId: r.actor_id,
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

/** An agent action (start, draft produced, execution attempt, outcome...). `action` is a short name. */
export async function recordAgentAction(tx: TenantTx, taskId: string | null, action: string, detail: AuditPayload = {}): Promise<void> {
  await tx.audit(AUDIT_TYPES.agentAction, { ...detail, action }, taskId);
}

/** A Checker result for a task revision (producer arrives in group 6). */
export async function recordCheckerResult(tx: TenantTx, taskId: string, result: AuditPayload): Promise<void> {
  await tx.audit(AUDIT_TYPES.checkerResult, result, taskId);
}

/** An owner approval or rejection decision (producer arrives in group 6). */
export async function recordApprovalDecision(tx: TenantTx, taskId: string, decision: AuditPayload): Promise<void> {
  await tx.audit(AUDIT_TYPES.approvalDecision, decision, taskId);
}

/** A data export event (not tied to a task). */
export async function recordExport(tx: TenantTx, detail: AuditPayload = {}): Promise<void> {
  await tx.audit(AUDIT_TYPES.export, detail, null);
}

/** A security event, recorded as `security.<kind>` (for example `security.cross_tenant_attempt`). */
export async function recordSecurityEvent(tx: TenantTx, kind: string, detail: AuditPayload = {}, taskId: string | null = null): Promise<void> {
  if (!SECURITY_KIND.test(kind)) throw new Error(`invalid security event kind: ${kind}`);
  await tx.audit(`security.${kind}`, detail, taskId);
}

/** One task's entries, oldest first (created_at, then insertion order within a transaction). */
export async function getTaskHistory(tx: TenantTx, taskId: string): Promise<AuditEntry[]> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from audit_log where task_id = $1 order by created_at, seq`, [taskId]);
  return rows.map(toEntry);
}

/** The caller's tenant entries, newest first, optionally filtered by exact event type. */
export async function listAuditEntries(tx: TenantTx, opts: { type?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const rows = opts.type
    ? await tx.query<Row>(`select ${COLUMNS} from audit_log where type = $1 order by created_at desc, seq desc limit $2`, [opts.type, limit])
    : await tx.query<Row>(`select ${COLUMNS} from audit_log order by created_at desc, seq desc limit $1`, [limit]);
  return rows.map(toEntry);
}
