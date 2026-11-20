import { GatewayError, ProviderTimeoutError } from "./errors";
import type {
  Association,
  CompleteRequest,
  CompleteResult,
  ModelGateway,
  ProviderAdapter,
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

/** Build the gateway over one provider adapter. All validation happens before the adapter is touched. */
export function createModelGateway(adapter: ProviderAdapter): ModelGateway {
  return {
    async complete(request: CompleteRequest): Promise<CompleteResult> {
      const association = resolveAssociation(request);
      if (typeof request.tenantId !== "string" || !UUID.test(request.tenantId)) {
        throw new GatewayError("invalid_request", "a trusted tenantId is required", { association });
      }
      if (!Array.isArray(request.messages) || request.messages.length === 0) {
        throw new GatewayError("invalid_request", "at least one message is required", { association });
      }

      let response;
      try {
        response = await adapter.generate({
          tenantId: request.tenantId,
          association,
          system: request.system,
          messages: request.messages,
        });
      } catch (err) {
        if (err instanceof GatewayError) throw err;
        throw new GatewayError(
          isTimeout(err) ? "timeout" : "provider_failure",
          isTimeout(err) ? "model call timed out" : "model provider failed",
          { association, cause: err },
        );
      }

      if (typeof response?.text !== "string") {
        throw new GatewayError("malformed_output", "provider returned no text", { association });
      }
      const result: CompleteResult = { text: response.text };
      if (response.usage) result.usage = response.usage;
      if (!request.responseSchema) return result;

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
      return result;
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
