import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(here, "../../../../package.json");

test("installer and portable builds use distinct artifact names", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.equal(packageJson.build.win.artifactName, "PetDesktop-${version}-${arch}.${ext}");
  assert.match(
    packageJson.scripts["dist:portable"],
    /-c\.win\.artifactName=PetDesktop-Portable-\$\{version\}-\$\{arch\}\.\$\{ext\}/
  );
});
