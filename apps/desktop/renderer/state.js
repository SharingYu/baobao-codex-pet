import { normalizeProgressByPet } from "./progression.js";

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function unwrapRendererState(savedState) {
  return objectOrEmpty(savedState?.rendererState ?? savedState?.petState ?? savedState);
}

export function migrateRendererState(savedState, installedPetIds = []) {
  const raw = unwrapRendererState(savedState);
  const installed = [...new Set(installedPetIds.filter(Boolean).map(String))];
  const storedPets = objectOrEmpty(raw.pets ?? raw.petHistory);
  const progress = normalizeProgressByPet(raw.progressByPet ?? raw.intimacyByPet);
  const hadVisibility = Array.isArray(raw.visiblePetIds);
  const visiblePetIds = hadVisibility
    ? [...new Set(raw.visiblePetIds.filter((id) => installed.includes(String(id))).map(String))]
    : installed.slice();
  const activePetId = visiblePetIds.includes(String(raw.activePetId))
    ? String(raw.activePetId)
    : visiblePetIds[0] ?? null;

  return {
    version: 2,
    quiet: Boolean(raw.quiet),
    platformInteractions: raw.platformInteractions === true,
    visiblePetIds,
    activePetId,
    pets: { ...storedPets },
    progressByPet: progress,
    guideDone: Boolean(raw.guideDone),
    platformHintShown: Boolean(raw.platformHintShown)
  };
}

export function mergePetHistory(previous = {}, visibleRecords = {}) {
  return { ...objectOrEmpty(previous), ...objectOrEmpty(visibleRecords) };
}
