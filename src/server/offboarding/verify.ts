import { withTenant, type Caller } from "../dal";
import { NotFoundError } from "../dal/errors";
import { readZip, type ArchiveFile } from "../exports/archive";
import { listExportEntities } from "../exports/registry";
import { auditDigest, AUDIT_ENTITY, OPERATOR_AUDIT_TYPES, sha256 } from "./fingerprint";
import { requireOperator } from "./errors";
/**
 * Archive verification (task 10.4, design §2.9). Operator-only. Checks an export archive (the
 * zip from task 10.3) against its OWN manifest and records the outcome:
 *  - manifest.json exists, has the known format, a valid cutoff, and names THIS tenant;
 *  - every file the manifest lists exists with the listed byte size and sha256, and the archive
 *    holds no file the manifest does not list;
 *  - every entity count in the manifest equals the number of rows in that entity's JSON file
 *    (the catalog count equals the number of catalog items), and every row that carries a
 *    tenant id carries this tenant's;
 *  - every entity the export service currently exports is present in the manifest.
 * A failed check is recorded too (result `failed`, with the problems); only a `passed` record
 * can unlock deactivation, and only while nothing has changed since the cutoff (./deactivate.ts).
 */
export interface VerificationResult {
  id: string;
  passed: boolean;
  problems: string[];
  cutoff: string | null;
  entities: Record<string, number>;
}
interface Manifest {
  format?: unknown;
  tenantId?: unknown;
  cutoff?: unknown;
  entities?: unknown;
  files?: unknown;
}
const MANIFEST_FORMAT = "aruna-export/1";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function parseJson(f: ArchiveFile | undefined): unknown {
  if (!f) return undefined;
  try {
    return JSON.parse(Buffer.from(f.data).toString("utf8"));
  } catch {
    return undefined;
  }
}
interface Checked {
  problems: string[];
  cutoff: string | null;
  entities: Record<string, number>;
  fileHashes: Record<string, string>;
  auditDigest: string | null;
}
/** Pure check of an archive against its manifest and the tenant it must belong to. */
export function checkArchive(archive: Uint8Array, tenantId: string): Checked {
  const out: Checked = { problems: [], cutoff: null, entities: {}, fileHashes: {}, auditDigest: null };
  const fail = (m: string) => void out.problems.push(m);
  let files: ArchiveFile[];
  try {
    files = readZip(archive);
  } catch (e) {
    fail(`archive is not a readable export zip: ${(e as Error).message}`);
    return out;
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifest = parseJson(byPath.get("manifest.json")) as Manifest | undefined;
  if (!isRecord(manifest)) {
    fail("manifest.json is missing or is not valid JSON");
    return out;
  }
  if (manifest.format !== MANIFEST_FORMAT) fail(`unknown manifest format: ${String(manifest.format)}`);
  if (manifest.tenantId !== tenantId) fail("the manifest belongs to a different tenant");
  const cutoffMs = typeof manifest.cutoff === "string" ? Date.parse(manifest.cutoff) : NaN;
  if (Number.isNaN(cutoffMs)) fail("the manifest has no valid cutoff timestamp");
  else out.cutoff = new Date(cutoffMs).toISOString();
  const listed = Array.isArray(manifest.files) ? manifest.files : null;
  const counts = isRecord(manifest.entities) ? manifest.entities : null;
  if (!listed) fail("the manifest lists no files");
  if (!counts) fail("the manifest has no entity counts");
  if (!listed || !counts) return out;
  // Files: presence, size, checksum; nothing unlisted.
  const listedPaths = new Set<string>(["manifest.json"]);
  for (const entry of listed) {
    const e = entry as { path?: unknown; bytes?: unknown; sha256?: unknown };
    if (typeof e?.path !== "string") {
      fail("a manifest file entry has no path");
      continue;
    }
    listedPaths.add(e.path);
    const f = byPath.get(e.path);
    if (!f) {
      fail(`listed file is missing: ${e.path}`);
      continue;
    }
    if (f.data.length !== e.bytes) fail(`byte size differs from the manifest: ${e.path}`);
    if (sha256(f.data) !== e.sha256) fail(`sha256 differs from the manifest: ${e.path}`);
  }
  for (const f of files) if (!listedPaths.has(f.path)) fail(`file is not listed in the manifest: ${f.path}`);
  // Counts and tenant ownership of every row.
  for (const [name, n] of Object.entries(counts)) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      fail(`entity count is not a number: ${name}`);
      continue;
    }
    out.entities[name] = n;
    const file = byPath.get(`${name}.json`);
    const data = parseJson(file);
    if (name === "catalog") {
      const actual = isRecord(data) && isRecord((data as { catalog?: unknown }).catalog)
        ? Object.values((data as { catalog: Record<string, unknown> }).catalog).reduce<number>((a, v) => a + (Array.isArray(v) ? v.length : 0), 0)
        : -1;
      if (actual !== n) fail(`entity count differs from the manifest: catalog (${actual} vs ${n})`);
      continue;
    }
    if (!Array.isArray(data)) {
      fail(`entity file is missing or is not a list: ${name}.json`);
      continue;
    }
    if (data.length !== n) fail(`entity count differs from the manifest: ${name} (${data.length} vs ${n})`);
    for (const r of data) {
      const row = r as Record<string, unknown>;
      const owner = name === "business_profile" ? row?.id : row?.tenant_id;
      if (owner !== tenantId) {
        fail(`a row of ${name} does not belong to this tenant`);
        break;
      }
    }
    if (name === AUDIT_ENTITY) out.auditDigest = auditDigest(data as Record<string, unknown>[]);
    else out.fileHashes[name] = sha256(file!.data);
  }
  for (const e of listExportEntities()) if (!(e.name in counts)) fail(`the manifest does not cover entity: ${e.name}`);
  if (!(AUDIT_ENTITY in counts)) out.auditDigest = null;
  return out;
}
/** Verify an archive for one tenant and record the result (and an operator audit entry) in one transaction. */
export async function verifyExport(caller: Caller, archive: Uint8Array): Promise<VerificationResult> {
  requireOperator(caller);
  const checked = checkArchive(archive, caller.tenantId);
  const passed = checked.problems.length === 0;
  return withTenant(
    caller,
    async (tx) => {
      const tenant = await tx.maybeOne("select id from tenants where id = $1", [tx.tenantId]);
      if (!tenant) throw new NotFoundError("tenants");
      const row = await tx.insert<{ id: string }>("export_verifications", {
        result: passed ? "passed" : "failed",
        verified_by: caller.actorId,
        archive_sha256: sha256(archive),
        archive_bytes: archive.length,
        cutoff: checked.cutoff,
        entities: JSON.stringify(checked.entities),
        file_hashes: JSON.stringify(passed ? checked.fileHashes : {}),
        audit_digest: passed ? checked.auditDigest : null,
        problems: JSON.stringify(checked.problems),
      });
      await tx.audit(passed ? OPERATOR_AUDIT_TYPES.verified : OPERATOR_AUDIT_TYPES.verificationFailed, {
        verification_id: row.id,
        archive_sha256: sha256(archive),
        cutoff: checked.cutoff,
        entities: checked.entities,
        problems: checked.problems,
      });
      return { id: row.id, passed, problems: checked.problems, cutoff: checked.cutoff, entities: checked.entities };
    },
    "service",
  );
}
