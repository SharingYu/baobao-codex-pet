'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  Tray,
} = require('electron');
const {
  IPC,
  buildWindowPlatformsPayload,
  createBoundedLineDecoder,
  createScreenToDipRectMapper,
  exponentialBackoffDelay,
  normalizeWindowPlatformRecords,
} = require('./ipc-contract.cjs');
const { assertAlphaRendererCompatibility } = require('./petpack-compat.cjs');
const { AtomicJsonStore } = require('./state-store.cjs');

const APP_NAME = 'Pet Desktop Companion';
const PETPACK_SCHEME = 'petpack';
const MAX_REGIONS = 128;
const HIT_TEST_INTERVAL_MS = 60;
const HOVER_GRACE_MS = 240;
const CONTROL_DOCK_HALF_WIDTH = 232;
const CONTROL_DOCK_HEIGHT = 86;
const PET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WINDOW_PLATFORM_WATCH_INTERVAL_MS = 120;
const WINDOW_PLATFORM_STARTUP_TIMEOUT_MS = 4_000;
const WINDOW_PLATFORM_STALL_TIMEOUT_MS = 1_500;
const WINDOW_PLATFORM_HEALTH_INTERVAL_MS = 250;
const WINDOW_PLATFORM_STALE_MS = 1_000;
const WINDOW_PLATFORM_EXPIRE_MS = 5_000;
const WINDOW_PLATFORM_RESTART_BASE_MS = 250;
const WINDOW_PLATFORM_RESTART_MAX_MS = 8_000;
const WINDOW_PLATFORM_MAX_LINE_BYTES = 256 * 1024;
const MAX_WINDOW_PLATFORMS = 256;
const QUIT_FLUSH_TIMEOUT_MS = 2_000;
const OVERLAY_UNRESPONSIVE_RECOVERY_MS = 6_000;
const OVERLAY_RECOVERY_COOLDOWN_MS = 4_000;

protocol.registerSchemesAsPrivileged([
  {
    scheme: PETPACK_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let overlayWindow = null;
let controlWindow = null;
let tray = null;
let store = null;
let runtimeConfig = null;
const catalogWatchers = [];
let catalogChangeTimer = null;
let hitTestTimer = null;
let overlayRecoveryTimer = null;
let overlayUnresponsiveTimer = null;
let lastOverlayRecoveryAt = 0;
let isQuitting = false;
let quitRequestPending = false;
let quitRequestTimer = null;
let windowPlatformCache = null;
const windowPlatformWatcher = {
  child: null,
  generation: 0,
  startedAt: 0,
  lastSnapshotAt: 0,
  snapshotCount: 0,
  restartAttempt: 0,
  restartTimer: null,
  healthTimer: null,
  // Opt in only after the renderer restores the user's saved preference.
  // This keeps startup at zero native scans when the feature is disabled.
  stopped: true,
  error: null,
};

const hitTestState = {
  mode: 'regions',
  regions: [],
  hovered: false,
  hoverGraceUntil: 0,
  manualIgnore: true,
  manualForward: true,
  lastAppliedIgnore: null,
  lastAppliedForward: null,
};

function appendDiagnostic(event, details = {}) {
  const record = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  console.warn(`[desktop-pet] ${record}`);
  if (!app.isReady()) return;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'diagnostics.log'), `${record}\n`, 'utf8');
  } catch (error) {
    console.warn('[desktop-pet] Unable to write diagnostics log:', error.message);
  }
}

function recoverOverlay(reason = 'unknown', { immediate = false } = {}) {
  if (isQuitting) return false;
  clearTimeout(overlayRecoveryTimer);
  overlayRecoveryTimer = null;
  const elapsed = Date.now() - lastOverlayRecoveryAt;
  if (!immediate && elapsed < OVERLAY_RECOVERY_COOLDOWN_MS) return false;
  lastOverlayRecoveryAt = Date.now();
  appendDiagnostic('overlay-recovery', { reason });

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = createOverlayWindow();
    return true;
  }
  if (!overlayWindow.webContents.isDestroyed()) {
    overlayWindow.webContents.reloadIgnoringCache();
    return true;
  }
  overlayWindow.destroy();
  overlayWindow = createOverlayWindow();
  return true;
}

function scheduleOverlayRecovery(reason, delay = 900) {
  if (isQuitting || overlayRecoveryTimer) return;
  appendDiagnostic('overlay-recovery-scheduled', { reason, delay });
  overlayRecoveryTimer = setTimeout(() => {
    overlayRecoveryTimer = null;
    recoverOverlay(reason);
  }, delay);
  overlayRecoveryTimer.unref?.();
}

function attachOverlayHealthHandlers(window) {
  window.on('unresponsive', () => {
    appendDiagnostic('overlay-unresponsive');
    clearTimeout(overlayUnresponsiveTimer);
    overlayUnresponsiveTimer = setTimeout(() => {
      overlayUnresponsiveTimer = null;
      recoverOverlay('renderer-unresponsive');
    }, OVERLAY_UNRESPONSIVE_RECOVERY_MS);
    overlayUnresponsiveTimer.unref?.();
  });
  window.on('responsive', () => {
    clearTimeout(overlayUnresponsiveTimer);
    overlayUnresponsiveTimer = null;
    appendDiagnostic('overlay-responsive');
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    appendDiagnostic('overlay-render-process-gone', details);
    scheduleOverlayRecovery(`renderer-${details.reason}`, 650);
  });
}

function readArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '');
}

