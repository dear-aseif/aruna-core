// Runs the stale-attempt recovery sweep once (task 8.2). Per-minute cron wiring is deployment work (group 14).
// Usage: npm run tasks:recover
import { closeAllPools } from "../src/server/db";
import { sweepStaleAttempts } from "../src/server/tasks";
(async () => {
  const r = await sweepStaleAttempts();
  console.log(`stale-attempt sweep: ${r.tenants} tenant(s), ${r.requeued} requeued, ${r.failed} failed, ${r.errors.length} error(s)`);
  for (const e of r.errors) console.error(`  ${e.tenantId}${e.taskId ? `/${e.taskId}` : ""}: ${e.message}`);
  await closeAllPools();
  if (r.errors.length) process.exit(1);
})().catch((e) => {
  console.error(String((e as Error).message));
  process.exit(1);
});
