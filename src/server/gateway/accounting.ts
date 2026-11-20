import { withTenant, type Caller } from "../dal";
import { NotFoundError } from "../dal/errors";
import { IllegalTransitionError, transitionTask } from "../tasks";
import { GatewayError } from "./errors";
import type { Association, Usage } from "./types";

/**
 * Gateway accounting (task 5.3, design §2.7, R10.3/R10.4, Property 10).
 *
 * Every call writes `model.attempt` BEFORE the provider is touched and `model.usage` as the
 * outcome (success, provider error, timeout, malformed output alike), through the DAL in the
 * caller's tenant. A failed call that is associated with a task moves that task to Failed in the
 * same transaction as the outcome entry. The tenant always comes from the trusted call context.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MODEL_AUDIT_TYPES = {
  attempt: "model.attempt",
  usage: "model.usage",
} as const;

/** Stable actor identity of the gateway on audit entries. */
export const GATEWAY_ACTOR_ID = "model-gateway";

export type CallOutcomeKind = "success" | "provider_failure" | "timeout" | "malformed_output";

export interface CallContext {
  tenantId: string;
  association: Association;
  provider: string;
  model: string;
}

export interface CallOutcome {
  outcome: CallOutcomeKind;
  usage?: Usage;
  durationMs: number;
  /** Visible error text for failures (recorded on the task when one is associated). */
  error?: string;
}

export interface GatewayAccounting {
  /** Written before the provider call. A throw here means the provider must not be called. */
  recordAttempt(ctx: CallContext): Promise<void>;
  /** Written after the provider call, for every outcome. Failures also fail the associated task. */
  recordOutcome(ctx: CallContext, outcome: CallOutcome): Promise<void>;
}

function caller(tenantId: string): Caller {
  return { tenantId, actor: "system", actorId: GATEWAY_ACTOR_ID };
}

function describe(ctx: CallContext): Record<string, unknown> {
  return {
    provider: ctx.provider,
    model: ctx.model,
    association: ctx.association.kind,
    ...(ctx.association.kind === "routine" ? { routine_context: ctx.association.routineContext } : {}),
  };
}

const taskIdOf = (a: Association): string | null => (a.kind === "task" ? a.taskId : null);

/** The production accounting: audit entries (and the Failed transition) through the DAL. */
export const dalAccounting: GatewayAccounting = {
  async recordAttempt(ctx) {
    const taskId = taskIdOf(ctx.association);
    if (taskId && !UUID.test(taskId)) {
      throw new GatewayError("invalid_request", "taskId is not a valid task id", { association: ctx.association });
    }
    try {
      await withTenant(caller(ctx.tenantId), async (tx) => {
        if (taskId) await tx.getById("tasks", taskId); // the task must exist in this tenant
        await tx.audit(MODEL_AUDIT_TYPES.attempt, describe(ctx), taskId);
      });
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new GatewayError("invalid_request", "the associated task does not exist for this tenant", {
          association: ctx.association,
        });
      }
      throw err;
    }
  },

  async recordOutcome(ctx, o) {
    const taskId = taskIdOf(ctx.association);
    await withTenant(caller(ctx.tenantId), async (tx) => {
      let taskState: "failed" | "not_transitioned" | undefined;
      if (o.outcome !== "success" && taskId) {
        try {
          await transitionTask(tx, taskId, "failed", {
            error: o.error ?? `model call failed (${o.outcome})`,
            reason: `model.${o.outcome}`,
          });
          taskState = "failed";
        } catch (err) {
          // Failed is legal only from Working or In Review. The usage entry is still written.
          if (!(err instanceof IllegalTransitionError)) throw err;
          taskState = "not_transitioned";
        }
      }
      await tx.audit(
        MODEL_AUDIT_TYPES.usage,
        {
          ...describe(ctx),
          outcome: o.outcome,
          duration_ms: o.durationMs,
          ...(o.usage ? { input_tokens: o.usage.inputTokens, output_tokens: o.usage.outputTokens } : {}),
          ...(o.error ? { error: o.error } : {}),
          ...(taskState ? { task_state: taskState } : {}),
        },
        taskId,
      );
    });
  },
};
