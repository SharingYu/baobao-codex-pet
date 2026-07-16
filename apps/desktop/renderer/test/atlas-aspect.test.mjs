import test from "node:test";
import assert from "node:assert/strict";
import { PetActor } from "../pet-actor.js";

test("pet actor aspect ratio follows manifest cell dimensions", () => {
  const actor = new PetActor(
    { width: 1000, height: 800 },
    {
      id: "wide-contract",
      name: "Test",
      displayName: "Test",
      manifest: { renderer: { cellWidth: 128, cellHeight: 256 } },
      color: "#fff",
      image: null
    },
    {},
    1
  );
  assert.equal(actor.height, actor.width * 2);
});
