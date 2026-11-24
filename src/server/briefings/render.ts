import { translate, type Language, type StringKey } from "../../i18n/strings";
import { formatTimestamp } from "../board/history";
import { CORE_SECTION_IDS } from "../routines/core-sections";

/**
 * Deterministic briefing rendering (task 10.2, design §2.11). A stored briefing holds facts only
 * (query results). This module turns those facts into the text the owner reads, with fixed
 * templates from the strings table: no model is involved and nothing is added that is not in the
 * facts. Pure: the same facts, language and timezone always give the same output. The assistant's
 * name is a parameter resolved live by the caller, never part of the stored facts.
 */
export interface RenderedItem {
  /** Set when the line is about one task; the UI links it to the task detail. */
  taskId?: string;
  text: string;
  /** Extra line under the text (for example the approval deadline). */
  note?: string;
}
export interface RenderedSection {
  id: string;
  heading: string;
  /** One line stating the section's totals, or its explicit "nothing" statement. */
  summary: string;
  items: RenderedItem[];
}
export interface StoredSection {
  id: string;
  facts: unknown;
}
export interface RenderContext {
  lang: Language;
  timeZone: string;
}
type SectionRenderer = (facts: unknown, ctx: RenderContext) => Omit<RenderedSection, "id">;

const rendererById = new Map<string, SectionRenderer>();
/** Pack sections (tasks 12.6 and 13.5) plug their template in here; an unregistered section is not rendered. */
export function registerSectionRenderer(id: string, fn: SectionRenderer): void {
  rendererById.set(id, fn);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
/** Fill `{name}` placeholders of a template. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
const OUTCOME_KEYS: Record<string, StringKey> = { done: "status.done", rejected: "status.rejected", expired: "status.expired" };

/** A schedule date (YYYY-MM-DD, already the tenant's local date) as a long date in the viewer's language. */
export function formatScheduleDate(date: string, lang: Language): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

rendererById.set(CORE_SECTION_IDS.yesterdayOutcomes, (facts, { lang }) => {
  const f = isRecord(facts) ? facts : {};
  const tasks = list(f.tasks);
  const t = (k: StringKey) => translate(lang, k);
  return {
    heading: t("briefings.section.yesterday"),
    summary: tasks.length
      ? fill(t("briefings.yesterday.summary"), { done: num(f.done), rejected: num(f.rejected), expired: num(f.expired) })
      : t("briefings.yesterday.none"),
    items: tasks.map((x) => ({
      taskId: str(x.id) || undefined,
      text: `${str(x.title)}: ${OUTCOME_KEYS[str(x.status)] ? t(OUTCOME_KEYS[str(x.status)]) : str(x.status)}`,
    })),
  };
});

rendererById.set(CORE_SECTION_IDS.pendingApprovals, (facts, { lang, timeZone }) => {
  const f = isRecord(facts) ? facts : {};
  const tasks = list(f.tasks);
  const t = (k: StringKey) => translate(lang, k);
  return {
    heading: t("briefings.section.pending"),
    // Always stated explicitly, including when nothing is waiting.
    summary: tasks.length ? fill(t("briefings.pending.count"), { count: tasks.length }) : t("briefings.pending.none"),
    items: tasks.map((x) => {
      const until = str(x.approval_expires_at);
      const at = until ? new Date(until) : null;
      return {
        taskId: str(x.id) || undefined,
        text: str(x.title),
        note: at && !Number.isNaN(at.getTime()) ? fill(t("briefings.pending.until"), { time: formatTimestamp(at, timeZone, lang) }) : undefined,
      };
    }),
  };
});

/** Render stored sections in their stored order. */
export function renderSections(sections: readonly StoredSection[], ctx: RenderContext): RenderedSection[] {
  const out: RenderedSection[] = [];
  for (const s of sections) {
    const r = rendererById.get(s.id);
    if (r) out.push({ id: s.id, ...r(s.facts, ctx) });
  }
  return out;
}

/** The opening line; the assistant's name is supplied live by the caller. */
export function renderGreeting(assistantName: string, lang: Language): string {
  return fill(translate(lang, "briefings.greeting"), { name: assistantName });
}
