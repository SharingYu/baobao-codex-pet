import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  IPC,
  buildWindowPlatformsPayload,
  createBoundedLineDecoder,
  createScreenToDipRectMapper,
  exponentialBackoffDelay,
  normalizeWindowPlatformRecords,
} = require('../ipc-contract.cjs');

test('window platform IPC channel is pinned in the shared contract', () => {
  assert.equal(IPC.GET_WINDOW_PLATFORMS, 'pet-desktop:platforms:get');
  assert.equal(IPC.SET_WINDOW_PLATFORM_INTERACTIONS, 'pet-desktop:platforms:set-enabled');
});

test('screenToDipRect mapper preserves the native receiver and argument order', () => {
  const targetWindow = { id: 'overlay' };
  const screenApi = {
    screenToDipRect(window, rect) {
      assert.equal(this, screenApi);
      assert.equal(window, targetWindow);
      assert.deepEqual(rect, { x: 200, y: 100, width: 400, height: 300 });
      return { x: 100, y: 50, width: 200, height: 150 };
    },
  };
  const mapper = createScreenToDipRectMapper(screenApi, () => targetWindow);
  assert.deepEqual(mapper({ x: 200, y: 100, width: 400, height: 300 }), {
    x: 100,
    y: 50,
    width: 200,
    height: 150,
  });
});

test('screenToDipRect mapper falls back to source geometry on native failure', () => {
  const source = { x: -100, y: 20, width: 320, height: 240 };
  const throwing = createScreenToDipRectMapper({
    screenToDipRect() {
      throw new Error('transient DPI mapping failure');
    },
  });
  const malformed = createScreenToDipRectMapper({
    screenToDipRect() {
      return { x: 1, y: 2 };
    },
  });
  assert.deepEqual(throwing(source), source);
  assert.deepEqual(malformed(source), source);
});

test('native records are validated, deduplicated, and content fields are dropped', () => {
  const records = normalizeWindowPlatformRecords([
    {
      hwnd: '42',
      pid: 12,
      left: 200,
      top: 100,
      right: 600,
      bottom: 500,
      title: 'must never cross IPC',
    },
    { hwnd: '42', pid: 12, left: 1, top: 1, right: 2, bottom: 2 },
    { hwnd: 'not-a-handle', pid: 9, left: 0, top: 0, right: 300, bottom: 200 },
    { hwnd: '43', pid: 0, left: 0, top: 0, right: 300, bottom: 200 },
    { hwnd: '44', pid: 9, left: 10, top: 10, right: 10, bottom: 200 },
  ], ({ x, y, width, height }) => ({
    x: x / 2,
    y: y / 2,
    width: width / 2,
    height: height / 2,
  }));

  assert.deepEqual(records, [{
    hwnd: '42',
    pid: 12,
    left: 100,
    top: 50,
    right: 300,
    bottom: 250,
  }]);
  assert.equal('title' in records[0], false);
});

test('bounded line decoder handles fragmented CRLF snapshots', () => {
  const lines = [];
  const violations = [];
  const decoder = createBoundedLineDecoder({
    maxBytes: 64,
    onLine: (line) => lines.push(line.toString('utf8')),
    onViolation: (code) => violations.push(code),
  });
  decoder.push(Buffer.from('[{"hwnd":"1"}]\r'));
  decoder.push(Buffer.from('\n[]\n'));
  assert.deepEqual(lines, ['[{"hwnd":"1"}]', '[]']);
  assert.deepEqual(violations, []);
});

test('bounded line decoder rejects a line over its byte cap once', () => {
  const violations = [];
  const decoder = createBoundedLineDecoder({
    maxBytes: 4,
    onViolation: (code) => violations.push(code),
  });
  decoder.push(Buffer.from('12345'));
  decoder.push(Buffer.from('67890\n'));
  assert.deepEqual(violations, ['WINDOW_PLATFORM_LINE_TOO_LARGE']);
});

test('watcher restart delay uses capped exponential backoff', () => {
  assert.equal(exponentialBackoffDelay(0, 250, 8_000), 250);
  assert.equal(exponentialBackoffDelay(3, 250, 8_000), 2_000);
  assert.equal(exponentialBackoffDelay(12, 250, 8_000), 8_000);
});

test('payload provides screen and overlay-local bounds without exposing window content', () => {
  const payload = buildWindowPlatformsPayload({
    capturedAt: 1234,
    overlayBounds: { x: 80, y: 40, width: 800, height: 600 },
    platforms: [{ hwnd: '99', pid: 7, left: 100, top: 120, right: 500, bottom: 420 }],
  });

  assert.deepEqual(payload.overlayBounds, {
    left: 80,
    top: 40,
    right: 880,
    bottom: 640,
    width: 800,
    height: 600,
  });
  assert.deepEqual(payload.platforms[0], {
    hwnd: '99',
    pid: 7,
    left: 100,
    top: 120,
    right: 500,
    bottom: 420,
    overlayLeft: 20,
    overlayTop: 80,
    overlayRight: 420,
    overlayBottom: 380,
  });
  assert.equal(payload.supported, true);
  assert.equal(payload.stale, false);
  assert.equal(payload.error, null);
});

test('unsupported or failed scans degrade to an empty, typed payload', () => {
  assert.deepEqual(buildWindowPlatformsPayload({
    supported: false,
    stale: true,
    error: 'WINDOW_PLATFORM_SCAN_UNAVAILABLE',
    capturedAt: 5,
    overlayBounds: null,
  }), {
    supported: false,
    capturedAt: 5,
    stale: true,
    error: 'WINDOW_PLATFORM_SCAN_UNAVAILABLE',
    overlayBounds: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    platforms: [],
  });
});
