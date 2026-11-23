import { AuthenticationError, resolveSession } from "../auth/service";
import { ShellForbiddenError } from "../workspace/shell";
/**
 * Briefings read model (task 9.4, design §2.11/§2.12, R9.4): today's briefing and the archive.
 *
 * The `briefings` table and the generator arrive in tasks 10.1/10.2, so there is nothing to read
 * yet: this function answers the honest empty state. It never returns sample content. Task 10.2
 * replaces the body below with the tenant-scoped query; the signature and the model stay.
 */
export interface BriefingListItem {
  id: string;
  /** The schedule date (tenant timezone), YYYY-MM-DD. */
  date: string;
}
export interface BriefingsModel {
  today: BriefingListItem | null;
  archive: BriefingListItem[];
}
export async function loadBriefings(token: unknown): Promise<BriefingsModel> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  return { today: null, archive: [] };
}
