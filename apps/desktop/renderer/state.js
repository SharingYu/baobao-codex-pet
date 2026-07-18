import { normalizeProgressByPet } from "./progression.js";
import { normalizePetRuntimeSettings } from "./pet-settings.js";

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function unwrapRendererState(savedState) {
  return objectOrEmpty(savedState?.rendererState ?? savedState?.petState ?? savedState);
}

export function migrateRendererState(savedState, installedPetIds = []) {
  const raw = unwrapRendererState(savedState);
  const installed = [...new Set(installedPetIds.filter(Boolean).map(String))];
  const storedPets = Object.fromEntries(
    Object.entries(objectOrEmpty(raw.pets ?? raw.petHistory)).map(([id, record]) => {
      const source = objectOrEmpty(record);
      const settings = normalizePetRuntimeSettings(source);
      const normalized = { ...source, ...settings };
      if (source.xRatio !== null && source.xRatio !== undefined && Number.isFinite(Number(source.xRatio))) {
        normalized.xRatio = Number(source.xRatio);
      } else {
        delete normalized.xRatio;
      }
      if (source.yRatio !== null && source.yRatio !== undefined && Number.isFinite(Number(source.yRatio))) {
        normalized.yRatio = Number(source.yRatio);
      } else {
        delete normalized.yRatio;
      }
      return [id, normalized];
    })
  );
  const progress = normalizeProgressByPet(raw.progressByPet ?? raw.intimacyByPet);
  const hadVisibility = Array.isArray(raw.visiblePetIds);
  const visiblePetIds = hadVisibility
    ? [...new Set(raw.visiblePetIds.filter((id) => installed.includes(String(id))).map(String))]
    : installed.slice();
  const activePetId = visiblePetIds.includes(String(raw.activePetId))
    ? String(raw.activePetId)
    : visiblePetIds[0] ?? null;

  return {
    version: 3,
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
