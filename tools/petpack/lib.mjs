import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const LIMITS = Object.freeze({
  maxManifestBytes: 256 * 1024,
  maxFiles: 128,
  maxSingleFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxImageDimension: 8192,
});

const FORMAT = 'com.baofeifei.petpack';
const VERSION = '1.0';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const EXECUTABLE_EXTENSIONS = new Set([
  '.app', '.bat', '.cmd', '.com', '.cpl', '.dll', '.dylib', '.exe', '.gadget',
  '.hta', '.htm', '.html', '.jar', '.js', '.jse', '.lnk', '.mjs', '.msi',
  '.msix', '.pif', '.ps1', '.py', '.rb', '.reg', '.scr', '.sh', '.svg', '.vbe',
  '.vbs', '.wsf',
]);
const MEDIA_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/webp': '.webp',
});
const TOP_LEVEL_KEYS = new Set([
  '$schema', 'format', 'manifestVersion', 'id', 'displayName', 'description',
  'license', 'source', 'assets', 'previewAsset', 'renderer', 'interactions',
]);

export class PetpackError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PetpackError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PetpackError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, pointer) {
  if (!isObject(value)) fail('INVALID_MANIFEST', `${pointer} must be an object`);
  return value;
}

function requireKeys(object, required, allowed, pointer) {
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      fail('INVALID_MANIFEST', `${pointer}.${key} is required`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail('INVALID_MANIFEST', `${pointer}.${key} is not allowed`);
    }
  }
}

function requireString(value, pointer, min, max, pattern = undefined) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('INVALID_MANIFEST', `${pointer} must be a string of ${min}-${max} characters`);
  }
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    fail('INVALID_MANIFEST', `${pointer} contains a control character`);
  }
  if (pattern && !pattern.test(value)) {
    fail('INVALID_MANIFEST', `${pointer} has an invalid format`);
  }
  return value;
}

function requireNumber(value, pointer, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_MANIFEST', `${pointer} must be a number from ${min} to ${max}`);
  }
  if (integer && !Number.isInteger(value)) {
    fail('INVALID_MANIFEST', `${pointer} must be an integer`);
  }
  return value;
}

function requireBoolean(value, pointer) {
  if (typeof value !== 'boolean') fail('INVALID_MANIFEST', `${pointer} must be a boolean`);
  return value;
}

export function assertSafeBundlePath(input, pointer = 'path') {
  const value = requireString(input, pointer, 1, 240);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    fail('UNSAFE_PATH', `${pointer} must be a relative POSIX path`);
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail('UNSAFE_PATH', `${pointer} contains malformed percent-encoding`);
  }
  if (decoded !== value && (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..'))) {
    fail('UNSAFE_PATH', `${pointer} contains an encoded path separator or traversal`);
  }
  const segments = value.split('/');
  if (segments.some((segment) =>
    segment === '' || segment === '.' || segment === '..' || segment.endsWith('.') ||
    !SAFE_SEGMENT.test(segment) || WINDOWS_DEVICE_NAME.test(segment)
  )) {
    fail('UNSAFE_PATH', `${pointer} contains an unsafe path segment`);
  }
  if (EXECUTABLE_EXTENSIONS.has(path.posix.extname(value).toLowerCase())) {
    fail('EXECUTABLE_REJECTED', `${pointer} uses a prohibited executable or active-content extension`);
  }
  return value;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function readImageInfo(buffer, mediaType) {
  if (!Buffer.isBuffer(buffer)) fail('INVALID_ASSET', 'Image asset is not binary data');
  let result;
  if (mediaType === 'image/png') {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
      fail('INVALID_ASSET', 'Declared PNG does not have a valid PNG header');
    }
    result = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (mediaType === 'image/webp') {
    if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
      fail('INVALID_ASSET', 'Declared WebP does not have a valid WebP header');
    }
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      result = {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    } else if (chunk === 'VP8L') {
      if (buffer[20] !== 0x2f) fail('INVALID_ASSET', 'WebP lossless header is malformed');
      const bits = buffer.readUInt32LE(21);
      result = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    } else if (chunk === 'VP8 ') {
      if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
        fail('INVALID_ASSET', 'WebP lossy frame header is malformed');
      }
      result = {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    } else {
      fail('INVALID_ASSET', `Unsupported WebP chunk ${JSON.stringify(chunk)}`);
    }
  } else {
    fail('INVALID_ASSET', `Unsupported media type ${mediaType}`);
  }
  if (
    result.width < 1 || result.height < 1 ||
    result.width > LIMITS.maxImageDimension || result.height > LIMITS.maxImageDimension
  ) {
    fail('LIMIT_EXCEEDED', `Image dimensions ${result.width}x${result.height} exceed v1 limits`);
  }
  return result;
}

