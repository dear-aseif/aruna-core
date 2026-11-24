import type { Caller } from "../dal";
/** The caller is not an operator. Verification and deactivation are operator-only (design §2.9), owners included. */
export class OperatorOnlyError extends Error {
  constructor() {
    super("this action is operator-only");
    this.name = "OperatorOnlyError";
  }
}
export function requireOperator(caller: Caller): void {
  if (!caller || caller.actor !== "operator") throw new OperatorOnlyError();
}
/** Deactivation was refused because no passed verification exists for the tenant (or the latest one failed). */
export class ExportNotVerifiedError extends Error {
  constructor(readonly reason: "no_verification" | "verification_failed") {
    super(reason === "no_verification" ? "no verified export exists for this tenant" : "the latest export verification failed");
    this.name = "ExportNotVerifiedError";
  }
}
/** The tenant's data changed after the verified archive's cutoff: a fresh export and verification are required. */
export class ExportStaleError extends Error {
  constructor(readonly changed: string[]) {
    super(`tenant data changed after the verified export's cutoff (${changed.join(", ")}); export and verify again`);
    this.name = "ExportStaleError";
  }
}
export class AlreadyDeactivatedError extends Error {
  constructor() {
    super("the tenant is already deactivated");
    this.name = "AlreadyDeactivatedError";
  }
}
