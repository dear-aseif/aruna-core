import type { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { createBedrockAdapter, type BedrockSender } from "@/server/gateway/adapters/bedrock";
import { createAdapter, resolveModelConfig } from "@/server/gateway/config";
import { createModelGateway, GatewayError } from "@/server/gateway";

// These suites test gateway logic without a database; accounting has its own suite (gateway-accounting.test.ts).
const NO_ACCOUNTING = { accounting: { recordAttempt: async () => {}, recordOutcome: async () => {} } };
const TENANT = "11111111-1111-4111-8111-111111111111";
const ENV = { BEDROCK_REGION: "us-east-1", BEDROCK_MODEL_ID: "test.default-model-v1:0" };

function mockClient(output: unknown) {
  const sent: ConverseCommand[] = [];
  const client: BedrockSender = {
    send: async (cmd) => {
      sent.push(cmd);
      if (output instanceof Error) throw output;
      return output as never;
    },
  };
  return { client, sent };
}

const req = {
  tenantId: TENANT,
  association: { kind: "routine" as const, routineContext: "daily-briefing" },
  system: "be brief",
  messages: [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi" },
    { role: "user" as const, content: "status?" },
  ],
};

describe("bedrock adapter mapping", () => {
  it("maps the request to Converse input and the response to text + usage", async () => {
    const { client, sent } = mockClient({
      output: { message: { role: "assistant", content: [{ text: "all " }, { text: "good" }] } },
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    const adapter = createBedrockAdapter({ region: "us-east-1", modelId: "m-1", client });
    const res = await adapter.generate(req);

    expect(adapter.provider).toBe("bedrock");
    expect(adapter.model).toBe("m-1");
    expect(res).toEqual({ text: "all good", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toMatchObject({
      modelId: "m-1",
      system: [{ text: "be brief" }],
      messages: [
        { role: "user", content: [{ text: "hello" }] },
        { role: "assistant", content: [{ text: "hi" }] },
        { role: "user", content: [{ text: "status?" }] },
      ],
    });
  });

  it("omits usage when the provider does not report it and system when blank", async () => {
    const { client, sent } = mockClient({ output: { message: { role: "assistant", content: [{ text: "ok" }] } } });
    const adapter = createBedrockAdapter({ region: "us-east-1", modelId: "m-1", client });
    const res = await adapter.generate({ ...req, system: "  " });
    expect(res).toEqual({ text: "ok" });
    expect(sent[0].input.system).toBeUndefined();
  });

  it("throws when the response has no text, and propagates client errors", async () => {
    const empty = createBedrockAdapter({
      region: "r",
      modelId: "m",
      client: mockClient({ output: { message: { role: "assistant", content: [] } } }).client,
    });
    await expect(empty.generate(req)).rejects.toThrow(/no text/);

    const boom = createBedrockAdapter({ region: "r", modelId: "m", client: mockClient(new Error("throttled")).client });
    await expect(boom.generate(req)).rejects.toThrow("throttled");
  });

  it("surfaces adapter failures as provider_failure through the gateway", async () => {
    const adapter = createBedrockAdapter({ region: "r", modelId: "m", client: mockClient(new Error("down")).client });
    const gw = createModelGateway(adapter, NO_ACCOUNTING);
    await expect(
      gw.complete({ tenantId: TENANT, routineContext: "x", system: "s", messages: req.messages }),
    ).rejects.toMatchObject({ kind: "provider_failure" });
  });
});

describe("model config resolution", () => {
  it("falls back to the project default when the tenant has no settings", () => {
    expect(resolveModelConfig(null, ENV)).toEqual({
      provider: "bedrock",
      modelId: "test.default-model-v1:0",
      source: "default",
    });
    expect(resolveModelConfig({ model_provider: null, model_id: "  " }, ENV).source).toBe("default");
  });

  it("applies the tenant's model override and keeps the default provider", () => {
    expect(resolveModelConfig({ model_provider: null, model_id: "tenant.model-v2:0" }, ENV)).toEqual({
      provider: "bedrock",
      modelId: "tenant.model-v2:0",
      source: "tenant",
    });
  });

  it("uses the provider's default model when only the provider is set", () => {
    expect(resolveModelConfig({ model_provider: "bedrock", model_id: null }, ENV)).toEqual({
      provider: "bedrock",
      modelId: "test.default-model-v1:0",
      source: "tenant",
    });
  });

  it("refuses an unknown provider and a malformed model id", () => {
    expect(() => resolveModelConfig({ model_provider: "acme-ai", model_id: null }, ENV)).toThrow(GatewayError);
    expect(() => resolveModelConfig({ model_provider: "openai", model_id: "gpt" }, ENV)).toThrow(/unknown model provider/);
    expect(() => resolveModelConfig({ model_provider: null, model_id: "bad id; drop" }, ENV)).toThrow(/invalid model id/);
  });

  it("fails when the default is needed but BEDROCK_MODEL_ID is unset or a placeholder", () => {
    expect(() => resolveModelConfig(null, {})).toThrow(/BEDROCK_MODEL_ID/);
    expect(() => resolveModelConfig(null, { BEDROCK_MODEL_ID: "CHANGE_ME" })).toThrow(/BEDROCK_MODEL_ID/);
    // a tenant model id does not need the project default
    expect(resolveModelConfig({ model_provider: null, model_id: "m-1" }, {}).modelId).toBe("m-1");
  });

  it("builds a bedrock adapter for the resolved config and requires BEDROCK_REGION", () => {
    const cfg = resolveModelConfig({ model_provider: null, model_id: "m-1" }, ENV);
    const { client } = mockClient({});
    const adapter = createAdapter(cfg, ENV, client);
    expect(adapter).toMatchObject({ provider: "bedrock", model: "m-1" });
    expect(() => createAdapter(cfg, { BEDROCK_MODEL_ID: "x" }, client)).toThrow(/BEDROCK_REGION/);
  });
});
