import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../..");

for (const petId of ["baobao", "feifei"]) {
  test(`${petId} resolves four touch regions to four distinct reactions`, async () => {
    const manifestPath = path.join(repositoryRoot, "petpacks", petId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const zones = manifest.interactions.touchZones;
    const events = zones.map((zone) => zone.event);
    const animations = events.map((event) => manifest.interactions.eventMap[event]);

    assert.deepEqual(zones.map((zone) => zone.id).sort(), ["back", "body", "head", "tail"]);
    assert.equal(new Set(events).size, 4, "each body region needs its own event");
    assert.equal(new Set(animations).size, 4, "each body region needs a visibly distinct animation");
    for (const animation of animations) {
      assert.ok(manifest.renderer.animations[animation], `missing animation ${animation}`);
      assert.equal(manifest.renderer.animations[animation].loop, false);
    }
  });
}
