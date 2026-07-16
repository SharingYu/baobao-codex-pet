import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const electronDirectory = path.resolve(here, "..");
const rendererDirectory = path.resolve(electronDirectory, "..", "renderer");
const [mainSource, preloadSource, bridgeSource, worldSource, stateSource] = await Promise.all([
  readFile(path.join(electronDirectory, "main.cjs"), "utf8"),
  readFile(path.join(electronDirectory, "preload.cjs"), "utf8"),
  readFile(path.join(rendererDirectory, "bridge.js"), "utf8"),
  readFile(path.join(rendererDirectory, "pet-world.js"), "utf8"),
  readFile(path.join(rendererDirectory, "state.js"), "utf8")
]);

function bodyBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("startup is scan-free until the restored renderer preference opts in", () => {
  assert.match(mainSource, /stopped:\s*true,/);
  const bootstrap = bodyBetween(mainSource, "async function bootstrap()", "const hasSingleInstanceLock");
  assert.doesNotMatch(bootstrap, /startWindowPlatformWatcher\(\)/);
  assert.match(stateSource, /platformInteractions:\s*raw\.platformInteractions === true/);
  assert.match(worldSource, /await this\.syncPlatformWatcher\(\)/);
  assert.match(worldSource, /Boolean\(this\.platformInteractions && this\.pets\.length > 0\)/);
});

test("disable kills the watcher, cancels both loops, and cannot schedule a restart", () => {
  const stop = bodyBetween(
    mainSource,
    "function stopWindowPlatformWatcher()",
    "function setWindowPlatformWatcherEnabled(enabled)"
  );
  assert.match(stop, /windowPlatformWatcher\.stopped = true/);
  assert.match(stop, /clearTimeout\(windowPlatformWatcher\.restartTimer\)/);
  assert.match(stop, /clearInterval\(windowPlatformWatcher\.healthTimer\)/);
  assert.match(stop, /terminateWindowPlatformWatcher\(null, \{ restart: false \}\)/);
  assert.match(stop, /windowPlatformCache = null/);

  const terminate = bodyBetween(
    mainSource,
    "function terminateWindowPlatformWatcher(errorCode, { restart = true } = {})",
    "function acceptWindowPlatformLine"
  );
  assert.match(terminate, /child\.kill\(\)/);
  assert.match(terminate, /if \(restart\) scheduleWindowPlatformWatcherRestart\(\)/);
});

test("enable can start a new watcher and application exit still stops it", () => {
  const gate = bodyBetween(mainSource, "function setWindowPlatformWatcherEnabled(enabled)", "function getWindowPlatforms()");
  assert.match(gate, /windowPlatformWatcher\.stopped = false/);
  assert.match(gate, /startWindowPlatformWatcher\(\)/);
  assert.match(mainSource, /app\.on\('before-quit',[\s\S]*?stopWindowPlatformWatcher\(\)/);
});

test("trusted IPC, preload, and renderer expose only the enable boolean", () => {
  assert.match(mainSource, /ipcMain\.handle\(IPC\.SET_WINDOW_PLATFORM_INTERACTIONS,[\s\S]*?assertTrustedSender\(event\)/);
  assert.match(preloadSource, /setWindowPlatformInteractions: \(enabled\) =>[\s\S]*?Boolean\(enabled\)/);
  assert.match(bridgeSource, /setWindowPlatformInteractions\(enabled\)[\s\S]*?Boolean\(enabled\)/);
  assert.match(worldSource, /this\.platformController\(enabled\)/);
});
