import { createHash } from "node:crypto";
import { AUDIT_TYPES } from "../audit";
import type { TenantTx } from "../dal";
import { json, exportQuery } from "../exports/service";
import { listExportEntities } from "../exports/registry";
/**
 * Change detection for the export cutoff rule (design §2.9, amendment #16).
 *
 * An archive describes the tenant at its cutoff. To decide whether anything changed since, the
 * tenant's current state is re-read in ONE statement (the export query) and compared with what
 * the verified archive holds:
 *  - every entity except the audit log: the sha256 of its JSON file (the exact bytes the export
 *    wrote), so any added, removed or edited row changes it;
 *  - the audit log: the digest of its entry ids, ignoring the entry types in NON_DATA_AUDIT_TYPES
 *    (the export, verification and refusal records that the offboarding process itself writes).
 *    Any other new audit entry means the tenant did something after the cutoff.
 */
export const OPERATOR_AUDIT_TYPES = {
  verified: "operator.export_verified",
  verificationFailed: "operator.export_verification_failed",
  deactivated: "operator.tenant_deactivated",
  deactivationRefused: "operator.tenant_deactivation_refused",
} as const;
const NON_DATA_AUDIT_TYPES: ReadonlySet<string> = new Set([
  AUDIT_TYPES.export,
  OPERATOR_AUDIT_TYPES.verified,
  OPERATOR_AUDIT_TYPES.verificationFailed,
  OPERATOR_AUDIT_TYPES.deactivationRefused,
]);
export const AUDIT_ENTITY = "audit_log";
type Row = Record<string, unknown>;
export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
export function auditDigest(rows: readonly Row[]): string {
  const ids = rows.filter((r) => !NON_DATA_AUDIT_TYPES.has(String(r.type))).map((r) => String(r.id)).sort();
  return sha256(ids.join("\n"));
}
export interface Fingerprint {
  /** `<entity name>` -> sha256 of its JSON file, audit log excluded. */
  fileHashes: Record<string, string>;
  auditDigest: string;
}
/** The tenant's state right now, read inside the given tenant transaction. */
export async function currentFingerprint(tx: TenantTx): Promise<Fingerprint> {
  const entities = listExportEntities();
  const [row] = await tx.query<Row>(exportQuery(entities));
  const fileHashes: Record<string, string> = {};
  for (const e of entities) if (e.name !== AUDIT_ENTITY) fileHashes[e.name] = sha256(json(row[e.name]));
  return { fileHashes, auditDigest: auditDigest((row[AUDIT_ENTITY] as Row[] | undefined) ?? []) };
}
/** Names of the entities whose current state differs from the recorded one. Empty = nothing changed. */
export function changedEntities(recorded: Fingerprint, now: Fingerprint): string[] {
  const changed = Object.entries(now.fileHashes)
    .filter(([name, hash]) => recorded.fileHashes[name] !== hash)
    .map(([name]) => name);
  if (recorded.auditDigest !== now.auditDigest) changed.push(AUDIT_ENTITY);
  return changed;
}
