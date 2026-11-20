import type { AdapterRequest, AdapterResponse, ProviderAdapter } from "@/server/gateway";

/**
 * TEST-ONLY fake provider adapter (design §2.7). It lives under tests/support so it cannot be
 * part of any deployed build, is not in SUPPORTED_PROVIDERS, and is never reachable through
 * tenant configuration. A test proves the deployed configuration resolves to the Bedrock adapter.
 *
 * Each call to `generate` consumes the next programmed behavior (the last one repeats).
 */
export type FakeBehavior =
  | { kind: "success"; text?: string; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: "provider_error"; message?: string }
  /** Waits `ms` (or until aborted), then answers. Used to force the gateway's per-call timeout. */
  | { kind: "delay"; ms: number; text?: string }
  /** Answers with text that is not valid for the caller's response schema (not JSON). */
  | { kind: "malformed"; text?: string };

export interface FakeAdapter extends ProviderAdapter {
  readonly TEST_ONLY: true;
  readonly calls: AdapterRequest[];
  program(...behaviors: FakeBehavior[]): void;
}

export function createFakeAdapter(...initial: FakeBehavior[]): FakeAdapter {
  let script: FakeBehavior[] = initial.length ? initial : [{ kind: "success" }];
  let index = 0;
  const calls: AdapterRequest[] = [];

  return {
    TEST_ONLY: true,
    provider: "fake-test-only",
    model: "fake-model-1",
    calls,
    program(...behaviors) {
      script = behaviors.length ? behaviors : [{ kind: "success" }];
      index = 0;
    },
    async generate(request): Promise<AdapterResponse> {
      calls.push(request);
      const b = script[Math.min(index++, script.length - 1)];
      switch (b.kind) {
        case "success":
          return { text: b.text ?? "ok", usage: b.usage ?? { inputTokens: 5, outputTokens: 3 } };
        case "provider_error":
          throw new Error(b.message ?? "fake provider error");
        case "malformed":
          return { text: b.text ?? "this is not json", usage: { inputTokens: 4, outputTokens: 2 } };
        case "delay":
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, b.ms);
            request.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
          return { text: b.text ?? "late" };
      }
    },
  };
}
