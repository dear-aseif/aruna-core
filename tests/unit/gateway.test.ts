import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bindGateway,
  createModelGateway,
  GatewayError,
  ProviderTimeoutError,
  type AdapterRequest,
  type ProviderAdapter,
} from "@/server/gateway";

// These suites test gateway logic without a database; accounting has its own suite (gateway-accounting.test.ts).
const NO_ACCOUNTING = { accounting: { recordAttempt: async () => {}, recordOutcome: async () => {} } };
const TENANT = "11111111-1111-4111-8111-111111111111";

// Contract-test stub; lives in tests/ only (the real fake adapter is task 5.4).
function stub(respond: (r: AdapterRequest) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>) {
  const calls: AdapterRequest[] = [];
  const adapter: ProviderAdapter = {
    provider: "stub",
    model: "stub-1",
    generate: (r) => {
      calls.push(r);
      return respond(r);
    },
  };
  return { adapter, calls };
}
const base = { tenantId: TENANT, system: "s", messages: [{ role: "user" as const, content: "hi" }] };

async function failureOf(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    return e as GatewayError;
  }
  throw new Error("expected a failed call");
}

describe("gateway association", () => {
  it("refuses a call with neither taskId nor routineContext before any provider work", async () => {
    const { adapter, calls } = stub(async () => ({ text: "x" }));
    const err = await failureOf(createModelGateway(adapter, NO_ACCOUNTING).complete(base));
    expect(err.kind).toBe("association_missing");
    expect(calls).toHaveLength(0);
  });

  it("treats blank associations as missing, and refuses both at once", async () => {
    const { adapter, calls } = stub(async () => ({ text: "x" }));
    const gw = createModelGateway(adapter, NO_ACCOUNTING);
    expect((await failureOf(gw.complete({ ...base, taskId: " ", routineContext: "" }))).kind).toBe("association_missing");
    expect((await failureOf(gw.complete({ ...base, taskId: "t", routineContext: "r" }))).kind).toBe("association_missing");
    expect(calls).toHaveLength(0);
  });

  it("accepts a taskId or a routineContext and passes the association on", async () => {
    const { adapter, calls } = stub(async () => ({ text: "ok", usage: { inputTokens: 3, outputTokens: 2 } }));
    const gw = createModelGateway(adapter, NO_ACCOUNTING);
    const r = await gw.complete({ ...base, taskId: "task-1" });
    await gw.complete({ ...base, routineContext: "briefing" });
    expect(r).toEqual({ text: "ok", usage: { inputTokens: 3, outputTokens: 2 } });
    expect(calls.map((c) => c.association)).toEqual([
      { kind: "task", taskId: "task-1" },
      { kind: "routine", routineContext: "briefing" },
    ]);
  });

  it("refuses a missing or malformed tenantId before provider work", async () => {
    const { adapter, calls } = stub(async () => ({ text: "x" }));
    const err = await failureOf(
      createModelGateway(adapter, NO_ACCOUNTING).complete({ ...base, tenantId: "", taskId: "t" }),
    );
    expect(err.kind).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("bindGateway forces the trusted tenant over any tenantId in the input", async () => {
    const { adapter, calls } = stub(async () => ({ text: "x" }));
    const bound = bindGateway(createModelGateway(adapter, NO_ACCOUNTING), { tenantId: TENANT });
    await bound.complete({
      ...({ tenantId: "22222222-2222-4222-8222-222222222222" } as object),
      system: "s",
      messages: base.messages,
      taskId: "t",
    });
    expect(calls[0].tenantId).toBe(TENANT);
  });
});

describe("gateway structured output", () => {
  const schema = z.object({ qty: z.number().int(), item: z.string() });

  it("returns parsed output when it is valid for the schema", async () => {
    const { adapter } = stub(async () => ({ text: '{"qty":3,"item":"kemeja"}' }));
    const r = await createModelGateway(adapter, NO_ACCOUNTING).complete({ ...base, taskId: "t", responseSchema: schema });
    expect(r.parsed).toEqual({ qty: 3, item: "kemeja" });
    expect(r.text).toBe('{"qty":3,"item":"kemeja"}');
  });

  it("fails the call when output is schema-invalid", async () => {
    const { adapter } = stub(async () => ({ text: '{"qty":"three","item":"kemeja"}' }));
    const err = await failureOf(
      createModelGateway(adapter, NO_ACCOUNTING).complete({ ...base, taskId: "t", responseSchema: schema }),
    );
    expect(err.kind).toBe("malformed_output");
  });

  it("fails the call when output is not JSON", async () => {
    const { adapter } = stub(async () => ({ text: "sure, here you go" }));
    const err = await failureOf(
      createModelGateway(adapter, NO_ACCOUNTING).complete({ ...base, taskId: "t", responseSchema: schema }),
    );
    expect(err.kind).toBe("malformed_output");
  });

  it("does not set parsed when no schema was requested", async () => {
    const { adapter } = stub(async () => ({ text: '{"qty":1}' }));
    const r = await createModelGateway(adapter, NO_ACCOUNTING).complete({ ...base, taskId: "t" });
    expect(r.parsed).toBeUndefined();
  });
});

describe("gateway provider failures", () => {
  it("classifies adapter errors as provider_failure and timeouts as timeout", async () => {
    const boom = stub(async () => {
      throw new Error("unreachable");
    });
    const slow = stub(async () => {
      throw new ProviderTimeoutError();
    });
    const e1 = await failureOf(createModelGateway(boom.adapter, NO_ACCOUNTING).complete({ ...base, taskId: "t" }));
    const e2 = await failureOf(createModelGateway(slow.adapter, NO_ACCOUNTING).complete({ ...base, taskId: "t" }));
    expect(e1.kind).toBe("provider_failure");
    expect(e2.kind).toBe("timeout");
    expect(e1.afterProviderCall && e2.afterProviderCall).toBe(true);
    expect(e1.details.association).toEqual({ kind: "task", taskId: "t" });
  });
});

describe("provider SDK boundary guard", () => {
  const SDK =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["'](?:@aws-sdk\/[^"']*|@smithy\/[^"']*|@anthropic-ai\/[^"']*|openai|@google\/[^"']*|@google-cloud\/[^"']*|@azure\/[^"']*|cohere-ai|@mistralai\/[^"']*|ollama|groq-sdk)["']/m;

  function walk(dir: string, out: string[]) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(f)) out.push(p);
    }
  }

  it("no source outside src/server/gateway/adapters imports a provider SDK", () => {
    const root = join(process.cwd(), "src");
    const files: string[] = [];
    walk(root, files);
    const offenders = files
      .map((p) => relative(root, p).split(sep).join("/"))
      .filter((rel) => !rel.startsWith("server/gateway/adapters/"))
      .filter((rel) => SDK.test(readFileSync(join(root, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("agent-facing code reaches the gateway only through its index module", () => {
    const root = join(process.cwd(), "src", "server");
    const files: string[] = [];
    walk(root, files);
    const offenders = files
      .map((p) => relative(root, p).split(sep).join("/"))
      .filter((rel) => !rel.startsWith("gateway/"))
      .filter((rel) => /from\s+["'](?:[^"']*\/)?gateway\/(?!index)[^"']+["']/.test(readFileSync(join(root, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});
