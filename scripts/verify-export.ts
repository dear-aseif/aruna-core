// Operator-only: verifies an export archive against its own manifest and records the result (task 10.4, design §2.9).
// Usage: npm run operator:verify-export -- --tenant <tenant-id> --archive <path/to/export.zip> --operator <operator-id>
import { readFileSync } from "node:fs";
import { closeAllPools } from "../src/server/db";
import { verifyExport } from "../src/server/offboarding";
import { operatorCaller, parseArgs } from "./_operator";
(async () => {
  const a = parseArgs(["tenant", "archive", "operator"]);
  const r = await verifyExport(operatorCaller(a), readFileSync(a.archive));
  console.log(`export verification ${r.passed ? "PASSED" : "FAILED"} (record ${r.id}, cutoff ${r.cutoff ?? "none"})`);
  for (const p of r.problems) console.error(`  - ${p}`);
  await closeAllPools();
  if (!r.passed) process.exit(1);
})().catch((e) => {
  console.error(String((e as Error).message));
  process.exit(1);
});
