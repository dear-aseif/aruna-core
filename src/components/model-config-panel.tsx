"use client";
import type { ModelConfigView } from "@/server/settings/owner";
import { useT } from "./i18n-provider";
import { SettingsSection } from "./settings-section";
/** Read-only view of the tenant's model configuration (provider, model, where the value comes from). */
export function ModelConfigPanel({ model }: { model: ModelConfigView }) {
  const { t } = useT();
  return (
    <SettingsSection title={t("settings.model")} testId="settings-model">
      {model.ok ? (
        <dl className="flex flex-col gap-tight text-caption">
          <div className="flex gap-cozy"><dt className="shrink-0 text-ink-muted">{t("settings.model.provider")}</dt><dd className="text-ink">{model.provider}</dd></div>
          <div className="flex gap-cozy"><dt className="shrink-0 text-ink-muted">{t("settings.model.id")}</dt><dd className="break-all text-ink">{model.modelId}</dd></div>
          <div className="flex gap-cozy"><dt className="shrink-0 text-ink-muted">{t("settings.model.source")}</dt><dd className="text-ink">{t(model.source === "tenant" ? "settings.model.source.tenant" : "settings.model.source.default")}</dd></div>
        </dl>
      ) : (
        <p className="text-caption text-ink-muted">{t("settings.model.unavailable")}</p>
      )}
    </SettingsSection>
  );
}
