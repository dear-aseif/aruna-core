"use client";
import { useEffect, useState } from "react";
import type { StringKey } from "@/i18n/strings";
import type { ExportSummary } from "@/server/exports";
import { Button } from "./button";
import { useT } from "./i18n-provider";
import { SettingsSection } from "./settings-section";
interface Ready {
  summary: ExportSummary;
  url: string;
}
/**
 * The owner's export trigger. It only calls the server operation, which always exports the
 * session's own tenant and answers with the archive (zip); the cutoff and entity counts come back
 * in headers. The panel offers the archive as a download link.
 */
export function ExportPanel({ available }: { available: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null as Ready | null);
  const [error, setError] = useState(null as StringKey | null);
  useEffect(() => () => void (result && URL.revokeObjectURL(result.url)), [result]);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/settings/export", { method: "POST" });
      if (res.ok) {
        const summary: ExportSummary = {
          cutoff: res.headers.get("X-Export-Cutoff") ?? "",
          manifest: JSON.parse(res.headers.get("X-Export-Manifest") ?? "{}") as Record<string, number>,
          fileName: res.headers.get("X-Export-File-Name") ?? "aruna-export.zip",
        };
        setResult({ summary, url: URL.createObjectURL(await res.blob()) });
      } else setError(res.status === 503 ? "settings.export.unavailable" : "settings.export.err");
    } catch {
      setError("settings.export.err");
    } finally {
      setBusy(false);
    }
  }
  const total = result ? Object.values(result.summary.manifest).reduce((a, b) => a + b, 0) : 0;
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
          <p className="text-caption text-ink-soft">
            {t("settings.export.done")} {t("settings.export.cutoff")} {result.summary.cutoff}. {t("settings.export.records")} {total}
          </p>
          <a href={result.url} download={result.summary.fileName} data-testid="export-download" className="text-body text-primary underline">
            {t("settings.export.download")}
          </a>
        </div>
      ) : null}
    </SettingsSection>
  );
}
