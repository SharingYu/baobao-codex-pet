import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.argv[2] ?? 9333);
const fullOutput = path.resolve(process.argv[3] ?? "docs/assets/desktop-v03.png");
const managerOutput = path.resolve(process.argv[4] ?? ".e2e/pet-manager-v03.png");

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => {
  if (!response.ok) throw new Error(`CDP target discovery failed: ${response.status}`);
  return response.json();
});
const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!target) throw new Error("No Electron renderer target is available");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
  else resolve(message.result);
});

function call(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await call("Page.enable");
await call("Runtime.enable");

async function evaluate(expression) {
  const response = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "Renderer evaluation failed");
  }
  return response.result?.value;
}

let readyState;
for (let attempt = 0; attempt < 40; attempt += 1) {
  readyState = await evaluate(`(() => {
    const button = document.querySelector("#pet-selector-button");
    return {
      buttonReady: Boolean(button && !button.disabled),
      cards: document.querySelectorAll(".pet-option.pet-card").length,
      portraits: [...document.querySelectorAll(".pet-card-portrait")]
        .filter((canvas) => canvas.dataset.empty === "false").length
    };
  })()`);
  if (readyState.buttonReady && readyState.cards >= 2 && readyState.portraits >= 2) break;
  await new Promise((resolve) => setTimeout(resolve, 125));
}
if (!readyState?.buttonReady || readyState.cards < 2 || readyState.portraits < 2) {
  throw new Error(`Pet manager data did not become ready: ${JSON.stringify(readyState)}`);
}

const opened = await evaluate(`(() => {
  const button = document.querySelector("#pet-selector-button");
  if (button.getAttribute("aria-expanded") !== "true") button.click();
  return {
    cards: document.querySelectorAll(".pet-option.pet-card").length,
    portraits: [...document.querySelectorAll(".pet-card-portrait")]
      .filter((canvas) => canvas.dataset.empty === "false").length,
    viewport: { width: innerWidth, height: innerHeight }
  };
})()`);
await new Promise((resolve) => setTimeout(resolve, 500));

const rect = await evaluate(`(() => {
  const node = document.querySelector("#pet-selector-popover");
  if (!node || node.hidden) throw new Error("Pet manager did not open");
  const bounds = node.getBoundingClientRect();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
})()`);
const full = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  captureBeyondViewport: false,
});
const manager = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  clip: {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    scale: 1,
  },
});

await mkdir(path.dirname(fullOutput), { recursive: true });
await mkdir(path.dirname(managerOutput), { recursive: true });
await writeFile(fullOutput, Buffer.from(full.data, "base64"));
await writeFile(managerOutput, Buffer.from(manager.data, "base64"));
socket.close();

console.log(JSON.stringify({
  page: target.url,
  fullOutput,
  managerOutput,
  managerRect: rect,
  state: opened,
}, null, 2));
