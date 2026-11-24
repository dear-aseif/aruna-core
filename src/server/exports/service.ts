import { createHash } from "node:crypto";
import { recordExport } from "../audit";
import type { Caller } from "../dal";
import { withTenant } from "../dal";
import { ShellForbiddenError } from "../workspace/shell";
import { buildZip, toCsv, type ArchiveFile } from "./archive";
import { listExportEntities, type ExportEntity } from "./registry";
import type { ExportResult } from "./index";

/**
 * The export service (task 10.3, design §2.9). One export = one tenant, read inside that tenant's
 * own session (RLS in force) through the Data Access Layer, in ONE SQL statement so every entity
 * comes from the same snapshot. The cutoff is the database's statement timestamp for that
 * statement (database time, not the app server's), recorded together with an entity-count manifest
 * in the archive and in the audit entry written in the same transaction.
 *
 * Archive layout (zip): `manifest.json`, then per entity `<name>.json` (and `<name>.csv` for
 * row entities) plus `catalog.json` (the active Playbook's catalog). Credentials and auth secrets
 * are never read: the SQL names its columns explicitly, and profiles/sessions are not exported.
 */
const q = (id: string) => `"${id}"`;

/** One statement; one column per entity, each a JSON array ordered by the entity's order columns. */
export function exportQuery(entities: readonly ExportEntity[]): string {
  const cols = entities.map((e) => {
    const select = e.columns.map(q).join(", ");
    const order = e.orderBy.map((c) => `r.${q(c)}`).join(", ");
    return `(select coalesce(jsonb_agg(to_jsonb(r) order by ${order}), '[]'::jsonb) from (select ${select} from ${q(e.table)}) r) as ${q(e.name)}`;
  });
  return `select statement_timestamp() as cutoff, ${cols.join(", ")}`;
}

type Row = Record<string, unknown>;

function catalogOf(playbooks: Row[]): { version: number | null; catalog: Record<string, unknown> } {
  const active = playbooks.find((p) => p.active === true);
  const config = (active?.config ?? {}) as { catalog?: unknown };
  const catalog = typeof config.catalog === "object" && config.catalog !== null ? (config.catalog as Record<string, unknown>) : {};
  return { version: typeof active?.version === "number" ? active.version : null, catalog };
}
const catalogCount = (catalog: Record<string, unknown>): number =>
  Object.values(catalog).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);

const json = (v: unknown): Uint8Array => Buffer.from(JSON.stringify(v, null, 2) + "\n", "utf8");

export async function runOwnerExport(caller: Caller): Promise<ExportResult> {
  if (caller.actor !== "owner") throw new ShellForbiddenError(); // the owner's own export; verification is operator-only (10.4)
  const entities = listExportEntities();
  return withTenant(caller, async (tx) => {
    const [row] = await tx.query<Row>(exportQuery(entities));
    const cutoff = (row.cutoff as Date).toISOString();
    const data = new Map<string, Row[]>(entities.map((e) => [e.name, row[e.name] as Row[]]));
    const catalog = catalogOf(data.get("playbooks") ?? []);

    const counts: Record<string, number> = {};
    for (const e of entities) counts[e.name] = data.get(e.name)!.length;
    counts.catalog = catalogCount(catalog.catalog);

    const files: ArchiveFile[] = [];
    for (const e of entities) {
      const rows = data.get(e.name)!;
      files.push({ path: `${e.name}.json`, data: json(rows) });
      files.push({ path: `${e.name}.csv`, data: Buffer.from(toCsv(e.columns, rows), "utf8") });
    }
    files.push({ path: "catalog.json", data: json(catalog) });

    const manifest = {
      format: "aruna-export/1",
      tenantId: tx.tenantId,
      cutoff,
      entities: counts,
      files: files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: createHash("sha256").update(f.data).digest("hex") })),
    };
    files.unshift({ path: "manifest.json", data: json(manifest) });

    const fileName = `aruna-export-${cutoff.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.zip`;
    // The export is itself audited, in the same transaction, with the manifest counts (R6.1).
    await recordExport(tx, { cutoff, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), fileName });
    return { summary: { cutoff, manifest: counts, fileName }, archive: buildZip(files, new Date(cutoff)) };
  });
}
