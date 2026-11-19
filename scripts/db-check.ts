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
}

main()
  .catch((err) => fail("db-check", err))
  .finally(async () => {
    await closeAllPools();
    process.exit(failed ? 1 : 0);
  });
