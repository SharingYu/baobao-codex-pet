import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(directory, '..', 'windows-platforms.ps1');
const allowedFields = ['bottom', 'hwnd', 'left', 'pid', 'right', 'top'];

test('watcher source stays inside the geometry-only privacy boundary', () => {
  const source = fs.readFileSync(script, 'utf8');
  for (const forbidden of [
    /GetWindowText/i,
    /System\.Windows\.Automation/i,
    /PrintWindow/i,
    /BitBlt/i,
    /CopyFromScreen/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test('Windows watcher emits bounded geometry-only JSONL near 120ms cadence', {
  skip: process.platform !== 'win32',
  timeout: 12_000,
}, async () => {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const child = spawn(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-OwnProcessId',
    String(process.pid),
    '-IntervalMilliseconds',
    '120',
    '-MaximumPlatforms',
    '64',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const snapshots = [];
  const observedAt = [];
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`watcher did not emit four snapshots: ${stderr.join('').trim()}`));
      }, 9_000);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (snapshots.length < 4) reject(new Error(`watcher exited early with code ${code}`));
      });
      lines.on('line', (line) => {
        assert.ok(Buffer.byteLength(line, 'utf8') <= 256 * 1024);
        const parsed = JSON.parse(line.replace(/^\uFEFF/, ''));
        assert.ok(Array.isArray(parsed));
        snapshots.push(parsed);
        observedAt.push(Date.now());
        if (snapshots.length >= 4) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    assert.equal(child.exitCode, null, 'watcher should remain alive between snapshots');
    for (const snapshot of snapshots) {
      for (const record of snapshot) {
        assert.deepEqual(Object.keys(record).sort(), allowedFields);
        assert.match(String(record.hwnd), /^\d{1,20}$/);
        assert.ok(Number.isInteger(record.pid) && record.pid > 0);
        assert.ok(record.right > record.left);
        assert.ok(record.bottom > record.top);
      }
    }

    const gaps = observedAt.slice(1).map((time, index) => time - observedAt[index]);
    assert.ok(Math.max(...gaps) < 750, `watcher cadence was too slow: ${gaps.join(', ')}ms`);
  } finally {
    lines.close();
    if (!child.killed) child.kill();
  }
});
