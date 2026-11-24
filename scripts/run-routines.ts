// Runs the briefing routine engine once (task 10.1). Per-minute cron wiring is deployment work (task 11.2).
// Usage: npm run routines:run
import { closeAllPools } from "../src/server/db";
import { installBriefingArchive } from "../src/server/briefings";
import { runBriefingRoutines } from "../src/server/routines";
(async () => {
  installBriefingArchive(); // each run's facts are stored in the briefings archive (task 10.2)
  const r = await runBriefingRoutines();
  console.log(`routines: ${r.tenants} tenant(s), ${r.ran} briefing run(s), ${r.failed} failure(s)`);
  for (const t of r.results) if (t.outcome === "failed") console.error(`  ${t.tenantId}: ${t.error}`);
  await closeAllPools();
  if (r.failed) process.exit(1);
})().catch((e) => {
  console.error(String((e as Error).message));
  process.exit(1);
});
