import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Windows overlay remains capture-eligible and avoids screen-saver z-order", async () => {
  const main = await readFile(path.resolve(here, "../main.cjs"), "utf8");
  assert.match(main, /setAlwaysOnTop\(true, 'floating'\)/);
  assert.match(main, /setContentProtection\(false\)/);
  assert.doesNotMatch(main, /setAlwaysOnTop\(true, 'screen-saver'/);
});

test("overlay recovers from renderer stalls and GPU process loss", async () => {
  const main = await readFile(path.resolve(here, "../main.cjs"), "utf8");
  assert.match(main, /window\.on\('unresponsive'/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /app\.on\('child-process-gone'/);
  assert.match(main, /reloadIgnoringCache\(\)/);
  assert.match(main, /修复卡顿（重载宠物）/);
});
