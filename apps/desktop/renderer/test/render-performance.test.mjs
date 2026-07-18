import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canvasDprForViewport } from "../pet-world.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("canvas resolution stays inside the desktop overlay pixel budget", () => {
  const dpr1080 = canvasDprForViewport(1920, 1080, 2);
  const dpr4k = canvasDprForViewport(3840, 2160, 2);
  assert.ok(dpr1080 <= 1.25);
  assert.ok(1920 * 1080 * dpr1080 * dpr1080 <= 3_200_001);
  assert.ok(dpr4k <= dpr1080);
  assert.ok(dpr4k >= 0.65);
});

test("animation schedules its successor before doing frame work", async () => {
  const source = await readFile(path.resolve(here, "../pet-world.js"), "utf8");
  const frameBody = source.slice(source.indexOf("  frame(timestamp) {"), source.indexOf("\n  update(", source.indexOf("  frame(timestamp) {")));
  assert.ok(frameBody.indexOf("requestAnimationFrame") < frameBody.indexOf("this.update"));
  assert.match(frameBody, /TARGET_RENDER_INTERVAL_MS/);
  assert.match(frameBody, /animation loop will continue/);
});
