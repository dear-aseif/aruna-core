/**
 * Agent registry (task 8.1, design §2.6). Follows the pack registry pattern: the core knows only
 * Maestro; a pack registers its specialist agents here (groups 12 and 13 register Stock and
 * Booking). A specialist belongs to one pack and gets a thread for every tenant whose active
 * pack it is.
 *
 * Labels are plain role names ("Stock", "Booking"). The assistant's display name is not a label:
 * it is read live from settings (src/server/settings) and never stored in the registry.
 */
export const MAESTRO_AGENT = "maestro";

const AGENT_ID = /^[a-z][a-z0-9_]{0,62}$/;

export interface SpecialistDefinition {
  /** Stable agent id (also used as tasks.agent and threads.agent). Not "maestro". */
  id: string;
  /** The pack whose tenants get this specialist (tenants.active_pack). */
  pack: string;
  /** Human-readable role label, shown as the thread title. Never the assistant's name. */
  label: string;
}

const specialists = new Map<string, SpecialistDefinition>();

export function registerSpecialist(def: SpecialistDefinition): void {
  if (!AGENT_ID.test(def.id)) throw new Error(`invalid agent id: ${def.id}`);
  if (def.id === MAESTRO_AGENT) throw new Error("maestro is built into the core and cannot be registered");
  if (!def.pack || !def.label?.trim()) throw new Error(`specialist ${def.id} needs a pack and a label`);
  if (specialists.has(def.id)) throw new Error(`specialist already registered: ${def.id}`);
  specialists.set(def.id, { ...def });
}

export function getSpecialist(id: unknown): SpecialistDefinition | null {
  return typeof id === "string" ? (specialists.get(id) ?? null) : null;
}

/** The specialists of one pack, sorted by id (stable thread creation order). */
export function listSpecialistsForPack(pack: string | null): SpecialistDefinition[] {
  if (!pack) return [];
  return [...specialists.values()].filter((s) => s.pack === pack).sort((a, b) => a.id.localeCompare(b.id));
}