function buildRuntimeConfig() {
  const packaged = app.isPackaged;
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  const defaultRendererDirectory = packaged
    ? path.join(app.getAppPath(), 'apps', 'desktop', 'dist')
    : path.join(repositoryRoot, 'apps', 'desktop', 'dist');
  const defaultPetpackLibrary = packaged
    ? path.join(process.resourcesPath, 'petpack-runtime', 'lib.mjs')
    : path.join(repositoryRoot, 'tools', 'petpack', 'lib.mjs');
  const defaultItempackLibrary = packaged
    ? path.join(process.resourcesPath, 'itempack-runtime', 'lib.mjs')
    : path.join(repositoryRoot, 'tools', 'itempack', 'lib.mjs');
  const defaultWindowPlatformsScript = packaged
    ? path.join(process.resourcesPath, 'windows-platforms.ps1')
    : path.join(__dirname, 'windows-platforms.ps1');

  // Packaged builds never accept renderer or runtime-library overrides. Those
  // switches are useful for local development, but honoring them in a shipped
  // executable would let an untrusted page inherit the preload API or let an
  // arbitrary local module execute in the main process.
  const rendererDirectory = packaged
    ? defaultRendererDirectory
    : firstValue(
      readArg('--renderer-dir'),
      process.env.PET_DESKTOP_RENDERER_DIR,
      defaultRendererDirectory,
    );
  return {
    packaged,
    rendererUrl: packaged
      ? undefined
      : firstValue(
        readArg('--renderer-url'),
        process.env.PET_DESKTOP_RENDERER_URL,
        process.env.PET_DESKTOP_DEV_URL,
      ),
    rendererDirectory: path.resolve(rendererDirectory),
    overlayUrl: packaged
      ? undefined
      : firstValue(
        readArg('--overlay-url'),
        process.env.PET_DESKTOP_OVERLAY_URL,
      ),
    controlUrl: packaged
      ? undefined
      : firstValue(
        readArg('--control-url'),
        process.env.PET_DESKTOP_CONTROL_URL,
      ),
    userPetpacksDirectory: path.join(app.getPath('userData'), 'petpacks'),
    userItempacksDirectory: path.join(app.getPath('userData'), 'itempacks'),
    petpackLibrary: path.resolve(packaged
      ? defaultPetpackLibrary
      : firstValue(
        readArg('--petpack-library'),
        process.env.PET_DESKTOP_PETPACK_LIBRARY,
        defaultPetpackLibrary,
      )),
    itempackLibrary: path.resolve(packaged
      ? defaultItempackLibrary
      : firstValue(
        readArg('--itempack-library'),
        process.env.PET_DESKTOP_ITEMPACK_LIBRARY,
        defaultItempackLibrary,
      )),
    windowPlatformsScript: path.resolve(defaultWindowPlatformsScript),
    trayIcon: firstValue(
      readArg('--tray-icon'),
      process.env.PET_DESKTOP_TRAY_ICON,
    ),
  };
}

function withViewQuery(urlString, view) {
  const target = new URL(urlString);
  target.searchParams.set('petView', view);
  return target.toString();
}

