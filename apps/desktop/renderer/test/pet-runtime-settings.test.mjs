import test from "node:test";
import assert from "node:assert/strict";
import { PetActor } from "../pet-actor.js";
import {
  normalizeAppearanceScale,
  normalizeMovementSpeed,
  normalizePetRuntimeSettings
} from "../pet-settings.js";

function createWorld(overrides = {}) {
  return {
    width: 1200,
    height: 800,
    quiet: false,
    reducedMotion: false,
    pointer: { x: 0, y: 0, seen: false },
    updatePlatformPet() { return false; },
    resolveTarget(target) { return target; },
    onPetArrived(pet) { pet.setState("idle"); },
    releaseBoxOccupant() {},
    spawnHearts() {},
    progressFor() { return { level: 1 }; },
    ...overrides
  };
}

function createActor(savedState = {}, world = createWorld()) {
  return new PetActor(world, {
    id: "settings-cat",
    name: "Settings Cat",
    displayName: "Settings Cat",
    color: "#abc",
    image: null,
    manifest: {
      renderer: {
        cellWidth: 192,
        cellHeight: 208,
        defaultScale: 1,
        anchor: { x: 0.5, y: 1 },
        animations: { idle: { row: 0, frames: [0], frameDurationsMs: [100], loop: true } }
      },
      interactions: { eventMap: { idle: "idle" } }
    }
  }, savedState, 0);
}

test("runtime size and speed values are finite, stepped, and bounded", () => {
  assert.equal(normalizeAppearanceScale(99), 1.8);
  assert.equal(normalizeAppearanceScale(1.234), 1.25);
  assert.equal(normalizeMovementSpeed(-4), 0.5);
  assert.equal(normalizeMovementSpeed(1.234), 1.25);
  assert.deepEqual(normalizePetRuntimeSettings({ size: 1.4, speed: 1.6 }), {
    appearanceScale: 1.4,
    movementSpeed: 1.6
  });
});

test("resizing a pet is immediate and preserves its grounded foot", () => {
  const actor = createActor({ appearanceScale: 1.2, movementSpeed: 1.3 });
  actor.placeFootAt(480, 620);
  const foot = actor.foot;
  const oldWidth = actor.width;

  assert.equal(actor.setAppearanceScale(1.55), true);
  assert.equal(actor.appearanceScale, 1.55);
  assert.ok(actor.width > oldWidth);
  assert.deepEqual(actor.foot, foot);
  assert.equal(actor.movementSpeed, 1.3);
});

test("movement speed scales autonomous travel and animation state", () => {
  const slow = createActor({ movementSpeed: 0.5 });
  const fast = createActor({ movementSpeed: 2 });
  slow.x = fast.x = 100;
  slow.y = fast.y = 420;
  slow.walkTo(1000, slow.center.y, "wander", { radius: 1 });
  fast.walkTo(1000, fast.center.y, "wander", { radius: 1 });
  const slowStart = slow.x;
  const fastStart = fast.x;

  slow.update(0.02, 1000);
  fast.update(0.02, 1000);

  assert.ok(Math.abs((fast.x - fastStart) / (slow.x - slowStart) - 4) < 0.001);
  assert.equal(slow.state, "walk");
  assert.equal(fast.state, "walk");
});

test("dragging uses the carried state and releases without leaving a stuck actor", () => {
  const actor = createActor();
  assert.equal(actor.setDragging(true, 1000), true);
  assert.equal(actor.dragging, true);
  assert.equal(actor.state, "carried");
  actor.update(0.02, 1100);
  assert.equal(actor.state, "carried");

  assert.equal(actor.setDragging(false, 1200), true);
  assert.equal(actor.dragging, false);
  assert.equal(actor.state, "idle");
});

test("conditional rest actions include grooming and sleep", () => {
  const actor = createActor();
  actor.idleSince = 0;
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.65;
    actor.chooseAutonomousAction(5000);
    assert.equal(actor.state, "groom");

    actor.setState("idle", 0, 6000);
    actor.idleSince = 0;
    Math.random = () => 0.85;
    actor.chooseAutonomousAction(9000);
    assert.equal(actor.state, "sleep");
    assert.ok(actor.stateUntil > 9000);
  } finally {
    Math.random = originalRandom;
  }
});

test("runtime recovery repairs non-finite coordinates and clears transient work", () => {
  const actor = createActor();
  actor.x = Number.NaN;
  actor.y = Number.POSITIVE_INFINITY;
  actor.target = { x: Number.NaN, y: 0 };
  actor.dragging = true;
  actor.recoverFromRuntimeError(2000);

  assert.equal(Number.isFinite(actor.x), true);
  assert.equal(Number.isFinite(actor.y), true);
  assert.equal(actor.target, null);
  assert.equal(actor.dragging, false);
  assert.equal(actor.state, "idle");
});

test("long mixed-action stress run never produces a non-finite actor", () => {
  const actor = createActor({ appearanceScale: 1.35, movementSpeed: 1.75 });
  let timestamp = 0;
  for (let index = 0; index < 20_000; index += 1) {
    timestamp += 16;
    if (index % 311 === 0) actor.walkTo((index * 17) % 1100, 500, "wander", { radius: 4 });
    if (index % 997 === 0) {
      actor.setDragging(true, timestamp);
      actor.setDragging(false, timestamp + 1);
    }
    actor.update(0.016, timestamp);
    assert.equal(Number.isFinite(actor.x) && Number.isFinite(actor.y), true);
    assert.ok(actor.appearanceScale >= 0.6 && actor.appearanceScale <= 1.8);
    assert.ok(actor.movementSpeed >= 0.5 && actor.movementSpeed <= 2);
  }
});