function validateManifestShape(manifest) {
  requireObject(manifest, 'manifest');
  requireKeys(
    manifest,
    ['format', 'manifestVersion', 'id', 'displayName', 'description', 'license', 'source', 'assets', 'renderer', 'interactions'],
    TOP_LEVEL_KEYS,
    'manifest',
  );
  if (manifest.format !== FORMAT) fail('INVALID_MANIFEST', `manifest.format must be ${FORMAT}`);
  if (manifest.manifestVersion !== VERSION) fail('UNSUPPORTED_VERSION', `Only manifestVersion ${VERSION} is supported`);
  if (Object.hasOwn(manifest, '$schema')) requireString(manifest.$schema, 'manifest.$schema', 1, 256);
  requireString(manifest.id, 'manifest.id', 1, 64, SLUG);
  requireString(manifest.displayName, 'manifest.displayName', 1, 80);
  requireString(manifest.description, 'manifest.description', 1, 500);
  requireString(manifest.license, 'manifest.license', 1, 120);

  const source = requireObject(manifest.source, 'manifest.source');
  requireKeys(source, ['kind'], new Set(['kind', 'spriteVersionNumber']), 'manifest.source');
  if (!['native', 'codex-v2'].includes(source.kind)) fail('INVALID_MANIFEST', 'manifest.source.kind is unsupported');
  if (Object.hasOwn(source, 'spriteVersionNumber')) {
    requireNumber(source.spriteVersionNumber, 'manifest.source.spriteVersionNumber', 1, 100, true);
  }
  if (source.kind === 'codex-v2' && source.spriteVersionNumber !== 2) {
    fail('INVALID_MANIFEST', 'A codex-v2 source must declare spriteVersionNumber 2');
  }

  if (!Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 64) {
    fail('INVALID_MANIFEST', 'manifest.assets must contain 1-64 assets');
  }
  const assetIds = new Set();
  const assetPaths = new Set();
  for (let index = 0; index < manifest.assets.length; index += 1) {
    const pointer = `manifest.assets[${index}]`;
    const asset = requireObject(manifest.assets[index], pointer);
    requireKeys(asset, ['id', 'path', 'mediaType', 'bytes', 'sha256'], new Set(['id', 'path', 'mediaType', 'bytes', 'sha256', 'width', 'height']), pointer);
    requireString(asset.id, `${pointer}.id`, 1, 64, SLUG);
    assertSafeBundlePath(asset.path, `${pointer}.path`);
    if (asset.path.toLowerCase() === 'manifest.json') fail('INVALID_MANIFEST', `${pointer}.path cannot be manifest.json`);
    if (!Object.hasOwn(MEDIA_EXTENSIONS, asset.mediaType)) fail('INVALID_MANIFEST', `${pointer}.mediaType is unsupported`);
    const expectedExtension = MEDIA_EXTENSIONS[asset.mediaType];
    if (path.posix.extname(asset.path).toLowerCase() !== expectedExtension) {
      fail('INVALID_MANIFEST', `${pointer}.path must end in ${expectedExtension}`);
    }
    requireNumber(asset.bytes, `${pointer}.bytes`, 1, LIMITS.maxSingleFileBytes, true);
    requireString(asset.sha256, `${pointer}.sha256`, 64, 64, SHA256);
    if (Object.hasOwn(asset, 'width')) requireNumber(asset.width, `${pointer}.width`, 1, LIMITS.maxImageDimension, true);
    if (Object.hasOwn(asset, 'height')) requireNumber(asset.height, `${pointer}.height`, 1, LIMITS.maxImageDimension, true);
    if (Object.hasOwn(asset, 'width') !== Object.hasOwn(asset, 'height')) {
      fail('INVALID_MANIFEST', `${pointer}.width and height must be declared together`);
    }
    const idKey = asset.id.toLowerCase();
    const pathKey = asset.path.toLowerCase();
    if (assetIds.has(idKey)) fail('INVALID_MANIFEST', `Duplicate asset id ${asset.id}`);
    if (assetPaths.has(pathKey)) fail('INVALID_MANIFEST', `Duplicate asset path ${asset.path}`);
    assetIds.add(idKey);
    assetPaths.add(pathKey);
  }
  if (Object.hasOwn(manifest, 'previewAsset')) {
    requireString(manifest.previewAsset, 'manifest.previewAsset', 1, 64, SLUG);
    if (!assetIds.has(manifest.previewAsset.toLowerCase())) fail('INVALID_REFERENCE', 'previewAsset does not reference an asset');
  }

  const renderer = requireObject(manifest.renderer, 'manifest.renderer');
  requireKeys(
    renderer,
    ['type', 'atlasAsset', 'cellWidth', 'cellHeight', 'columns', 'rows', 'anchor', 'defaultScale', 'animations'],
    new Set(['type', 'atlasAsset', 'cellWidth', 'cellHeight', 'columns', 'rows', 'anchor', 'defaultScale', 'animations', 'lookDirections', 'lookScale', 'lookOffsetX', 'lookOffsetY']),
    'manifest.renderer',
  );
  if (renderer.type !== 'sprite-atlas') fail('INVALID_MANIFEST', 'Only sprite-atlas renderers are supported in v1');
  requireString(renderer.atlasAsset, 'manifest.renderer.atlasAsset', 1, 64, SLUG);
  if (!assetIds.has(renderer.atlasAsset.toLowerCase())) fail('INVALID_REFERENCE', 'renderer.atlasAsset does not reference an asset');
  requireNumber(renderer.cellWidth, 'manifest.renderer.cellWidth', 1, 2048, true);
  requireNumber(renderer.cellHeight, 'manifest.renderer.cellHeight', 1, 2048, true);
  requireNumber(renderer.columns, 'manifest.renderer.columns', 1, 64, true);
  requireNumber(renderer.rows, 'manifest.renderer.rows', 1, 64, true);
  requireNumber(renderer.defaultScale, 'manifest.renderer.defaultScale', 0.1, 4);
  if (Object.hasOwn(renderer, 'lookScale')) requireNumber(renderer.lookScale, 'manifest.renderer.lookScale', 0.7, 1.35);
  if (Object.hasOwn(renderer, 'lookOffsetX')) requireNumber(renderer.lookOffsetX, 'manifest.renderer.lookOffsetX', -0.5, 0.5);
  if (Object.hasOwn(renderer, 'lookOffsetY')) requireNumber(renderer.lookOffsetY, 'manifest.renderer.lookOffsetY', -0.5, 0.5);
  const anchor = requireObject(renderer.anchor, 'manifest.renderer.anchor');
  requireKeys(anchor, ['x', 'y'], new Set(['x', 'y']), 'manifest.renderer.anchor');
  requireNumber(anchor.x, 'manifest.renderer.anchor.x', 0, 1);
  requireNumber(anchor.y, 'manifest.renderer.anchor.y', 0, 1);

  const animations = requireObject(renderer.animations, 'manifest.renderer.animations');
  const animationNames = Object.keys(animations);
  if (animationNames.length < 1 || animationNames.length > 64) fail('INVALID_MANIFEST', 'renderer.animations must contain 1-64 entries');
  for (const name of animationNames) {
    requireString(name, `manifest.renderer.animations key ${name}`, 1, 64, SLUG);
    const pointer = `manifest.renderer.animations.${name}`;
    const animation = requireObject(animations[name], pointer);
    requireKeys(animation, ['row', 'frames', 'frameDurationsMs', 'loop'], new Set(['row', 'frames', 'frameDurationsMs', 'loop', 'visualScale', 'offsetX', 'offsetY']), pointer);
    requireNumber(animation.row, `${pointer}.row`, 0, renderer.rows - 1, true);
    if (!Array.isArray(animation.frames) || animation.frames.length < 1 || animation.frames.length > 64) {
      fail('INVALID_MANIFEST', `${pointer}.frames must contain 1-64 columns`);
    }
    if (!Array.isArray(animation.frameDurationsMs) || animation.frameDurationsMs.length !== animation.frames.length) {
      fail('INVALID_MANIFEST', `${pointer}.frameDurationsMs must match frames length`);
    }
    const usedFrames = new Set();
    animation.frames.forEach((frame, index) => {
      requireNumber(frame, `${pointer}.frames[${index}]`, 0, renderer.columns - 1, true);
      if (usedFrames.has(frame)) fail('INVALID_MANIFEST', `${pointer}.frames contains duplicate column ${frame}`);
      usedFrames.add(frame);
      requireNumber(animation.frameDurationsMs[index], `${pointer}.frameDurationsMs[${index}]`, 16, 10000, true);
    });
    requireBoolean(animation.loop, `${pointer}.loop`);
    if (Object.hasOwn(animation, 'visualScale')) requireNumber(animation.visualScale, `${pointer}.visualScale`, 0.7, 1.35);
    if (Object.hasOwn(animation, 'offsetX')) requireNumber(animation.offsetX, `${pointer}.offsetX`, -0.5, 0.5);
    if (Object.hasOwn(animation, 'offsetY')) requireNumber(animation.offsetY, `${pointer}.offsetY`, -0.5, 0.5);
  }

  if (Object.hasOwn(renderer, 'lookDirections')) {
    if (!Array.isArray(renderer.lookDirections) || renderer.lookDirections.length < 4 || renderer.lookDirections.length > 64) {
      fail('INVALID_MANIFEST', 'renderer.lookDirections must contain 4-64 entries');
    }
    const degreeKeys = new Set();
    const cellKeys = new Set();
    renderer.lookDirections.forEach((direction, index) => {
      const pointer = `manifest.renderer.lookDirections[${index}]`;
      requireObject(direction, pointer);
      requireKeys(direction, ['degrees', 'row', 'column'], new Set(['degrees', 'row', 'column']), pointer);
      requireNumber(direction.degrees, `${pointer}.degrees`, 0, 359.5);
      if (Math.round(direction.degrees * 2) !== direction.degrees * 2) fail('INVALID_MANIFEST', `${pointer}.degrees must use half-degree increments`);
      requireNumber(direction.row, `${pointer}.row`, 0, renderer.rows - 1, true);
      requireNumber(direction.column, `${pointer}.column`, 0, renderer.columns - 1, true);
      const degreeKey = String(direction.degrees);
      const cellKey = `${direction.row}:${direction.column}`;
      if (degreeKeys.has(degreeKey)) fail('INVALID_MANIFEST', `Duplicate look direction ${direction.degrees}`);
      if (cellKeys.has(cellKey)) fail('INVALID_MANIFEST', `Look directions reuse cell ${cellKey}`);
      degreeKeys.add(degreeKey);
      cellKeys.add(cellKey);
    });
  }

  const interactions = requireObject(manifest.interactions, 'manifest.interactions');
  requireKeys(interactions, ['eventMap'], new Set(['eventMap', 'touchZones']), 'manifest.interactions');
  const eventMap = requireObject(interactions.eventMap, 'manifest.interactions.eventMap');
  const eventNames = Object.keys(eventMap);
  if (eventNames.length < 1 || eventNames.length > 64) fail('INVALID_MANIFEST', 'interactions.eventMap must contain 1-64 entries');
  for (const event of eventNames) {
    requireString(event, `manifest.interactions.eventMap key ${event}`, 1, 64, SLUG);
    requireString(eventMap[event], `manifest.interactions.eventMap.${event}`, 1, 64, SLUG);
    if (!Object.hasOwn(animations, eventMap[event])) {
      fail('INVALID_REFERENCE', `Event ${event} references missing animation ${eventMap[event]}`);
    }
  }
  if (!Object.hasOwn(eventMap, 'idle')) fail('INVALID_MANIFEST', 'interactions.eventMap.idle is required');
  if (Object.hasOwn(interactions, 'touchZones')) {
    if (!Array.isArray(interactions.touchZones) || interactions.touchZones.length < 1 || interactions.touchZones.length > 12) {
      fail('INVALID_MANIFEST', 'interactions.touchZones must contain 1-12 normalized rectangles');
    }
    const zoneIds = new Set();
    interactions.touchZones.forEach((zone, index) => {
      const pointer = `manifest.interactions.touchZones[${index}]`;
      requireObject(zone, pointer);
      requireKeys(
        zone,
        ['id', 'event', 'x', 'y', 'width', 'height'],
        new Set(['id', 'label', 'event', 'x', 'y', 'width', 'height']),
        pointer,
      );
      requireString(zone.id, `${pointer}.id`, 1, 64, SLUG);
      if (Object.hasOwn(zone, 'label')) requireString(zone.label, `${pointer}.label`, 1, 40);
      requireString(zone.event, `${pointer}.event`, 1, 64, SLUG);
      if (!Object.hasOwn(eventMap, zone.event)) fail('INVALID_REFERENCE', `${pointer}.event does not reference eventMap`);
      requireNumber(zone.x, `${pointer}.x`, 0, 1);
      requireNumber(zone.y, `${pointer}.y`, 0, 1);
      requireNumber(zone.width, `${pointer}.width`, Number.EPSILON, 1);
      requireNumber(zone.height, `${pointer}.height`, Number.EPSILON, 1);
      if (zone.x + zone.width > 1 || zone.y + zone.height > 1) {
        fail('INVALID_MANIFEST', `${pointer} must stay inside normalized pet bounds`);
      }
      if (zoneIds.has(zone.id.toLowerCase())) fail('INVALID_MANIFEST', `Duplicate touch zone id ${zone.id}`);
      zoneIds.add(zone.id.toLowerCase());
    });
  }

  const atlas = manifest.assets.find((asset) => asset.id.toLowerCase() === renderer.atlasAsset.toLowerCase());
  if (!Object.hasOwn(atlas, 'width') || !Object.hasOwn(atlas, 'height')) {
    fail('INVALID_MANIFEST', 'The atlas asset must declare width and height');
  }
  if (atlas.width !== renderer.cellWidth * renderer.columns || atlas.height !== renderer.cellHeight * renderer.rows) {
    fail('INVALID_MANIFEST', 'Atlas dimensions do not match the declared cell grid');
  }

  if (source.kind === 'codex-v2') {
    const expectedDegrees = Array.from({ length: 16 }, (_, index) => index * 22.5);
    const actualDegrees = (renderer.lookDirections ?? []).map((entry) => entry.degrees).sort((a, b) => a - b);
    if (actualDegrees.length !== expectedDegrees.length || actualDegrees.some((value, index) => value !== expectedDegrees[index])) {
      fail('INVALID_MANIFEST', 'A codex-v2 source must expose all 16 clockwise look directions');
    }
    if (renderer.columns !== 8 || renderer.rows !== 11 || renderer.cellWidth !== 192 || renderer.cellHeight !== 208) {
      fail('INVALID_MANIFEST', 'A codex-v2 source must use the 8x11 grid of 192x208 cells');
    }
  }
  return manifest;
}

