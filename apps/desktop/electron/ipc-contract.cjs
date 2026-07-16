'use strict';

/**
 * Keep Electron channel names in one dependency-free module so the main and
 * preload processes cannot silently drift apart.
 */
const IPC = Object.freeze({
  LOAD_PET_CATALOG: 'pet-desktop:catalog:load',
  IMPORT_PETPACK: 'pet-desktop:catalog:import',
  REMOVE_PETPACK: 'pet-desktop:catalog:remove',
  IMPORT_ITEMPACK: 'pet-desktop:item-catalog:import',
  REMOVE_ITEMPACK: 'pet-desktop:item-catalog:remove',
  PET_CATALOG_CHANGED: 'pet-desktop:catalog:changed',
  LOAD_STATE: 'pet-desktop:state:load',
  SAVE_STATE: 'pet-desktop:state:save',
  SET_INTERACTIVE_REGIONS: 'pet-desktop:overlay:set-interactive-regions',
  SET_POINTER_HOVER: 'pet-desktop:overlay:set-pointer-hover',
  SET_IGNORE_MOUSE_EVENTS: 'pet-desktop:overlay:set-ignore-mouse-events',
  GET_SHELL_STATE: 'pet-desktop:shell:get-state',
  SET_SHELL_STATE: 'pet-desktop:shell:set-state',
  SHELL_STATE_CHANGED: 'pet-desktop:shell:state-changed',
  GET_WINDOW_PLATFORMS: 'pet-desktop:platforms:get',
  SET_WINDOW_PLATFORM_INTERACTIONS: 'pet-desktop:platforms:set-enabled',
  QUIT_REQUESTED: 'pet-desktop:shell:quit-requested',
  QUIT_APP: 'pet-desktop:shell:quit',
});

function asFiniteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function validRect(rect) {
  const x = asFiniteInteger(rect?.x);
  const y = asFiniteInteger(rect?.y);
  const width = asFiniteInteger(rect?.width);
  const height = asFiniteInteger(rect?.height);
  if ([x, y, width, height].some((value) => value === null)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Electron's screenToDipRect must be invoked as a method (to preserve its
 * native receiver) and receives the BrowserWindow before the rectangle. Keep
 * that easy-to-miss call shape in one tested adapter. If Windows cannot map a
 * transient window rectangle, retaining the physical coordinates is safer
 * than dropping the platform entirely.
 */
function createScreenToDipRectMapper(screenApi, getWindow = () => null) {
  return (rect) => {
    const sourceRect = validRect(rect);
    if (!sourceRect) return rect;
    if (!screenApi || typeof screenApi.screenToDipRect !== 'function') return sourceRect;

    try {
      const window = typeof getWindow === 'function' ? getWindow() : getWindow;
      return validRect(screenApi.screenToDipRect(window ?? null, sourceRect)) ?? sourceRect;
    } catch {
      return sourceRect;
    }
  };
}

/**
 * Incremental byte-bounded JSONL framing for the native watcher. The decoder
 * deliberately deals in Buffers so a multi-byte UTF-8 stream cannot bypass
 * the per-line byte limit.
 */
function createBoundedLineDecoder({ maxBytes, onLine, onViolation }) {
  const limit = Math.max(1, asFiniteInteger(maxBytes) ?? 1);
  let pending = Buffer.alloc(0);
  let failed = false;

  function violate(code) {
    if (failed) return;
    failed = true;
    pending = Buffer.alloc(0);
    onViolation?.(code);
  }

  function push(chunk) {
    if (failed || chunk === undefined || chunk === null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);

    while (!failed) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.length > limit) violate('WINDOW_PLATFORM_LINE_TOO_LARGE');
        return;
      }

      let line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length > limit) {
        violate('WINDOW_PLATFORM_LINE_TOO_LARGE');
        return;
      }
      if (line.length > 0) onLine?.(line);
    }
  }

  function end() {
    if (failed || pending.length === 0) return;
    if (pending.length > limit) {
      violate('WINDOW_PLATFORM_LINE_TOO_LARGE');
      return;
    }
    const line = pending;
    pending = Buffer.alloc(0);
    onLine?.(line);
  }

  return { push, end };
}

