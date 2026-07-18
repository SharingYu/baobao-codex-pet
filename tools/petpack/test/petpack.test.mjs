import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LIMITS,
  PetpackError,
  createPetpackArchive,
  importBundle,
  packBundle,
  readPetpackArchiveBuffer,
  sha256,
  validateBundle,
  validateBundleEntries,
} from '../lib.mjs';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function sampleManifest(overrides = {}) {
  const manifest = {
    $schema: '../../../packages/pet-schema/petpack.v1.schema.json',
    format: 'com.baofeifei.petpack',
    manifestVersion: '1.0',
    id: 'test-pet',
    displayName: 'Test Pet',
    description: 'A tiny fixture pet.',
    license: 'MIT',
    source: { kind: 'native' },
    assets: [
      {
        id: 'atlas',
        path: 'assets/atlas.png',
        mediaType: 'image/png',
        bytes: ONE_PIXEL_PNG.length,
        sha256: sha256(ONE_PIXEL_PNG),
        width: 1,
        height: 1,
      },
    ],
    renderer: {
      type: 'sprite-atlas',
      atlasAsset: 'atlas',
      cellWidth: 1,
      cellHeight: 1,
      columns: 1,
      rows: 1,
      anchor: { x: 0.5, y: 1 },
      defaultScale: 1,
      animations: {
        idle: { row: 0, frames: [0], frameDurationsMs: [100], loop: true },
      },
    },
    interactions: { eventMap: { idle: 'idle' } },
  };
  return Object.assign(manifest, overrides);
}

function sampleEntries(manifest = sampleManifest()) {
  return new Map([
    ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['assets/atlas.png', ONE_PIXEL_PNG],
  ]);
}

async function writeFixture(root, manifest = sampleManifest()) {
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'assets', 'atlas.png'), ONE_PIXEL_PNG);
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'petpack-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('validates a data-only directory bundle', async (t) => {
  const temp = await temporaryDirectory(t);
  const source = path.join(temp, 'source');
  await writeFixture(source);
  const report = await validateBundle(source);
  assert.equal(report.ok, true);
  assert.equal(report.manifest.id, 'test-pet');
  assert.equal(report.fileCount, 2);
  assert.equal(report.bundleType, 'directory');
});

test('packs, validates, and imports a .petpack archive round trip', async (t) => {
  const temp = await temporaryDirectory(t);
  const source = path.join(temp, 'source');
  const archive = path.join(temp, 'test-pet.petpack');
  const imported = path.join(temp, 'imported');
  await writeFixture(source);
  await packBundle(source, archive);
  const packedReport = await validateBundle(archive);
  assert.equal(packedReport.bundleType, 'archive');
  assert.equal(packedReport.manifest.id, 'test-pet');
  const importReport = await importBundle(archive, imported);
  assert.equal(importReport.destination, imported);
  assert.deepEqual(await readFile(path.join(imported, 'assets', 'atlas.png')), ONE_PIXEL_PNG);
  assert.equal((await validateBundle(imported)).ok, true);
});

test('refuses to overwrite an existing import destination', async (t) => {
  const temp = await temporaryDirectory(t);
  const source = path.join(temp, 'source');
  const destination = path.join(temp, 'already-there');
  await writeFixture(source);
  await mkdir(destination);
  await assert.rejects(() => importBundle(source, destination), (error) => {
    assert.equal(error.code, 'DESTINATION_EXISTS');
    return true;
  });
});

test('rejects asset checksum tampering before import', async (t) => {
  const temp = await temporaryDirectory(t);
  const source = path.join(temp, 'source');
  await writeFixture(source);
  await writeFile(path.join(source, 'assets', 'atlas.png'), Buffer.concat([ONE_PIXEL_PNG, Buffer.from([0])]));
  await assert.rejects(() => validateBundle(source), (error) => {
    assert.equal(error.code, 'ASSET_MISMATCH');
    return true;
  });
});

test('rejects executable and active-content paths', () => {
  const manifest = sampleManifest();
  manifest.assets[0].path = 'assets/payload.js';
  assert.throws(() => validateBundleEntries(sampleEntries(manifest)), (error) => {
    assert.equal(error.code, 'EXECUTABLE_REJECTED');
    return true;
  });
});

