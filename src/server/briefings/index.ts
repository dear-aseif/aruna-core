import { AuthenticationError, resolveSession } from "../auth/service";
import { callerFromAuth, withTenant, type Caller } from "../dal";
import { getActivePlaybook } from "../playbook";
import { localMoment } from "../routines";
import { getAssistantName, getUiLanguage } from "../settings";
import { ShellForbiddenError } from "../workspace/shell";
import { formatTimestamp } from "../board/history";
import { formatScheduleDate, renderGreeting, renderSections, type RenderedSection } from "./render";
import { getBriefingTx, listBriefingsTx } from "./store";

export { BRIEFING_AUDIT_TYPES, archiveSink, getBriefingTx, installBriefingArchive, listBriefingsTx, storeBriefing } from "./store";
export type { StoredBriefing } from "./store";
export { registerSectionRenderer, renderSections } from "./render";
export type { RenderedItem, RenderedSection } from "./render";

/**
 * Briefings read model (task 10.2, design §2.11/§2.12, R9.4): today's briefing, the archive, and
 * one briefing reopened. All from the stored archive; nothing is generated on read. Text is
 * rendered from the stored facts with fixed templates in the tenant's UI language, and the
 * assistant's name is resolved live (a rename shows on the next read, also in old briefings).
 */
export interface BriefingListItem {
  id: string;
  /** The schedule date (tenant timezone), YYYY-MM-DD. */
  date: string;
  /** The date as the owner reads it, in the UI language. */
  dateLabel: string;
}
export interface BriefingsModel {
  today: BriefingListItem | null;
  archive: BriefingListItem[];
}
export interface BriefingDetailModel extends BriefingListItem {
  greeting: string;
  /** When the briefing was stored, in the business timezone. */
  generated: string;
  timeZone: string;
  sections: RenderedSection[];
}

async function ownerCaller(token: unknown): Promise<Caller> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  return callerFromAuth(auth);
}

/** Today (the tenant's local date) is the briefing stored for that date, if any; every other one is archive. */
export async function loadBriefingsForCaller(caller: Caller, now?: Date): Promise<BriefingsModel> {
  return withTenant(caller, async (tx) => {
    const [pb, lang] = [await getActivePlaybook(tx), await getUiLanguage(tx)];
    const todayDate = localMoment(now ?? (await tx.query<{ n: Date }>("select clock_timestamp() as n"))[0].n, pb.business.timezone).date;
    const item = (b: { id: string; date: string }): BriefingListItem => ({ id: b.id, date: b.date, dateLabel: formatScheduleDate(b.date, lang) });
    const all = await listBriefingsTx(tx);
    const today = all.find((b) => b.date === todayDate);
    return { today: today ? item(today) : null, archive: all.filter((b) => b !== today).map(item) };
  });
}

/** Reopen one briefing. Unknown, malformed or other-tenant ids are NotFoundError. */
export async function loadBriefingDetailForCaller(caller: Caller, id: unknown): Promise<BriefingDetailModel> {
  return withTenant(caller, async (tx) => {
    const b = await getBriefingTx(tx, id);
    const [pb, lang, name] = [await getActivePlaybook(tx), await getUiLanguage(tx), await getAssistantName(tx)];
    const timeZone = pb.business.timezone;
    return {
      id: b.id,
      date: b.date,
      dateLabel: formatScheduleDate(b.date, lang),
      greeting: renderGreeting(name, lang),
      generated: formatTimestamp(b.createdAt, timeZone, lang),
      timeZone,
      sections: renderSections(b.sections, { lang, timeZone }),
    };
  });
}

export async function loadBriefings(token: unknown): Promise<BriefingsModel> {
  return loadBriefingsForCaller(await ownerCaller(token));
}
export async function loadBriefingDetail(token: unknown, id: unknown): Promise<BriefingDetailModel> {
  return loadBriefingDetailForCaller(await ownerCaller(token), id);
}
