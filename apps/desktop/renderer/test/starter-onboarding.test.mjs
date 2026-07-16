import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "../../../../itempacks/starter-play-kit/manifest.json");
const appPath = path.resolve(here, "../main-v03.js");

test("starter pack lets a new pet eat and play before later unlocks", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const foods = manifest.items.filter((item) => item.category === "food");
  const toys = manifest.items.filter((item) => item.category === "toy");

  assert.ok(foods.some((item) => item.unlockLevel === 1), "one food must be available at Lv.1");
  assert.ok(toys.some((item) => item.unlockLevel === 1), "one toy must be available at Lv.1");
  assert.ok(manifest.items.some((item) => item.unlockLevel > 1), "progression needs a later unlock");
});

test("empty-shell startup retains the complete four-step first-run journey", async () => {
  const source = await readFile(appPath, "utf8");
  const guide = source.match(/const GUIDE_STEPS = \[([\s\S]*?)\n\];/);
  assert.ok(guide, "guide steps must remain declared");
  const actions = [...guide[1].matchAll(/action: "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(actions, ["pet", "feed", "toy", "quiet"]);
  assert.match(source, /const guideSteps = GUIDE_STEPS;/);
  assert.doesNotMatch(source, /GUIDE_STEPS\.filter/);
  assert.match(source, /if \(hasVisiblePets && this\.guide && !this\.guide\.done\) this\.guide\.show\(\)/);
});
