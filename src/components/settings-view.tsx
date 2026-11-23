"use client";
import type { SettingsModel } from "@/server/settings/owner";
import { AssistantNameForm } from "./assistant-name-form";
import { ExportPanel } from "./export-panel";
import { useT } from "./i18n-provider";
import { ModelConfigPanel } from "./model-config-panel";
import { PlaybookPanel } from "./playbook-panel";
import { SettingsSection } from "./settings-section";
/** The settings screen for an owner: assistant rename, Playbook view, model configuration, data export. */
export function SettingsView({ model }: { model: SettingsModel }) {
  const { t, nav } = useT();
  return (
    <div className="flex flex-col gap-gutter" data-testid="settings-view">
      <h1 className="text-title font-semibold">{nav({ id: "settings", label: "settings" })}</h1>
      <SettingsSection title={t("settings.assistant")} testId="settings-assistant">
        <AssistantNameForm key={model.assistantName} current={model.assistantName} />
      </SettingsSection>
      <PlaybookPanel playbook={model.playbook} />
      <ModelConfigPanel model={model.model} />
      <ExportPanel available={model.exportAvailable} />
    </div>
  );
}
