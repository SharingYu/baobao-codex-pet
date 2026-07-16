import test from "node:test";
import assert from "node:assert/strict";
import { PetActor } from "../pet-actor.js";
import { PetWorld } from "../pet-world.js";
import { lookCellForVector } from "../sprite.js";

const syntheticManifest = {
  format: "com.baofeifei.petpack",
  manifestVersion: "1.0",
  id: "third-party-anchor-cat",
  displayName: "Anchor Cat",
  description: "Synthetic third-party manifest used to verify the public runtime contract.",
  license: "MIT",
  source: { kind: "native" },
  assets: [{
    id: "atlas",
    path: "assets/atlas.webp",
    mediaType: "image/webp",
    bytes: 1,
    sha256: "0".repeat(64),
    width: 800,
    height: 2400
  }],
  renderer: {
    type: "sprite-atlas",
    atlasAsset: "atlas",
    cellWidth: 100,
    cellHeight: 200,
    columns: 8,
    rows: 12,
    anchor: { x: 0.25, y: 0.75 },
    defaultScale: 1.5,
    animations: {
      idle: { row: 0, frames: [0], frameDurationsMs: [120], loop: true },
      sparkle: { row: 11, frames: [6], frameDurationsMs: [240], loop: false }
    },
    lookDirections: [
      { degrees: 10, row: 4, column: 1 },
      { degrees: 100, row: 6, column: 3 },
      { degrees: 190, row: 8, column: 2 },
      { degrees: 280, row: 10, column: 4 }
    ]
  },
  interactions: {
    eventMap: { idle: "idle", "rub-flank": "sparkle" },
    touchZones: [{
      id: "flank",
      label: "Flank",
      event: "rub-flank",
      x: 0.2,
      y: 0.2,
      width: 0.24,
      height: 0.24
    }]
  }
};

function createWorld(overrides = {}) {
  return Object.assign(Object.create(PetWorld.prototype), {
    width: 1200,
    height: 1000,
    platformHintShown: true,
    callbacks: { requestSave() {}, toast() {} },
    spawnHearts() {},
    progressFor() { return { level: 1 }; },
    ...overrides
  });
}

function createActor(world = createWorld()) {
  return new PetActor(world, {
    id: syntheticManifest.id,
    name: syntheticManifest.displayName,
    displayName: syntheticManifest.displayName,
    manifest: syntheticManifest,
    color: "#abc",
    image: { complete: true, naturalWidth: 800 }
  }, {}, 0);
}

test("a third-party defaultScale and anchor control actor size and platform grounding", () => {
  const world = createWorld();
  const actor = createActor(world);

  assert.equal(actor.width, 178 * 1.5);
  assert.equal(actor.height, actor.width * 2);
  assert.deepEqual(actor.anchor, { x: 0.25, y: 0.75 });

  actor.placeFootAt(420, 360);
  assert.deepEqual(actor.foot, { x: 420, y: 360 });

  world.attachPetToPlatform(actor, {
    id: "window-42",
    left: 100,
    top: 240,
    width: 500,
    height: 300
  });
  assert.equal(actor.foot.y, 240);
  assert.equal(actor.foot.x, 420);
  assert.equal(actor.x, actor.foot.x - actor.width * 0.25);
  assert.equal(actor.y, 240 + 7 - actor.height * 0.75);
});

test("renderer.lookDirections supplies both direction angles and atlas cells", () => {
  const directions = syntheticManifest.renderer.lookDirections;
  assert.deepEqual(lookCellForVector(100, 0, directions), { row: 6, column: 3 });
  assert.deepEqual(lookCellForVector(-100, 0, directions), { row: 10, column: 4 });

  const actor = createActor();
  actor.x = 100;
  actor.y = 120;
  actor.state = "look";
  actor.lookTarget = { x: actor.center.x + 100, y: actor.center.y };
  const drawCalls = [];
  const context = {
    globalAlpha: 1,
    save() {},
    restore() {},
    drawImage(...args) { drawCalls.push(args); }
  };
  actor.draw(context, 1_000, false);
  assert.deepEqual(drawCalls[0].slice(1, 5), [300, 1200, 100, 200]);
});

test("a declared touch zone routes its event instead of deriving one from the zone id", () => {
  const actor = createActor();
  actor.x = 100;
  actor.y = 100;
  const touch = actor.touchInteractionAt(
    actor.x + actor.width * 0.3,
    actor.y + actor.height * 0.3
  );

  assert.deepEqual(touch, { id: "flank", event: "rub-flank", label: "Flank" });
  assert.equal(actor.touchZoneAt(actor.x + actor.width * 0.3, actor.y + actor.height * 0.3), "flank");
  actor.reactToPetting(touch, 1_000);
  assert.equal(actor.state, "rub-flank");
  assert.equal(actor.resolveAnimation(actor.state), syntheticManifest.renderer.animations.sparkle);
});
