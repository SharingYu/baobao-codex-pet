import test from "node:test";
import assert from "node:assert/strict";
import { PetWorld } from "../pet-world.js";
import { readWindowPlatforms } from "../platforms.js";

function createPollingWorld(overrides = {}) {
  return Object.assign(Object.create(PetWorld.prototype), {
    platformInteractions: true,
    platformWatcherEnabled: true,
    platformPollAt: 0,
    platformPollPending: null,
    platformErrorShown: false,
    platforms: [],
    platformReader: async () => [],
    callbacks: { toast() {} },
    ...overrides
  });
}

test("concurrent platform polls share one awaitable request", async () => {
  let finishScan;
  let scanCount = 0;
  const scan = new Promise((resolve) => { finishScan = resolve; });
  const world = createPollingWorld({
    platformReader: () => {
      scanCount += 1;
      return scan;
    }
  });

  const first = world.pollPlatforms(100);
  const second = world.pollPlatforms(110);
  assert.equal(second, first);
  await Promise.resolve();
  assert.equal(scanCount, 1);

  const platforms = [{ id: "window-1", left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 }];
  finishScan(platforms);
  assert.equal(await first, platforms);
  assert.equal(await second, platforms);
  assert.equal(world.platforms, platforms);
  assert.equal(world.platformPollPending, null);
});

test("platform payloads keep stale geometry but hide native failures", async () => {
  const stalePayload = {
    stale: true,
    error: "WINDOW_PLATFORM_SCAN_UNAVAILABLE",
    platforms: [{ hwnd: "42", overlayLeft: 25, overlayTop: 80, overlayRight: 325, overlayBottom: 280 }]
  };
  assert.deepEqual(await readWindowPlatforms({ getWindowPlatforms: async () => stalePayload }), [{
    id: "42",
    left: 25,
    top: 80,
    right: 325,
    bottom: 280,
    width: 300,
    height: 200
  }]);

  assert.deepEqual(await readWindowPlatforms({
    getWindowPlatforms: async () => ({
      stale: true, error: "WINDOW_PLATFORM_CACHE_EXPIRED", platforms: []
    })
  }), []);

  await assert.rejects(
    () => readWindowPlatforms({
      getWindowPlatforms: async () => ({ stale: false, error: "C:\\private\\scanner-detail", platforms: [] })
    }),
    (error) => {
      assert.equal(error.message, "Window platform discovery is temporarily unavailable");
      assert.doesNotMatch(error.message, /private|scanner-detail/i);
      return true;
    }
  );
});

test("a failed refresh retains last-known platforms and only announces once", async (context) => {
  context.mock.method(console, "warn", () => {});
  const stale = [{ id: "window-1", left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 }];
  const toasts = [];
  const world = createPollingWorld({
    platforms: stale,
    platformReader: async () => { throw new Error("transient"); },
    callbacks: { toast(message) { toasts.push(message); } }
  });

  assert.equal(await world.pollPlatforms(100), stale);
  assert.equal(world.platforms, stale);
  assert.equal(toasts.length, 1);
  assert.equal(await world.pollPlatforms(300), stale);
  assert.equal(toasts.length, 1);
});

test("a pet dropped away from a window edge falls and lands on the desktop", async () => {
  let saveCount = 0;
  const world = Object.assign(Object.create(PetWorld.prototype), {
    platformInteractions: true,
    platforms: [],
    height: 200,
    quiet: false,
    reducedMotion: false,
    pollPlatforms: async () => [],
    callbacks: { requestSave() { saveCount += 1; } }
  });
  const pet = {
    x: 20,
    y: 10,
    width: 100,
    height: 100,
    platformAttachment: { id: "old" },
    fallingVelocity: 0,
    state: "idle",
    get foot() { return { x: this.x + this.width / 2, y: this.y + this.height - 7 }; },
    setState(state) { this.state = state; },
    clampToStage() {}
  };

  assert.equal(await world.tryAttachToPlatform(pet), false);
  assert.equal(pet.platformAttachment, null);
  assert.equal(pet.fallingVelocity, 36);
  assert.equal(pet.state, "fall");

  pet.y = 101;
  assert.equal(world.updatePlatformPet(pet, 0.2, 1_000), true);
  assert.equal(pet.y, 100);
  assert.equal(pet.fallingVelocity, 0);
  assert.equal(pet.state, "land");
  assert.equal(saveCount, 1);
});