function validateEntryLimits(entries) {
  if (entries.size < 1 || entries.size > LIMITS.maxFiles) {
    fail('LIMIT_EXCEEDED', `Bundle contains ${entries.size} files; maximum is ${LIMITS.maxFiles}`);
  }
  let total = 0;
  const caseInsensitivePaths = new Set();
  for (const [entryPath, data] of entries) {
    assertSafeBundlePath(entryPath, `bundle entry ${entryPath}`);
    const pathKey = entryPath.toLowerCase();
    if (caseInsensitivePaths.has(pathKey)) fail('INVALID_BUNDLE', `Bundle contains a case-insensitive path collision at ${entryPath}`);
    caseInsensitivePaths.add(pathKey);
    if (!Buffer.isBuffer(data)) fail('INVALID_BUNDLE', `Bundle entry ${entryPath} is not binary data`);
    if (data.length > LIMITS.maxSingleFileBytes) fail('LIMIT_EXCEEDED', `Bundle entry ${entryPath} exceeds the single-file limit`);
    total += data.length;
    if (total > LIMITS.maxTotalBytes) fail('LIMIT_EXCEEDED', 'Bundle exceeds the uncompressed total-size limit');
  }
  return total;
}

export function validateBundleEntries(entries) {
  validateEntryLimits(entries);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) fail('MISSING_MANIFEST', 'Bundle must contain manifest.json at its root');
  if (manifestBytes.length > LIMITS.maxManifestBytes) fail('LIMIT_EXCEEDED', 'manifest.json exceeds 256 KiB');
  let manifest;
  try {
    const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
    manifest = JSON.parse(manifestText.replace(/^\uFEFF/u, ''));
  } catch (error) {
    fail('INVALID_MANIFEST', `manifest.json is not valid UTF-8 JSON: ${error.message}`);
  }
  validateManifestShape(manifest);

  const declaredPaths = new Set(['manifest.json']);
  for (const asset of manifest.assets) {
    const data = entries.get(asset.path);
    if (!data) fail('MISSING_ASSET', `Declared asset ${asset.path} is missing`);
    declaredPaths.add(asset.path);
    if (data.length !== asset.bytes) fail('ASSET_MISMATCH', `Asset ${asset.path} byte size does not match manifest`);
    if (sha256(data) !== asset.sha256) fail('ASSET_MISMATCH', `Asset ${asset.path} SHA-256 does not match manifest`);
    const imageInfo = readImageInfo(data, asset.mediaType);
    if (Object.hasOwn(asset, 'width') && (asset.width !== imageInfo.width || asset.height !== imageInfo.height)) {
      fail('ASSET_MISMATCH', `Asset ${asset.path} dimensions do not match manifest`);
    }
  }
  for (const entryPath of entries.keys()) {
    if (!declaredPaths.has(entryPath)) fail('UNDECLARED_FILE', `Bundle entry ${entryPath} is not declared in manifest.assets`);
  }
  return {
    ok: true,
    manifest,
    fileCount: entries.size,
    totalBytes: [...entries.values()].reduce((sum, data) => sum + data.length, 0),
  };
}

