import { withTenant, type Caller } from "../dal";
import { NotFoundError } from "../dal/errors";
import { expireAllPendingApprovals } from "../tasks";
import { changedEntities, currentFingerprint, OPERATOR_AUDIT_TYPES } from "./fingerprint";
import { AlreadyDeactivatedError, ExportNotVerifiedError, ExportStaleError, requireOperator } from "./errors";
/**
 * Tenant deactivation (task 10.4, design §2.9). Operator-only, and only in the fixed order
 * export -> verify -> deactivate:
 *  1. the tenant's write lock is taken exclusively (the database write guard, migration 0010, takes
 *     it shared), so in-flight writers finish first and later writers are refused;
 *  2. the LATEST verification of the tenant must exist and have passed;
 *  3. nothing may have changed since that archive's cutoff (re-read now and compared with the
 *     archive's fingerprints, ./fingerprint.ts); otherwise a fresh export and verification are needed;
 *  4. then, in the same transaction: every Pending Approval task is expired through the task
 *     state machine, every session is revoked, the tenant becomes `deactivated`, and the operator
 *     action is audited.
 * Data is retained, read-only (the write guard refuses INSERT/UPDATE of tenant tables from then
 * on; every session-resolving operation already refuses a non-active tenant). A refusal is audited
 * in its own transaction and then raised as a typed error; nothing else changes.
 */
export interface DeactivationResult {
  verificationId: string;
  expiredTaskIds: string[];
  revokedSessions: number;
}
type Outcome = { ok: true; result: DeactivationResult } | { ok: false; error: Error; audit: Record<string, unknown> };
export async function deactivateTenant(caller: Caller): Promise<DeactivationResult> {
  requireOperator(caller);
  const outcome = await withTenant<Outcome>(
    caller,
    async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended('aruna.tenant.' || $1::text, 0))", [tx.tenantId]);
      const tenant = await tx.maybeOne<{ status: string }>("select status from tenants where id = $1 for update", [tx.tenantId]);
      if (!tenant) throw new NotFoundError("tenants");
      if (tenant.status === "deactivated") throw new AlreadyDeactivatedError();
      const v = await tx.maybeOne<{ id: string; result: string; file_hashes: Record<string, string>; audit_digest: string | null }>(
        "select id, result, file_hashes, audit_digest from export_verifications order by created_at desc, id limit 1",
      );
      if (!v || v.result !== "passed") {
        const error = new ExportNotVerifiedError(v ? "verification_failed" : "no_verification");
        return { ok: false, error, audit: { reason: error.reason, verification_id: v?.id ?? null } };
      }
      const changed = changedEntities(
        { fileHashes: v.file_hashes, auditDigest: v.audit_digest ?? "" },
        await currentFingerprint(tx),
      );
      if (changed.length > 0) return { ok: false, error: new ExportStaleError(changed), audit: { reason: "stale_export", verification_id: v.id, changed } };
      // All checks passed. Write order matters: the write guard refuses tenant-table writes once the status flips.
      const expiredTaskIds = await expireAllPendingApprovals(tx);
      const revoked = await tx.query("update sessions set revoked_at = now() where revoked_at is null returning id");
      await tx.updateById("tenants", tx.tenantId, { status: "deactivated", updated_at: new Date() });
      await tx.audit(OPERATOR_AUDIT_TYPES.deactivated, {
        verification_id: v.id,
        expired_tasks: expiredTaskIds.length,
        revoked_sessions: revoked.length,
      });
      return { ok: true, result: { verificationId: v.id, expiredTaskIds, revokedSessions: revoked.length } };
    },
    "service",
  );
  if (outcome.ok) return outcome.result;
  // The refusal is evidence: record it (its own transaction; the checked one wrote nothing).
  await withTenant(caller, (tx) => tx.audit(OPERATOR_AUDIT_TYPES.deactivationRefused, outcome.audit), "service");
  throw outcome.error;
}