test("disabling platform interactions synchronously requests native shutdown and rejects a late scan", async () => {
  const nativeStates = [];
  let finishScan;
  const world = createPollingWorld({
    platformInteractions: true,
    pets: [{ platformAttachment: { id: "window-1" }, fallingVelocity: 0 }],
    platforms: [{ id: "window-1" }],
    platformReader: () => new Promise((resolve) => { finishScan = resolve; }),
    platformController(enabled) {
      nativeStates.push(enabled);
      return Promise.resolve(enabled);
    },
    callbacks: { toast() {}, requestSave() {} }
  });

  const pendingScan = world.pollPlatforms(100);
  await Promise.resolve();
  const disabled = world.setPlatformInteractions(false);
  assert.deepEqual(nativeStates, [false], "native stop must be requested in the toggle handler");
  assert.deepEqual(world.platforms, []);
  assert.equal(world.pets[0].platformAttachment, null);
  assert.equal(world.pets[0].fallingVelocity, 36);

  finishScan([{ id: "late-window" }]);
  assert.deepEqual(await pendingScan, []);
  assert.deepEqual(world.platforms, [], "an in-flight response must not repopulate disabled platforms");
  assert.equal(await disabled, false);
});

test("re-enabling platform interactions requests a fresh native watcher start", async () => {
  const nativeStates = [];
  const world = createPollingWorld({
    platformInteractions: false,
    platformWatcherEnabled: false,
    pets: [{ id: "bao" }],
    platformPollAt: 999,
    platformController(enabled) {
      nativeStates.push(enabled);
      return Promise.resolve(enabled);
    },
    callbacks: { toast() {}, requestSave() {} }
  });

  assert.equal(await world.setPlatformInteractions(true), true);
  assert.deepEqual(nativeStates, [true]);
  assert.equal(world.platformPollAt, 0);
});

test("an explicit preference stays enabled without scanning while no pet is visible", async () => {
  const nativeStates = [];
  const world = createPollingWorld({
    platformInteractions: false,
    platformWatcherEnabled: false,
    pets: [],
    platformController(enabled) {
      nativeStates.push(enabled);
      return Promise.resolve(enabled);
    },
    callbacks: { toast() {}, requestSave() {} }
  });

  assert.equal(await world.setPlatformInteractions(true), true);
  assert.equal(world.platformInteractions, true);
  assert.equal(world.platformWatcherEnabled, false);
  assert.deepEqual(nativeStates, []);
});

test("no visible pets stop a previously active native watcher", async () => {
  const nativeStates = [];
  const world = createPollingWorld({
    platformInteractions: true,
    platformWatcherEnabled: true,
    pets: [],
    platformController(enabled) {
      nativeStates.push(enabled);
      return Promise.resolve(enabled);
    },
    callbacks: { toast() {} }
  });

  assert.equal(await world.syncPlatformWatcher(), false);
  assert.equal(world.platformWatcherEnabled, false);
  assert.deepEqual(nativeStates, [false]);
});

test("renderer bridge forwards only a boolean platform preference", async () => {
  const calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    petDesktop: {
      setWindowPlatformInteractions(enabled) {
        calls.push(enabled);
        return enabled;
      }
    }
  };
  try {
    const { petBridge } = await import("../bridge.js");
    assert.equal(await petBridge.setWindowPlatformInteractions(1), true);
    assert.deepEqual(calls, [true]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
