/** A write was refused because the tenant is deactivated (design §2.9). Raised from the database write guard (SQLSTATE AD001). */
export class TenantDeactivatedError extends Error {
  constructor() {
    super("tenant is deactivated: writes are refused");
    this.name = "TenantDeactivatedError";
  }
}
export const DEACTIVATED_SQLSTATE = "AD001";
export const isDeactivatedWriteError = (err: unknown): boolean => (err as { code?: string })?.code === DEACTIVATED_SQLSTATE;
