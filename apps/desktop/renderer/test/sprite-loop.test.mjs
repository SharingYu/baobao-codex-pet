import test from "node:test";
import assert from "node:assert/strict";
import { frameAt } from "../sprite.js";

test("legacy sprite frame selection honors non-looping animations", () => {
  const animation = { durations: [100, 100], loop: false };
  assert.equal(frameAt(animation, 50), 0);
  assert.equal(frameAt(animation, 150), 1);
  assert.equal(frameAt(animation, 250), 1);
  assert.equal(frameAt({ ...animation, loop: true }, 250), 0);
});
