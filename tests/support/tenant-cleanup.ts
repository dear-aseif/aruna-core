import { getPool } from "@/server/db";

/** The two seeded proof tenants (task 2.5). Cleanup refuses to touch them. */
export const SEEDED_TENANT_IDS = [
  "5eed0000-0000-4000-8000-00000000d3a1",
  "5eed0000-0000-4000-8000-00000000a5e2",
] as const;

// Children first: sessions -> profiles (composite FK), audit_log -> tasks (composite FK), everything -> tenants (ON DELETE RESTRICT).
const CHILD_TABLES = ["export_verifications", "sessions", "messages", "threads", "briefings", "audit_log", "tasks", "playbooks", "settings", "profiles"] as const;
const RLS_TABLES = [...CHILD_TABLES, "tenants"] as const;

const TRANSIENT = /lock timeout|could not obtain lock|deadlock|connection timeout|Connection terminated|ECONNRESET|ETIMEDOUT/i;
/**
 * Runs one cleanup transaction with a SHORT lock_timeout and bounded retries. The cleanup DDL needs
 * ACCESS EXCLUSIVE locks; while it waits for them it queues every other session behind itself, so a
 * long wait stalls the whole suite (sign-ins, approvals, teardown connects). A short timeout caps that
 * stall; the retry (with jitter) then tries again once the table is quiet. Connection failures retry too.
 */
async function cleanupTx<T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 12; attempt++) {
    let client: import("pg").PoolClient | undefined;
    try {
      client = await getPool("migrator").connect();
      await client.query("begin");
      await client.query("set local lock_timeout = '2s'");
      await client.query("select pg_advisory_xact_lock(5150001)"); // serialize concurrent cleanups
      const out = await work(client);
      await client.query("commit");
      return out;
    } catch (err) {
      last = err;
      if (client) await client.query("rollback").catch(() => {});
      if (!TRANSIENT.test(String((err as Error)?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 250 * attempt + Math.random() * 500));
    } finally {
      client?.release();
    }
  }
  throw last;
}
/**
 * Test-support only (never imported by src/). Removes synthetic tenants and every dependent row
 * as the MIGRATOR (table owner), in one transaction:
 *  - FORCE RLS applies to the owner and no policy names it, so RLS is disabled on the affected
 *    tables for the duration and re-enabled and re-forced before commit (DDL is transactional);
 *  - the append-only trigger on audit_log is disabled for the row deletes and re-enabled before commit.
 * Seeded tenants are refused. A new tenant-scoped table not listed above aborts the cleanup.
 */
export async function deleteTenants(ids: readonly string[]): Promise<number> {
  const targets = [...new Set(ids)];
  if (targets.length === 0) return 0;
  const seeded = targets.filter((i) => (SEEDED_TENANT_IDS as readonly string[]).includes(i));
  if (seeded.length) throw new Error("refusing to delete a seeded tenant");

  return cleanupTx(async (client) => {
    const found = await client.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id'",
    );
    const unknown = found.rows.map((r) => r.table_name).filter((t) => !(CHILD_TABLES as readonly string[]).includes(t));
    if (unknown.length) throw new Error(`cleanup does not know tenant-scoped table(s): ${unknown.join(", ")}`);
    for (const t of RLS_TABLES) await client.query(`alter table "${t}" disable row level security`);
    await client.query("alter table audit_log disable trigger audit_log_no_update_delete");
    for (const t of CHILD_TABLES) await client.query(`delete from "${t}" where tenant_id = any($1::uuid[])`, [targets]);
    const res = await client.query("delete from tenants where id = any($1::uuid[])", [targets]);
    await client.query("alter table audit_log enable trigger audit_log_no_update_delete");
    for (const t of RLS_TABLES) {
      await client.query(`alter table "${t}" enable row level security`);
      await client.query(`alter table "${t}" force row level security`);
    }
    return res.rowCount ?? 0;
  });
}
/** Every tenant id in the database except the two seeded ones (migrator view: RLS briefly off, read-only). */
export async function listNonSeedTenantIds(): Promise<string[]> {
  const client = await getPool("migrator").connect();
  try {
    await client.query("begin");
    await client.query('alter table "tenants" disable row level security');
    const r = await client.query<{ id: string }>("select id from tenants where id <> all($1::uuid[])", [SEEDED_TENANT_IDS]);
    await client.query('alter table "tenants" enable row level security');
    await client.query('alter table "tenants" force row level security');
    await client.query("commit");
    return r.rows.map((x) => x.id);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Removes the audit rows a test itself wrote under a seeded tenant, so the seeded tenants stay
 * as they were. Only rows whose actor_id starts with "test-" can be removed, and only for the
 * given tenants. Runs as the migrator with the append-only trigger and RLS handled as above.
 */
export async function purgeTestAuditEntries(tenantIds: readonly string[], actorId: string): Promise<number> {
  if (!actorId.startsWith("test-")) throw new Error("only test-* actor ids may be purged");
  return cleanupTx(async (client) => {
    await client.query('alter table "audit_log" disable row level security');
    await client.query("alter table audit_log disable trigger audit_log_no_update_delete");
    const res = await client.query("delete from audit_log where actor_id = $1 and tenant_id = any($2::uuid[])", [actorId, tenantIds]);
    await client.query("alter table audit_log enable trigger audit_log_no_update_delete");
    await client.query('alter table "audit_log" enable row level security');
    await client.query('alter table "audit_log" force row level security');
    return res.rowCount ?? 0;
  });
}
