import { closeAllPools } from "@/server/db";
import { SEEDED_TENANT_IDS, deleteTenants, purgeTestAuditEntries } from "./tenant-cleanup";
import { clearLedger, readLedger } from "./ledger";

/** Runs once after all test files: removes every fixture they recorded (leftovers of a crashed run too). */
export default function setup() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* env may already be provided by the shell */
  }
  return async () => {
    const { tenants, auditActors } = readLedger();
    try {
      await deleteTenants(tenants);
      for (const a of auditActors) await purgeTestAuditEntries(SEEDED_TENANT_IDS, a);
      clearLedger();
    } finally {
      await closeAllPools();
    }
  };
}
