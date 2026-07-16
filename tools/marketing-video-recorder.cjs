'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { createHash } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]);

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value == null) {
      throw new Error(`Invalid recorder argument near ${key ?? '<end>'}.`);
    }
    parsed.set(key, value);
  }
  for (const required of ['--html', '--result', '--out-dir']) {
    if (!parsed.has(required)) throw new Error(`Missing recorder argument ${required}.`);
  }
  for (const key of parsed.keys()) {
    if (!['--html', '--result', '--out-dir'].includes(key)) {
      throw new Error(`Unsupported recorder argument ${key}.`);
    }
  }
  return {
    htmlPath: path.resolve(parsed.get('--html')),
    resultPath: path.resolve(parsed.get('--result')),
    outDir: path.resolve(parsed.get('--out-dir')),
  };
}

function validNumber(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

async function atomicWrite(filePath, buffer) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, buffer, { flag: 'wx' });
  await fs.rename(temporaryPath, filePath);
}

async function writeResult(resultPath, value) {
  await atomicWrite(resultPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

let mainWindow = null;
let timeoutHandle = null;
let completed = false;

async function fail(message) {
  if (completed) return;
  completed = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  try {
    await writeResult(args.resultPath, { ok: false, error: message });
  } catch (error) {
    process.stderr.write(`Could not write recorder error result: ${error.message}\n`);
  }
  process.stderr.write(`${message}\n`);
  app.exit(1);
}

async function finishRecording(event, payload) {
  if (completed) throw new Error('Recorder has already completed.');
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Rejected recording from an unexpected renderer.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Recorder payload must be an object.');
  }
  if (typeof payload.error === 'string') {
    await fail(`Renderer failed: ${payload.error.slice(0, 1000)}`);
    return { ok: false };
  }
  if (!ALLOWED_MIME_TYPES.has(payload.mimeType)) {
    throw new Error(`Unsupported recording MIME type: ${payload.mimeType}.`);
  }
  if (typeof payload.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.dataBase64)) {
    throw new Error('Recording payload is not valid base64.');
  }
  if (payload.dataBase64.length > Math.ceil((MAX_VIDEO_BYTES * 4) / 3) + 4) {
    throw new Error('Recording payload exceeds the 80 MiB safety limit.');
  }
  if (
    !validNumber(payload.durationMs, 13000, 16000) ||
    payload.width !== 1080 ||
    payload.height !== 1920 ||
    payload.fps !== 30
  ) {
    throw new Error('Recording metadata does not match the fixed 1080x1920, 30 fps, 13–16 second contract.');
  }

  const videoBuffer = Buffer.from(payload.dataBase64, 'base64');
  if (!videoBuffer.length || videoBuffer.length > MAX_VIDEO_BYTES) {
    throw new Error('Decoded recording is empty or exceeds the 80 MiB safety limit.');
  }
  const extension = payload.mimeType.startsWith('video/mp4') ? '.mp4' : '.webm';
  const fileName = `internal-test-video${extension}`;
  const videoPath = path.join(args.outDir, fileName);
  const result = {
    ok: true,
    fileName,
    mimeType: payload.mimeType,
    bytes: videoBuffer.length,
    sha256: createHash('sha256').update(videoBuffer).digest('hex'),
    durationMs: payload.durationMs,
    width: payload.width,
    height: payload.height,
    fps: payload.fps,
  };

  completed = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  await fs.mkdir(args.outDir, { recursive: true });
  await atomicWrite(videoPath, videoBuffer);
  await writeResult(args.resultPath, result);
  setImmediate(() => app.quit());
  return { ok: true };
}

app.whenReady().then(async () => {
  try {
    const htmlStat = await fs.stat(args.htmlPath);
    if (!htmlStat.isFile() || path.extname(args.htmlPath).toLowerCase() !== '.html') {
      throw new Error('Recorder HTML input is not a regular .html file.');
    }
    await fs.mkdir(path.dirname(args.resultPath), { recursive: true });
    await fs.mkdir(args.outDir, { recursive: true });

    ipcMain.handle('marketing:finish', async (event, payload) => {
      try {
        return await finishRecording(event, payload);
      } catch (error) {
        await fail(`Rejected recorder payload: ${error.message}`);
        return { ok: false };
      }
    });

    mainWindow = new BrowserWindow({
      show: false,
      width: 1080,
      height: 1920,
      useContentSize: true,
      backgroundColor: '#111111',
      webPreferences: {
        preload: path.join(__dirname, 'marketing-video-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      void fail(`Recorder renderer exited unexpectedly: ${details.reason}.`);
    });
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      void fail(`Recorder preload failed (${preloadPath}): ${error.message}.`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      process.stderr.write('[recorder main] page loaded\n');
    });
    mainWindow.webContents.on('console-message', (_event, levelOrDetails, legacyMessage) => {
      const message =
        typeof levelOrDetails === 'object' ? levelOrDetails.message : legacyMessage ?? String(levelOrDetails);
      process.stderr.write(`[recorder renderer] ${message}\n`);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      void fail(`Recorder page failed to load (${code}): ${description}.`);
    });
    timeoutHandle = setTimeout(() => {
      void fail('Recorder timed out after 75 seconds.');
    }, 75000);
    await mainWindow.loadURL(pathToFileURL(args.htmlPath).href);
  } catch (error) {
    await fail(`Recorder setup failed: ${error.message}`);
  }
});

app.on('window-all-closed', () => {
  if (!completed) void fail('Recorder window closed before the video was saved.');
});
