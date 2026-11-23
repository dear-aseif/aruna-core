"use client";
import { STRINGS, type StringKey } from "@/i18n/strings";
import type { TrailEntry } from "@/server/board/history";
import { useT } from "./i18n-provider";
/** The task's audit trail, oldest first, read only. Times arrive formatted in the business timezone. */
export function AuditTrail({ entries }: { entries: TrailEntry[] }) {
  const { t, lang } = useT();
  const label = (type: string) => (`audit.type.${type}` in STRINGS[lang] ? t(`audit.type.${type}` as StringKey) : type);
  if (entries.length === 0) return <p className="text-caption text-ink-muted">{t("task.detail.auditEmpty")}</p>;
  return (
    <ol data-testid="audit-trail" className="flex flex-col gap-cozy">
      {entries.map((e) => (
        <li key={e.id} data-testid="audit-entry" data-type={e.type} className="flex flex-col gap-tight rounded-control border border-border bg-surface p-cozy text-caption">
          <div className="flex items-start justify-between gap-snug">
            <span className="font-semibold text-ink">{label(e.type)}</span>
            <time dateTime={e.atIso} className="text-right text-ink-muted">{e.at}</time>
          </div>
          <p className="text-ink-muted">{e.actor} · {e.actorId}</p>
          {e.facts.length > 0 ? (
            <dl className="flex flex-col gap-tight">
              {e.facts.map((f) => (
                <div key={f.key} className="flex gap-cozy">
                  <dt className="shrink-0 text-ink-muted">{f.key}</dt>
                  <dd className="min-w-0 break-words text-ink">{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
