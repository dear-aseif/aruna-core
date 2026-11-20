import type { TenantTx } from "../dal";
import { NotFoundError } from "../dal/errors";
import { getActivePack } from "../playbook";
import { AUDIT_TYPES, getTaskHistory, recordCheckerResult } from "../audit";
import { transitionTask, type TaskRow, type TaskStatus } from "../tasks";
import { getActionType, getCheckerPack } from "./registry";
import { readPath, type Anomaly, type CheckRule } from "./rules";

/**
 * Checker service (task 6.1, design §2.4 step 1 and §2.7 rework bound).
 *
 * Runs on a task in In Review and checks the draft's structured fields (`payload.fields`) against
 * source records with the pack's pure rules. The task row is locked, then in ONE transaction the
 * anomaly is written, a `checker.result` audit entry is recorded against the exact
 * `payload_revision` that was checked, and the task moves through the state machine:
 *   pass + gated action      -> Pending Approval
 *   pass + non-gated action  -> Done
 *   fail                     -> Working, with the anomaly on the task (at most MAX_REWORK_RETURNS times)
 *   fail after the bound     -> Failed (no further loop)
 * Payload shape this slice relies on: `payload.action_type` (string) and `payload.fields` (object).
 * Model review (task 6.2) lives in ./review.ts and reuses runDeterministicChecks / routeChecked.
 */
export const MAX_REWORK_RETURNS = 3;

export type CheckRoute = Extract<TaskStatus, "pending_approval" | "done" | "working" | "failed">;

export class NotInReviewError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: string,
  ) {
    super(`the Checker runs only on tasks in review (status: ${status})`);
    this.name = "NotInReviewError";
  }
}

/** No rules are registered for the pack. Nothing was changed: a draft never passes unchecked. */
export class NoCheckerRulesError extends Error {
  constructor(readonly packId: string) {
    super(`no checker rules registered for pack: ${packId}`);
    this.name = "NoCheckerRulesError";
  }
}

export interface CheckOutcome {
  passed: boolean;
  route: CheckRoute;
  /** The payload revision that was checked. */
  revision: number;
  anomalies: Anomaly[];
  /** Failed checks that returned this task to Working, including this one when it did. */
  reworkReturns: number;
  task: TaskRow;
}

export interface CheckOptions {
  /** Server-trusted override of the pack whose rules apply. Default: the tenant's active pack. */
  packId?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function evaluate(packRules: readonly CheckRule[], actionType: string, fields: Record<string, unknown>, sources: Record<string, unknown>): Anomaly[] {
  const out: Anomaly[] = [];
  for (const rule of packRules) {
    if (rule.actionTypes && !rule.actionTypes.includes(actionType)) continue;
    try {
      out.push(...rule.check({ fields, sources }));
    } catch (e) {
      // A rule that throws is a defect, never a pass.
      out.push({ rule: rule.id, message: `rule could not be evaluated: ${(e as Error).message}` });
    }
  }
  return out;
}

/** Returns to Working already recorded for this task (durable: counted from its audit history). */
async function priorReworkReturns(tx: TenantTx, taskId: string): Promise<number> {
  const history = await getTaskHistory(tx, taskId);
  return history.filter((e) => e.type === AUDIT_TYPES.checkerResult && e.payload.route === "working").length;
}

/** The locked task plus the result of the deterministic checks (task 6.1), before any routing. */
export interface DeterministicCheck {
  task: TaskRow;
  packId: string;
  actionType: unknown;
  action: ReturnType<typeof getActionType>;
  fields: Record<string, unknown> | null;
  revision: number;
  anomalies: Anomaly[];
}

/** Lock the task and run the deterministic checks. Writes nothing. */
export async function runDeterministicChecks(tx: TenantTx, taskId: string, opts: CheckOptions = {}): Promise<DeterministicCheck> {
  const task = await tx.maybeOne<TaskRow>("select * from tasks where id = $1 for update", [taskId]);
  if (!task) throw new NotFoundError("tasks");
  if (task.status !== "in_review") throw new NotInReviewError(taskId, task.status);

  const packId = opts.packId ?? (await getActivePack(tx));
  const pack = getCheckerPack(packId);
  if (!pack) throw new NoCheckerRulesError(packId);

  const actionType = readPath(task.payload, "action_type");
  const action = getActionType(actionType);
  const rawFields = readPath(task.payload, "fields");

  let anomalies: Anomaly[];
  if (!action) {
    anomalies = [
      {
        rule: "action_type",
        field: "action_type",
        message: typeof actionType === "string" ? `action type "${actionType}" is not registered` : "the draft has no action type",
      },
    ];
  } else if (!isRecord(rawFields)) {
    anomalies = [{ rule: "fields", field: "fields", message: "the draft has no structured fields" }];
  } else {
    const sources = (await pack.loadSources?.(tx, task)) ?? {};
    anomalies = evaluate(pack.rules, action.type, rawFields, sources);
  }
  return { task, packId, actionType, action, fields: isRecord(rawFields) ? rawFields : null, revision: task.payload_revision, anomalies };
}

/**
 * Route a checked task and write the anomaly, the `checker.result` audit entry and the transition
 * in the caller's transaction. `stage` distinguishes deterministic results from model-review ones.
 * Anomalies (deterministic or model flags) send the task back to Working until the rework bound.
 */
export async function routeChecked(
  tx: TenantTx,
  check: DeterministicCheck,
  anomalies: Anomaly[],
  stage: "deterministic" | "model_review",
  extra: Record<string, unknown> = {},
): Promise<CheckOutcome> {
  const { task, packId, actionType, action, revision } = check;
  const taskId = task.id;
  const passed = anomalies.length === 0;
  const prior = await priorReworkReturns(tx, taskId);
  let route: CheckRoute;
  if (passed) route = action!.gated ? "pending_approval" : "done";
  else route = prior >= MAX_REWORK_RETURNS ? "failed" : "working";
  const reworkReturns = route === "working" ? prior + 1 : prior;

  const summary = anomalies.map((a) => a.message).join("; ");
  await tx.query("update tasks set anomaly = $2, updated_at = now() where id = $1", [taskId, passed ? null : summary]);
  await recordCheckerResult(tx, taskId, {
    stage,
    outcome: passed ? "pass" : "fail",
    revision,
    pack: packId,
    action_type: typeof actionType === "string" ? actionType : null,
    route,
    rework_returns: reworkReturns,
    max_rework_returns: MAX_REWORK_RETURNS,
    anomalies,
    ...extra,
  });
  const updated = await transitionTask(
    tx,
    taskId,
    route,
    route === "failed"
      ? { error: `rework exhausted after ${MAX_REWORK_RETURNS} returns to Working: ${summary}`, reason: "rework_exhausted" }
      : { reason: passed ? "checker_passed" : stage === "model_review" ? "model_review_flag" : "checker_anomaly" },
  );
  return { passed, route, revision, anomalies, reworkReturns, task: { ...updated, anomaly: passed ? null : summary } };
}

/** Check one In Review task and route it. See the module comment. */
export async function checkTask(tx: TenantTx, taskId: string, opts: CheckOptions = {}): Promise<CheckOutcome> {
  const check = await runDeterministicChecks(tx, taskId, opts);
  return routeChecked(tx, check, check.anomalies, "deterministic");
}
