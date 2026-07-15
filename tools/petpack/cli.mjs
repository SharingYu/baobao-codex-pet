#!/usr/bin/env node
import { PetpackError, importBundle, packBundle, validateBundle } from './lib.mjs';

function usage() {
  return [
    'Usage:',
    '  node cli.mjs validate <bundle-directory|file.petpack>',
    '  node cli.mjs inspect  <bundle-directory|file.petpack>',
    '  node cli.mjs pack     <bundle-directory> <output.petpack>',
    '  node cli.mjs import   <bundle-directory|file.petpack> <new-directory>',
  ].join('\n');
}

async function main(argv) {
  const [command, ...args] = argv;
  if ((command === 'validate' || command === 'inspect') && args.length === 1) {
    const report = await validateBundle(args[0]);
    if (command === 'validate') {
      return {
        ok: report.ok,
        id: report.manifest.id,
        displayName: report.manifest.displayName,
        manifestVersion: report.manifest.manifestVersion,
        bundleType: report.bundleType,
        fileCount: report.fileCount,
        totalBytes: report.totalBytes,
      };
    }
    return report;
  }
  if (command === 'pack' && args.length === 2) return packBundle(args[0], args[1]);
  if (command === 'import' && args.length === 2) return importBundle(args[0], args[1]);
  throw new PetpackError('USAGE', usage());
}

main(process.argv.slice(2)).then(
  (report) => console.log(JSON.stringify(report, null, 2)),
  (error) => {
    const payload = error instanceof PetpackError
      ? { ok: false, code: error.code, error: error.message, details: error.details }
      : { ok: false, code: 'UNEXPECTED', error: error.message };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  },
);
