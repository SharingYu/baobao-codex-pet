import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDirectory = path.resolve(here, "..");

const [bootstrap, fallbackHtml, renderer, styles] = await Promise.all([
  readFile(path.join(rendererDirectory, "v03-bootstrap.js"), "utf8"),
  readFile(path.join(rendererDirectory, "index.html"), "utf8"),
  readFile(path.join(rendererDirectory, "main-v03.js"), "utf8"),
  readFile(path.join(rendererDirectory, "v03.css"), "utf8")
]);

test("v03 styles are a static module dependency that Vite includes in the build", () => {
  assert.match(bootstrap, /^import "\.\/v03\.css";/);
  assert.doesNotMatch(bootstrap, /document\.createElement\("link"\)|style\.href\s*=\s*"\.\/v03\.css"/);
});

test("pet manager exposes a complete accessible management surface", () => {
  assert.match(bootstrap, /id="pet-manager-title">宠物小屋/);
  assert.match(bootstrap, /id="pet-list"[^>]+role="list"/);
  assert.match(bootstrap, /id="pet-selector-import-button"/);
  assert.match(bootstrap, /id="platform-toggle"/);
});

test("static fallback markup does not expose the removed active edge action", () => {
  assert.doesNotMatch(fallbackHtml, /id="edge-button"/);
  assert.doesNotMatch(fallbackHtml, /data-action="edge"/);
});

test("pet manager uses four-column cards and a blue current-pet marker", () => {
  assert.match(styles, /\.pet-list\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,/);
  assert.match(styles, /\.pet-option\.pet-card\.is-current\s*\{[\s\S]*?border:\s*3px solid #168cf2/);
  assert.match(styles, /\.pet-card\.is-current \.pet-selection-dot\s*\{[\s\S]*?display:\s*block/);
  assert.match(styles, /max-height:\s*min\(430px,[\s\S]*?overflow-y:\s*auto/);
});

test("pet cards crop real idle frames from installed pet atlases", () => {
  assert.match(renderer, /function drawPetCardPortrait\(canvas, definition\)/);
  assert.match(renderer, /const idle = renderer\.animations\?\.idle/);
  assert.match(renderer, /context\.drawImage\([\s\S]*?frame\) \* cellWidth[\s\S]*?row\) \* cellHeight/);
  assert.match(renderer, /drawPetCardPortrait\(portrait, definition\)/);
});

test("a resting pet can be restored and selected from its card", () => {
  assert.match(renderer, /if \(summary && !summary\.visible\) this\.world\.setPetVisible\(petId, true\)/);
  assert.match(renderer, /this\.world\.setActivePet\(petId\)/);
  assert.match(renderer, /input\.dataset\.petVisible = pet\.id/);
  assert.match(renderer, /text\.textContent = "桌面显示"/);
});

test("every pet card exposes live size and movement speed controls", () => {
  assert.match(renderer, /range\.dataset\[kind\] = pet\.id/);
  assert.match(renderer, /kind: "petScale"[\s\S]*?label: "大小"/);
  assert.match(renderer, /kind: "petSpeed"[\s\S]*?label: "速度"/);
  assert.match(renderer, /setPetAppearanceScale/);
  assert.match(renderer, /setPetMovementSpeed/);
  assert.match(styles, /\.pet-card-controls\s*\{/);
});