function fallbackDocument(view, message) {
  const safeMessage = String(message)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const overlayStyles =
    view === 'overlay'
      ? 'background:transparent;color:#5a4635;align-items:flex-end;justify-content:flex-end;pointer-events:none'
      : 'background:#f8f4ed;color:#30271f;align-items:center;justify-content:center';

  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>${APP_NAME}</title></head>
  <body style="margin:0;display:flex;min-height:100vh;font:14px/1.5 system-ui;${overlayStyles}">
    <div style="margin:18px;padding:12px 16px;border-radius:14px;background:rgba(255,255,255,.9);box-shadow:0 8px 30px rgba(0,0,0,.12);max-width:540px">
      <strong>桌面宠物界面尚未就绪</strong><br>${safeMessage}
    </div>
  </body>
</html>`;
}

async function loadView(window, view) {
  const explicitUrl = view === 'overlay' ? runtimeConfig.overlayUrl : runtimeConfig.controlUrl;

  try {
    if (explicitUrl) {
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(explicitUrl)) {
        await window.loadURL(withViewQuery(explicitUrl, view));
      } else {
        await window.loadFile(path.resolve(explicitUrl), { query: { petView: view } });
      }
      return;
    }

    if (runtimeConfig.rendererUrl) {
      await window.loadURL(withViewQuery(runtimeConfig.rendererUrl, view));
      return;
    }

    const candidates = [
      path.join(runtimeConfig.rendererDirectory, `${view}.html`),
      path.join(runtimeConfig.rendererDirectory, 'index.html'),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));

    if (!file) {
      throw new Error(`Renderer not found in ${runtimeConfig.rendererDirectory}`);
    }

    await window.loadFile(file, { query: { petView: view } });
  } catch (error) {
    const html = fallbackDocument(view, error.message);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}

function navigationIsAllowed(targetUrl, view) {
  try {
    const target = new URL(targetUrl);
    if (target.protocol === 'file:') {
      const targetPath = fileURLToPath(target);
      const explicitView = view === 'overlay' ? runtimeConfig.overlayUrl : runtimeConfig.controlUrl;
      if (explicitView && !/^[a-z][a-z\d+.-]*:\/\//i.test(explicitView)) {
        return path.resolve(targetPath) === path.resolve(explicitView);
      }
      return isInside(runtimeConfig.rendererDirectory, path.resolve(targetPath));
    }

    if (target.protocol === 'data:' || target.protocol === 'about:') return false;

    const viewUrl = view === 'overlay' ? runtimeConfig.overlayUrl : runtimeConfig.controlUrl;
    const configuredUrl = viewUrl || runtimeConfig.rendererUrl;
    if (!configuredUrl || !/^[a-z][a-z\d+.-]*:\/\//i.test(configuredUrl)) return false;

    return target.origin === new URL(configuredUrl).origin;
  } catch {
    return false;
  }
}

function guardRendererNavigation(window, view) {
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!navigationIsAllowed(targetUrl, view)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function getTargetDisplay() {
  const shellState = store.getShellState();
  const displays = screen.getAllDisplays();
  const configured = displays.find(
    (display) => String(display.id) === String(shellState.displayId),
  );
  return configured || screen.getPrimaryDisplay();
}

function applyOverlayBounds() {
  windowPlatformCache = null;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = getTargetDisplay();
  overlayWindow.setBounds(display.workArea, false);
}

function currentOverlayBounds() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow.getBounds();
  return getTargetDisplay().workArea;
}

function cachedWindowPlatformPayload({ stale = false, error = null, dropPlatforms = false } = {}) {
  return buildWindowPlatformsPayload({
    platforms: dropPlatforms ? [] : windowPlatformCache?.platforms ?? [],
    overlayBounds: currentOverlayBounds(),
    supported: process.platform === 'win32',
    capturedAt: windowPlatformCache?.capturedAt ?? Date.now(),
    stale,
    error,
  });
}

function powershellExecutablePath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function currentScreenToDipMapper() {
  return createScreenToDipRectMapper(screen, () => (
    overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null
  ));
}

function windowPlatformWatcherIsCurrent(child, generation) {
  return windowPlatformWatcher.child === child
    && windowPlatformWatcher.generation === generation;
}

function scheduleWindowPlatformWatcherRestart() {
  if (
    process.platform !== 'win32'
    || isQuitting
    || windowPlatformWatcher.stopped
    || windowPlatformWatcher.restartTimer
  ) return;

  const delay = exponentialBackoffDelay(
    windowPlatformWatcher.restartAttempt,
    WINDOW_PLATFORM_RESTART_BASE_MS,
    WINDOW_PLATFORM_RESTART_MAX_MS,
  );
  windowPlatformWatcher.restartAttempt += 1;
  windowPlatformWatcher.restartTimer = setTimeout(() => {
    windowPlatformWatcher.restartTimer = null;
    startWindowPlatformWatcher();
  }, delay);
  windowPlatformWatcher.restartTimer.unref?.();
}

function terminateWindowPlatformWatcher(errorCode, { restart = true } = {}) {
  const child = windowPlatformWatcher.child;
  windowPlatformWatcher.child = null;
  windowPlatformWatcher.generation += 1;
  windowPlatformWatcher.startedAt = 0;
  windowPlatformWatcher.lastSnapshotAt = 0;
  windowPlatformWatcher.snapshotCount = 0;
  if (errorCode) windowPlatformWatcher.error = errorCode;

  if (child) {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // The OS already reclaimed the watcher.
      }
    }
    child.unref?.();
  }

  if (restart) scheduleWindowPlatformWatcherRestart();
}

function acceptWindowPlatformLine(line, child, generation) {
  if (!windowPlatformWatcherIsCurrent(child, generation)) return;

  let records;
  try {
    const source = line.toString('utf8').replace(/^\uFEFF/, '').trim();
    const parsed = source ? JSON.parse(source) : [];
    if (!Array.isArray(parsed)) throw new TypeError('Expected a JSON array');
    records = parsed;
  } catch {
    terminateWindowPlatformWatcher('WINDOW_PLATFORM_WATCHER_INVALID_JSON');
    return;
  }

  const capturedAt = Date.now();
  windowPlatformCache = {
    capturedAt,
    platforms: normalizeWindowPlatformRecords(records, currentScreenToDipMapper())
      .slice(0, MAX_WINDOW_PLATFORMS),
  };
  windowPlatformWatcher.lastSnapshotAt = capturedAt;
  windowPlatformWatcher.snapshotCount += 1;
  // A helper that emits one frame and immediately crashes must still back off.
  // Reset only after roughly 2.4 seconds of continuous healthy snapshots.
  if (windowPlatformWatcher.snapshotCount >= 20) {
    windowPlatformWatcher.restartAttempt = 0;
  }
  windowPlatformWatcher.error = null;
}

function ensureWindowPlatformHealthLoop() {
  if (windowPlatformWatcher.healthTimer) return;
  windowPlatformWatcher.healthTimer = setInterval(() => {
    if (windowPlatformWatcher.stopped || isQuitting) return;
    const child = windowPlatformWatcher.child;
    if (!child) {
      if (!windowPlatformWatcher.restartTimer) startWindowPlatformWatcher();
      return;
    }

    const now = Date.now();
    if (
      windowPlatformWatcher.lastSnapshotAt === 0
      && now - windowPlatformWatcher.startedAt > WINDOW_PLATFORM_STARTUP_TIMEOUT_MS
    ) {
      terminateWindowPlatformWatcher('WINDOW_PLATFORM_WATCHER_START_TIMEOUT');
      return;
    }
    if (
      windowPlatformWatcher.lastSnapshotAt > 0
      && now - windowPlatformWatcher.lastSnapshotAt > WINDOW_PLATFORM_STALL_TIMEOUT_MS
    ) {
      terminateWindowPlatformWatcher('WINDOW_PLATFORM_WATCHER_STALLED');
    }
  }, WINDOW_PLATFORM_HEALTH_INTERVAL_MS);
  windowPlatformWatcher.healthTimer.unref?.();
}

function startWindowPlatformWatcher() {
  if (
    process.platform !== 'win32'
    || isQuitting
    || windowPlatformWatcher.stopped
    || windowPlatformWatcher.child
    || windowPlatformWatcher.restartTimer
  ) return;

  ensureWindowPlatformHealthLoop();
  if (!fs.existsSync(runtimeConfig.windowPlatformsScript)) {
    windowPlatformWatcher.error = 'WINDOW_PLATFORM_WATCHER_MISSING';
    scheduleWindowPlatformWatcherRestart();
    return;
  }

  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runtimeConfig.windowPlatformsScript,
    '-OwnProcessId',
    String(process.pid),
    '-IntervalMilliseconds',
    String(WINDOW_PLATFORM_WATCH_INTERVAL_MS),
    '-MaximumPlatforms',
    String(MAX_WINDOW_PLATFORMS),
  ];

  let child;
  try {
    child = spawn(powershellExecutablePath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    windowPlatformWatcher.error = 'WINDOW_PLATFORM_WATCHER_SPAWN_FAILED';
    scheduleWindowPlatformWatcherRestart();
    return;
  }

  const generation = windowPlatformWatcher.generation + 1;
  windowPlatformWatcher.generation = generation;
  windowPlatformWatcher.child = child;
  windowPlatformWatcher.startedAt = Date.now();
  windowPlatformWatcher.lastSnapshotAt = 0;
  windowPlatformWatcher.snapshotCount = 0;

  const decoder = createBoundedLineDecoder({
    maxBytes: WINDOW_PLATFORM_MAX_LINE_BYTES,
    onLine: (line) => acceptWindowPlatformLine(line, child, generation),
    onViolation: (code) => {
      if (windowPlatformWatcherIsCurrent(child, generation)) {
        terminateWindowPlatformWatcher(code);
      }
    },
  });

  child.stdout.on('data', (chunk) => decoder.push(chunk));
  child.stdout.on('end', () => decoder.end());
  // Drain stderr so a faulty helper cannot deadlock. Its contents are never
  // logged or sent to the renderer because they could contain environment data.
  child.stderr.on('data', () => {});
  child.once('error', () => {
    if (windowPlatformWatcherIsCurrent(child, generation)) {
      terminateWindowPlatformWatcher('WINDOW_PLATFORM_WATCHER_SPAWN_FAILED');
    }
  });
  child.once('exit', (code) => {
    if (!windowPlatformWatcherIsCurrent(child, generation)) return;
    windowPlatformWatcher.child = null;
    windowPlatformWatcher.startedAt = 0;
    windowPlatformWatcher.lastSnapshotAt = 0;
    windowPlatformWatcher.snapshotCount = 0;
    windowPlatformWatcher.error = code === 0
      ? 'WINDOW_PLATFORM_WATCHER_EXITED'
      : 'WINDOW_PLATFORM_WATCHER_FAILED';
    scheduleWindowPlatformWatcherRestart();
  });
}

function stopWindowPlatformWatcher() {
  windowPlatformWatcher.stopped = true;
  clearTimeout(windowPlatformWatcher.restartTimer);
  clearInterval(windowPlatformWatcher.healthTimer);
  windowPlatformWatcher.restartTimer = null;
  windowPlatformWatcher.healthTimer = null;
  windowPlatformWatcher.restartAttempt = 0;
  terminateWindowPlatformWatcher(null, { restart: false });
  windowPlatformCache = null;
  windowPlatformWatcher.error = null;
}

function setWindowPlatformWatcherEnabled(enabled) {
  const nextEnabled = Boolean(enabled) && process.platform === 'win32' && !isQuitting;
  if (!nextEnabled) {
    stopWindowPlatformWatcher();
    return false;
  }

  windowPlatformWatcher.stopped = false;
  windowPlatformWatcher.error = null;
  startWindowPlatformWatcher();
  return true;
}

function getWindowPlatforms() {
  if (process.platform !== 'win32') {
    return buildWindowPlatformsPayload({
      supported: false,
      platforms: [],
      overlayBounds: currentOverlayBounds(),
    });
  }

  if (windowPlatformWatcher.stopped) {
    return cachedWindowPlatformPayload({ dropPlatforms: true });
  }

  startWindowPlatformWatcher();
  const cacheAge = windowPlatformCache
    ? Date.now() - windowPlatformCache.capturedAt
    : Number.POSITIVE_INFINITY;
  const stale = cacheAge > WINDOW_PLATFORM_STALE_MS;
  const expired = cacheAge > WINDOW_PLATFORM_EXPIRE_MS;
  return cachedWindowPlatformPayload({
    stale,
    error: windowPlatformWatcher.error,
    dropPlatforms: expired,
  });
}

function createOverlayWindow() {
  const display = getTargetDisplay();
  const window = new BrowserWindow({
    ...display.workArea,
    title: APP_NAME,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: !runtimeConfig.packaged,
    },
  });

  // A normal floating overlay stays above application windows without using
  // the extreme screen-saver z-level, which can fight fullscreen video and
  // hardware-overlay paths on Windows.
  window.setAlwaysOnTop(true, 'floating');
  window.setSkipTaskbar(true);
  window.setFocusable(false);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Explicitly keep the pet eligible for Windows screen capture. Electron maps
  // the enabled state to WDA_EXCLUDEFROMCAPTURE on supported Windows versions.
  if (process.platform === 'win32') window.setContentProtection(false);
  window.setIgnoreMouseEvents(true, { forward: true });
  hitTestState.lastAppliedIgnore = true;
  hitTestState.lastAppliedForward = true;

  window.on('focus', () => window.blur());
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      setOverlayVisible(false);
    }
  });
  attachOverlayHealthHandlers(window);
  guardRendererNavigation(window, 'overlay');

  void loadView(window, 'overlay').then(() => {
    if (store.getShellState().visible && !window.isDestroyed()) {
      window.showInactive();
    }
  });

  return window;
}

function createControlWindow() {
  const window = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 540,
    title: `${APP_NAME} - 控制台`,
    show: false,
    backgroundColor: '#f8f4ed',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !runtimeConfig.packaged,
    },
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  guardRendererNavigation(window, 'control');
  void loadView(window, 'control');
  return window;
}

function openControlPanel() {
  // Alpha keeps a single renderer instance so a second preview window cannot
  // race the overlay and overwrite pet positions with a different viewport.
  // The overlay already owns the complete interaction bar and import dialog.
  setInteractionBarVisible(true);
}

function broadcast(channel, payload) {
  for (const window of [overlayWindow, controlWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function shellStatePayload() {
  const { visible, interactionBarVisible, quiet, displayId } = store.getShellState();
  return { visible, interactionBarVisible, quiet, displayId };
}

function notifyShellState() {
  const state = shellStatePayload();
  broadcast(IPC.SHELL_STATE_CHANGED, state);
  rebuildTrayMenu();
  return state;
}

function setOverlayVisible(visible) {
  const next = Boolean(visible);
  store.patchShellState({ visible: next });

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (next) {
      applyOverlayBounds();
      overlayWindow.showInactive();
      overlayWindow.setFocusable(false);
    } else {
      overlayWindow.hide();
    }
  }

  return notifyShellState();
}

function setInteractionBarVisible(visible) {
  const next = Boolean(visible);
  const current = store.getShellState();
  store.patchShellState({
    interactionBarVisible: next,
    visible: next ? true : current.visible,
  });

  if (next && overlayWindow && !overlayWindow.isDestroyed()) {
    applyOverlayBounds();
    overlayWindow.showInactive();
    overlayWindow.setFocusable(false);
  }

  return notifyShellState();
}

function setQuietMode(quiet) {
  store.patchShellState({ quiet: Boolean(quiet) });
  return notifyShellState();
}

function finishAppQuit() {
  if (isQuitting) return;
  clearTimeout(quitRequestTimer);
  quitRequestTimer = null;
  quitRequestPending = false;
  isQuitting = true;
  app.quit();
}

function requestAppQuit(reason = 'tray') {
  if (isQuitting || quitRequestPending) return;
  const renderer = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.webContents
    : null;
  if (!renderer || renderer.isDestroyed()) {
    finishAppQuit();
    return;
  }

  quitRequestPending = true;
  try {
    renderer.send(IPC.QUIT_REQUESTED, { reason });
  } catch {
    finishAppQuit();
    return;
  }
  quitRequestTimer = setTimeout(() => {
    finishAppQuit();
  }, QUIT_FLUSH_TIMEOUT_MS);
  quitRequestTimer.unref?.();
}

function trayIconImage() {
  if (runtimeConfig.trayIcon) {
    const candidate = nativeImage.createFromPath(path.resolve(runtimeConfig.trayIcon));
    if (!candidate.isEmpty()) return candidate;
  }

  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
  const image = nativeImage.createFromPath(iconPath);

  if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });

  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed() || !store) return;
  const state = store.getShellState();
  const menu = Menu.buildFromTemplate([
    {
      label: state.visible ? '隐藏宠物' : '显示宠物',
      click: () => setOverlayVisible(!state.visible),
    },
    {
      label: '安静模式',
      type: 'checkbox',
      checked: state.quiet,
      click: (item) => setQuietMode(item.checked),
    },
    { type: 'separator' },
    {
      label: state.interactionBarVisible ? '隐藏互动条' : '显示互动条',
      click: () => setInteractionBarVisible(!state.interactionBarVisible),
    },
    {
      label: '修复卡顿（重载宠物）',
      click: () => recoverOverlay('tray-manual', { immediate: true }),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => requestAppQuit('tray'),
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const instance = new Tray(trayIconImage());
  instance.setToolTip(APP_NAME);
  instance.on('click', () => {
    const state = store.getShellState();
    setOverlayVisible(!state.visible);
  });
  instance.on('double-click', openControlPanel);
  tray = instance;
  rebuildTrayMenu();
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml; charset=utf-8',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
    }[extension] || 'application/octet-stream'
  );
}

async function handlePetpackRequest(request) {
  try {
    const url = new URL(request.url);
    const rootDirectory =
      url.hostname === 'pets'
        ? runtimeConfig.userPetpacksDirectory
        : url.hostname === 'items'
          ? runtimeConfig.userItempacksDirectory
          : null;
    if (!rootDirectory) {
      return new Response('Not found', { status: 404 });
    }

    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (
      segments.length < 2 ||
      segments.some(
        (segment) => segment === '.' || segment === '..' || /[\\/]/.test(segment),
      )
    ) {
      return new Response('Invalid petpack path', { status: 400 });
    }

    const root = fs.realpathSync(rootDirectory);
    const requested = fs.realpathSync(path.resolve(root, ...segments));
    if (!isInside(root, requested) || !fs.statSync(requested).isFile()) {
      return new Response('Forbidden', { status: 403 });
    }

    const body = await fs.promises.readFile(requested);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': mimeTypeFor(requested),
        'cache-control': 'no-cache',
      },
    });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    return new Response(status === 404 ? 'Not found' : 'Unable to load package asset', {
      status,
    });
  }
}

function readManifest(directory) {
  for (const fileName of ['manifest.json', 'pet.json', 'pack.json']) {
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) continue;

    try {
      const source = fs.readFileSync(filePath, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > 512 * 1024) continue;
      const manifest = JSON.parse(source);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
      return { manifest, fileName };
    } catch {
      // A malformed pack is omitted while the remaining catalog stays usable.
    }
  }

  return null;
}

function readCatalogRoot(root, collection, expectedFormat) {
  let entries = [];

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes('.import-')) continue;
    const loaded = readManifest(path.join(root, entry.name));
    if (!loaded) continue;
    if (loaded.manifest.format !== expectedFormat) continue;

    const id = String(loaded.manifest.id || entry.name);
    packs.push({
      id,
      name: String(loaded.manifest.name || loaded.manifest.displayName || id),
      manifest: loaded.manifest,
      manifestFile: loaded.fileName,
      installation: 'user',
      removable: true,
      assetBaseUrl: `${PETPACK_SCHEME}://${collection}/${encodeURIComponent(entry.name)}/`,
    });
  }

  return packs;
}