async function walkDirectory(root, current, entries, state) {
  const names = await readdir(current, { withFileTypes: true });
  names.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const dirent of names) {
    const absolute = path.join(current, dirent.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    assertSafeBundlePath(relative, `bundle entry ${relative}`);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail('SYMLINK_REJECTED', `Symbolic link ${relative} is not allowed`);
    if (info.isDirectory()) {
      await walkDirectory(root, absolute, entries, state);
    } else if (info.isFile()) {
      if (entries.has(relative)) fail('INVALID_BUNDLE', `Duplicate bundle path ${relative}`);
      if (entries.size + 1 > LIMITS.maxFiles) fail('LIMIT_EXCEEDED', `Bundle has more than ${LIMITS.maxFiles} files`);
      if (info.size > LIMITS.maxSingleFileBytes) fail('LIMIT_EXCEEDED', `Bundle entry ${relative} exceeds the single-file limit`);
      state.totalBytes += info.size;
      if (state.totalBytes > LIMITS.maxTotalBytes) fail('LIMIT_EXCEEDED', 'Bundle exceeds the uncompressed total-size limit');
      entries.set(relative, await readFile(absolute));
    } else {
      fail('INVALID_BUNDLE', `Special filesystem entry ${relative} is not allowed`);
    }
  }
}

