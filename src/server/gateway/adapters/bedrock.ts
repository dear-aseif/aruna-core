import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from "../types";

/** The one method of the Bedrock client the adapter uses; lets tests pass a mock client. */
export interface BedrockSender {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockAdapterOptions {
  region: string;
  modelId: string;
  /** Injected for tests. Defaults to a real client for `region` (credentials from the AWS default chain). */
  client?: BedrockSender;
}

/**
 * The real client. `maxAttempts: 1` disables the SDK's default retries: one gateway call is
 * exactly one provider attempt (task 5.3), so accounting and the timeout cover every attempt.
 */
export function createBedrockClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region, maxAttempts: 1 });
}

/** Amazon Bedrock adapter (Converse API). The only module that imports the Bedrock SDK. */
export function createBedrockAdapter(options: BedrockAdapterOptions): ProviderAdapter {
  const { modelId } = options;
  if (!modelId.trim()) throw new Error("bedrock adapter requires a model id");
  const client: BedrockSender = options.client ?? createBedrockClient(options.region);

  return {
    provider: "bedrock",
    model: modelId,
    async generate(request: AdapterRequest): Promise<AdapterResponse> {
      const out = await client.send(
        new ConverseCommand({
          modelId,
          system: request.system.trim() ? [{ text: request.system }] : undefined,
          messages: request.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
        }),
        request.signal ? { abortSignal: request.signal } : undefined,
      );
      const blocks = out.output?.message?.content ?? [];
      const text = blocks.flatMap((b) => (typeof b.text === "string" ? [b.text] : [])).join("");
      if (blocks.length === 0 || text.length === 0) {
        throw new Error("bedrock returned no text content");
      }
      const response: AdapterResponse = { text };
      if (out.usage && typeof out.usage.inputTokens === "number" && typeof out.usage.outputTokens === "number") {
        response.usage = { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens };
      }
      return response;
    },
  };
}
