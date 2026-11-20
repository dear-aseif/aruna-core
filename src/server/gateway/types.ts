import type { ZodType } from "zod";

/** A chat message. System text travels separately in `system`. */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Request shape from design §2.7.
 * `tenantId` is derived server-side from the trusted execution context (a Caller / session),
 * never from client or agent input. Exactly one association is required: `taskId` or `routineContext`.
 */
export interface CompleteRequest {
  tenantId: string;
  taskId?: string;
  routineContext?: string;
  system: string;
  messages: Message[];
  /** When set, the output is parsed as JSON and validated; the result is returned as `parsed`. */
  responseSchema?: ZodType;
}

export interface CompleteResult {
  text: string;
  /** Present only when `responseSchema` was set and parsing + validation succeeded. */
  parsed?: unknown;
  usage?: Usage;
}

export interface ModelGateway {
  complete(request: CompleteRequest): Promise<CompleteResult>;
}

/** The association a call is attributed to (design §2.7, amendment #12). */
export type Association = { kind: "task"; taskId: string } | { kind: "routine"; routineContext: string };

/** What an adapter (group 5.2) receives. Providers never see the response schema. */
export interface AdapterRequest {
  tenantId: string;
  association: Association;
  system: string;
  messages: Message[];
  /** Aborted when the per-call timeout elapses; adapters should pass it to the provider client. */
  signal?: AbortSignal;
}

export interface AdapterResponse {
  text: string;
  usage?: Usage;
}

/**
 * The seam between the gateway and a provider. Implementations live under
 * `src/server/gateway/adapters/` (the only place a provider SDK may be imported).
 * Adapters report failures by throwing; the gateway classifies them.
 */
export interface ProviderAdapter {
  readonly provider: string;
  readonly model: string;
  generate(request: AdapterRequest): Promise<AdapterResponse>;
}
