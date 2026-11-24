"use client";
import type { BriefingDetailModel } from "@/server/briefings";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
/** One stored briefing reopened: greeting, then each section's summary and items. Read only. */
export function BriefingDetailView({ briefing }: { briefing: BriefingDetailModel }) {
  const { t } = useT();
  return (
    <div data-testid="briefing-detail" data-briefing-id={briefing.id} data-date={briefing.date} className="flex flex-col gap-gutter p-gutter">
      <ButtonLink href="/briefings" size="sm" className="min-h-tap self-start">{t("briefings.back")}</ButtonLink>
      <header className="flex flex-col gap-tight">
        <h1 data-testid="briefing-title" className="text-title font-semibold text-ink">{briefing.dateLabel}</h1>
        <p data-testid="briefing-greeting" className="text-body text-ink">{briefing.greeting}</p>
        <p className="text-caption text-ink-muted">{t("briefings.generated")} {briefing.generated} · {t("briefings.timezone")} {briefing.timeZone}</p>
      </header>
      {briefing.sections.map((s) => (
        <section key={s.id} data-testid="briefing-section" data-section-id={s.id} className="flex flex-col gap-snug">
          <h2 className="text-body font-semibold text-ink-soft">{s.heading}</h2>
          <p data-testid="briefing-summary" className="text-body text-ink">{s.summary}</p>
          {s.items.length > 0 ? (
            <ul className="flex flex-col gap-snug">
              {s.items.map((i, n) => (
                <li key={`${i.taskId ?? "x"}-${n}`} data-testid="briefing-item" className="flex flex-col gap-tight rounded-control border border-border bg-surface p-cozy text-caption">
                  <span className="text-ink">{i.text}</span>
                  {i.note ? <span className="text-ink-muted">{i.note}</span> : null}
                  {i.taskId ? <ButtonLink href={`/board/${i.taskId}`} size="sm" className="min-h-tap self-start">{t("briefings.openTask")}</ButtonLink> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}
