"use client";
import type { StringKey } from "@/i18n/strings";
import type { PlaybookView } from "@/server/settings/owner";
import { useT } from "./i18n-provider";
import { SettingsSection } from "./settings-section";
/** Read-only view of the active Playbook as stored. Field names from the Playbook are data and are shown as they are. */
export function PlaybookPanel({ playbook }: { playbook: PlaybookView }) {
  const { t } = useT();
  const row = (label: string, value: string, testId?: string) => (
    <div key={label} className="flex gap-cozy"><dt className="shrink-0 text-ink-muted">{label}</dt><dd data-testid={testId} className="text-ink">{value}</dd></div>
  );
  return (
    <SettingsSection title={t("settings.playbook")} testId="settings-playbook">
      <p className="text-caption text-ink-muted">{t("settings.playbook.readOnly")}</p>
      <dl className="flex flex-col gap-tight text-caption">
        {row(t("settings.business"), playbook.business.name, "playbook-business")}
        {row(t("settings.type"), playbook.business.type)}
        {row(t("settings.timezone"), playbook.business.timezone)}
        {row(t("settings.pack"), playbook.pack)}
        {row(t("settings.version"), String(playbook.version))}
        {playbook.briefingTime ? row(t("settings.briefingTime"), playbook.briefingTime) : null}
      </dl>
      <h3 className="text-caption font-semibold text-ink-soft">{t("settings.hours")}</h3>
      <ul className="flex flex-col gap-tight text-caption text-ink">
        {playbook.hours.map((h) => (
          <li key={h.day}>{t(`day.${h.day}` as StringKey)} {h.open}–{h.close}</li>
        ))}
      </ul>
      {Object.keys(playbook.thresholds).length > 0 ? (
        <>
          <h3 className="text-caption font-semibold text-ink-soft">{t("settings.thresholds")}</h3>
          <dl className="flex flex-col gap-tight text-caption">
            {Object.entries(playbook.thresholds).map(([k, v]) => row(k, String(v)))}
          </dl>
        </>
      ) : null}
      <h3 className="text-caption font-semibold text-ink-soft">{t("settings.templates")}</h3>
      <dl className="flex flex-col gap-tight text-caption">
        {Object.entries(playbook.templates).map(([k, v]) => (
          <div key={k} className="flex flex-col"><dt className="text-ink-muted">{k}</dt><dd className="break-words text-ink">{v}</dd></div>
        ))}
      </dl>
      {playbook.catalog.map((g) => (
        <div key={g.group} className="flex flex-col gap-tight">
          <h3 className="text-caption font-semibold text-ink-soft">{t("settings.catalog")}: {g.group}</h3>
          <p className="text-caption text-ink">{g.items.join(", ")}</p>
        </div>
      ))}
    </SettingsSection>
  );
}
