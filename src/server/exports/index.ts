import { AuthenticationError, resolveSession } from "../auth/service";
import { callerFromAuth, type Caller } from "../dal";
import { ShellForbiddenError } from "../workspace/shell";
import { runOwnerExport } from "./service";
/**
 * Owner export trigger (task 9.4, design §2.9 permission matrix: the owner may export their own
 * tenant's data at any time) and the installed export service (task 10.3, ./service.ts).
 *
 * This module authenticates an OWNER session, takes the tenant from that session (no tenant is
 * ever accepted as input), and hands a Caller to the runner. The real runner is installed by
 * default; `setExportRunner(null)` removes it (tests), after which the trigger answers
 * `ExportUnavailableError` and exports nothing.
 */
export interface ExportSummary {
  /** Cutoff instant (database time) and entity-count manifest (design §2.9, amendment #16). */
  cutoff: string;
  manifest: Record<string, number>;
  /** Suggested file name of the archive. */
  fileName: string;
}
/** The summary and the archive (a zip) it describes. */
export interface ExportResult {
  summary: ExportSummary;
  archive: Uint8Array;
}
export type ExportRunner = (caller: Caller) => Promise<ExportResult>;
export class ExportUnavailableError extends Error {
  constructor() {
    super("the export service is not installed yet");
    this.name = "ExportUnavailableError";
  }
}
let runner: ExportRunner | null = runOwnerExport;
/** Replace or remove (null) the export runner. The real service is installed by default; tests swap it. */
export function setExportRunner(next: ExportRunner | null): void {
  runner = next;
}
export const hasExportRunner = (): boolean => runner !== null;
export async function requestOwnExport(token: unknown): Promise<ExportResult> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  if (!runner) throw new ExportUnavailableError();
  return runner(callerFromAuth(auth)); // the owner's own tenant: it comes from the session only
}
export { registerExportEntity, listExportEntities, type ExportEntity } from "./registry";