function loadPetCatalog() {
  const pets = readCatalogRoot(
    runtimeConfig.userPetpacksDirectory,
    'pets',
    'com.baofeifei.petpack',
  );
  const items = readCatalogRoot(
    runtimeConfig.userItempacksDirectory,
    'items',
    'com.petdesktop.itempack',
  );
  pets.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  items.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  return {
    schemaVersion: 2,
    runtimeMode: 'empty-shell',
    roots: {
      pets: 'userData/petpacks',
      items: 'userData/itempacks',
    },
    pets,
    items,
  };
}

function notifyCatalogChanged() {
  const payload = {
    revision: Date.now(),
    catalog: loadPetCatalog(),
  };
  broadcast(IPC.PET_CATALOG_CHANGED, payload);
  return payload.catalog;
}

function startCatalogWatchers() {
  const onChange = () => {
    clearTimeout(catalogChangeTimer);
    catalogChangeTimer = setTimeout(notifyCatalogChanged, 250);
  };

  for (const directory of [
    runtimeConfig.userPetpacksDirectory,
    runtimeConfig.userItempacksDirectory,
  ]) {
    if (!fs.existsSync(directory)) continue;
    try {
      catalogWatchers.push(
        fs.watch(
          directory,
          { recursive: process.platform === 'win32' },
          onChange,
        ),
      );
    } catch {
      // A watcher is a convenience; import/remove also push catalog changes.
    }
  }
}

