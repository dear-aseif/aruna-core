import type { CheckOptions } from "../checker";
import { adapterForTenant, createModelGateway, type ModelGateway } from "../gateway";

/**
 * What the board needs to re-run the Checker on a revised draft: the model gateway and the checker
 * options. Production resolves the tenant's own gateway (Bedrock by default). A non-production
 * override exists only so the phone-viewport browser test can run the full pipeline without a
 * provider account (see approvals/e2e-handlers.ts); it refuses to be set when NODE_ENV is "production".
 */
export interface ReviseCheckDeps {
  gateway?: ModelGateway;
  check?: CheckOptions;
}

let override: ReviseCheckDeps | null = null;

export function setReviseCheckOverride(deps: ReviseCheckDeps | null): void {
  if (deps && process.env.NODE_ENV === "production") throw new Error("the revise-check override is not available in production");
  override = deps;
}

export async function resolveReviseCheckDeps(tenantId: string, explicit?: ReviseCheckDeps): Promise<Required<Pick<ReviseCheckDeps, "gateway">> & { check: CheckOptions }> {
  const src = explicit ?? override;
  return {
    gateway: src?.gateway ?? createModelGateway(await adapterForTenant(tenantId)),
    check: src?.check ?? {},
  };
}