function exponentialBackoffDelay(attempt, baseMs = 250, maximumMs = 8_000) {
  const exponent = Math.max(0, Math.min(16, asFiniteInteger(attempt) ?? 0));
  const base = Math.max(1, asFiniteInteger(baseMs) ?? 250);
  const maximum = Math.max(base, asFiniteInteger(maximumMs) ?? 8_000);
  return Math.min(maximum, base * (2 ** exponent));
}

/**
 * Converts the native scanner's deliberately tiny record shape into renderer
 * coordinates. Unknown fields (for example, a future accidental window title)
 * are never copied across the IPC boundary.
 */
function normalizeWindowPlatformRecords(records, mapRect = (rect) => rect) {
  if (!Array.isArray(records)) return [];

  const normalized = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const hwnd = String(record.hwnd ?? '').trim();
    const pid = asFiniteInteger(record.pid);
    const left = asFiniteInteger(record.left);
    const top = asFiniteInteger(record.top);
    const right = asFiniteInteger(record.right);
    const bottom = asFiniteInteger(record.bottom);
    if (!/^\d{1,20}$/.test(hwnd) || pid === null || pid <= 0) continue;
    if ([left, top, right, bottom].some((value) => value === null)) continue;
    if (right <= left || bottom <= top || seen.has(hwnd)) continue;

    let dipBounds;
    try {
      dipBounds = mapRect({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
    } catch {
      continue;
    }
    const dipLeft = asFiniteInteger(dipBounds?.x);
    const dipTop = asFiniteInteger(dipBounds?.y);
    const dipWidth = asFiniteInteger(dipBounds?.width);
    const dipHeight = asFiniteInteger(dipBounds?.height);
    if ([dipLeft, dipTop, dipWidth, dipHeight].some((value) => value === null)) continue;
    const dipRight = dipLeft + dipWidth;
    const dipBottom = dipTop + dipHeight;
    if (dipRight <= dipLeft || dipBottom <= dipTop) continue;

    seen.add(hwnd);
    normalized.push({
      hwnd,
      pid,
      left: dipLeft,
      top: dipTop,
      right: dipRight,
      bottom: dipBottom,
    });
  }

  // EnumWindows already yields top-level windows in Z order. Preserve that
  // order so the renderer can choose the uppermost overlapping platform.
  return normalized;
}

function normalizeOverlayBounds(bounds) {
  const x = asFiniteInteger(bounds?.x) ?? 0;
  const y = asFiniteInteger(bounds?.y) ?? 0;
  const width = Math.max(0, asFiniteInteger(bounds?.width) ?? 0);
  const height = Math.max(0, asFiniteInteger(bounds?.height) ?? 0);
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
  };
}

function buildWindowPlatformsPayload({
  platforms,
  overlayBounds,
  supported = true,
  capturedAt = Date.now(),
  stale = false,
  error = null,
} = {}) {
  const overlay = normalizeOverlayBounds(overlayBounds);
  return {
    supported: Boolean(supported),
    capturedAt: asFiniteInteger(capturedAt) ?? Date.now(),
    stale: Boolean(stale),
    error: typeof error === 'string' ? error : null,
    overlayBounds: overlay,
    platforms: (Array.isArray(platforms) ? platforms : []).map((platform) => ({
      hwnd: platform.hwnd,
      pid: platform.pid,
      left: platform.left,
      top: platform.top,
      right: platform.right,
      bottom: platform.bottom,
      overlayLeft: platform.left - overlay.left,
      overlayTop: platform.top - overlay.top,
      overlayRight: platform.right - overlay.left,
      overlayBottom: platform.bottom - overlay.top,
    })),
  };
}

module.exports = {
  IPC,
  buildWindowPlatformsPayload,
  createBoundedLineDecoder,
  createScreenToDipRectMapper,
  exponentialBackoffDelay,
  normalizeWindowPlatformRecords,
};