let petpackLibraryPromise = null;
let itempackLibraryPromise = null;

function loadPetpackLibrary() {
  if (!fs.existsSync(runtimeConfig.petpackLibrary)) {
    throw new Error(`PETPACK_RUNTIME_MISSING: ${runtimeConfig.petpackLibrary}`);
  }
  if (!petpackLibraryPromise) {
    petpackLibraryPromise = import(pathToFileURL(runtimeConfig.petpackLibrary).href);
  }
  return petpackLibraryPromise;
}

function loadItempackLibrary() {
  if (!fs.existsSync(runtimeConfig.itempackLibrary)) {
    throw new Error(`ITEMPACK_RUNTIME_MISSING: ${runtimeConfig.itempackLibrary}`);
  }
  if (!itempackLibraryPromise) {
    itempackLibraryPromise = import(pathToFileURL(runtimeConfig.itempackLibrary).href);
  }
  return itempackLibraryPromise;
}

function asIpcError(error, fallbackCode) {
  const code = typeof error?.code === 'string' ? error.code : fallbackCode;
  return new Error(`${code}: ${error?.message || 'Petpack operation failed'}`);
}

async function importPetpack(event) {
  assertTrustedSender(event);
  const owner =
    controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible()
      ? controlWindow
      : undefined;
  const options = {
    title: '导入桌面宠物',
    properties: ['openFile'],
    filters: [
      { name: '桌面宠物包', extensions: ['petpack'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
  const selection = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  try {
    const library = await loadPetpackLibrary();
    const source = selection.filePaths[0];
    const validation = await library.validateBundle(source);
    assertAlphaRendererCompatibility(validation.manifest);
    const petId = validation.manifest.id;
    if (!PET_ID_PATTERN.test(petId)) {
      throw Object.assign(new Error('Manifest id is invalid'), { code: 'INVALID_ID' });
    }
    fs.mkdirSync(runtimeConfig.userPetpacksDirectory, { recursive: true });
    const destination = path.join(runtimeConfig.userPetpacksDirectory, petId);
    await library.importBundle(source, destination);
    const catalog = notifyCatalogChanged();
    return {
      ok: true,
      cancelled: false,
      petId,
      manifest: validation.manifest,
      catalog,
    };
  } catch (error) {
    throw asIpcError(error, 'PETPACK_IMPORT_FAILED');
  }
}

async function importItempack(event) {
  assertTrustedSender(event);
  const owner =
    controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible()
      ? controlWindow
      : undefined;
  const options = {
    title: '导入互动道具包',
    properties: ['openFile'],
    filters: [
      { name: '桌宠道具包', extensions: ['itempack'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
  const selection = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  try {
    const library = await loadItempackLibrary();
    const source = selection.filePaths[0];
    const validation = await library.validateItempack(source);
    const itempackId = validation.manifest.id;
    if (!PET_ID_PATTERN.test(itempackId)) {
      throw Object.assign(new Error('Manifest id is invalid'), { code: 'INVALID_ID' });
    }
    fs.mkdirSync(runtimeConfig.userItempacksDirectory, { recursive: true });
    const destination = path.join(runtimeConfig.userItempacksDirectory, itempackId);
    await library.importItempack(source, destination);
    const catalog = notifyCatalogChanged();
    return {
      ok: true,
      cancelled: false,
      itempackId,
      manifest: validation.manifest,
      catalog,
    };
  } catch (error) {
    throw asIpcError(error, 'ITEMPACK_IMPORT_FAILED');
  }
}

async function removePetpack(event, inputId) {
  assertTrustedSender(event);
  const petId = typeof inputId === 'string' ? inputId : '';
  if (!PET_ID_PATTERN.test(petId)) {
    throw new Error('INVALID_ID: Pet id is invalid');
  }

  const root = path.resolve(runtimeConfig.userPetpacksDirectory);
  const target = path.resolve(root, petId);
  if (!isInside(root, target) || target === root) {
    throw new Error('UNSAFE_PATH: Refusing to remove an unsafe petpack path');
  }

  let info;
  try {
    info = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, removed: false, petId, catalog: loadPetCatalog() };
    }
    throw asIpcError(error, 'PETPACK_REMOVE_FAILED');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('UNSAFE_PATH: User petpack is not a regular directory');
  }

  const loaded = readManifest(target);
  if (!loaded || String(loaded.manifest.id).toLowerCase() !== petId.toLowerCase()) {
    throw new Error('INVALID_MANIFEST: User petpack manifest id does not match its directory');
  }

  try {
    await fs.promises.rm(target, { recursive: true, force: false, maxRetries: 2 });
    const catalog = notifyCatalogChanged();
    return { ok: true, removed: true, petId, catalog };
  } catch (error) {
    throw asIpcError(error, 'PETPACK_REMOVE_FAILED');
  }
}

async function removeItempack(event, inputId) {
  assertTrustedSender(event);
  const itempackId = typeof inputId === 'string' ? inputId : '';
  if (!PET_ID_PATTERN.test(itempackId)) {
    throw new Error('INVALID_ID: Item pack id is invalid');
  }
  const root = path.resolve(runtimeConfig.userItempacksDirectory);
  const target = path.resolve(root, itempackId);
  if (!isInside(root, target) || target === root) {
    throw new Error('UNSAFE_PATH: Refusing to remove an unsafe itempack path');
  }

  let info;
  try {
    info = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, removed: false, itempackId, catalog: loadPetCatalog() };
    }
    throw asIpcError(error, 'ITEMPACK_REMOVE_FAILED');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('UNSAFE_PATH: User itempack is not a regular directory');
  }
  const loaded = readManifest(target);
  if (
    !loaded ||
    loaded.manifest.format !== 'com.petdesktop.itempack' ||
    String(loaded.manifest.id).toLowerCase() !== itempackId.toLowerCase()
  ) {
    throw new Error('INVALID_MANIFEST: User itempack manifest id does not match its directory');
  }
  try {
    await fs.promises.rm(target, { recursive: true, force: false, maxRetries: 2 });
    const catalog = notifyCatalogChanged();
    return { ok: true, removed: true, itempackId, catalog };
  } catch (error) {
    throw asIpcError(error, 'ITEMPACK_REMOVE_FAILED');
  }
}

function sanitizeRegions(value) {
  if (!Array.isArray(value)) return [];

  return value.slice(0, MAX_REGIONS).flatMap((region) => {
    if (!region || typeof region !== 'object') return [];
    const x = Number(region.x);
    const y = Number(region.y);
    const width = Number(region.width);
    const height = Number(region.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return [];
    }
    return [{ x, y, width, height }];
  });
}

function applyMousePolicy(ignore, forward = true) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const nextIgnore = Boolean(ignore);
  const nextForward = Boolean(forward);
  if (
    hitTestState.lastAppliedIgnore === nextIgnore &&
    (!nextIgnore || hitTestState.lastAppliedForward === nextForward)
  ) {
    return;
  }

  if (nextIgnore) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: nextForward });
  } else {
    overlayWindow.setIgnoreMouseEvents(false);
  }
  hitTestState.lastAppliedIgnore = nextIgnore;
  hitTestState.lastAppliedForward = nextForward;
}

