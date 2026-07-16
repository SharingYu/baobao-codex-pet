import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const releaseDirectory = path.join(repositoryRoot, 'release');
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = `v${packageJson.version}`;
const assets = [
  `PetDesktop-${packageJson.version}-x64.exe`,
  'petpacks/baobao.petpack',
  'petpacks/feifei.petpack',
  'itempacks/starter-play-kit.itempack',
];

const lines = [];
for (const asset of assets) {
  const contents = await readFile(path.join(releaseDirectory, asset));
  const digest = createHash('sha256').update(contents).digest('hex');
  lines.push(`${digest}  ${path.basename(asset)}`);
}

const outputPath = path.join(releaseDirectory, `SHA256SUMS-${version}.txt`);
await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(outputPath);
