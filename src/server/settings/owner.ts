import { AuthenticationError, resolveSession } from "../auth/service";
import { callerFromAuth, withTenant, type TenantTx } from "../dal";
import { resolveModelConfig, type ModelConfig } from "../gateway";
import { getActivePlaybook } from "../playbook";
import { ShellForbiddenError } from "../workspace/shell";
import { hasExportRunner } from "../exports";
import { getAssistantName, getUiLanguage, renameAssistant } from "./index";
import type { Language } from "../../i18n/strings";
/**
 * Owner-facing settings operations (task 9.4, design §2.12). The tenant comes from the session.
 * Read-only views of the Playbook and the model configuration; the one edit here is the rename.
 */
export interface PlaybookView {
  version: number;
  business: { name: string; type: string; timezone: string };
  pack: string;
  hours: { day: string; open: string; close: string }[];
  briefingTime: string | null;
  thresholds: Record<string, number>;
  templates: Record<string, string>;
  /** Catalog groups (for example treatments or products) with their item names. */
  catalog: { group: string; items: string[] }[];
}
/** The tenant's effective gateway configuration. `unavailable` when the project default is not configured. */
export type ModelConfigView = ({ ok: true } & ModelConfig) | { ok: false };
export interface SettingsModel {
  assistantName: string;
  language: Language;
  playbook: PlaybookView;
  model: ModelConfigView;
  /** True when an export service is installed (task 10.3); the UI disables the trigger otherwise. */
  exportAvailable: boolean;
}
async function ownerTx<T>(token: unknown, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  return withTenant(callerFromAuth(auth), work);
}
function catalogView(catalog: unknown): PlaybookView["catalog"] {
  if (typeof catalog !== "object" || catalog === null) return [];
  return Object.entries(catalog).flatMap(([group, v]) =>
    Array.isArray(v)
      ? [{ group, items: v.map((i) => (typeof i === "object" && i !== null && typeof (i as { name?: unknown }).name === "string" ? (i as { name: string }).name : String(i))) }]
      : [],
  );
}
export async function loadSettingsTx(tx: TenantTx): Promise<SettingsModel> {
  const pb = await getActivePlaybook(tx);
  const row = await tx.maybeOne<{ version: number }>("select version from playbooks where active");
  const cfg = await tx.maybeOne<{ model_provider: string | null; model_id: string | null }>("select model_provider, model_id from settings where tenant_id = $1", [tx.tenantId]);
  let model: ModelConfigView;
  try {
    model = { ok: true, ...resolveModelConfig(cfg) };
  } catch {
    model = { ok: false };
  }
  return {
    assistantName: await getAssistantName(tx),
    language: await getUiLanguage(tx),
    playbook: {
      version: row?.version ?? 0,
      business: pb.business,
      pack: pb.pack,
      hours: pb.hours,
      briefingTime: pb.schedule?.briefingTime ?? null,
      thresholds: Object.fromEntries(Object.entries(pb.thresholds).filter((e): e is [string, number] => typeof e[1] === "number")),
      templates: pb.templates,
      catalog: catalogView(pb.catalog),
    },
    model,
    exportAvailable: hasExportRunner(),
  };
}
export const loadSettings = (token: unknown): Promise<SettingsModel> => ownerTx(token, loadSettingsTx);
/** Rename the assistant for the session's own tenant. The name is audited; returns the saved name. */
export const renameAssistantForOwner = (token: unknown, name: unknown): Promise<string> => ownerTx(token, (tx) => renameAssistant(tx, name));
