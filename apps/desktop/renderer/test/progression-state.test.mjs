import test from "node:test";
import assert from "node:assert/strict";
import { awardAffinity, levelForAffinity, unlockLevelForItem } from "../progression.js";
import { mergePetHistory, migrateRendererState } from "../state.js";
import { findLandingPlatform, findSnapPlatform, normalizePlatforms } from "../platforms.js";

test("affinity thresholds follow the v0.3 contract", () => {
  assert.deepEqual([0, 39, 40, 119, 120, 299, 300, 599, 600].map(levelForAffinity), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
});

test("daily caps and touch-zone cooldowns do not block the reaction itself", () => {
  let progress = {};
  const first = awardAffinity(progress, "pet-head", { timestamp: 1_000, dayKey: "2026-07-16" });
  assert.equal(first.reward, 3);
  progress = first.progress;
  const cooldown = awardAffinity(progress, "pet-head", { timestamp: 5_000, dayKey: "2026-07-16" });
  assert.equal(cooldown.reward, 0);
  assert.equal(cooldown.reason, "cooldown");
  const later = awardAffinity(progress, "pet-back", { timestamp: 35_000, dayKey: "2026-07-16" });
  assert.equal(later.reward, 2);
});

test("state v1 migrates visible pets and v2 preserves hidden unknown history", () => {
  const v1 = migrateRendererState({ version: 1, activePetId: "bao", pets: { bao: { xRatio: 0.2 } } }, ["bao", "fei"]);
  assert.deepEqual(v1.visiblePetIds, ["bao", "fei"]);
  assert.equal(v1.platformInteractions, false, "legacy state must not silently opt into window scanning");
  const v2 = migrateRendererState({ version: 2, visiblePetIds: ["fei", "gone"], pets: { gone: { xRatio: 0.8 } } }, ["bao", "fei"]);
  assert.deepEqual(v2.visiblePetIds, ["fei"]);
  assert.deepEqual(mergePetHistory(v2.pets, { fei: { xRatio: 0.3 } }).gone, {
    xRatio: 0.8,
    appearanceScale: 1,
    movementSpeed: 1
  });
});

test("state v3 migrates and clamps per-pet presentation settings", () => {
  const state = migrateRendererState({
    pets: {
      bao: { xRatio: 0.2, appearanceScale: 8, movementSpeed: 0.1 },
      hidden: { size: 1.25, speed: 1.55 }
    }
  }, ["bao"]);
  assert.equal(state.version, 3);
  assert.deepEqual(state.pets.bao, { xRatio: 0.2, appearanceScale: 1.8, movementSpeed: 0.5 });
  assert.equal(state.pets.hidden.appearanceScale, 1.25);
  assert.equal(state.pets.hidden.movementSpeed, 1.55);

  const invalidCoordinates = migrateRendererState({ pets: { bao: { xRatio: null, yRatio: "oops" } } }, ["bao"]);
  assert.equal(Object.hasOwn(invalidCoordinates.pets.bao, "xRatio"), false);
  assert.equal(Object.hasOwn(invalidCoordinates.pets.bao, "yRatio"), false);
});

test("window platform scanning requires an explicitly stored true preference", () => {
  assert.equal(migrateRendererState({}, ["bao"]).platformInteractions, false);
  assert.equal(migrateRendererState({ platformInteractions: false }, ["bao"]).platformInteractions, false);
  assert.equal(migrateRendererState({ platformInteractions: 1 }, ["bao"]).platformInteractions, false);
  assert.equal(migrateRendererState({ platformInteractions: true }, ["bao"]).platformInteractions, true);
});

test("unlock level supports both manifest shapes", () => {
  assert.equal(unlockLevelForItem({ unlockLevel: 3 }), 3);
  assert.equal(unlockLevelForItem({ unlock: { affinityLevel: 4 } }), 4);
});

test("platform helpers snap only at a top edge and land while falling", () => {
  const platforms = normalizePlatforms([{ id: "notepad", x: 100, y: 300, width: 500, height: 400 }]);
  assert.equal(findSnapPlatform(platforms, 150, 318), platforms[0]);
  assert.equal(findSnapPlatform(platforms, 150, 380), null);
  assert.equal(findLandingPlatform(platforms, 250, 280, 320), platforms[0]);
});
