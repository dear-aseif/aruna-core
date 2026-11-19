import { closeAllPools, getPool, withTenantSession } from "../src/server/db";
import type { DbRole } from "../src/server/db";
import { describeError } from "./_util";

let failed = false;
const pass = (m: string) => console.log(`PASS ${m}`);
const fail = (m: string, err: unknown) => {
  failed = true;
  console.error(`FAIL ${m}: ${describeError(err)}`);
};

async function main() {
  for (const role of ["migrator", "app", "service"] as DbRole[]) {
    try {
      const r = await getPool(role).query("select 1 as ok");
      if (r.rows[0].ok !== 1) throw new Error("unexpected result");
      pass(`${role} role: connected over TLS, select 1`);
    } catch (err) {
      fail(`${role} role connect`, err);
    }
  }

  try {
    const probe = "00000000-0000-0000-0000-000000000001";
    const seen = await withTenantSession(probe, async (c) => {
      const r = await c.query<{ v: string }>("select current_setting('app.tenant_id') as v");
      return r.rows[0].v;
    });
    if (seen !== probe) throw new Error("tenant variable did not round-trip");
    // transaction-local: must not leak to the next use of the pool
    const after = await getPool("app").query<{ v: string | null }>("select current_setting('app.tenant_id', true) as v");
    if (after.rows[0].v) throw new Error("tenant variable leaked outside the transaction");
    pass("app role: tenant variable round-trips inside a transaction and does not leak after it");
  } catch (err) {
    fail("app role tenant round-trip", err);
  }

  try {
    await withTenantSession("", async () => {});
    fail("fail-closed check", new Error("empty tenant id was accepted"));
  } catch {
    pass("app role: empty tenant id is refused (fails closed)");
  }

  try {
    const r = await getPool("app").query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean }>(
      "select rolsuper, rolbypassrls, rolcreatedb from pg_roles where rolname = current_user",
    );
    const a = r.rows[0];
    if (a.rolsuper || a.rolbypassrls || a.rolcreatedb) throw new Error("app role has elevated attributes");
    pass("app role: not superuser, no BYPASSRLS, no CREATEDB");
  } catch (err) {
    fail("app role attributes", err);
  }

  await coreSchemaChecks();
}

const CORE_TABLES = ["tenants", "profiles", "playbooks", "settings", "audit_log"];

async function expectCode(label: string, code: string, run: () => Promise<unknown>) {
  try {
    await run();
    fail(label, new Error("statement was accepted"));
  } catch (err) {
    const got = (err as { code?: string }).code;
    if (got === code) pass(label);
    else fail(label, err);
  }
}

// Task 2.1 checks. Synthetic data only; every write runs in a transaction that is rolled back.
async function coreSchemaChecks() {
  try {
    const r = await getPool("migrator").query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)",
      [CORE_TABLES],
    );
    const missing = CORE_TABLES.filter((t) => !r.rows.some((x) => x.relname === t));
    const weak = r.rows.filter((x) => !x.relrowsecurity || !x.relforcerowsecurity).map((x) => x.relname);
    if (missing.length || weak.length) throw new Error(`missing: [${missing}] RLS not enabled+forced: [${weak}]`);
    pass(`RLS enabled and forced on ${CORE_TABLES.join(", ")}`);
  } catch (err) {
    fail("RLS enabled and forced on core tables", err);
  }

  try {
    const r = await getPool("service").query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    if (r.rows[0].rolsuper || r.rows[0].rolbypassrls) throw new Error("service role bypasses RLS");
    const runtime = [await roleOf("app"), await roleOf("service")];
    const p = await getPool("migrator").query<{ policyname: string }>(
      "select policyname from pg_policies where schemaname = 'public' and tablename = any($1) and (qual = 'true' or with_check = 'true') and roles && $2::name[]",
      [CORE_TABLES, runtime],
    );
    if (p.rows.length) throw new Error(`unconditional policy for a runtime role: ${p.rows.map((x) => x.policyname)}`);
    pass("service role: no BYPASSRLS and no blanket policy on core tables");
  } catch (err) {
    fail("service role has no RLS bypass", err);
  }

  try {
    const unknown = "00000000-0000-0000-0000-0000000000aa";
    const n = await withTenantSession(unknown, async (c) => (await c.query("select 1 from tenants")).rowCount, "service");
    if (n !== 0) throw new Error(`service role saw ${n} tenant rows outside any tenant`);
    const ids = await getPool("service").query<{ id: string }>("select aruna_list_tenant_ids() as id");
    if (!Array.isArray(ids.rows)) throw new Error("bootstrap lookup failed");
    pass("service role: sees no tenant rows without a tenant session; bootstrap lookup returns ids only");
  } catch (err) {
    fail("service role tenant scoping", err);
  }

  await expectCode("app role: bootstrap tenant lookup is refused", "42501", () =>
    getPool("app").query("select aruna_list_tenant_ids()"),
  );

  // audit_log is append-only for both application roles.
  for (const role of ["app", "service"] as const) {
    const t = "00000000-0000-0000-0000-0000000000bb";
    await expectCode(`${role} role: UPDATE on audit_log refused`, "42501", () =>
      withTenantSession(t, (c) => c.query("update audit_log set payload = '{}'::jsonb"), role),
    );
    await expectCode(`${role} role: DELETE on audit_log refused`, "42501", () =>
      withTenantSession(t, (c) => c.query("delete from audit_log"), role),
    );
    await expectCode(`${role} role: TRUNCATE on audit_log refused`, "42501", () =>
      withTenantSession(t, (c) => c.query("truncate audit_log"), role),
    );
  }

  // Even the table owner is stopped by the trigger.
  await expectCode("owner: TRUNCATE on audit_log refused by trigger", "42501", () => getPool("migrator").query("truncate audit_log"));

  // Tenant isolation on write: a tenant session cannot insert a row for another tenant.
  try {
    const a = "00000000-0000-0000-0000-00000000a001";
    const b = "00000000-0000-0000-0000-00000000b002";
    const client = await getPool("service").connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [a]);
      await client.query("insert into tenants (id, name, type) values ($1, 'Synthetic Shop A', 'retail')", [a]);
      await client.query("savepoint s");
      let refused = false;
      try {
        await client.query("insert into tenants (id, name, type) values ($1, 'Synthetic Shop B', 'retail')", [b]);
      } catch (e) {
        refused = (e as { code?: string }).code === "42501";
      }
      await client.query("rollback to savepoint s");
      if (!refused) throw new Error("cross-tenant insert was not refused by RLS");
      await client.query("insert into audit_log (tenant_id, actor, actor_id, type) values ($1, 'system', 'db-check', 'check.synthetic')", [a]);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
    pass("RLS: cross-tenant insert refused; same-tenant insert and audit append accepted (rolled back)");
  } catch (err) {
    fail("RLS cross-tenant write", err);
  }
}

async function roleOf(role: DbRole): Promise<string> {
  const r = await getPool(role).query<{ u: string }>("select current_user as u");
  return r.rows[0].u;
}

main()
  .catch((err) => fail("db-check", err))
  .finally(async () => {
    await closeAllPools();
    process.exit(failed ? 1 : 0);
  });
