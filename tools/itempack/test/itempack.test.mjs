import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ItempackError, importItempack, packItempack, validateItempack } from '../lib.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+L2y5GQAAAABJRU5ErkJggg==',
  'base64',
);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function makeFixture(name = 'cozy-toys') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'itempack-'));
  const assets = path.join(root, 'assets');
  await mkdir(assets);
  await writeFile(path.join(assets, 'ball.png'), PNG_1X1);
  const manifest = {
    format: 'com.petdesktop.itempack',
    manifestVersion: '1.0',
    id: name,
    displayName: '午后玩具盒',
    description: '一颗可追逐的小球。',
    license: 'LicenseRef-Test',
    assets: [{
      id: 'ball-art',
      path: 'assets/ball.png',
      mediaType: 'image/png',
      bytes: PNG_1X1.length,
      sha256: sha256(PNG_1X1),
      width: 1,
      height: 1,
    }],
    items: [{
      id: 'sunny-ball',
      displayName: '太阳小球',
      category: 'toy',
      behavior: 'ball',
      asset: 'ball-art',
      scale: 1,
    }],
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}

test('validates, packs, and imports a standalone item pack', async (t) => {
  const fixture = await makeFixture();
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'itempack-output-'));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(outputRoot, { recursive: true, force: true }),
  ]));
  const directoryReport = await validateItempack(fixture.root);
  assert.equal(directoryReport.manifest.items[0].behavior, 'ball');

  const archive = path.join(outputRoot, 'cozy-toys.itempack');
  const packed = await packItempack(fixture.root, archive);
  assert.equal(packed.archive, archive);
  const archiveReport = await validateItempack(archive);
  assert.equal(archiveReport.bundleType, 'archive');

  const destination = path.join(outputRoot, 'installed-itempack');
  const imported = await importItempack(archive, destination);
  assert.equal(imported.destination, destination);
  assert.deepEqual(await readFile(path.join(destination, 'assets', 'ball.png')), PNG_1X1);
});

test('rejects a behavior that does not belong to the item category', async (t) => {
  const fixture = await makeFixture('invalid-toy');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(fixture.root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.items[0].category = 'food';
  await writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    () => validateItempack(fixture.root),
    (error) => error instanceof ItempackError && error.code === 'INVALID_MANIFEST',
  );
});

test('rejects checksum tampering and undeclared assets', async (t) => {
  const tampered = await makeFixture('tampered-toys');
  const undeclared = await makeFixture('undeclared-toys');
  t.after(() => Promise.all([
    rm(tampered.root, { recursive: true, force: true }),
    rm(undeclared.root, { recursive: true, force: true }),
  ]));

  await writeFile(path.join(tampered.root, 'assets', 'ball.png'), Buffer.concat([PNG_1X1, Buffer.from([0])]));
  await assert.rejects(
    () => validateItempack(tampered.root),
    (error) => error instanceof ItempackError && error.code === 'ASSET_MISMATCH',
  );

  await writeFile(path.join(undeclared.root, 'assets', 'extra.png'), PNG_1X1);
  await assert.rejects(
    () => validateItempack(undeclared.root),
    (error) => error instanceof ItempackError && error.code === 'UNDECLARED_FILE',
  );
});

test('enforces item image dimension and total pixel budgets', async (t) => {
  const oversized = await makeFixture('oversized-toys');
  const overBudget = await makeFixture('pixel-budget-toys');
  t.after(() => Promise.all([
    rm(oversized.root, { recursive: true, force: true }),
    rm(overBudget.root, { recursive: true, force: true }),
  ]));

  const oversizedPath = path.join(oversized.root, 'manifest.json');
  const oversizedManifest = JSON.parse(await readFile(oversizedPath, 'utf8'));
  oversizedManifest.assets[0].width = 2049;
  await writeFile(oversizedPath, JSON.stringify(oversizedManifest));
  await assert.rejects(
    () => validateItempack(oversized.root),
    (error) => error instanceof ItempackError && error.code === 'INVALID_MANIFEST',
  );

  const budgetPath = path.join(overBudget.root, 'manifest.json');
  const budgetManifest = JSON.parse(await readFile(budgetPath, 'utf8'));
  budgetManifest.assets = [0, 1, 2].map((index) => ({
    ...budgetManifest.assets[0],
    id: `ball-art-${index}`,
    path: `assets/ball-${index}.png`,
    width: 2048,
    height: 2048,
  }));
  budgetManifest.items[0].asset = 'ball-art-0';
  for (let index = 0; index < 3; index += 1) {
    await writeFile(path.join(overBudget.root, 'assets', `ball-${index}.png`), PNG_1X1);
  }
  await writeFile(budgetPath, JSON.stringify(budgetManifest));
  await assert.rejects(
    () => validateItempack(overBudget.root),
    (error) => error instanceof ItempackError && error.code === 'LIMIT_EXCEEDED',
  );
});

test('refuses to overwrite an installed item pack', async (t) => {
  const fixture = await makeFixture('existing-destination');
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'itempack-existing-'));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(outputRoot, { recursive: true, force: true }),
  ]));
  const archive = path.join(outputRoot, 'existing-destination.itempack');
  const destination = path.join(outputRoot, 'installed');
  await packItempack(fixture.root, archive);
  await mkdir(destination);
  await assert.rejects(
    () => importItempack(archive, destination),
    (error) => error instanceof ItempackError && error.code === 'DESTINATION_EXISTS',
  );
});
