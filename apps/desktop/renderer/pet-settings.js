export const PET_APPEARANCE_SCALE = Object.freeze({ min: 0.6, max: 1.8, step: 0.05, defaultValue: 1 });
export const PET_MOVEMENT_SPEED = Object.freeze({ min: 0.5, max: 2, step: 0.05, defaultValue: 1 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizedNumber(value, contract) {
  const number = Number(value);
  if (!Number.isFinite(number)) return contract.defaultValue;
  const stepped = Math.round(number / contract.step) * contract.step;
  return Number(clamp(stepped, contract.min, contract.max).toFixed(2));
}

export function normalizeAppearanceScale(value) {
  return normalizedNumber(value, PET_APPEARANCE_SCALE);
}

export function normalizeMovementSpeed(value) {
  return normalizedNumber(value, PET_MOVEMENT_SPEED);
}

export function normalizePetRuntimeSettings(value = {}) {
  return {
    appearanceScale: normalizeAppearanceScale(value.appearanceScale ?? value.userScale ?? value.size),
    movementSpeed: normalizeMovementSpeed(value.movementSpeed ?? value.speed)
  };
}
