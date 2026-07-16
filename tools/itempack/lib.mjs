import {
  LIMITS,
  PetpackError,
  assertSafeBundlePath,
  importBundleWith,
  packBundleWith,
  readImageInfo,
  sha256,
  validateBundleWith,
} from './petpack-lib.mjs';

const FORMAT = 'com.petdesktop.itempack';
const VERSION = '1.0';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set(['image/png', 'image/webp']);
const MAX_ITEM_IMAGE_DIMENSION = 2048;
const MAX_ITEMPACK_PIXELS = 8_388_608;
const ITEM_BEHAVIORS = Object.freeze({
  food: new Set(['treat']),
  toy: new Set(['ball', 'wand', 'hideout']),
});

export class ItempackError extends PetpackError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = 'ItempackError';
  }
}

function asItempackError(error) {
  if (error instanceof ItempackError) return error;
  return new ItempackError(
    typeof error?.code === 'string' ? error.code : 'ITEMPACK_ERROR',
    error?.message || 'Item pack operation failed',
    error?.details,
  );
}

function fail(code, message, details) {
  throw new ItempackError(code, message, details);
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
    if (!Object.hasOwn(object, key)) fail('INVALID_MANIFEST', `${pointer}.${key} is required`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail('INVALID_MANIFEST', `${pointer}.${key} is not allowed`);
  }
}

function requireString(value, pointer, min, max, pattern = undefined) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('INVALID_MANIFEST', `${pointer} must be a string of ${min}-${max} characters`);
  }
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    fail('INVALID_MANIFEST', `${pointer} contains a control character`);
  }
  if (pattern && !pattern.test(value)) fail('INVALID_MANIFEST', `${pointer} has an invalid format`);
  return value;
}

function requireNumber(value, pointer, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_MANIFEST', `${pointer} must be a number from ${min} to ${max}`);
  }
  if (integer && !Number.isInteger(value)) fail('INVALID_MANIFEST', `${pointer} must be an integer`);
  return value;
}

function validateLimits(entries) {
  if (!(entries instanceof Map) || entries.size < 2 || entries.size > LIMITS.maxFiles) {
    fail('LIMIT_EXCEEDED', 'Item pack must contain manifest.json and 1-127 declared assets');
  }
  let total = 0;
  const paths = new Set();
  for (const [entryPath, data] of entries) {
    assertSafeBundlePath(entryPath, `bundle entry ${entryPath}`);
    if (paths.has(entryPath.toLowerCase())) fail('INVALID_BUNDLE', `Case-insensitive path collision at ${entryPath}`);
    paths.add(entryPath.toLowerCase());
    if (!Buffer.isBuffer(data)) fail('INVALID_BUNDLE', `Bundle entry ${entryPath} is not binary data`);
    if (data.length > LIMITS.maxSingleFileBytes) fail('LIMIT_EXCEEDED', `${entryPath} exceeds the single-file limit`);
    total += data.length;
    if (total > LIMITS.maxTotalBytes) fail('LIMIT_EXCEEDED', 'Item pack exceeds the total-size limit');
  }
}

function parseManifest(entries) {
  const bytes = entries.get('manifest.json');
  if (!bytes) fail('MISSING_MANIFEST', 'Item pack must contain manifest.json at its root');
  if (bytes.length > LIMITS.maxManifestBytes) fail('LIMIT_EXCEEDED', 'manifest.json exceeds 256 KiB');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''));
  } catch (error) {
    fail('INVALID_MANIFEST', `manifest.json is not valid UTF-8 JSON: ${error.message}`);
  }
}

