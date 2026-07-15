'use strict';

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
const { IPC } = require('./ipc-contract.cjs');
const { assertAlphaRendererCompatibility } = require('./petpack-compat.cjs');
const { AtomicJsonStore } = require('./state-store.cjs');

const APP_NAME = 'Baobao & Feifei Desktop Pets';
const PETPACK_SCHEME = 'petpack';
const MAX_REGIONS = 128;
const HIT_TEST_INTERVAL_MS = 60;
const PET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

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
let isQuitting = false;

const hitTestState = {
  mode: 'regions',
  regions: [],
  hovered: false,
  manualIgnore: true,
  manualForward: true,
  lastAppliedIgnore: null,
  lastAppliedForward: null,
};

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
  const defaultPetpacksDirectory = packaged
    ? path.join(process.resourcesPath, 'petpacks')
    : path.join(repositoryRoot, 'petpacks');
  const defaultPetpackLibrary = packaged
    ? path.join(process.resourcesPath, 'petpack-runtime', 'lib.mjs')
    : path.join(repositoryRoot, 'tools', 'petpack', 'lib.mjs');

  const rendererDirectory = firstValue(
    readArg('--renderer-dir'),
    process.env.PET_DESKTOP_RENDERER_DIR,
    defaultRendererDirectory,
  );
  const petpacksDirectory = firstValue(
    readArg('--petpacks-dir'),
    process.env.PET_DESKTOP_PETPACKS_DIR,
    defaultPetpacksDirectory,
  );

  return {
    packaged,
    rendererUrl: firstValue(
      readArg('--renderer-url'),
      process.env.PET_DESKTOP_RENDERER_URL,
      process.env.PET_DESKTOP_DEV_URL,
    ),
    rendererDirectory: path.resolve(rendererDirectory),
    overlayUrl: firstValue(
      readArg('--overlay-url'),
      process.env.PET_DESKTOP_OVERLAY_URL,
    ),
    controlUrl: firstValue(
      readArg('--control-url'),
      process.env.PET_DESKTOP_CONTROL_URL,
    ),
    petpacksDirectory: path.resolve(petpacksDirectory),
    userPetpacksDirectory: path.join(app.getPath('userData'), 'petpacks'),
    petpackLibrary: path.resolve(
      firstValue(
        readArg('--petpack-library'),
        process.env.PET_DESKTOP_PETPACK_LIBRARY,
        defaultPetpackLibrary,
      ),
    ),
    trayIcon: firstValue(
      readArg('--tray-icon'),
      process.env.PET_DESKTOP_TRAY_ICON,
    ),
    rootKind:
      readArg('--petpacks-dir') || process.env.PET_DESKTOP_PETPACKS_DIR
        ? 'override'
        : packaged
          ? 'packaged'
          : 'development',
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
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = getTargetDisplay();
  overlayWindow.setBounds(display.workArea, false);
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

  window.setAlwaysOnTop(true, 'screen-saver', 1);
  window.setSkipTaskbar(true);
  window.setFocusable(false);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  setOverlayVisible(true);
}

