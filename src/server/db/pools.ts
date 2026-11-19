import { Pool, type PoolClient } from "pg";
import { poolConfigFor, type DbRole } from "./config";

// One pool per role, created lazily and cached across dev hot reloads.
const g = globalThis as unknown as { __arunaPools?: Partial<Record<DbRole, Pool>> };

export function getPool(role: DbRole): Pool {
  const pools = (g.__arunaPools ??= {});
  let pool = pools[role];
  if (!pool) {
    pool = new Pool(poolConfigFor(role));
    // An idle-client error must not crash the process.
    pool.on("error", () => {});
    pools[role] = pool;
  }
  return pool;
}

export async function closeAllPools(): Promise<void> {
  const pools = g.__arunaPools ?? {};
  g.__arunaPools = {};
  await Promise.all(Object.values(pools).map((p) => p?.end()));
}

/**
 * Seed of the Data Access Layer (full DAL is task 2.3). Runs `work` in one
 * transaction after binding the tenant with a bound parameter. `set_config`'s
 * third argument `true` makes it transaction-local, equal to SET LOCAL, so
 * the value cannot leak to another request on a pooled connection.
 * Fails closed: an empty tenant id never opens a transaction.
 * Only the app and service roles may be used; the migrator never runs at runtime.
 */
export async function withTenantSession<T>(
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
  role: Exclude<DbRole, "migrator"> = "app",
): Promise<T> {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("withTenantSession: tenant id is required (failing closed)");
  }
  const client = await getPool(role).connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* connection already unusable; original error is what matters */
    }
    throw err;
  } finally {
    client.release();
  }
}