function validateManifest(manifest) {
  requireObject(manifest, 'manifest');
  requireKeys(
    manifest,
    ['format', 'manifestVersion', 'id', 'displayName', 'description', 'license', 'assets', 'items'],
    new Set(['$schema', 'format', 'manifestVersion', 'id', 'displayName', 'description', 'license', 'assets', 'previewAsset', 'items']),
    'manifest',
  );
  if (manifest.format !== FORMAT) fail('INVALID_MANIFEST', `manifest.format must be ${FORMAT}`);
  if (manifest.manifestVersion !== VERSION) fail('UNSUPPORTED_VERSION', `Only manifestVersion ${VERSION} is supported`);
  if (Object.hasOwn(manifest, '$schema')) requireString(manifest.$schema, 'manifest.$schema', 1, 256);
  requireString(manifest.id, 'manifest.id', 1, 64, SLUG);
  requireString(manifest.displayName, 'manifest.displayName', 1, 80);
  requireString(manifest.description, 'manifest.description', 1, 500);
  requireString(manifest.license, 'manifest.license', 1, 120);

  if (!Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 64) {
    fail('INVALID_MANIFEST', 'manifest.assets must contain 1-64 images');
  }
  const assetIds = new Set();
  const assetPaths = new Set();
  let totalPixels = 0;
  manifest.assets.forEach((asset, index) => {
    const pointer = `manifest.assets[${index}]`;
    requireObject(asset, pointer);
    requireKeys(asset, ['id', 'path', 'mediaType', 'bytes', 'sha256', 'width', 'height'], new Set(['id', 'path', 'mediaType', 'bytes', 'sha256', 'width', 'height']), pointer);
    requireString(asset.id, `${pointer}.id`, 1, 64, SLUG);
    assertSafeBundlePath(asset.path, `${pointer}.path`);
    if (asset.path.toLowerCase() === 'manifest.json') fail('INVALID_MANIFEST', `${pointer}.path cannot be manifest.json`);
    if (!MEDIA_TYPES.has(asset.mediaType)) fail('INVALID_MANIFEST', `${pointer}.mediaType is unsupported`);
    const expectedExtension = asset.mediaType === 'image/png' ? '.png' : '.webp';
    if (!asset.path.toLowerCase().endsWith(expectedExtension)) fail('INVALID_MANIFEST', `${pointer}.path must end in ${expectedExtension}`);
    requireNumber(asset.bytes, `${pointer}.bytes`, 1, LIMITS.maxSingleFileBytes, true);
    requireString(asset.sha256, `${pointer}.sha256`, 64, 64, SHA256);
    requireNumber(asset.width, `${pointer}.width`, 1, MAX_ITEM_IMAGE_DIMENSION, true);
    requireNumber(asset.height, `${pointer}.height`, 1, MAX_ITEM_IMAGE_DIMENSION, true);
    totalPixels += asset.width * asset.height;
    if (totalPixels > MAX_ITEMPACK_PIXELS) {
      fail('LIMIT_EXCEEDED', `Item pack image pixels exceed ${MAX_ITEMPACK_PIXELS}`);
    }
    if (assetIds.has(asset.id.toLowerCase())) fail('INVALID_MANIFEST', `Duplicate asset id ${asset.id}`);
    if (assetPaths.has(asset.path.toLowerCase())) fail('INVALID_MANIFEST', `Duplicate asset path ${asset.path}`);
    assetIds.add(asset.id.toLowerCase());
    assetPaths.add(asset.path.toLowerCase());
  });
  if (Object.hasOwn(manifest, 'previewAsset')) {
    requireString(manifest.previewAsset, 'manifest.previewAsset', 1, 64, SLUG);
    if (!assetIds.has(manifest.previewAsset.toLowerCase())) fail('INVALID_REFERENCE', 'previewAsset does not reference an asset');
  }

  if (!Array.isArray(manifest.items) || manifest.items.length < 1 || manifest.items.length > 32) {
    fail('INVALID_MANIFEST', 'manifest.items must contain 1-32 items');
  }
  const itemIds = new Set();
  manifest.items.forEach((item, index) => {
    const pointer = `manifest.items[${index}]`;
    requireObject(item, pointer);
    requireKeys(item, ['id', 'displayName', 'category', 'behavior', 'asset', 'scale'], new Set(['id', 'displayName', 'category', 'behavior', 'asset', 'scale', 'unlockLevel']), pointer);
    requireString(item.id, `${pointer}.id`, 1, 64, SLUG);
    requireString(item.displayName, `${pointer}.displayName`, 1, 60);
    if (!Object.hasOwn(ITEM_BEHAVIORS, item.category)) fail('INVALID_MANIFEST', `${pointer}.category is unsupported`);
    if (!ITEM_BEHAVIORS[item.category].has(item.behavior)) fail('INVALID_MANIFEST', `${pointer}.behavior is not valid for ${item.category}`);
    requireString(item.asset, `${pointer}.asset`, 1, 64, SLUG);
    if (!assetIds.has(item.asset.toLowerCase())) fail('INVALID_REFERENCE', `${pointer}.asset does not reference an asset`);
    requireNumber(item.scale, `${pointer}.scale`, 0.35, 2.5);
    if (Object.hasOwn(item, 'unlockLevel')) {
      requireNumber(item.unlockLevel, `${pointer}.unlockLevel`, 1, 5, true);
    }
    if (itemIds.has(item.id.toLowerCase())) fail('INVALID_MANIFEST', `Duplicate item id ${item.id}`);
    itemIds.add(item.id.toLowerCase());
  });
  return manifest;
}

export function validateItempackEntries(entries) {
  validateLimits(entries);
  const manifest = validateManifest(parseManifest(entries));
  const declared = new Set(['manifest.json']);
  for (const asset of manifest.assets) {
    const data = entries.get(asset.path);
    if (!data) fail('MISSING_ASSET', `Declared asset ${asset.path} is missing`);
    declared.add(asset.path);
    if (data.length !== asset.bytes) fail('ASSET_MISMATCH', `Asset ${asset.path} byte size does not match manifest`);
    if (sha256(data) !== asset.sha256) fail('ASSET_MISMATCH', `Asset ${asset.path} SHA-256 does not match manifest`);
    const dimensions = readImageInfo(data, asset.mediaType);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
      fail('ASSET_MISMATCH', `Asset ${asset.path} dimensions do not match manifest`);
    }
  }
  for (const entryPath of entries.keys()) {
    if (!declared.has(entryPath)) fail('UNDECLARED_FILE', `Bundle entry ${entryPath} is not declared in manifest.assets`);
  }
  return {
    ok: true,
    manifest,
    fileCount: entries.size,
    totalBytes: [...entries.values()].reduce((sum, data) => sum + data.length, 0),
  };
}

export async function validateItempack(input) {
  try {
    return await validateBundleWith(input, '.itempack', validateItempackEntries);
  } catch (error) {
    throw asItempackError(error);
  }
}

export async function packItempack(directory, output) {
  try {
    return await packBundleWith(directory, output, '.itempack', validateItempackEntries);
  } catch (error) {
    throw asItempackError(error);
  }
}

export async function importItempack(input, destination) {
  try {
    return await importBundleWith(input, destination, '.itempack', validateItempackEntries);
  } catch (error) {
    throw asItempackError(error);
  }
}
