import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { assertAlphaRendererCompatibility } = require('../../../apps/desktop/electron/petpack-compat.cjs');

async function loadManifest() {
  return JSON.parse(await readFile(new URL('../../../petpacks/baobao/manifest.json', import.meta.url), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('runtime accepts the checked-in Codex v2 layout', async () => {
  assert.equal(assertAlphaRendererCompatibility(await loadManifest()), true);
});

test('runtime accepts a larger declarative atlas grid', async () => {
  const manifest = clone(await loadManifest());
  manifest.renderer.rows = 15;
  assert.equal(assertAlphaRendererCompatibility(manifest), true);
});

test('runtime rejects animation or look cells outside the declared grid', async () => {
  const animationManifest = clone(await loadManifest());
  animationManifest.renderer.animations.idle.row = 99;
  assert.throws(
    () => assertAlphaRendererCompatibility(animationManifest),
    (error) => error?.code === 'UNSUPPORTED_RENDERER',
  );

  const lookManifest = clone(await loadManifest());
  lookManifest.renderer.lookDirections[0].column = 99;
  assert.throws(
    () => assertAlphaRendererCompatibility(lookManifest),
    (error) => error?.code === 'UNSUPPORTED_RENDERER',
  );
});
