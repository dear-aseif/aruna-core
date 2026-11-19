// Removes every tenant except the two seeded ones (test debris), as the migrator.
// Usage: npx tsx --env-file=.env.local scripts/cleanup-test-tenants.ts
import { closeAllPools } from "../src/server/db";
import { deleteTenants, listNonSeedTenantIds } from "../tests/support/tenant-cleanup";

(async () => {
  const ids = await listNonSeedTenantIds();
  const removed = await deleteTenants(ids);
  console.log(`removed ${removed} non-seed tenant(s)`);
  await closeAllPools();
})().catch((e) => {
  console.error(String((e as Error).message));
  process.exit(1);
});
