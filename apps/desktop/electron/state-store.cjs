'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_SCHEMA_VERSION = 1;
const MAX_RENDERER_STATE_BYTES = 2 * 1024 * 1024;

function makeDefaultDocument() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    shell: {
      visible: true,
      quiet: false,
      displayId: null,
    },
    rendererState: {},
  };
}

function normalizeJson(value, maxBytes = MAX_RENDERER_STATE_BYTES) {
  let text;

  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`State must be JSON serializable: ${error.message}`);
  }

  if (text === undefined) {
    throw new TypeError('State must be a JSON value');
  }

  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new RangeError(`State exceeds the ${maxBytes}-byte limit`);
  }

  return JSON.parse(text);
}

function normalizeShellState(value) {
  const defaults = makeDefaultDocument().shell;
  const input = value && typeof value === 'object' ? value : {};

  return {
    visible: typeof input.visible === 'boolean' ? input.visible : defaults.visible,
    quiet: typeof input.quiet === 'boolean' ? input.quiet : defaults.quiet,
    displayId:
      typeof input.displayId === 'number' || typeof input.displayId === 'string'
        ? input.displayId
        : defaults.displayId,
  };
}

function normalizeDocument(value) {
  const defaults = makeDefaultDocument();
  const input = value && typeof value === 'object' ? value : {};

  let rendererState = defaults.rendererState;
  try {
    rendererState = normalizeJson(input.rendererState ?? defaults.rendererState);
  } catch {
    rendererState = defaults.rendererState;
  }

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    shell: normalizeShellState(input.shell),
    rendererState,
  };
}

class AtomicJsonStore {
  constructor(filePath) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('AtomicJsonStore requires an absolute file path');
    }

    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.document = this.#loadDocument();
  }

  getShellState() {
    return { ...this.document.shell };
  }

  patchShellState(patch) {
    const current = this.document.shell;
    const candidate = {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
    };

    this.document.shell = normalizeShellState(candidate);
    this.#persist();
    return this.getShellState();
  }

  loadRendererState() {
    return normalizeJson(this.document.rendererState);
  }

  saveRendererState(state) {
    this.document.rendererState = normalizeJson(state);
    this.#persist();
    return this.loadRendererState();
  }

  #loadDocument() {
    for (const candidate of [this.filePath, this.backupPath]) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        return normalizeDocument(JSON.parse(raw));
      } catch {
        // Try the backup next, then fall back to defaults.
      }
    }

    return makeDefaultDocument();
  }

  #persist() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const payload = `${JSON.stringify(this.document, null, 2)}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    let descriptor;

    try {
      fs.writeFileSync(tempPath, payload, { encoding: 'utf8', flag: 'wx' });
      // Windows requires a descriptor opened with write access for fsync.
      descriptor = fs.openSync(tempPath, 'r+');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;

      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, this.backupPath);
      }

      try {
        fs.renameSync(tempPath, this.filePath);
      } catch (error) {
        // Most platforms replace an existing file atomically. Some Windows
        // setups deny that operation, so retain a narrow compatibility
        // fallback while keeping the .bak recovery file.
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
          throw error;
        }
        fs.rmSync(this.filePath, { force: true });
        fs.renameSync(tempPath, this.filePath);
      }
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
      fs.rmSync(tempPath, { force: true });
    }
  }
}

module.exports = {
  AtomicJsonStore,
  MAX_RENDERER_STATE_BYTES,
  STORE_SCHEMA_VERSION,
};
