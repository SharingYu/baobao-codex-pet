import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { IPC } = require(path.resolve(here, "../ipc-contract.cjs"));

test("tray exit requests a renderer state flush before quitting", async () => {
  assert.equal(IPC.QUIT_REQUESTED, "pet-desktop:shell:quit-requested");
  const main = await readFile(path.resolve(here, "../main.cjs"), "utf8");
  const preload = await readFile(path.resolve(here, "../preload.cjs"), "utf8");
  const renderer = await readFile(path.resolve(here, "../../renderer/main-v03.js"), "utf8");

  assert.match(main, /click: \(\) => requestAppQuit\('tray'\)/);
  assert.match(main, /renderer\.send\(IPC\.QUIT_REQUESTED/);
  assert.match(main, /QUIT_FLUSH_TIMEOUT_MS = 2_000/);
  assert.match(preload, /onQuitRequested: \(listener\) => subscribe\(IPC\.QUIT_REQUESTED/);
  assert.match(renderer, /this\.unsubscribeQuit = petBridge\.onQuitRequested/);
  assert.match(renderer, /await this\.saveNow\(\)/);
  assert.match(renderer, /await petBridge\.quitApp\(\)/);
});
