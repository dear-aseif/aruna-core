import type { TenantTx } from "../dal";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "../../i18n/strings";

/**
 * The one reader of the assistant's display name (design §2.6, R4.4, R4.5). Every surface that
 * shows the name (chat now, briefings and the workspace later) calls this inside its own
 * transaction, so a rename in settings is visible on the next read and no copy can go stale.
 * The name is never written to any other table.
 */
export async function getAssistantName(tx: TenantTx): Promise<string> {
  const row = await tx.maybeOne<{ assistant_name: string }>("select assistant_name from settings where tenant_id = $1", [tx.tenantId]);
  if (!row) throw new Error("tenant has no settings row (activate a Playbook first)");
  return row.assistant_name;
}

/** The tenant's UI language (presentation setting; default EN). Read inside the caller's tenant transaction. */
export async function getUiLanguage(tx: TenantTx): Promise<Language> {
  const row = await tx.maybeOne<{ ui_language: string }>("select ui_language from settings where tenant_id = $1", [tx.tenantId]);
  return row && isLanguage(row.ui_language) ? row.ui_language : DEFAULT_LANGUAGE;
}

export class InvalidLanguageError extends Error {
  constructor() {
    super("unsupported language");
    this.name = "InvalidLanguageError";
  }
}

/** Persist the tenant's UI language and audit the change in the same transaction. Returns the saved value. */
export async function setUiLanguage(tx: TenantTx, language: unknown): Promise<Language> {
  if (!isLanguage(language)) throw new InvalidLanguageError();
  const before = await getUiLanguage(tx);
  await tx.updateById("settings", tx.tenantId, { ui_language: language, updated_at: new Date() }, "tenant_id");
  await tx.audit("settings.ui_language_changed", { from: before, to: language });
  return language;
}
export const MAX_ASSISTANT_NAME_LENGTH = 60;
export const ASSISTANT_RENAME_AUDIT_TYPE = "settings.assistant_name_changed";
export class InvalidAssistantNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAssistantNameError";
  }
}
/** Only the owner renames the assistant. Nothing was written. */
export class RenameNotPermittedError extends Error {
  constructor(readonly actor: string) {
    super("only the owner can rename the assistant");
    this.name = "RenameNotPermittedError";
  }
}
/**
 * Rename the assistant (task 9.4, R4.5). The name lives only in `settings.assistant_name`; every
 * surface reads it through `getAssistantName`, so the change is visible on the next read everywhere.
 * The old and new names are audited in the same transaction, attributed to the owner. Renaming to the
 * current name writes nothing. Returns the saved name.
 */
export async function renameAssistant(tx: TenantTx, input: unknown): Promise<string> {
  if (tx.caller.actor !== "owner") throw new RenameNotPermittedError(tx.caller.actor);
  if (typeof input !== "string") throw new InvalidAssistantNameError("name must be text");
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) throw new InvalidAssistantNameError("name is required");
  if ([...name].length > MAX_ASSISTANT_NAME_LENGTH) throw new InvalidAssistantNameError(`name is longer than ${MAX_ASSISTANT_NAME_LENGTH} characters`);
  if (/\p{Cc}/u.test(name)) throw new InvalidAssistantNameError("name has control characters");
  const before = await getAssistantName(tx);
  if (before === name) return before;
  await tx.updateById("settings", tx.tenantId, { assistant_name: name, updated_at: new Date() }, "tenant_id");
  await tx.audit(ASSISTANT_RENAME_AUDIT_TYPE, { field: "assistant_name", from: before, to: name });
  return name;
}
