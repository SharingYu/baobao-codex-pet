import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const lucideRoot = path.dirname(require.resolve('lucide-static/package.json'));
const sourcePath = path.join(lucideRoot, 'icons', 'package-open.svg');
const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'build',
  'icon.png',
);

const source = (await readFile(sourcePath, 'utf8')).replaceAll(
  'currentColor',
  '#C7664F',
);
const image = new Resvg(source, {
  background: '#FFF7EB',
  fitTo: { mode: 'width', value: 512 },
}).render().asPng();

await writeFile(outputPath, image);
console.log(`Wrote ${outputPath}`);
