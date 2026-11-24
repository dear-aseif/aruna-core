import type { TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { setBriefingSink, type BriefingRun, type BriefingSink } from "../routines";

/**
 * Briefing archive (task 10.2, design §2.11, amendment #25, R9.4). Stores the facts the routine
 * collected, one row per (tenant, schedule date). Everything here runs on the caller's tenant
 * transaction, so RLS applies and the audit entry shares the transaction with the row.
 *
 * Idempotent: `on conflict (tenant_id, date) do nothing`, backed by the table's unique constraint.
 * A stored briefing is never changed (the runtime roles cannot UPDATE or DELETE it); storing the
 * same date again returns the existing one untouched.
 */
export const BRIEFING_AUDIT_TYPES = { stored: "briefing.stored" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredBriefing {
  id: string;
  /** The schedule date in the tenant's timezone, YYYY-MM-DD. */
  date: string;
  sections: { id: string; facts: unknown }[];
  createdAt: Date;
}
interface Row {
  id: string;
  date: string;
  sections: { id: string; facts: unknown }[];
  created_at: Date;
}
const COLUMNS = "id, to_char(date, 'YYYY-MM-DD') as date, sections, created_at";
const toStored = (r: Row): StoredBriefing => ({ id: r.id, date: r.date, sections: r.sections, createdAt: r.created_at });

/** Store the briefing for `run.scheduleDate`, or return the one already stored for it. */
export async function storeBriefing(tx: TenantTx, run: BriefingRun): Promise<{ briefing: StoredBriefing; created: boolean }> {
  const sections = run.sections.map((s) => ({ id: s.id, facts: s.facts }));
  const inserted = await tx.query<Row>(
    `insert into briefings (tenant_id, date, sections) values ($1, $2::date, $3::jsonb)
       on conflict (tenant_id, date) do nothing
       returning ${COLUMNS}`,
    [tx.tenantId, run.scheduleDate, JSON.stringify(sections)],
  );
  if (inserted[0]) {
    await tx.audit(BRIEFING_AUDIT_TYPES.stored, { briefing_id: inserted[0].id, schedule_date: run.scheduleDate, sections: sections.map((s) => s.id) });
    return { briefing: toStored(inserted[0]), created: true };
  }
  const existing = await tx.query<Row>(`select ${COLUMNS} from briefings where date = $1::date`, [run.scheduleDate]);
  return { briefing: toStored(existing[0]), created: false };
}

/** The routine's sink: stores each run's facts in the archive, in the run's own transaction. */
export const archiveSink: BriefingSink = async (tx, run) => {
  await storeBriefing(tx, run);
};
/** Wire the archive into the routine engine. Called by the cron entry point (and tests). */
export function installBriefingArchive(): void {
  setBriefingSink(archiveSink);
}

/** One stored briefing, exactly as stored. Another tenant's id, a malformed id or an unknown id is NotFoundError. */
export async function getBriefingTx(tx: TenantTx, id: unknown): Promise<StoredBriefing> {
  if (typeof id !== "string" || !UUID.test(id)) throw new NotFoundError("briefings");
  const r = await tx.maybeOne<Row>(`select ${COLUMNS} from briefings where id = $1`, [id]);
  if (!r) throw new NotFoundError("briefings");
  return toStored(r);
}

export const MAX_ARCHIVE = 90;
/** The tenant's briefings, newest schedule date first. */
export async function listBriefingsTx(tx: TenantTx, limit = MAX_ARCHIVE): Promise<StoredBriefing[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_ARCHIVE);
  return (await tx.query<Row>(`select ${COLUMNS} from briefings order by date desc limit $1`, [n])).map(toStored);
}
