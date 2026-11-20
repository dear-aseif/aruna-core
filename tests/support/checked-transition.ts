import type { TenantTx } from "@/server/dal";
import { recordCheckerResult } from "@/server/audit";
import { transitionTask, type TaskStatus, type TransitionOptions } from "@/server/tasks";

/** Record a passing deterministic checker.result for the task's CURRENT payload revision (what the Checker does). */
export async function recordPassingCheck(tx: TenantTx, taskId: string): Promise<void> {
  const t = await tx.getById<{ payload_revision: number }>("tasks", taskId);
  await recordCheckerResult(tx, taskId, { stage: "deterministic", outcome: "pass", revision: t.payload_revision, route: "pending_approval" });
}

/**
 * transitionTask for fixtures: when the move is In Review -> Done / Pending Approval, first records the
 * passing check that gate ruling 6.4 requires. Every other move is passed straight through.
 */
export async function checkedTransition(tx: TenantTx, taskId: string, to: TaskStatus, opts: TransitionOptions = {}) {
  if (to === "done" || to === "pending_approval") {
    const t = await tx.getById<{ status: string }>("tasks", taskId);
    if (t.status === "in_review") await recordPassingCheck(tx, taskId);
  }
  return transitionTask(tx, taskId, to, opts);
}