export async function readDirectoryBundle(directory) {
  const root = path.resolve(directory);
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory()) fail('NOT_A_BUNDLE', `${directory} is not a directory`);
  const entries = new Map();
  await walkDirectory(root, root, entries, { totalBytes: 0 });
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function createPetpackArchive(entries) {
  validateEntryLimits(entries);
  const sorted = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [entryPath, data] of sorted) {
    const name = Buffer.from(entryPath, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('INVALID_ARCHIVE', 'ZIP end-of-central-directory record is missing');
}

export function readPetpackArchiveBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('INVALID_ARCHIVE', 'Petpack archive is too small');
  const eocdOffset = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) fail('INVALID_ARCHIVE', 'Multi-disk ZIP archives are not supported');
  if (entryCount < 1 || entryCount > LIMITS.maxFiles) fail('LIMIT_EXCEEDED', `Archive declares ${entryCount} files`);
  if (eocdOffset + 22 + commentLength !== buffer.length) fail('INVALID_ARCHIVE', 'Archive has trailing or truncated data');
  if (centralOffset + centralSize !== eocdOffset) fail('INVALID_ARCHIVE', 'Central directory bounds are inconsistent');

  const entries = new Map();
  const caseInsensitiveNames = new Set();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) fail('INVALID_ARCHIVE', 'Central directory entry is malformed');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (cursor + recordLength > eocdOffset) fail('INVALID_ARCHIVE', 'Central directory entry exceeds archive bounds');
    if ((flags & 0x0001) !== 0) fail('INVALID_ARCHIVE', 'Encrypted ZIP entries are not supported');
    if ((flags & ~(0x0008 | 0x0800)) !== 0) fail('INVALID_ARCHIVE', `ZIP entry ${index} uses unsupported flags`);
    if (method !== 0 && method !== 8) fail('INVALID_ARCHIVE', `ZIP compression method ${method} is not supported`);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) fail('SYMLINK_REJECTED', 'Archive symbolic links are not allowed');
    const entryPath = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assertSafeBundlePath(entryPath, `archive entry ${entryPath}`);
    const nameKey = entryPath.toLowerCase();
    if (caseInsensitiveNames.has(nameKey)) fail('INVALID_ARCHIVE', `Duplicate archive path ${entryPath}`);
    caseInsensitiveNames.add(nameKey);
    if (uncompressedSize > LIMITS.maxSingleFileBytes) fail('LIMIT_EXCEEDED', `Archive entry ${entryPath} exceeds the single-file limit`);
    total += uncompressedSize;
    if (total > LIMITS.maxTotalBytes) fail('LIMIT_EXCEEDED', 'Archive exceeds the uncompressed total-size limit');

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) fail('INVALID_ARCHIVE', `Local header for ${entryPath} is malformed`);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
    if (localFlags !== flags || localMethod !== method || localName !== entryPath) fail('INVALID_ARCHIVE', `Local header for ${entryPath} disagrees with central directory`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) fail('INVALID_ARCHIVE', `Compressed data for ${entryPath} exceeds archive bounds`);
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: LIMITS.maxSingleFileBytes });
    } catch (error) {
      fail('INVALID_ARCHIVE', `Could not decompress ${entryPath}: ${error.message}`);
    }
    if (data.length !== uncompressedSize) fail('INVALID_ARCHIVE', `Uncompressed size mismatch for ${entryPath}`);
    if (crc32(data) !== checksum) fail('INVALID_ARCHIVE', `CRC-32 mismatch for ${entryPath}`);
    entries.set(entryPath, data);
    cursor += recordLength;
  }
  if (cursor !== eocdOffset) fail('INVALID_ARCHIVE', 'Central directory contains unparsed bytes');
  return entries;
}

