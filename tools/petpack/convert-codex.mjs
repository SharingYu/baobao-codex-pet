#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PetpackError,
  assertSafeBundlePath,
  readImageInfo,
  sha256,
  validateBundle,
} from './lib.mjs';

const SCHEMA_URL = 'https://raw.githubusercontent.com/SharingYu/baobao-codex-pet/main/packages/pet-schema/petpack.v1.schema.json';

const ANIMATIONS = Object.freeze({
  idle: { row: 0, frames: [0, 1, 2, 3, 4, 5], frameDurationsMs: [280, 110, 110, 140, 140, 320], loop: true },
  'running-right': { row: 1, frames: [0, 1, 2, 3, 4, 5, 6, 7], frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
  'running-left': { row: 2, frames: [0, 1, 2, 3, 4, 5, 6, 7], frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
  waving: { row: 3, frames: [0, 1, 2, 3], frameDurationsMs: [140, 140, 140, 280], loop: false },
  jumping: { row: 4, frames: [0, 1, 2, 3, 4], frameDurationsMs: [140, 140, 140, 140, 280], loop: false },
  failed: { row: 5, frames: [0, 1, 2, 3, 4, 5, 6, 7], frameDurationsMs: [140, 140, 140, 140, 140, 140, 140, 240], loop: false },
  waiting: { row: 6, frames: [0, 1, 2, 3, 4, 5], frameDurationsMs: [150, 150, 150, 150, 150, 260], loop: true },
  running: { row: 7, frames: [0, 1, 2, 3, 4, 5], frameDurationsMs: [120, 120, 120, 120, 120, 220], loop: true },
  review: { row: 8, frames: [0, 1, 2, 3, 4, 5], frameDurationsMs: [150, 150, 150, 150, 150, 280], loop: true },
});

const EVENT_MAP = Object.freeze({
  idle: 'idle',
  'move-right': 'running-right',
  'move-left': 'running-left',
  greet: 'waving',
  pet: 'waving',
  feed: 'jumping',
  play: 'jumping',
  jump: 'jumping',
  error: 'failed',
  waiting: 'waiting',
  working: 'running',
  review: 'review',
});

async function pathExists(input) {
  return access(input).then(() => true, () => false);
}

export async function convertCodexV2({ input, output, license = 'LicenseRef-Personal-Display-Only' }) {
  const sourceDirectory = path.resolve(input);
  const outputDirectory = path.resolve(output);
  const sourceInfo = await lstat(sourceDirectory).catch(() => null);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new PetpackError('INVALID_SOURCE', `${input} must be a regular Codex pet directory`);
  }
  if (await pathExists(outputDirectory)) {
    throw new PetpackError('DESTINATION_EXISTS', `Output ${output} already exists`);
  }

  let pet;
  try {
    const petJson = await readFile(path.join(sourceDirectory, 'pet.json'), 'utf8');
    pet = JSON.parse(petJson.replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new PetpackError('INVALID_SOURCE', `Could not read Codex pet.json: ${error.message}`);
  }
  if (
    !pet || typeof pet !== 'object' || Array.isArray(pet) ||
    typeof pet.id !== 'string' || typeof pet.displayName !== 'string' ||
    typeof pet.description !== 'string' || pet.spriteVersionNumber !== 2 ||
    typeof pet.spritesheetPath !== 'string'
  ) {
    throw new PetpackError('INVALID_SOURCE', 'Codex pet.json is missing required v2 metadata');
  }
  assertSafeBundlePath(pet.spritesheetPath, 'pet.spritesheetPath');
  const atlasPath = path.resolve(sourceDirectory, ...pet.spritesheetPath.split('/'));
  if (!atlasPath.startsWith(`${sourceDirectory}${path.sep}`)) {
    throw new PetpackError('UNSAFE_PATH', 'Codex spritesheet path escapes the source directory');
  }
  const atlasInfo = await lstat(atlasPath).catch(() => null);
  if (!atlasInfo?.isFile() || atlasInfo.isSymbolicLink()) {
    throw new PetpackError('INVALID_SOURCE', 'Codex spritesheet must be a regular file');
  }
  const atlas = await readFile(atlasPath);
  const mediaType = path.extname(atlasPath).toLowerCase() === '.webp' ? 'image/webp' : 'image/png';
  const dimensions = readImageInfo(atlas, mediaType);
  if (dimensions.width !== 1536 || dimensions.height !== 2288) {
    throw new PetpackError('INVALID_SOURCE', `Codex v2 atlas must be 1536x2288, got ${dimensions.width}x${dimensions.height}`);
  }

  const manifest = {
    $schema: SCHEMA_URL,
    format: 'com.baofeifei.petpack',
    manifestVersion: '1.0',
    id: pet.id,
    displayName: pet.displayName,
    description: pet.description,
    license,
    source: {
      kind: 'codex-v2',
      spriteVersionNumber: 2,
    },
    assets: [
      {
        id: 'atlas',
        path: `assets/atlas${path.extname(atlasPath).toLowerCase()}`,
        mediaType,
        bytes: atlas.length,
        sha256: sha256(atlas),
        width: dimensions.width,
        height: dimensions.height,
      },
    ],
    renderer: {
      type: 'sprite-atlas',
      atlasAsset: 'atlas',
      cellWidth: 192,
      cellHeight: 208,
      columns: 8,
      rows: 11,
      anchor: { x: 0.5, y: 1 },
      defaultScale: 1,
      animations: ANIMATIONS,
      lookDirections: Array.from({ length: 16 }, (_, index) => ({
        degrees: index * 22.5,
        row: 9 + Math.floor(index / 8),
        column: index % 8,
      })),
    },
    interactions: {
      eventMap: EVENT_MAP,
    },
  };

  const staging = `${outputDirectory}.convert-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await mkdir(path.join(staging, 'assets'), { recursive: true });
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(staging, 'assets', `atlas${path.extname(atlasPath).toLowerCase()}`), atlas, { flag: 'wx', mode: 0o600 });
    await validateBundle(staging);
    await mkdir(path.dirname(outputDirectory), { recursive: true });
    await rename(staging, outputDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return validateBundle(outputDirectory);
}

function parseArguments(argv) {
  const args = { license: 'LicenseRef-Personal-Display-Only' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input' || token === '--output' || token === '--license') {
      if (!argv[index + 1]) throw new PetpackError('USAGE', `${token} requires a value`);
      args[token.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new PetpackError('USAGE', `Unknown argument ${token}`);
    }
  }
  if (!args.input || !args.output) throw new PetpackError('USAGE', 'Usage: node convert-codex.mjs --input <codex-pet-dir> --output <petpack-dir> [--license <license>]');
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  convertCodexV2(parseArguments(process.argv.slice(2))).then(
    (report) => console.log(JSON.stringify(report, null, 2)),
    (error) => {
      const payload = error instanceof PetpackError
        ? { ok: false, code: error.code, error: error.message }
        : { ok: false, code: 'UNEXPECTED', error: error.message };
      console.error(JSON.stringify(payload, null, 2));
      process.exitCode = 1;
    },
  );
}
