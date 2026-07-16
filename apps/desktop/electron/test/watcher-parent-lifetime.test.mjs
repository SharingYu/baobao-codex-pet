import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "../windows-platforms.ps1");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("Windows watcher exits after its owner process disappears", {
  skip: process.platform !== "win32",
  timeout: 12_000
}, async () => {
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore"
  });
  const watcher = spawn(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-OwnProcessId",
    String(owner.pid),
    "-IntervalMilliseconds",
    "120",
    "-MaximumPlatforms",
    "16"
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines = readline.createInterface({ input: watcher.stdout, crlfDelay: Infinity });
  const stderr = [];
  watcher.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

  try {
    await withTimeout(once(lines, "line"), 7_000, `watcher did not start: ${stderr.join("")}`);
    const stoppedAt = once(watcher, "exit");
    const startedAt = Date.now();
    owner.kill();
    const [code] = await withTimeout(stoppedAt, 3_500, "watcher outlived its owner");
    assert.equal(code, 0, `watcher should exit cleanly, stderr=${stderr.join("")}`);
    assert.ok(Date.now() - startedAt < 3_500);
  } finally {
    lines.close();
    if (owner.exitCode === null && !owner.killed) owner.kill();
    if (watcher.exitCode === null && !watcher.killed) watcher.kill();
  }
});
