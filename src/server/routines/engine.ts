import { withTenant, type Caller, type TenantTx } from "../dal";
import { listActiveTenantIds } from "../db";
import { getActivePlaybook, NoActivePlaybookError } from "../playbook";
import { expireTaskIfOverdue } from "../tasks";
import "./core-sections";
import { sectionsForPack, type SectionContext } from "./registry";
import { decideBriefing, previousDate } from "./schedule";

/**
 * Routine engine (task 10.1, design §2.11, R9.1/R9.3). Decides, per tenant and in the tenant's own
 * timezone, whether the briefing routine is due; if so runs the shared routine: apply approval
 * expiry, then collect every section that applies to the tenant's pack. What a briefing contains
 * and where it is stored is task 10.2, which installs a sink with `setBriefingSink`.
 *
 * Isolation: tenants come from the narrow bootstrap lookup (active tenants only, ids only), and each
 * is processed in its own tenant session, so RLS applies and a deactivated tenant is never touched.
 * One tenant's failure is recorded and never stops the others.
 *
 * Run record (audit, system actor): `routine.briefing_run` on success, `routine.briefing_failed` on
 * failure. A tenant runs at most once per schedule date; a failed run is retried on the next
 * invocation up to MAX_FAILED_ATTEMPTS times, then given up on for that date.
 */
export const ROUTINE_ACTOR_ID = "briefing-routine";
export const ROUTINE_AUDIT_TYPES = { run: "routine.briefing_run", failed: "routine.briefing_failed" } as const;
export const MAX_FAILED_ATTEMPTS = 3;

export type TenantOutcome = "ran" | "not_due" | "already_ran" | "gave_up" | "no_playbook" | "locked" | "failed";
export interface TenantRunResult {
  tenantId: string;
  outcome: TenantOutcome;
  scheduleDate?: string;
  error?: string;
}
export interface RoutineRunResult {
  tenants: number;
  ran: number;
  failed: number;
  results: TenantRunResult[];
}

export interface CollectedSection {
  id: string;
  facts: unknown;
}
export interface BriefingRun {
  scheduleDate: string;
  sections: CollectedSection[];
}
/** Task 10.2 installs the generator/storage here. It runs in the same transaction as the run record. */
export type BriefingSink = (tx: TenantTx, run: BriefingRun, ctx: SectionContext) => Promise<void>;
let sink: BriefingSink | null = null;
export function setBriefingSink(fn: BriefingSink | null): void {
  sink = fn;
}

const caller = (tenantId: string): Caller => ({ tenantId, actor: "system", actorId: ROUTINE_ACTOR_ID });

/** Overdue approvals lapse before the pending list is read (design §2.11, amendment #25). */
async function applyApprovalExpiry(tx: TenantTx): Promise<number> {
  const ids = await tx.query<{ id: string }>(
    "select id from tasks where status = 'pending_approval' and approval_expires_at <= clock_timestamp() order by approval_expires_at",
  );
  let n = 0;
  for (const { id } of ids) if (await expireTaskIfOverdue(tx, id)) n++;
  return n;
}

