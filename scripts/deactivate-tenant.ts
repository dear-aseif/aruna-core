// Operator-only: deactivates a tenant after a verified, still-fresh export (task 10.4, design §2.9).
// Usage: npm run operator:deactivate -- --tenant <tenant-id> --operator <operator-id>
import { closeAllPools } from "../src/server/db";
import { deactivateTenant } from "../src/server/offboarding";
import { operatorCaller, parseArgs } from "./_operator";
(async () => {
  const r = await deactivateTenant(operatorCaller(parseArgs(["tenant", "operator"])));
  console.log(`tenant deactivated: ${r.expiredTaskIds.length} approval(s) expired, ${r.revokedSessions} session(s) revoked (verification ${r.verificationId})`);
  await closeAllPools();
})().catch((e) => {
  console.error(String((e as Error).message));
  process.exit(1);
});