test('rejects undeclared files even when their extension is inert', () => {
  const entries = sampleEntries();
  entries.set('assets/hidden.png', ONE_PIXEL_PNG);
  assert.throws(() => validateBundleEntries(entries), (error) => {
    assert.equal(error.code, 'UNDECLARED_FILE');
    return true;
  });
});

test('rejects Windows device names and case-insensitive path collisions', () => {
  const reserved = sampleManifest();
  reserved.assets[0].path = 'assets/CON.png';
  assert.throws(() => validateBundleEntries(sampleEntries(reserved)), (error) => {
    assert.equal(error.code, 'UNSAFE_PATH');
    return true;
  });

  const collision = sampleEntries();
  collision.set('MANIFEST.JSON', Buffer.from('{}'));
  assert.throws(() => validateBundleEntries(collision), (error) => {
    assert.equal(error.code, 'INVALID_BUNDLE');
    return true;
  });
});

test('rejects path traversal in a hostile ZIP central and local filename', () => {
  const archive = createPetpackArchive(new Map([['safe-name', Buffer.from('x')]]));
  const safeName = Buffer.from('safe-name');
  const traversal = Buffer.from('../escape');
  assert.equal(safeName.length, traversal.length);
  let offset = 0;
  while ((offset = archive.indexOf(safeName, offset)) !== -1) {
    traversal.copy(archive, offset);
    offset += traversal.length;
  }
  assert.throws(() => readPetpackArchiveBuffer(archive), (error) => {
    assert.equal(error.code, 'UNSAFE_PATH');
    return true;
  });
});

test('rejects bundles above the file-count limit before parsing content', () => {
  const entries = new Map();
  for (let index = 0; index < LIMITS.maxFiles + 1; index += 1) {
    entries.set(`file-${String(index).padStart(3, '0')}.png`, Buffer.from([index & 0xff]));
  }
  assert.throws(() => validateBundleEntries(entries), (error) => {
    assert.equal(error.code, 'LIMIT_EXCEEDED');
    return true;
  });
});

test('rejects declared atlas dimensions that disagree with the file', () => {
  const manifest = sampleManifest();
  manifest.assets[0].width = 2;
  manifest.renderer.cellWidth = 2;
  assert.throws(() => validateBundleEntries(sampleEntries(manifest)), (error) => {
    assert.equal(error.code, 'ASSET_MISMATCH');
    return true;
  });
});

test('errors are typed for callers', () => {
  assert.throws(() => validateBundleEntries(new Map()), PetpackError);
});

test('accepts bounded presentation corrections and rejects unsafe scaling', () => {
  const manifest = sampleManifest();
  manifest.renderer.lookScale = 1.08;
  manifest.renderer.lookOffsetX = 0.04;
  manifest.renderer.lookOffsetY = -0.03;
  manifest.renderer.animations.idle.visualScale = 1.12;
  manifest.renderer.animations.idle.offsetX = -0.05;
  manifest.renderer.animations.idle.offsetY = 0.06;
  assert.equal(validateBundleEntries(sampleEntries(manifest)).manifest.id, 'test-pet');

  manifest.renderer.animations.idle.visualScale = 1.8;
  assert.throws(() => validateBundleEntries(sampleEntries(manifest)), (error) => {
    assert.equal(error.code, 'INVALID_MANIFEST');
    return true;
  });
});

test('the checked-in JSON Schema is valid JSON and pins v1 constants', async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(testDirectory, '..', '..', '..', 'packages', 'pet-schema', 'petpack.v1.schema.json');
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  assert.equal(schema.properties.format.const, 'com.baofeifei.petpack');
  assert.equal(schema.properties.manifestVersion.const, '1.0');
  assert.equal(schema.properties.assets.maxItems, 64);
});


test('validates normalized touch zones and their event references', () => {
  const manifest = sampleManifest();
  manifest.interactions.eventMap['pet-head'] = 'idle';
  manifest.interactions.touchZones = [{
    id: 'head',
    label: 'Head',
    event: 'pet-head',
    x: 0.2,
    y: 0.1,
    width: 0.6,
    height: 0.35,
  }];
  assert.doesNotThrow(() => validateBundleEntries(sampleEntries(manifest)));

  const invalid = structuredClone(manifest);
  invalid.interactions.touchZones[0].event = 'missing-event';
  assert.throws(
    () => validateBundleEntries(sampleEntries(invalid)),
    (error) => error?.code === 'INVALID_REFERENCE',
  );
});
