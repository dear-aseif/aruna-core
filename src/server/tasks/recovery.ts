import { withTenant, type Caller } from "../dal";
import { listActiveTenantIds } from "../db";
import { DEFAULT_STALE_ATTEMPT_SECONDS, recoverStaleAttempt } from "./state-machine";
/**
 * Stale-attempt recovery sweep (task 8.2, gate ruling 4.2, amendment #14). Same pattern as the
 * approval expiry sweep (task 4.3): service-role routine, tenants enumerated by id only, each
 * tenant worked in its own tenant session, each task recovered in its own transaction as the
 * system actor. Per-minute cron wiring is group 14 work; until then run `npm run tasks:recover`.
 * A Working task whose attempt is stale returns to Queued, or becomes Failed past the bound.
 */
export const RECOVERY_ACTOR_ID = "stale-attempt-sweep";
export interface RecoverySweepResult {
  tenants: number;
  /** Stale attempts returned to Queued. */
  requeued: number;
  /** Stale attempts past the failure bound, marked Failed. */
  failed: number;
  errors: { tenantId: string; taskId?: string; message: string }[];
}
export async function sweepStaleAttempts(opts: { staleAfterSeconds?: number } = {}): Promise<RecoverySweepResult> {
  const staleAfter = opts.staleAfterSeconds ?? DEFAULT_STALE_ATTEMPT_SECONDS;
  const result: RecoverySweepResult = { tenants: 0, requeued: 0, failed: 0, errors: [] };
  for (const tenantId of await listActiveTenantIds()) {
    result.tenants++;
    const caller: Caller = { tenantId, actor: "system", actorId: RECOVERY_ACTOR_ID };
    let ids: string[];
    try {
      ids = await withTenant(
        caller,
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              "select id from tasks where status = 'working' and updated_at <= clock_timestamp() - make_interval(secs => $1::float8) order by updated_at",
              [staleAfter],
            )
          ).map((r) => r.id),
        "service",
      );
    } catch (e) {
      result.errors.push({ tenantId, message: (e as Error).message });
      continue;
    }
    for (const taskId of ids) {
      try {
        const t = await withTenant(caller, (tx) => recoverStaleAttempt(tx, taskId, { staleAfterSeconds: staleAfter }), "service");
        if (t.status === "failed") result.failed++;
        else result.requeued++;
      } catch (e) {
        result.errors.push({ tenantId, taskId, message: (e as Error).message });
      }
    }
  }
  return result;
}
