import { dalAccounting, type CallContext, type CallOutcomeKind, type GatewayAccounting } from "./accounting";
import { GatewayError, ProviderTimeoutError } from "./errors";
import type {
  Association,
  CompleteRequest,
  CompleteResult,
  ModelGateway,
  ProviderAdapter,
  Usage,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Exactly one association must be present; anything else is refused before provider work. */
export function resolveAssociation(req: Pick<CompleteRequest, "taskId" | "routineContext">): Association {
  const hasTask = nonEmpty(req.taskId);
  const hasRoutine = nonEmpty(req.routineContext);
  if (hasTask && hasRoutine) {
    throw new GatewayError("association_missing", "a call carries a taskId or a routineContext, not both");
  }
  if (hasTask) return { kind: "task", taskId: req.taskId! };
  if (hasRoutine) return { kind: "routine", routineContext: req.routineContext! };
  throw new GatewayError("association_missing", "a model call requires a taskId or a named routineContext");
}

function isTimeout(err: unknown): boolean {
  if (err instanceof ProviderTimeoutError) return true;
  const e = err as { name?: string };
  return e?.name === "TimeoutError" || e?.name === "AbortError";
}

/** Per-call timeout default (amendment #13). Overridable per gateway through `GatewayOptions.timeoutMs`. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

export interface GatewayOptions {
  /** Per-call timeout in milliseconds. Default: DEFAULT_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Accounting sink. Default: DAL audit entries plus the Failed transition. Tests may substitute. */
  accounting?: GatewayAccounting;
}

/** Run one provider attempt, aborting and failing with ProviderTimeoutError when `ms` elapses. */
async function withTimeout<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderTimeoutError()); // first, so the timeout wins the race against the abort rejection
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const OUTCOME_OF: Record<"provider_failure" | "timeout" | "malformed_output", CallOutcomeKind> = {
  provider_failure: "provider_failure",
  timeout: "timeout",
  malformed_output: "malformed_output",
};

/**
 * Build the gateway over one provider adapter. Validation happens before the adapter is touched;
 * once a call is accepted, `model.attempt` is written first and `model.usage` closes it for every
 * outcome. A failed call fails its task (when it has one) and is rethrown; no result is invented.
 */
export function createModelGateway(adapter: ProviderAdapter, options: GatewayOptions = {}): ModelGateway {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("gateway timeoutMs must be a positive number");
  const accounting = options.accounting ?? dalAccounting;
  return {
    async complete(request: CompleteRequest): Promise<CompleteResult> {
      const association = resolveAssociation(request);
      if (typeof request.tenantId !== "string" || !UUID.test(request.tenantId)) {
        throw new GatewayError("invalid_request", "a trusted tenantId is required", { association });
      }
      if (!Array.isArray(request.messages) || request.messages.length === 0) {
        throw new GatewayError("invalid_request", "at least one message is required", { association });
      }

      const ctx: CallContext = {
        tenantId: request.tenantId,
        association,
        provider: adapter.provider,
        model: adapter.model,
      };
      await accounting.recordAttempt(ctx);

      const started = Date.now();
      let usage: Usage | undefined;
      let result: CompleteResult | undefined;
      let failure: GatewayError | undefined;
      try {
        const response = await withTimeout(timeoutMs, (signal) =>
          adapter.generate({
            tenantId: request.tenantId,
            association,
            system: request.system,
            messages: request.messages,
            signal,
          }),
        );
        if (typeof response?.text !== "string") {
          throw new GatewayError("malformed_output", "provider returned no text", { association });
        }
        usage = response.usage;
        result = { text: response.text };
        if (response.usage) result.usage = response.usage;
        if (request.responseSchema) {
          let json: unknown;
          try {
            json = JSON.parse(response.text);
          } catch (err) {
            throw new GatewayError("malformed_output", "output is not valid JSON", { association, cause: err });
          }
          const checked = request.responseSchema.safeParse(json);
          if (!checked.success) {
            throw new GatewayError("malformed_output", "output failed schema validation", {
              association,
              cause: checked.error,
            });
          }
          result.parsed = checked.data;
        }
      } catch (err) {
        result = undefined;
        failure =
          err instanceof GatewayError
            ? err
            : new GatewayError(
                isTimeout(err) ? "timeout" : "provider_failure",
                isTimeout(err) ? "model call timed out" : "model provider failed",
                { association, cause: err },
              );
      }

      const durationMs = Date.now() - started;
      if (failure) {
        const kind = failure.kind === "timeout" || failure.kind === "malformed_output" ? failure.kind : "provider_failure";
        await accounting.recordOutcome(ctx, {
          outcome: OUTCOME_OF[kind],
          usage,
          durationMs,
          error: `Model call failed (${kind}): ${failure.message}`,
        });
        throw failure;
      }
      await accounting.recordOutcome(ctx, { outcome: "success", usage, durationMs });
      return result!;
    },
  };
}

/** What agent code receives: tenant is already bound from the trusted Caller and cannot be supplied. */
export type BoundCompleteRequest = Omit<CompleteRequest, "tenantId">;
export interface BoundModelGateway {
  complete(request: BoundCompleteRequest): Promise<CompleteResult>;
}

/** Bind a gateway to a trusted tenant (taken from the server-side Caller). Any `tenantId` in the input is ignored. */
export function bindGateway(gateway: ModelGateway, trusted: { tenantId: string }): BoundModelGateway {
  const tenantId = trusted.tenantId;
  return {
    complete: (request) => gateway.complete({ ...request, tenantId }),
  };
}
