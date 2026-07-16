import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("window platform cache expires before it can become a ghost platform", async () => {
  const source = await readFile(path.resolve(here, "../main.cjs"), "utf8");
  assert.match(source, /WINDOW_PLATFORM_EXPIRE_MS = 5_000/);
  assert.match(source, /const expired = cacheAge > WINDOW_PLATFORM_EXPIRE_MS/);
  assert.match(source, /dropPlatforms: expired/);
  assert.match(source, /platforms: dropPlatforms \? \[\]/);
});
