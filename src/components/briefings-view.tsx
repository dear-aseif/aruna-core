"use client";
import type { BriefingListItem, BriefingsModel } from "@/server/briefings";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
/** Today's briefing and the archive; each opens its detail. With no data it shows the honest empty state, never sample content. */
function BriefingRow({ b, testId }: { b: BriefingListItem; testId?: string }) {
  const { t } = useT();
  return (
    <div data-testid={testId} data-briefing-id={b.id} data-date={b.date} className="flex items-center justify-between gap-snug rounded-control border border-border p-cozy text-body text-ink">
      <span>{b.dateLabel}</span>
      <ButtonLink href={`/briefings/${b.id}`} size="sm" className="min-h-tap">{t("briefings.open")}</ButtonLink>
    </div>
  );
}
export function BriefingsView({ model }: { model: BriefingsModel }) {
  const { t, nav } = useT();
  return (
    <section className="flex flex-col gap-gutter" data-testid="briefings-view">
      <h1 className="text-title font-semibold">{nav({ id: "briefings", label: "briefings" })}</h1>
      <div className="flex flex-col gap-snug">
        <h2 className="text-body font-semibold text-ink-soft">{t("briefings.today")}</h2>
        {model.today ? (
          <BriefingRow b={model.today} testId="briefing-today" />
        ) : (
          <p data-testid="briefings-empty-today" className="rounded-control border border-border p-cozy text-body text-ink-muted">{t("briefings.emptyToday")}</p>
        )}
      </div>
      <div className="flex flex-col gap-snug">
        <h2 className="text-body font-semibold text-ink-soft">{t("briefings.archive")}</h2>
        {model.archive.length === 0 ? (
          <p data-testid="briefings-empty-archive" className="rounded-control border border-border p-cozy text-body text-ink-muted">{t("briefings.emptyArchive")}</p>
        ) : (
          <ul data-testid="briefing-archive" className="flex flex-col gap-snug">
            {model.archive.map((b) => (
              <li key={b.id}><BriefingRow b={b} testId="briefing-archive-item" /></li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
