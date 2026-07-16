import test from "node:test";
import assert from "node:assert/strict";
import { PetWorld } from "../pet-world.js";

function callbacks(overrides = {}) {
  return {
    toast() {},
    itemsChanged() {},
    regionsChanged() {},
    pettingChanged() {},
    action() {},
    progressChanged() {},
    requestSave() {},
    petsChanged() {},
    wandChanged() {},
    ...overrides
  };
}

test("petting is armed first and a body-zone click completes one reaction", () => {
  const changes = [];
  const pet = {
    id: "baobao",
    name: "包包",
    reactToPetting(zone) { this.reactedTo = zone; }
  };
  const world = Object.assign(Object.create(PetWorld.prototype), {
    pets: [pet],
    activePetId: pet.id,
    pettingMode: null,
    foodDrag: null,
    pointerSession: null,
    progressByPet: { [pet.id]: {} },
    wand: { active: false },
    canvas: { dataset: {} },
    callbacks: callbacks({ pettingChanged(active, reason) { changes.push([active, reason]); } })
  });

  assert.equal(world.togglePettingMode(), true);
  assert.ok(world.pettingMode);
  assert.deepEqual(changes[0], [true, "start"]);

  world.performPetting(pet, "head");
  assert.equal(pet.reactedTo, "head");
  assert.equal(world.progressByPet[pet.id].affinity, 3);
  assert.equal(world.pettingMode, null);
  assert.deepEqual(changes.at(-1), [false, "complete"]);
});

test("food and toy cancellation remove visuals, targets, and captured pointers", () => {
  const released = [];
  const pet = {
    id: "baobao",
    height: 100,
    target: { reason: "food", entityId: "food-1" },
    insideBox: false,
    setState(state) { this.state = state; }
  };
  const world = Object.assign(Object.create(PetWorld.prototype), {
    pets: [pet],
    foods: [{ id: "food-1" }],
    foodDrag: null,
    balls: [],
    box: null,
    wand: { active: false, item: null },
    toySession: null,
    pettingMode: null,
    height: 500,
    pointerSession: { kind: "food", pointerId: 7, item: { id: "food-1" } },
    canvas: {
      dataset: {},
      releasePointerCapture(pointerId) { released.push(pointerId); }
    },
    callbacks: callbacks()
  });

  assert.equal(world.clearFood("manual", false), true);
  assert.deepEqual(world.foods, []);
  assert.equal(pet.target, null);
  assert.equal(world.pointerSession, null);
  assert.deepEqual(released, [7]);

  pet.target = { reason: "ball" };
  pet.insideBox = true;
  world.balls = [{ id: "ball-1" }];
  world.box = { occupantId: pet.id };
  world.wand = { active: true, item: { id: "wand-1" } };
  world.toySession = { petId: pet.id, item: { name: "毛线球" }, startedAt: performance.now(), hits: 0 };
  world.pointerSession = { kind: "ball", pointerId: 9, item: world.balls[0] };

  assert.equal(world.clearToy("manual", false), true);
  assert.deepEqual(world.balls, []);
  assert.equal(world.box, null);
  assert.equal(world.wand.active, false);
  assert.equal(world.toySession, null);
  assert.equal(world.pointerSession, null);
  assert.equal(pet.target, null);
  assert.equal(pet.insideBox, false);
  assert.deepEqual(released, [7, 9]);
});

test("hiding and restoring a pet preserves position history and affinity", () => {
  const pet = {
    id: "baobao",
    name: "包包",
    x: 160,
    y: 240,
    width: 100,
    height: 120
  };
  const definition = {
    id: pet.id,
    name: pet.name,
    displayName: pet.name,
    manifest: { renderer: { cellWidth: 192, cellHeight: 208 } },
    color: "#fff",
    image: null,
    installedIndex: 0
  };
  const world = Object.assign(Object.create(PetWorld.prototype), {
    definitions: [definition],
    pets: [pet],
    visiblePetIds: [pet.id],
    activePetId: pet.id,
    petHistory: {},
    progressByPet: { [pet.id]: { affinity: 120 } },
    foods: [],
    foodDrag: null,
    toySession: null,
    platformInteractions: false,
    platformWatcherEnabled: false,
    pettingMode: null,
    width: 1000,
    height: 700,
    callbacks: callbacks()
  });

  assert.equal(world.setPetVisible(pet.id, false), true);
  assert.deepEqual(world.visiblePetIds, []);
  assert.equal(world.activePetId, null);
  assert.equal(world.progressFor(pet.id).affinity, 120);
  assert.ok(world.petHistory[pet.id]);

  assert.equal(world.setPetVisible(pet.id, true), true);
  assert.deepEqual(world.visiblePetIds, [pet.id]);
  assert.equal(world.activePetId, pet.id);
  assert.equal(world.progressFor(pet.id).affinity, 120);
});

test("autonomous arrivals do not replace the user's current pet selection", () => {
  const selected = { id: "baobao", name: "BaoBao" };
  const wandering = { id: "feifei", name: "FeiFei", setState() {} };
  const world = Object.assign(Object.create(PetWorld.prototype), {
    pets: [selected, wandering],
    activePetId: selected.id,
    callbacks: callbacks()
  });

  world.onPetArrived(wandering, { reason: "wander", manual: false }, performance.now());
  assert.equal(world.activePetId, selected.id);

  world.onPetArrived(wandering, { reason: "manual-position", manual: true }, performance.now());
  assert.equal(world.activePetId, wandering.id);
});