function refreshHitTest() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;

  if (hitTestState.mode === 'manual') {
    applyMousePolicy(hitTestState.manualIgnore, hitTestState.manualForward);
    return;
  }

  if (hitTestState.regions.length === 0) {
    applyMousePolicy(!hitTestState.hovered, true);
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const bounds = overlayWindow.getBounds();
  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  const insideReportedRegion = hitTestState.regions.some(
    (region) =>
      localX >= region.x &&
      localX <= region.x + region.width &&
      localY >= region.y &&
      localY <= region.y + region.height,
  );
  // The action dock has a stable native fallback so it remains clickable even
  // when Windows briefly reports a transparent Electron pixel as belonging to
  // the window underneath. The renderer still reports its exact bounds; this
  // small strip only covers the visible dock at the bottom center.
  const insideControlDock =
    localY >= bounds.height - CONTROL_DOCK_HEIGHT &&
    localX >= bounds.width / 2 - CONTROL_DOCK_HALF_WIDTH &&
    localX <= bounds.width / 2 + CONTROL_DOCK_HALF_WIDTH;
  const insideHoverGrace = Date.now() < hitTestState.hoverGraceUntil;

  applyMousePolicy(
    !(insideReportedRegion || insideControlDock || hitTestState.hovered || insideHoverGrace),
    true,
  );
}

