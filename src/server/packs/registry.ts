import type { ZodType, ZodRawShape } from "zod";

/**
 * Pack registration point (design §2.8). A pack registers its Playbook schema fragment here;
 * the core knows nothing pack-specific. Later task groups (12, 13) extend `PackDefinition`
 * with the pack's entities, checks, routines and briefing section.
 */
export interface PackSchemaFragment {
  /** The pack's catalog shape (strict object): the core only requires that a catalog exists. */
  catalog: ZodType;
  /** Pack-specific threshold keys, merged into the core thresholds (strict). */
  thresholds: ZodRawShape;
  /** Pack-specific message templates (strict: templates of another pack are refused). */
  templates: ZodRawShape;
}

/** A workspace screen the pack contributes to the navigation shell (design §2.12). Content arrives in later tasks. */
export interface PackScreen {
  /** URL-safe slug, unique within the pack. */
  id: string;
  label: string;
}
export interface PackDefinition {
  id: string;
  label: string;
  /** Screens shown in the shell between Briefings and Settings, in order. */
  screens: readonly PackScreen[];
  fragment: PackSchemaFragment;
}

const packs = new Map<string, PackDefinition>();

export function registerPack(def: PackDefinition): void {
  if (packs.has(def.id)) throw new Error(`pack already registered: ${def.id}`);
  packs.set(def.id, def);
}

export function getPack(id: unknown): PackDefinition | null {
  return typeof id === "string" ? (packs.get(id) ?? null) : null;
}

export function listPackIds(): string[] {
  return [...packs.keys()].sort();
}
