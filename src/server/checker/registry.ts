import type { TenantTx } from "../dal";
import type { TaskRow } from "../tasks";
import type { CheckRule } from "./rules";

/**
 * Per-pack Checker rule registry (task 6.1, design §2.4) and the action-type registry that
 * declares which action types are gated (consumed by the approval slice, task 6.3).
 */

/** Loads the verified source records a draft is checked against, inside the checker's transaction. */
export type SourceLoader = (tx: TenantTx, task: TaskRow) => Promise<Record<string, unknown>>;

export interface CheckerPack {
  /** Pack id, as in the Playbook's `pack` (for example "retail", "services"). */
  packId: string;
  rules: readonly CheckRule[];
  /** Omitted: rules see an empty `sources` object. */
  loadSources?: SourceLoader;
}

const packs = new Map<string, CheckerPack>();

export function registerCheckerPack(def: CheckerPack): void {
  if (packs.has(def.packId)) throw new Error(`checker rules already registered for pack: ${def.packId}`);
  const ids = new Set<string>();
  for (const r of def.rules) {
    if (ids.has(r.id)) throw new Error(`duplicate checker rule id "${r.id}" in pack ${def.packId}`);
    ids.add(r.id);
  }
  packs.set(def.packId, def);
}

export function getCheckerPack(packId: string): CheckerPack | null {
  return packs.get(packId) ?? null;
}

/** Test support: remove one pack's registration. */
export function unregisterCheckerPack(packId: string): void {
  packs.delete(packId);
}

export interface ActionTypeDef {
  type: string;
  /** True: a deterministic pass goes to Pending Approval. False: it goes straight to Done. */
  gated: boolean;
}

const actionTypes = new Map<string, ActionTypeDef>();

export function registerActionType(def: ActionTypeDef): void {
  if (!def.type || typeof def.type !== "string") throw new Error("action type is required");
  if (actionTypes.has(def.type)) throw new Error(`action type already registered: ${def.type}`);
  actionTypes.set(def.type, { type: def.type, gated: def.gated });
}

export function getActionType(type: unknown): ActionTypeDef | null {
  return typeof type === "string" ? (actionTypes.get(type) ?? null) : null;
}

/** Test support: remove one action type's registration. */
export function unregisterActionType(type: string): void {
  actionTypes.delete(type);
}
