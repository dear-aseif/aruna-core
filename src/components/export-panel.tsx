"use client";
import { useState } from "react";
import type { StringKey } from "@/i18n/strings";
import type { ExportSummary } from "@/server/exports";
import { Button } from "./button";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
import { SettingsSection } from "./settings-section";
/** The owner's export trigger. It only calls the server operation, which always exports the session's own tenant. */
export function ExportPanel({ available }: { available: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null as ExportSummary | null);
  const [error, setError] = useState(null as StringKey | null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/settings/export", { method: "POST" });
      if (res.ok) setResult((await res.json()) as ExportSummary);
      else setError(res.status === 503 ? "settings.export.unavailable" : "settings.export.err");
    } catch {
      setError("settings.export.err");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSection title={t("settings.export")} testId="settings-export">
      <p className="text-caption text-ink-muted">{t("settings.export.body")}</p>
      <Button onClick={run} disabled={!available || busy} className="min-h-tap" data-testid="export-run">
        {busy ? t("settings.export.running") : t("settings.export.run")}
      </Button>
      {!available ? <p data-testid="export-unavailable" className="text-caption text-ink-muted">{t("settings.export.unavailable")}</p> : null}
      {error ? <p role="alert" className="text-caption text-danger">{t(error)}</p> : null}
      {result ? (
        <div data-testid="export-result" className="flex flex-col gap-snug">
          <p className="text-caption text-ink-soft">{t("settings.export.done")} {t("settings.export.cutoff")} {result.cutoff}</p>
          <a href={result.downloadPath} className="text-body text-primary underline">{t("settings.export.download")}</a>
        </div>
      ) : null}
    </SettingsSection>
  );
}
