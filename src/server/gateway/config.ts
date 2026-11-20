import { withTenant, type Caller } from "../dal";
import { createBedrockAdapter, type BedrockSender } from "./adapters/bedrock";
import { GatewayError } from "./errors";
import type { ProviderAdapter } from "./types";

/** Providers an adapter exists for. Anything else in `settings.model_provider` is refused. */
export const SUPPORTED_PROVIDERS = ["bedrock"] as const;
export type ModelProvider = (typeof SUPPORTED_PROVIDERS)[number];
export const DEFAULT_PROVIDER: ModelProvider = "bedrock";

export interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
  /** "tenant" when any of the tenant's settings supplied a value, else "default". */
  source: "tenant" | "default";
}

type Env = Record<string, string | undefined>;

// Bedrock model ids and inference-profile ARNs: letters, digits and . : - _ / (no whitespace).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;

function envValue(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v || v === "CHANGE_ME") {
    throw new GatewayError("invalid_request", `${name} is not configured`);
  }
  return v;
}

function projectDefaultModel(provider: ModelProvider, env: Env): string {
  switch (provider) {
    case "bedrock":
      return envValue(env, "BEDROCK_MODEL_ID");
  }
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/**
 * Pure resolution of a tenant's model configuration from its settings values.
 * Null/blank values fall back to the project default (Bedrock, BEDROCK_MODEL_ID).
 * An unknown provider or a malformed model id is refused, never silently defaulted.
 */
export function resolveModelConfig(
  settings: { model_provider: string | null; model_id: string | null } | null,
  env: Env = process.env,
): ModelConfig {
  const rawProvider = clean(settings?.model_provider);
  const rawModel = clean(settings?.model_id);

  let provider: ModelProvider = DEFAULT_PROVIDER;
  if (rawProvider !== null) {
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(rawProvider)) {
      throw new GatewayError("invalid_request", `unknown model provider in tenant settings: ${rawProvider}`);
    }
    provider = rawProvider as ModelProvider;
  }
  if (rawModel !== null && !MODEL_ID.test(rawModel)) {
    throw new GatewayError("invalid_request", "invalid model id in tenant settings");
  }
  return {
    provider,
    modelId: rawModel ?? projectDefaultModel(provider, env),
    source: rawProvider !== null || rawModel !== null ? "tenant" : "default",
  };
}

/** Read the tenant's gateway configuration through the Data Access Layer (tenant-bound, RLS-enforced). */
export async function loadTenantModelConfig(tenantId: string, env: Env = process.env): Promise<ModelConfig> {
  const caller: Caller = { tenantId, actor: "system", actorId: "model-gateway" };
  const row = await withTenant(caller, (tx) =>
    tx.maybeOne<{ model_provider: string | null; model_id: string | null }>(
      "select model_provider, model_id from settings where tenant_id = $1",
      [tenantId],
    ),
  );
  return resolveModelConfig(row, env);
}

/** Build the adapter for a resolved configuration. `client` is for tests. */
export function createAdapter(config: ModelConfig, env: Env = process.env, client?: BedrockSender): ProviderAdapter {
  switch (config.provider) {
    case "bedrock":
      return createBedrockAdapter({ region: envValue(env, "BEDROCK_REGION"), modelId: config.modelId, client });
  }
}

/** Resolve the tenant's configuration and build its adapter. */
export async function adapterForTenant(tenantId: string, env: Env = process.env): Promise<ProviderAdapter> {
  return createAdapter(await loadTenantModelConfig(tenantId, env), env);
}
