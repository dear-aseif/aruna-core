import { getSpecialist, registerSpecialist } from "@/server/agents";

/**
 * Test-only specialists (task 8.1). The real Booking and Stock specialists are registered by the
 * packs in groups 12 and 13; these use `test_` ids so they can never collide with them. Never
 * imported by src/.
 */
export const TEST_SPECIALISTS = [
  { id: "test_scribe", pack: "services", label: "Test Scribe" },
  { id: "test_counter", pack: "retail", label: "Test Counter" },
  { id: "test_counter_two", pack: "retail", label: "Test Counter Two" },
] as const;

export function registerTestSpecialists(): void {
  for (const s of TEST_SPECIALISTS) if (!getSpecialist(s.id)) registerSpecialist({ ...s });
}