function broadcast(channel, payload) {
  for (const window of [overlayWindow, controlWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function shellStatePayload() {
  const { visible, quiet, displayId } = store.getShellState();
  return { visible, quiet, displayId };
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

function setQuietMode(quiet) {
  store.patchShellState({ quiet: Boolean(quiet) });
  return notifyShellState();
}

function trayIconImage() {
  if (runtimeConfig.trayIcon) {
    const candidate = nativeImage.createFromPath(path.resolve(runtimeConfig.trayIcon));
    if (!candidate.isEmpty()) return candidate;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <path fill="#D89C57" d="M5 13 7 3l7 6h4l7-6 2 10v8c0 5-5 9-11 9S5 26 5 21z"/>
    <path fill="#FFF5E8" d="M9 16c2-3 12-3 14 0v7c-2 3-12 3-14 0z"/>
    <circle cx="12" cy="17" r="2" fill="#27343B"/><circle cx="20" cy="17" r="2" fill="#27343B"/>
    <path d="m14 21 2 1 2-1" fill="none" stroke="#A45D5D" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );

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
      label: '显示互动条',
      click: openControlPanel,
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
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
      url.hostname === 'builtin' || url.hostname === 'local'
        ? runtimeConfig.petpacksDirectory
        : url.hostname === 'user'
          ? runtimeConfig.userPetpacksDirectory
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
        'cache-control': runtimeConfig.packaged && url.hostname !== 'user'
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    return new Response(status === 404 ? 'Not found' : 'Unable to load petpack', {
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

function readCatalogRoot(root, installation) {
  let entries = [];

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const pets = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes('.import-')) continue;
    const loaded = readManifest(path.join(root, entry.name));
    if (!loaded) continue;

    const id = String(loaded.manifest.id || entry.name);
    pets.push({
      id,
      name: String(loaded.manifest.name || loaded.manifest.displayName || id),
      manifest: loaded.manifest,
      manifestFile: loaded.fileName,
      installation,
      removable: installation === 'user',
      assetBaseUrl: `${PETPACK_SCHEME}://${installation}/${encodeURIComponent(entry.name)}/`,
    });
  }

  return pets;
}

function loadPetCatalog() {
  const builtinPets = readCatalogRoot(runtimeConfig.petpacksDirectory, 'builtin');
  const userPets = readCatalogRoot(runtimeConfig.userPetpacksDirectory, 'user');
  const seenIds = new Set();
  const pets = [];

  // Built-ins are trusted application resources and cannot be shadowed by a
  // manually copied user directory with the same manifest id.
  for (const pet of [...builtinPets, ...userPets]) {
    const key = pet.id.toLowerCase();
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    pets.push(pet);
  }

  pets.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  return {
    schemaVersion: 1,
    rootKind: runtimeConfig.rootKind,
    roots: {
      builtin: runtimeConfig.rootKind,
      user: 'userData',
    },
    pets,
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
    runtimeConfig.petpacksDirectory,
    runtimeConfig.userPetpacksDirectory,
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

function loadPetpackLibrary() {
  if (!fs.existsSync(runtimeConfig.petpackLibrary)) {
    throw new Error(`PETPACK_RUNTIME_MISSING: ${runtimeConfig.petpackLibrary}`);
  }
  if (!petpackLibraryPromise) {
    petpackLibraryPromise = import(pathToFileURL(runtimeConfig.petpackLibrary).href);
  }
  return petpackLibraryPromise;
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
    if (
      readCatalogRoot(runtimeConfig.petpacksDirectory, 'builtin').some(
        (pet) => pet.id.toLowerCase() === petId.toLowerCase(),
      )
    ) {
      throw Object.assign(new Error(`Built-in pet ${petId} already exists`), {
        code: 'BUILTIN_ID_CONFLICT',
      });
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

  applyMousePolicy(!(insideReportedRegion || hitTestState.hovered), true);
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
  ipcMain.handle(IPC.GET_SHELL_STATE, (event) => {
    assertTrustedSender(event);
    return shellStatePayload();
  });
  ipcMain.handle(IPC.SET_SHELL_STATE, (event, patch) => {
    assertTrustedSender(event);
    const input = patch && typeof patch === 'object' ? patch : {};
    if (typeof input.quiet === 'boolean') setQuietMode(input.quiet);
    if (typeof input.visible === 'boolean') return setOverlayVisible(input.visible);
    return shellStatePayload();
  });
}

async function bootstrap() {
  app.setName(APP_NAME);
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.baobao-feifei.desktop-pets');
  }

  runtimeConfig = buildRuntimeConfig();
  store = new AtomicJsonStore(path.join(app.getPath('userData'), 'desktop-state.json'));
  fs.mkdirSync(runtimeConfig.userPetpacksDirectory, { recursive: true });

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

app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(hitTestTimer);
  clearTimeout(catalogChangeTimer);
  for (const watcher of catalogWatchers) watcher.close();
  tray?.destroy();
});