function startHitTestLoop() {
  hitTestTimer = setInterval(refreshHitTest, HIT_TEST_INTERVAL_MS);
  hitTestTimer.unref?.();
}

function isTrustedSender(event) {
  const candidates = [
    [overlayWindow, 'overlay'],
    [controlWindow, 'control'],
  ];
  for (const [window, view] of candidates) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) continue;
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false;
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    return navigationIsAllowed(senderUrl, view);
  }
  return false;
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) {
    throw new Error('Rejected IPC from an untrusted renderer');
  }
}

function assertOverlaySender(event) {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    event.sender !== overlayWindow.webContents ||
    !isTrustedSender(event)
  ) {
    throw new Error('This IPC method is only available to the overlay renderer');
  }
}

function registerIpc() {
  ipcMain.handle(IPC.LOAD_PET_CATALOG, (event) => {
    assertTrustedSender(event);
    return loadPetCatalog();
  });
  ipcMain.handle(IPC.IMPORT_PETPACK, importPetpack);
  ipcMain.handle(IPC.REMOVE_PETPACK, removePetpack);
  ipcMain.handle(IPC.IMPORT_ITEMPACK, importItempack);
  ipcMain.handle(IPC.REMOVE_ITEMPACK, removeItempack);
  ipcMain.handle(IPC.LOAD_STATE, (event) => {
    assertTrustedSender(event);
    return store.loadRendererState();
  });
  ipcMain.handle(IPC.SAVE_STATE, (event, state) => {
    assertTrustedSender(event);
    return store.saveRendererState(state);
  });
  ipcMain.handle(IPC.SET_INTERACTIVE_REGIONS, (event, regions) => {
    assertOverlaySender(event);
    hitTestState.regions = sanitizeRegions(regions);
    hitTestState.mode = 'regions';
    refreshHitTest();
    return hitTestState.regions;
  });
  ipcMain.handle(IPC.SET_POINTER_HOVER, (event, hovered) => {
    assertOverlaySender(event);
    hitTestState.hovered = Boolean(hovered);
    if (hitTestState.hovered) {
      hitTestState.hoverGraceUntil = Date.now() + HOVER_GRACE_MS;
    }
    hitTestState.mode = hitTestState.regions.length > 0 ? 'regions' : 'hover';
    refreshHitTest();
    return hitTestState.hovered;
  });
  ipcMain.handle(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore, options) => {
    assertOverlaySender(event);
    hitTestState.mode = 'manual';
    hitTestState.manualIgnore = Boolean(ignore);
    hitTestState.manualForward = options?.forward !== false;
    refreshHitTest();
    return {
      ignore: hitTestState.manualIgnore,
      forward: hitTestState.manualForward,
    };
  });
  ipcMain.handle(IPC.GET_WINDOW_PLATFORMS, (event) => {
    assertTrustedSender(event);
    return getWindowPlatforms();
  });
  ipcMain.handle(IPC.SET_WINDOW_PLATFORM_INTERACTIONS, (event, enabled) => {
    assertTrustedSender(event);
    return setWindowPlatformWatcherEnabled(enabled);
  });
  ipcMain.handle(IPC.GET_SHELL_STATE, (event) => {
    assertTrustedSender(event);
    return shellStatePayload();
  });
  ipcMain.handle(IPC.SET_SHELL_STATE, (event, patch) => {
    assertTrustedSender(event);
    const input = patch && typeof patch === 'object' ? patch : {};
    if (typeof input.quiet === 'boolean') setQuietMode(input.quiet);
    if (typeof input.interactionBarVisible === 'boolean') return setInteractionBarVisible(input.interactionBarVisible);
    if (typeof input.visible === 'boolean') return setOverlayVisible(input.visible);
    return shellStatePayload();
  });
  ipcMain.handle(IPC.QUIT_APP, (event) => {
    assertTrustedSender(event);
    finishAppQuit();
    return true;
  });
}

