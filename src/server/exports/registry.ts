/**
 * Export entity registry (task 10.3, design §2.9).
 *
 * An entity is one tenant-scoped table exported as one JSON file (and one CSV file). Every entity
 * lists its columns EXPLICITLY: there is no `select *` anywhere in the export, so a column that
 * is not listed (for example a password hash or a session token) can never reach the archive.
 * The registry also refuses, at registration, a table or column that looks like credential
 * material, so a later pack cannot add one by mistake.
 *
 * The core entities are defined below. Packs register the entities of their own tables
 * (treatments, bookings, products, variants, stock, suppliers, purchase orders and lines...) with
 * `registerExportEntity` when those tables are created (task groups 12 and 13). The export
 * covers every registered entity regardless of which pack is active for the tenant.
 */
export interface ExportEntity {
  /** File stem and manifest key, for example `tasks`. */
  name: string;
  /** Tenant-scoped table with row-level security. Read only through the tenant's own session. */
  table: string;
  /** Exported columns, explicit. The first column order is the CSV header order. */
  columns: readonly string[];
  /** Columns that give a stable, total order of the rows. */
  orderBy: readonly string[];
  /** `core`, or the id of the pack that owns the table. */
  owner: string;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
/** Tables and column names that hold credentials or auth secrets. Never exportable. */
const FORBIDDEN_TABLES = new Set(["profiles", "sessions", "accounts", "verification_tokens"]);
const FORBIDDEN_COLUMN = /pass(word|wd)|hash|secret|token|api_?key|credential/i;

export const CORE_EXPORT_ENTITIES: readonly ExportEntity[] = [
  {
    name: "business_profile",
    table: "tenants",
    columns: ["id", "name", "type", "active_pack", "timezone", "status", "created_at", "updated_at"],
    orderBy: ["id"],
    owner: "core",
  },
  {
    name: "playbooks",
    table: "playbooks",
    columns: ["id", "tenant_id", "version", "config", "active", "created_at"],
    orderBy: ["version"],
    owner: "core",
  },
  {
    name: "settings",
    table: "settings",
    columns: ["tenant_id", "assistant_name", "model_provider", "model_id", "ui_language", "updated_at"],
    orderBy: ["tenant_id"],
    owner: "core",
  },
  {
    name: "tasks",
    table: "tasks",
    columns: [
      "id", "tenant_id", "title", "origin", "agent", "status", "payload", "payload_revision",
      "anomaly", "error", "approval_expires_at", "created_by", "created_at", "updated_at",
    ],
    orderBy: ["created_at", "id"],
    owner: "core",
  },
  {
    name: "threads",
    table: "threads",
    columns: ["id", "tenant_id", "kind", "agent", "title", "created_at"],
    orderBy: ["created_at", "id"],
    owner: "core",
  },
  {
    name: "messages",
    table: "messages",
    columns: ["id", "tenant_id", "thread_id", "sender", "body", "task_id", "seq", "created_at"],
    orderBy: ["seq"],
    owner: "core",
  },
  {
    name: "briefings",
    table: "briefings",
    columns: ["id", "tenant_id", "date", "sections", "created_at"],
    orderBy: ["date", "id"],
    owner: "core",
  },
  {
    name: "audit_log",
    table: "audit_log",
    columns: ["id", "tenant_id", "task_id", "actor", "actor_id", "type", "payload", "created_at", "seq"],
    orderBy: ["created_at", "seq"],
    owner: "core",
  },
];

const registered = new Map<string, ExportEntity>(CORE_EXPORT_ENTITIES.map((e) => [e.name, e]));

export function validateExportEntity(e: ExportEntity): void {
  if (!IDENT.test(e.name) || !IDENT.test(e.table)) throw new Error(`export entity ${e.name}: invalid name or table`);
  if (FORBIDDEN_TABLES.has(e.table)) throw new Error(`export entity ${e.name}: table ${e.table} holds credentials and is never exported`);
  if (e.columns.length === 0 || e.orderBy.length === 0) throw new Error(`export entity ${e.name}: columns and orderBy are required`);
  for (const c of [...e.columns, ...e.orderBy]) {
    if (!IDENT.test(c)) throw new Error(`export entity ${e.name}: invalid column ${c}`);
    if (FORBIDDEN_COLUMN.test(c)) throw new Error(`export entity ${e.name}: column ${c} looks like credential material and is never exported`);
  }
  if (!e.orderBy.every((c) => e.columns.includes(c))) throw new Error(`export entity ${e.name}: orderBy must be exported columns`);
}

/** Register a pack's entity. Names are unique; a duplicate is an error. */
export function registerExportEntity(e: ExportEntity): void {
  validateExportEntity(e);
  if (registered.has(e.name)) throw new Error(`export entity already registered: ${e.name}`);
  registered.set(e.name, e);
}

/** Test support: remove a registered (non-core) entity. */
export function unregisterExportEntity(name: string): void {
  if (!CORE_EXPORT_ENTITIES.some((c) => c.name === name)) registered.delete(name);
}

export const listExportEntities = (): ExportEntity[] => [...registered.values()];