export async function readBundleWithExtension(input, extension = '.petpack') {
  const expectedExtension = String(extension).toLowerCase();
  if (!/^\.[a-z0-9]+$/u.test(expectedExtension)) {
    fail('INVALID_EXTENSION', `Bundle extension ${JSON.stringify(extension)} is not supported`);
  }
  const absolute = path.resolve(input);
  const info = await lstat(absolute).catch(() => null);
  if (!info) fail('NOT_A_BUNDLE', `${input} does not exist`);
  if (info.isSymbolicLink()) fail('SYMLINK_REJECTED', 'Bundle root cannot be a symbolic link');
  if (info.isDirectory()) return { type: 'directory', entries: await readDirectoryBundle(absolute) };
  if (!info.isFile()) fail('NOT_A_BUNDLE', `${input} is not a regular file or directory`);
  if (path.extname(absolute).toLowerCase() !== expectedExtension) {
    fail('NOT_A_BUNDLE', `Archive filename must end in ${expectedExtension}`);
  }
  if (info.size > LIMITS.maxTotalBytes + 16 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'Compressed archive is unreasonably large');
  return { type: 'archive', entries: readPetpackArchiveBuffer(await readFile(absolute)) };
}

export async function readBundle(input) {
  return readBundleWithExtension(input, '.petpack');
}