async function runTenant(tenantId: string, now: Date | undefined): Promise<TenantRunResult> {
  return withTenant(
    caller(tenantId),
    async (tx): Promise<TenantRunResult> => {
      let playbook;
      try {
        playbook = await getActivePlaybook(tx);
      } catch (e) {
        if (e instanceof NoActivePlaybookError) return { tenantId, outcome: "no_playbook" };
        throw e;
      }
      const status = await tx.maybeOne<{ status: string }>("select status from tenants where id = $1", [tx.tenantId]);
      if (status?.status !== "active") return { tenantId, outcome: "not_due" };

      const timezone = playbook.business.timezone;
      const d = decideBriefing(now ?? (await dbNow(tx)), timezone, playbook.schedule?.briefingTime);
      if (!d.due) return { tenantId, outcome: "not_due", scheduleDate: d.date };

      // One run per (tenant, schedule date), also across overlapping invocations.
      const got = await tx.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext($1)) as ok", [`briefing:${tx.tenantId}:${d.date}`]);
      if (!got[0]?.ok) return { tenantId, outcome: "locked", scheduleDate: d.date };

      const prior = await tx.query<{ type: string }>(
        "select type from audit_log where type in ($1, $2) and payload->>'schedule_date' = $3",
        [ROUTINE_AUDIT_TYPES.run, ROUTINE_AUDIT_TYPES.failed, d.date],
      );
      if (prior.some((p) => p.type === ROUTINE_AUDIT_TYPES.run)) return { tenantId, outcome: "already_ran", scheduleDate: d.date };
      if (prior.length >= MAX_FAILED_ATTEMPTS) return { tenantId, outcome: "gave_up", scheduleDate: d.date };

      const expired = await applyApprovalExpiry(tx);
      const ctx: SectionContext = { scheduleDate: d.date, previousDate: previousDate(d.date), timezone, pack: playbook.pack, playbook };
      const collected: CollectedSection[] = [];
      for (const s of sectionsForPack(playbook.pack)) collected.push({ id: s.id, facts: await s.collect(tx, ctx) });
      if (sink) await sink(tx, { scheduleDate: d.date, sections: collected }, ctx);

      await tx.audit(ROUTINE_AUDIT_TYPES.run, {
        schedule_date: d.date,
        local_time: d.time,
        briefing_time: d.briefingTime,
        timezone,
        pack: playbook.pack,
        sections: collected.map((c) => c.id),
        approvals_expired: expired,
      });
      return { tenantId, outcome: "ran", scheduleDate: d.date };
    },
    "service",
  );
}

async function dbNow(tx: TenantTx): Promise<Date> {
  return (await tx.query<{ n: Date }>("select clock_timestamp() as n"))[0].n;
}

/** Record a failed run in its own transaction (the failed one rolled back), so the attempt is auditable. */
async function recordFailure(tenantId: string, scheduleDate: string | undefined, message: string): Promise<void> {
  if (!scheduleDate) return;
  await withTenant(caller(tenantId), (tx) => tx.audit(ROUTINE_AUDIT_TYPES.failed, { schedule_date: scheduleDate, error: message }), "service");
}

/**
 * Run the briefing routine once for every tenant that is due. Meant to be invoked every minute by
 * system cron (deployment: task 11.2). `now` is for tests; production uses database time.
 */
export async function runBriefingRoutines(opts: { now?: Date; onlyTenantIds?: string[] } = {}): Promise<RoutineRunResult> {
  const out: RoutineRunResult = { tenants: 0, ran: 0, failed: 0, results: [] };
  // `onlyTenantIds` narrows the active set (it can never add a tenant the lookup did not return).
  const active = (await listActiveTenantIds()).filter((id) => !opts.onlyTenantIds || opts.onlyTenantIds.includes(id));
  for (const tenantId of active) {
    out.tenants++;
    try {
      const r = await runTenant(tenantId, opts.now);
      out.results.push(r);
      if (r.outcome === "ran") out.ran++;
    } catch (e) {
      const message = (e as Error).message;
      out.failed++;
      let scheduleDate: string | undefined;
      try {
        scheduleDate = await failureDate(tenantId, opts.now);
        await recordFailure(tenantId, scheduleDate, message);
      } catch {
        /* the failure itself is still reported in the result */
      }
      out.results.push({ tenantId, outcome: "failed", scheduleDate, error: message });
    }
  }
  return out;
}

/** The schedule date to attach to a failure record. */
async function failureDate(tenantId: string, now: Date | undefined): Promise<string | undefined> {
  return withTenant(
    caller(tenantId),
    async (tx) => {
      const pb = await getActivePlaybook(tx);
      const at = now ?? (await dbNow(tx));
      try {
        return decideBriefing(at, pb.business.timezone, pb.schedule?.briefingTime).date;
      } catch {
        return decideBriefing(at, "UTC", undefined).date; // unknown timezone: record against the UTC date so retries stay bounded
      }
    },
    "service",
  );
}
