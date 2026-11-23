import "../packs";
import { AuthenticationError, resolveSession } from "../auth/service";
import { withTenant, callerFromAuth, type TenantTx } from "../dal";
import { getPack } from "../packs";
import { getActivePlaybook, NoActivePlaybookError } from "../playbook";
import { getAssistantName, getUiLanguage, setUiLanguage } from "../settings";
import type { Language } from "../../i18n/strings";

/** One entry of the navigation shell. `href` is an app route; the shell never builds routes itself. */
export interface NavItem {
  id: string;
  label: string;
  href: string;
  kind: "core" | "pack";
}

export interface ShellModel {
  businessName: string;
  assistantName: string;
  /** The tenant's UI language (EN by default). */
  language: Language;
  pack: string;
  /** Core items first, then the active pack's screens, then Settings. */
  nav: NavItem[];
}

export class ShellForbiddenError extends Error {
  constructor() {
    super("the owner workspace is for owner sessions");
    this.name = "ShellForbiddenError";
  }
}

const CORE_BEFORE: NavItem[] = [
  { id: "board", label: "Board", href: "/board", kind: "core" },
  { id: "chat", label: "Chat", href: "/chat", kind: "core" },
  { id: "briefings", label: "Briefings", href: "/briefings", kind: "core" },
];
const CORE_AFTER: NavItem[] = [{ id: "settings", label: "Settings", href: "/settings", kind: "core" }];

/** Pure: the one navigation list for every tenant. Only the pack's screens differ. */
export function buildNav(packId: string): NavItem[] {
  const pack = getPack(packId);
  const screens: NavItem[] = (pack?.screens ?? []).map((s) => ({
    id: `${pack!.id}:${s.id}`,
    label: s.label,
    href: `/p/${s.id}`,
    kind: "pack",
  }));
  return [...CORE_BEFORE, ...screens, ...CORE_AFTER];
}

/** Read the shell model inside the caller's tenant transaction. Names come from the Playbook and settings only. */
export async function getShellModelTx(tx: TenantTx): Promise<ShellModel> {
  const pb = await getActivePlaybook(tx);
  const assistantName = await getAssistantName(tx);
  const language = await getUiLanguage(tx);
  return { businessName: pb.business.name, assistantName, language, pack: pb.pack, nav: buildNav(pb.pack) };
}

/**
 * The server operation behind the workspace shell (used by the API route and the layout).
 * The tenant comes from the session, never from input. Returns null when the tenant has no
 * active Playbook yet.
 */
export async function loadShell(token: unknown): Promise<ShellModel | null> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  try {
    return await withTenant(callerFromAuth(auth), getShellModelTx);
  } catch (e) {
    if (e instanceof NoActivePlaybookError) return null;
    throw e;
  }
}

/** True when `screenId` is a screen of the pack (guards the /p/[screen] route). */
export function findPackScreen(packId: string, screenId: string): NavItem | null {
  return buildNav(packId).find((n) => n.kind === "pack" && n.href === `/p/${screenId}`) ?? null;
}

/**
 * Server operation: set the UI language for the session's own tenant (owner sessions only).
 * The tenant comes from the session, never from input; an unsupported value is refused.
 */
export async function setShellLanguage(token: unknown, language: unknown): Promise<Language> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  if (auth.role !== "owner") throw new ShellForbiddenError();
  return withTenant(callerFromAuth(auth), (tx) => setUiLanguage(tx, language));
}