export async function validateBundleWith(input, extension, validateEntries) {
  if (typeof validateEntries !== 'function') {
    fail('INVALID_VALIDATOR', 'A bundle validator function is required');
  }
  const bundle = await readBundleWithExtension(input, extension);
  return {
    ...validateEntries(bundle.entries),
    bundleType: bundle.type,
    source: path.resolve(input),
  };
}

export async function validateBundle(input) {
  return validateBundleWith(input, '.petpack', validateBundleEntries);
}

async function writeAtomically(output, data) {
  const absolute = path.resolve(output);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function packBundleWith(directory, output, extension, validateEntries) {
  if (typeof validateEntries !== 'function') {
    fail('INVALID_VALIDATOR', 'A bundle validator function is required');
  }
  const expectedExtension = String(extension).toLowerCase();
  const entries = await readDirectoryBundle(directory);
  const report = validateEntries(entries);
  const archive = createPetpackArchive(entries);
  if (path.extname(output).toLowerCase() !== expectedExtension) {
    fail('INVALID_OUTPUT', `Packed output filename must end in ${expectedExtension}`);
  }
  await access(path.resolve(output), fsConstants.F_OK).then(
    () => fail('DESTINATION_EXISTS', `Output ${output} already exists`),
    () => {},
  );
  await writeAtomically(output, archive);
  return { ...report, archive: path.resolve(output), archiveBytes: archive.length };
}

export async function packBundle(directory, output) {
  return packBundleWith(directory, output, '.petpack', validateBundleEntries);
}

function safeOutputPath(root, entryPath) {
  assertSafeBundlePath(entryPath, `bundle entry ${entryPath}`);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...entryPath.split('/'));
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    fail('UNSAFE_PATH', `Bundle entry ${entryPath} escapes import destination`);
  }
  return target;
}

export async function importBundleWith(input, destination, extension, validateEntries) {
  if (typeof validateEntries !== 'function') {
    fail('INVALID_VALIDATOR', 'A bundle validator function is required');
  }
  const bundle = await readBundleWithExtension(input, extension);
  const report = validateEntries(bundle.entries);
  const absoluteDestination = path.resolve(destination);
  await access(absoluteDestination, fsConstants.F_OK).then(
    () => fail('DESTINATION_EXISTS', `Destination ${destination} already exists`),
    () => {},
  );
  await mkdir(path.dirname(absoluteDestination), { recursive: true });
  const temporary = `${absoluteDestination}.import-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await mkdir(temporary, { recursive: false });
    for (const [entryPath, data] of bundle.entries) {
      const target = safeOutputPath(temporary, entryPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    }
    await rename(temporary, absoluteDestination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { ...report, destination: absoluteDestination, sourceType: bundle.type };
}

export async function importBundle(input, destination) {
  return importBundleWith(input, destination, '.petpack', validateBundleEntries);
}
