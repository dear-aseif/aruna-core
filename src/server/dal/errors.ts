export class TenantContextError extends Error {
  constructor(message = "no tenant context could be established (failing closed)") {
    super(message);
    this.name = "TenantContextError";
  }
}

/** A reference to a record of another tenant. Refused; the DAL records the audit entry. */
export class CrossTenantReferenceError extends Error {
  constructor(
    readonly reason: "tenant_mismatch" | "rls_violation",
    readonly table?: string,
  ) {
    super("forbidden");
    this.name = "CrossTenantReferenceError";
  }
}

/** No visible record. Under RLS, another tenant's record is indistinguishable from a missing one. */
export class NotFoundError extends Error {
  constructor(readonly table: string) {
    super("not found");
    this.name = "NotFoundError";
  }
}
