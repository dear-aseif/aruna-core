import type { TenantTx } from "../dal";
import type { PlaybookCore } from "../playbook";

/**
 * Briefing section registry (task 10.1, design §2.11, R9.3). One shared routine serves every
 * tenant; a section contributes facts to it. Core registers the core sections (core-sections.ts);
 * pack groups 12 and 13 register theirs here. The engine only ever reads this registry, it never
 * imports pack code.
 */
export interface SectionContext {
  /** The briefing's schedule date in the tenant's timezone, YYYY-MM-DD ("today"). */
  scheduleDate: string;
  /** The day before, in the tenant's timezone ("yesterday"). */
  previousDate: string;
  timezone: string;
  pack: string;
  playbook: PlaybookCore;
}

export interface BriefingSection {
  /** Unique across the registry; pack sections should prefix with the pack id (e.g. "services.todays_bookings"). */
  id: string;
  /** null = a core section (every tenant); otherwise the pack id whose tenants get this section. */
  pack: string | null;
  /** Lower first; ties keep registration order. Core sections use 0-99. */
  order?: number;
  /** Facts come from tenant records read on the given transaction (RLS in force), never from a model. */
  collect(tx: TenantTx, ctx: SectionContext): Promise<unknown>;
}

const sections = new Map<string, BriefingSection>();

export function registerBriefingSection(section: BriefingSection): void {
  if (sections.has(section.id)) throw new Error(`briefing section already registered: ${section.id}`);
  sections.set(section.id, section);
}

/** For tests that register temporary sections. */
export function unregisterBriefingSection(id: string): void {
  sections.delete(id);
}

/** The sections that apply to a tenant of `pack`: all core sections plus that pack's, in order. */
export function sectionsForPack(pack: string): BriefingSection[] {
  return [...sections.values()]
    .filter((s) => s.pack === null || s.pack === pack)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? 100) - (b.s.order ?? 100) || a.i - b.i)
    .map((x) => x.s);
}
