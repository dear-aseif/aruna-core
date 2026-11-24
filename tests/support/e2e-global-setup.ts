import { enterRunGate } from "./run-gate";
/**
 * Playwright global setup: holds the cross-runner gate for the whole run. The returned function is the
 * global teardown: after every worker has finished it removes the recorded fixtures, but only when no
 * other runner (Vitest) is still live on the shared database. Specs only record (deferTenantCleanup).
 */
export default async function globalSetup() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* env may already be provided by the shell */
  }
  const gate = await enterRunGate();
  return async () => {
    await gate.finish();
  };
}
