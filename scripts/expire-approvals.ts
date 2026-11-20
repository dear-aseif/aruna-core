// Runs the approval-expiry sweep once (task 4.3). Per-minute cron wiring is deployment work (group 14).
// Usage: npm run tasks:sweep
import { closeAllPools } from "../src/server/db";
import { sweepExpiredApprovals } from "../src/server/tasks";
(async () => {
  const r = await sweepExpiredApprovals();
  console.log(`expiry sweep: ${r.tenants} tenant(s), ${r.expired} task(s) expired, ${r.errors.length} error(s)`);
  for (const e of r.errors) console.error(`  ${e.tenantId}${e.taskId ? `/${e.taskId}` : ""}: ${e.message}`);
  await closeAllPools();
  if (r.errors.length) process.exit(1);
})().catch((e) => {
  console.error(String((e as Error).message));
  process.exit(1);
});
