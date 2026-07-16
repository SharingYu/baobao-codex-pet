import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlatforms } from "../platforms.js";

test("native platform payload prefers overlay-local coordinates", () => {
  const [platform] = normalizePlatforms({
    overlayBounds: { left: 1920, top: 40 },
    platforms: [{
      hwnd: "42",
      left: 2100,
      top: 500,
      right: 2500,
      bottom: 900,
      overlayLeft: 180,
      overlayTop: 460,
      overlayRight: 580,
      overlayBottom: 860
    }]
  });
  assert.deepEqual(platform, {
    id: "42",
    left: 180,
    top: 460,
    right: 580,
    bottom: 860,
    width: 400,
    height: 400
  });
});
