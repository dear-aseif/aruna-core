import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Fixture ledger. Test files record the synthetic tenants they create (and the `test-` actor ids
 * whose audit rows they wrote under seeded tenants). The global teardown removes them all, once,
 * after every test file of every concurrently running test runner has finished (run-gate.ts). Cleanup needs brief table-level DDL as the
 * migrator (the owner is subject to FORCE RLS), which takes ACCESS EXCLUSIVE locks and stalls every
 * other session touching those tables; so it runs once, at the end, never inline in a spec.
 */
// One ledger shared by both runners (Vitest and Playwright); only the last runner to finish empties it (see run-gate.ts).
// Not under test-results/: Playwright empties that folder when it starts, which would drop the entries a
// concurrently running Vitest run had already recorded (leaked tenants). node_modules/ is git-ignored.
export const LEDGER_FILE = path.join(process.cwd(), "node_modules", ".cache", "aruna-fixture-ledger.txt");

export function trackTenant(id: string): void {
  mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  appendFileSync(LEDGER_FILE, `tenant:${id}\n`);
}

/** Records tenants for the runner's global teardown (the only place cleanup DDL runs). Never delete inline in a spec. */
export function deferTenantCleanup(ids: readonly string[]): void {
  for (const id of ids) trackTenant(id);
}
export function trackSeedAuditActor(actorId: string): void {
  mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  appendFileSync(LEDGER_FILE, `audit:${actorId}\n`);
}

export function readLedger(): { tenants: string[]; auditActors: string[] } {
  if (!existsSync(LEDGER_FILE)) return { tenants: [], auditActors: [] };
  const lines = readFileSync(LEDGER_FILE, "utf8").split("\n").filter(Boolean);
  const pick = (p: string) => [...new Set(lines.filter((l) => l.startsWith(p)).map((l) => l.slice(p.length)))];
  return { tenants: pick("tenant:"), auditActors: pick("audit:") };
}

export function clearLedger(): void {
  rmSync(LEDGER_FILE, { force: true });
}
