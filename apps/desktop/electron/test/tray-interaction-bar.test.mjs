import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { AtomicJsonStore } = require(path.resolve(here, "../state-store.cjs"));

test("interaction bar visibility defaults on, persists, and migrates legacy shell state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pet-desktop-tray-bar-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const statePath = path.join(root, "state.json");
  let store = new AtomicJsonStore(statePath);
  assert.equal(store.getShellState().interactionBarVisible, true);

  store.patchShellState({ interactionBarVisible: false });
  store = new AtomicJsonStore(statePath);
  assert.equal(store.getShellState().interactionBarVisible, false);

  const legacyPath = path.join(root, "legacy.json");
  await writeFile(legacyPath, JSON.stringify({
    schemaVersion: 1,
    shell: { visible: true, quiet: false, displayId: null },
    rendererState: {},
  }));
  const migrated = new AtomicJsonStore(legacyPath);
  assert.equal(migrated.getShellState().interactionBarVisible, true);
});

test("tray toggles the persisted interaction bar state through the existing shell IPC", async () => {
  const main = await readFile(path.resolve(here, "../main.cjs"), "utf8");
  const preload = await readFile(path.resolve(here, "../preload.cjs"), "utf8");
  const renderer = await readFile(path.resolve(here, "../../renderer/main-v03.js"), "utf8");

  assert.match(main, /label: state\.interactionBarVisible \? '隐藏互动条' : '显示互动条'/);
  assert.match(main, /click: \(\) => setInteractionBarVisible\(!state\.interactionBarVisible\)/);
  assert.match(main, /interactionBarVisible: next,[\s\S]*?visible: next \? true : current\.visible/);
  assert.match(main, /overlayWindow\.showInactive\(\)/);
  assert.match(main, /broadcast\(IPC\.SHELL_STATE_CHANGED, state\)/);
  assert.match(preload, /onShellStateChanged: \(listener\) => subscribe\(IPC\.SHELL_STATE_CHANGED, listener\)/);
  assert.match(renderer, /this\.setInteractionBarVisible\(shellState\?\.interactionBarVisible !== false\)/);
  assert.match(renderer, /this\.elements\.actionShell\.hidden = !next/);
  assert.match(renderer, /this\.setInteractionBarVisible\(state\.interactionBarVisible\)/);
});
