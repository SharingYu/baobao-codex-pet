import test from "node:test";
import assert from "node:assert/strict";
import { animationCell, PetActor } from "../pet-actor.js";
import { drawSpriteFrame } from "../sprite.js";

test("numeric manifest frames use frameDurationsMs and stop when loop is false", () => {
  const animation = {
    row: 3,
    frames: [2, 4],
    frameDurationsMs: [100, 100],
    loop: false
  };
  assert.deepEqual(animationCell(animation, 50, false), { row: 3, column: 2 });
  assert.deepEqual(animationCell(animation, 250, false), { row: 3, column: 4 });
  assert.deepEqual(animationCell({ ...animation, loop: true }, 250, false), { row: 3, column: 2 });
});

test("interaction event maps and touch zones are read from the checked-in manifest path", () => {
  const waving = { row: 3, frames: [0, 1], frameDurationsMs: [100, 100], loop: false };
  const actor = Object.assign(Object.create(PetActor.prototype), {
    manifest: {
      renderer: { animations: { waving } },
      interactions: {
        eventMap: { "pet-head": "waving" },
        touchZones: [{ id: "head", x: 0.22, y: 0.12, width: 0.56, height: 0.3 }]
      }
    },
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    facing: "right"
  });
  assert.equal(actor.touchZoneAt(50, 20), "head");
  assert.equal(actor.resolveAnimation("pet-head"), waving);
});

test("sprite drawing respects a manifest-declared cell size", () => {
  const calls = [];
  const context = {
    globalAlpha: 1,
    save() {},
    restore() {},
    drawImage(...args) { calls.push(args); }
  };
  const image = { complete: true, naturalWidth: 1024 };
  assert.equal(drawSpriteFrame(context, image, 2, 3, { x: 5, y: 6, width: 70, height: 80 }, 1, { cellWidth: 128, cellHeight: 96 }), true);
  assert.deepEqual(calls[0].slice(1, 5), [384, 192, 128, 96]);
});
