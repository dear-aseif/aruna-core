import { getPack, registerPack } from "./registry";
import { retailPack } from "./retail/fragment";
import { servicesPack } from "./services/fragment";

// The single composition point where the built-in packs register. Idempotent.
for (const def of [retailPack, servicesPack]) {
  if (!getPack(def.id)) registerPack(def);
}

export { getPack, listPackIds, registerPack, type PackDefinition, type PackScreen, type PackSchemaFragment } from "./registry";
