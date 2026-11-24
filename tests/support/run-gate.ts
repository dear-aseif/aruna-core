import { Client } from "pg";
import { closeAllPools } from "../../src/server/db";
import { poolConfigFor } from "../../src/server/db/config";
import { clearLedger, readLedger } from "./ledger";
import { SEEDED_TENANT_IDS, deleteTenants, purgeTestAuditEntries } from "./tenant-cleanup";
/**
 * Cross-runner gate for fixture cleanup (task 11.1, Flake Watch).
 *
 * Cause it fixes: fixture cleanup has to run as the migrator with `ALTER TABLE ... DISABLE ROW LEVEL
 * SECURITY` / `DISABLE TRIGGER` on eleven tables (the owner is subject to FORCE RLS). Each ALTER takes
 * an ACCESS EXCLUSIVE lock, held to commit. Run while other test traffic is live on the shared database
 * (the e2e specs used to clean up inline in afterAll; the Vitest teardown ran while Playwright was still
 * running, and vice versa), it (1) queues every other session's query on those tables behind it, so
 * sign-ins, approvals and connects stall past their timeouts, and (2) acquires the locks table by table
 * while live transactions hold some of those tables and wait for others, so Postgres kills one side with
 * `deadlock detected`.
 *
 * The gate: every runner holds a SHARED session advisory lock on one dedicated connection for its whole
 * run. At teardown it drops its shared lock and tries the EXCLUSIVE lock without waiting. Only a runner
 * that gets it (no other runner is live) runs the cleanup DDL, for the whole shared ledger; otherwise it
 * leaves the ledger to the runner still running. A new runner cannot start while a cleanup holds the
 * exclusive lock (it waits for its shared lock), so no test traffic ever overlaps the DDL.
 */
const GATE_KEY = 5150002;
async function connectGate(): Promise<Client> {
  const { max: _max, idleTimeoutMillis: _idle, ...cfg } = poolConfigFor("migrator");
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const c = new Client({ ...cfg, keepAlive: true, application_name: "aruna-test-gate" });
    c.on("error", () => {}); // a dropped gate connection must not crash the runner
    try {
      await c.connect();
      return c;
    } catch (err) {
      last = err;
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw last;
}
export interface RunGate {
  /** Drops this runner's hold; cleans the shared ledger if no other runner is live. Returns whether it cleaned. */
  finish(): Promise<boolean>;
}
export async function enterRunGate(): Promise<RunGate> {
  const gate = await connectGate();
  await gate.query("select pg_advisory_lock_shared($1)", [GATE_KEY]); // waits while a cleanup runs
  return {
    async finish() {
      let owner: Client = gate;
      try {
        try {
          await gate.query("select pg_advisory_unlock_shared($1)", [GATE_KEY]);
        } catch {
          // The gate connection dropped (its locks went with it); take the exclusive try on a fresh one.
          owner = await connectGate();
        }
        const got = (await owner.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [GATE_KEY])).rows[0].ok;
        if (!got) return false; // another runner is live; it cleans the ledger when it finishes
        try {
          const { tenants, auditActors } = readLedger();
          await deleteTenants(tenants);
          for (const a of auditActors) await purgeTestAuditEntries(SEEDED_TENANT_IDS, a);
          clearLedger();
          return true;
        } finally {
          await owner.query("select pg_advisory_unlock($1)", [GATE_KEY]).catch(() => {});
        }
      } finally {
        await closeAllPools();
        await gate.end().catch(() => {});
        if (owner !== gate) await owner.end().catch(() => {});
      }
    },
  };
}
