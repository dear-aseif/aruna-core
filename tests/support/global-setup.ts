import { enterRunGate } from "./run-gate";
/**
 * Vitest global setup: holds the cross-runner gate for the whole run; the returned teardown runs after
 * all test files and removes every recorded fixture (leftovers of a crashed run too), but only when no
 * other runner (Playwright) is still live on the shared database. See run-gate.ts.
 */
export default async function setup() {
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
