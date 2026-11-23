import { AUDIT_TYPES, type AuditEntry } from "../audit";
import type { Language } from "../../i18n/strings";
/**
 * Pure mapping from audit entries to what the owner sees on task cards and the task detail
 * (task 9.3, design §2.12). Timestamps are stored in UTC and shown in the tenant's Playbook
 * timezone; the audit entries are read only and nothing here writes.
 */
export interface CheckItem {
  id: string;
  at: string;
  atIso: string;
  outcome: "pass" | "fail";
  stage: string | null;
  revision: number | null;
  anomalies: string[];
}
export interface ApprovalItem {
  id: string;
  at: string;
  atIso: string;
  decision: "approve" | "reject";
  /** An approve that the gate refused (for example the payment rule). */
  blocked: boolean;
  revision: number | null;
  decidedBy: string;
  reason: string | null;
}
export interface TrailEntry {
  id: string;
  at: string;
  atIso: string;
  type: string;
  actor: string;
  actorId: string;
  /** Scalar payload fields, as text. Nested values are left out. */
  facts: { key: string; value: string }[];
}
/** Entry types the cards summarize. */
export const CARD_HISTORY_TYPES = [AUDIT_TYPES.checkerResult, AUDIT_TYPES.approvalDecision] as const;
const MAX_FACT_LENGTH = 200;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A UTC instant as date and time in the business timezone, with the zone name (for example "20 Nov 2026, 14:30 GMT+8"). */
export function formatTimestamp(at: Date, timeZone: string, lang: Language): string {
  const locale = lang === "id" ? "id-ID" : "en-GB";
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone, timeZoneName: "short" }).format(at);
  } catch {
    return at.toISOString();
  }
}
const iso = (d: Date) => new Date(d).toISOString();
const revisionOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
export function toCheckItem(e: AuditEntry, timeZone: string, lang: Language): CheckItem {
  const p = e.payload;
  const anomalies = Array.isArray(p.anomalies)
    ? p.anomalies.flatMap((a) => (isRecord(a) && typeof a.message === "string" ? [a.message] : typeof a === "string" ? [a] : []))
    : [];
  return {
    id: e.id,
    at: formatTimestamp(new Date(e.createdAt), timeZone, lang),
    atIso: iso(e.createdAt),
    outcome: p.outcome === "pass" ? "pass" : "fail",
    stage: typeof p.stage === "string" ? p.stage : null,
    revision: revisionOf(p.revision),
    anomalies,
  };
}
export function toApprovalItem(e: AuditEntry, timeZone: string, lang: Language): ApprovalItem {
  const p = e.payload;
  return {
    id: e.id,
    at: formatTimestamp(new Date(e.createdAt), timeZone, lang),
    atIso: iso(e.createdAt),
    decision: p.decision === "reject" ? "reject" : "approve",
    blocked: p.outcome === "blocked",
    revision: revisionOf(p.revision),
    decidedBy: typeof p.decided_by === "string" ? p.decided_by : e.actorId,
    reason: typeof p.reason === "string" ? p.reason : null,
  };
}
export function toTrailEntry(e: AuditEntry, timeZone: string, lang: Language): TrailEntry {
  const facts: { key: string; value: string }[] = [];
  for (const [key, v] of Object.entries(e.payload)) {
    if (typeof v === "string" && /_at$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) {
      facts.push({ key, value: formatTimestamp(new Date(v), timeZone, lang) }); // stored UTC, shown in the business timezone
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") facts.push({ key, value: String(v).slice(0, MAX_FACT_LENGTH) });
  }
  return { id: e.id, at: formatTimestamp(new Date(e.createdAt), timeZone, lang), atIso: iso(e.createdAt), type: e.type, actor: e.actor, actorId: e.actorId, facts };
}
/** Split entries into check and approval items per task, keeping the entries' (oldest first) order. */
export function groupCardHistory(entries: readonly AuditEntry[], timeZone: string, lang: Language): Map<string, { checks: CheckItem[]; approvals: ApprovalItem[] }> {
  const out = new Map<string, { checks: CheckItem[]; approvals: ApprovalItem[] }>();
  for (const e of entries) {
    if (!e.taskId) continue;
    const slot = out.get(e.taskId) ?? { checks: [], approvals: [] };
    if (e.type === AUDIT_TYPES.checkerResult) slot.checks.push(toCheckItem(e, timeZone, lang));
    else if (e.type === AUDIT_TYPES.approvalDecision) slot.approvals.push(toApprovalItem(e, timeZone, lang));
    out.set(e.taskId, slot);
  }
  return out;
}
