import type { Association } from "./types";

/**
 * Typed failure surface of the gateway.
 *  - association_missing: refused before any provider work (amendment #12)
 *  - invalid_request:     refused before any provider work (bad tenant/messages)
 *  - provider_failure:    provider unreachable or returned an error
 *  - timeout:             per-call timeout elapsed; a kind of provider failure (amendment #13)
 *  - malformed_output:    output was not parseable JSON or failed the response schema
 */
export type GatewayFailureKind =
  | "association_missing"
  | "invalid_request"
  | "provider_failure"
  | "timeout"
  | "malformed_output";

export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayFailureKind,
    message: string,
    readonly details: { association?: Association; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    if (details.cause !== undefined) this.cause = details.cause;
  }

  /** True for failures that happened after the request was accepted (a provider call was attempted). */
  get afterProviderCall(): boolean {
    return this.kind === "provider_failure" || this.kind === "timeout" || this.kind === "malformed_output";
  }
}

/** Adapters throw this to signal a timeout explicitly. */
export class ProviderTimeoutError extends Error {
  constructor(message = "model call timed out") {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}
