import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPackage } from '@electron/asar';

const resources = path.resolve(
  process.argv[2] ?? path.join('release', 'win-unpacked', 'resources'),
);
const asarPath = path.join(resources, 'app.asar');
const petRuntime = path.join(resources, 'petpack-runtime', 'lib.mjs');
const itemRuntime = path.join(resources, 'itempack-runtime', 'lib.mjs');
const itemCore = path.join(resources, 'itempack-runtime', 'petpack-lib.mjs');
const allowedResourceFiles = new Set([
  'app.asar',
  'app-update.yml',
  'elevate.exe',
  'itempack-runtime/lib.mjs',
  'itempack-runtime/petpack-lib.mjs',
  'petpack-runtime/lib.mjs',
  'windows-platforms.ps1',
]);

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Packaged resource must not be a symbolic link: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

await Promise.all([
  access(asarPath),
  access(petRuntime),
  access(itemRuntime),
  access(itemCore),
]);

const resourceFiles = await listFiles(resources);
const unexpectedResources = resourceFiles.filter((file) => !allowedResourceFiles.has(file));
assert.deepEqual(
  unexpectedResources,
  [],
  `Packaged shell contains unexpected resource files: ${unexpectedResources.join(', ')}`,
);

const packagedFiles = listPackage(asarPath);
const forbidden = packagedFiles.filter((file) =>
  /(?:^|[\\/])(?:petpacks|itempacks|pets)(?:[\\/]|$)|starter-play-kit|baobao|feifei/i.test(file),
);
assert.deepEqual(
  forbidden,
  [],
  `Packaged shell contains content-pack files: ${forbidden.join(', ')}`,
);

const petLibrary = await import(pathToFileURL(petRuntime).href);
const itemLibrary = await import(pathToFileURL(itemRuntime).href);
assert.equal(typeof petLibrary.validateBundle, 'function');
assert.equal(typeof petLibrary.importBundle, 'function');
assert.equal(typeof itemLibrary.validateItempack, 'function');
assert.equal(typeof itemLibrary.importItempack, 'function');

console.log(JSON.stringify({
  ok: true,
  runtimeMode: 'empty-shell',
  packagedFileCount: packagedFiles.length,
  packagedResourceFileCount: resourceFiles.length,
  contentPackFiles: 0,
  runtimes: ['petpack', 'itempack'],
}, null, 2));
