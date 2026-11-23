"use client";
import type { BriefingsModel } from "@/server/briefings";
import { useT } from "./i18n-provider";
/** Today's briefing and the archive. With no data it shows the honest empty state; it never shows sample content. */
export function BriefingsView({ model }: { model: BriefingsModel }) {
  const { t, nav } = useT();
  return (
    <section className="flex flex-col gap-gutter" data-testid="briefings-view">
      <h1 className="text-title font-semibold">{nav({ id: "briefings", label: "briefings" })}</h1>
      <div className="flex flex-col gap-snug">
        <h2 className="text-body font-semibold text-ink-soft">{t("briefings.today")}</h2>
        {model.today ? (
          <p data-testid="briefing-today" className="rounded-control border border-border p-cozy text-body text-ink">{model.today.date}</p>
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
              <li key={b.id} className="rounded-control border border-border p-cozy text-body text-ink">{b.date}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
