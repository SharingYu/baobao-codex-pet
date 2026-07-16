#!/usr/bin/env node
import { ItempackError, importItempack, packItempack, validateItempack } from './lib.mjs';

const usage = () => [
  'Usage:',
  '  node cli.mjs validate <bundle-directory|file.itempack>',
  '  node cli.mjs inspect  <bundle-directory|file.itempack>',
  '  node cli.mjs pack     <bundle-directory> <output.itempack>',
  '  node cli.mjs import   <bundle-directory|file.itempack> <new-directory>',
].join('\n');

async function main(argv) {
  const [command, ...args] = argv;
  if ((command === 'validate' || command === 'inspect') && args.length === 1) {
    const report = await validateItempack(args[0]);
    return command === 'inspect' ? report : {
      ok: report.ok,
      id: report.manifest.id,
      displayName: report.manifest.displayName,
      itemCount: report.manifest.items.length,
      bundleType: report.bundleType,
      fileCount: report.fileCount,
      totalBytes: report.totalBytes,
    };
  }
  if (command === 'pack' && args.length === 2) return packItempack(args[0], args[1]);
  if (command === 'import' && args.length === 2) return importItempack(args[0], args[1]);
  throw new ItempackError('USAGE', usage());
}

main(process.argv.slice(2)).then(
  (report) => console.log(JSON.stringify(report, null, 2)),
  (error) => {
    const payload = error instanceof ItempackError
      ? { ok: false, code: error.code, error: error.message, details: error.details }
      : { ok: false, code: 'UNEXPECTED', error: error.message };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  },
);