async function bootstrap() {
  app.setName(APP_NAME);
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.sharingyu.petdesktop');
  }

  runtimeConfig = buildRuntimeConfig();
  store = new AtomicJsonStore(path.join(app.getPath('userData'), 'desktop-state.json'));
  fs.mkdirSync(runtimeConfig.userPetpacksDirectory, { recursive: true });
  fs.mkdirSync(runtimeConfig.userItempacksDirectory, { recursive: true });

  await protocol.handle(PETPACK_SCHEME, handlePetpackRequest);
  registerIpc();

  overlayWindow = createOverlayWindow();
  createTray();
  startCatalogWatchers();
  startHitTestLoop();

  screen.on('display-metrics-changed', applyOverlayBounds);
  screen.on('display-removed', applyOverlayBounds);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) openControlPanel();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[desktop-pet] Failed to start:', error);
    app.quit();
  });
}

app.on('activate', () => {
  if (app.isReady() && store) openControlPanel();
});

app.on('window-all-closed', () => {
  // The tray owns the application lifetime on every platform.
});

app.on('child-process-gone', (_event, details) => {
  if (String(details?.type ?? '').toLowerCase() !== 'gpu') return;
  appendDiagnostic('gpu-process-gone', details);
  scheduleOverlayRecovery(`gpu-${details.reason ?? 'gone'}`, 1_200);
});

app.on('before-quit', () => {
  clearTimeout(quitRequestTimer);
  clearTimeout(overlayRecoveryTimer);
  clearTimeout(overlayUnresponsiveTimer);
  quitRequestTimer = null;
  overlayRecoveryTimer = null;
  overlayUnresponsiveTimer = null;
  isQuitting = true;
  stopWindowPlatformWatcher();
  clearInterval(hitTestTimer);
  clearTimeout(catalogChangeTimer);
  for (const watcher of catalogWatchers) watcher.close();
  tray?.destroy();
});
