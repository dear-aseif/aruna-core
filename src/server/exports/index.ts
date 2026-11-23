import { AuthenticationError, resolveSession } from "../auth/service";
import { callerFromAuth, type Caller } from "../dal";
import { ShellForbiddenError } from "../workspace/shell";
/**
 * Owner export trigger (task 9.4, design §2.9 permission matrix: the owner may export their own
 * tenant's data at any time).
 *
 * The export SERVICE is task 10.3 and is not built here. This module is only the owner-scoped
 * entry to it: it authenticates an OWNER session, takes the tenant from that session (no tenant
 * is ever accepted as input), and hands a Caller to the installed runner. Until task 10.3 installs
 * a runner, the trigger answers `ExportUnavailableError`; nothing is exported and nothing is faked.
 */
export interface ExportSummary {
  /** Cutoff instant and entity-count manifest (design §2.9, amendment #16). */
  cutoff: string;
  manifest: Record<string, number>;
  /** Where the owner downloads the archive. */
  downloadPath: string;
}
export type ExportRunner = (caller: Caller) => Promise<ExportSummary>;
export class ExportUnavailableError extends Error {
  constructor() {
    super("the export service is not installed yet");
    this.name = "ExportUnavailableError";
  }
}
let runner: ExportRunner | null = null;
/** Task 10.3 installs the export service here. Tests install a stand-in and remove it. */
export function setExportRunner(next: ExportRunner | null): void {
  runner = next;
}
export const hasExportRunner = (): boolean => runner !== null;
export async function requestOwnExport(token: unknown): Promise<ExportSummary> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  if (!runner) throw new ExportUnavailableError();
  return runner(callerFromAuth(auth)); // the owner's own tenant: it comes from the session only
}
