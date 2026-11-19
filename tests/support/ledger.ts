import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Fixture ledger. Test files record the synthetic tenants they create (and the `test-` actor ids
 * whose audit rows they wrote under seeded tenants). The global teardown removes them all, once,
 * after every test file has finished. Cleanup needs brief table-level DDL as the migrator (the
 * owner is subject to FORCE RLS), which must never overlap other test files' transactions.
 */
export const LEDGER_FILE = path.join(process.cwd(), "test-results", "fixture-ledger.txt"); // test-results/ is git-ignored

export function trackTenant(id: string): void {
  mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  appendFileSync(LEDGER_FILE, `tenant:${id}\n`);
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
