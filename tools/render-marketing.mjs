#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import {
  MARKETING_COPY,
  MARKETING_COPY_ENTRIES,
  MARKETING_COPY_VERSION,
} from '../marketing/copy-data.mjs';

const require = createRequire(import.meta.url);
const RENDER_SCRIPT_PATH = fileURLToPath(import.meta.url);
const TOOLS_DIR = path.dirname(RENDER_SCRIPT_PATH);
const ROOT = path.resolve(TOOLS_DIR, '..');
const MARKETING_DIR = path.join(ROOT, 'marketing');
const OUTPUT_DIR = path.join(MARKETING_DIR, 'out');
const COPY_DATA_PATH = path.join(MARKETING_DIR, 'copy-data.mjs');
const COPY_DOC_PATH = path.join(MARKETING_DIR, 'copy.md');
const VIDEO_SCRIPT_PATH = path.join(MARKETING_DIR, 'video.js');
const SCREENSHOT_PATH = path.join(ROOT, 'docs', 'assets', 'desktop-v03.png');
const PET_MANIFEST_PATHS = {
  baobao: path.join(ROOT, 'petpacks', 'baobao', 'manifest.json'),
  feifei: path.join(ROOT, 'petpacks', 'feifei', 'manifest.json'),
};
const ITEM_MANIFEST_PATH = path.join(ROOT, 'itempacks', 'starter-play-kit', 'manifest.json');
const COPY = MARKETING_COPY;

const PALETTE = {
  cream: '#FFF7EB',
  softCream: '#F8EAD7',
  coral: '#C7664F',
  sage: '#8EA58C',
  cobalt: '#3157C8',
  ink: '#24211F',
  muted: '#6F6861',
  line: '#E8D8C4',
  white: '#FFFFFF',
};

const FONT_STACK = 'Microsoft YaHei, Noto Sans CJK SC, sans-serif';
const STATIC_OUTPUTS = [
  { name: 'internal-test-portrait-01.png', width: 1080, height: 1440 },
  { name: 'internal-test-portrait-02.png', width: 1080, height: 1440 },
  { name: 'github-hero.png', width: 1280, height: 640 },
];

const argv = new Set(process.argv.slice(2));
for (const argument of argv) {
  if (!['--check', '--images-only'].includes(argument)) {
    throw new Error(`Unknown option: ${argument}. Supported options are --check and --images-only.`);
  }
}

function rel(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function dataUri(buffer, mediaType) {
  return `data:${mediaType};base64,${buffer.toString('base64')}`;
}

function pngDimensions(buffer, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${label} is not a valid PNG file.`);
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${label} has no valid PNG IHDR header.`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) {
    throw new Error(`${label} has invalid dimensions ${width}x${height}.`);
  }
  return { width, height };
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function readJson(filePath, label) {
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`Missing ${label}: ${rel(filePath)}.`, { cause: error });
  }
  try {
    return { value: JSON.parse(buffer.toString('utf8')), buffer };
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${rel(filePath)}.`, { cause: error });
  }
}

function makeTextSourceRecord(id, kind, filePath, mediaType, buffer) {
  return { id, kind, path: rel(filePath), mediaType, bytes: buffer.length, sha256: sha256(buffer) };
}

function referencedCopyKeys(source, identifier) {
  const pattern = new RegExp(`\\b${identifier}((?:\\.[A-Za-z][A-Za-z0-9_]*)+)`, 'g');
  return new Set([...source.matchAll(pattern)].map((match) => match[1].slice(1)));
}

async function loadCopyContract() {
  const [copyDataBuffer, copyDocBuffer, renderScriptBuffer, videoScriptBuffer] = await Promise.all([
    fs.readFile(COPY_DATA_PATH), fs.readFile(COPY_DOC_PATH), fs.readFile(RENDER_SCRIPT_PATH), fs.readFile(VIDEO_SCRIPT_PATH),
  ]);
  const copyDoc = copyDocBuffer.toString('utf8');
  const renderSource = renderScriptBuffer.toString('utf8');
  const videoSource = videoScriptBuffer.toString('utf8');
  if (!Number.isInteger(MARKETING_COPY_VERSION) || MARKETING_COPY_VERSION < 1) {
    throw new Error('Marketing copy version must be a positive integer.');
  }
  const entriesByKey = new Map();
  for (const entry of MARKETING_COPY_ENTRIES) {
    if (!entry.key || typeof entry.value !== 'string' || entry.value.trim() !== entry.value || !entry.value) {
      throw new Error(`Invalid marketing copy entry ${entry.key || '<missing-key>'}.`);
    }
    if (entriesByKey.has(entry.key)) throw new Error(`Duplicate marketing copy key ${entry.key}.`);
    entriesByKey.set(entry.key, entry.value);
  }
  const documentedVersion = /^COPY-DATA-VERSION:\s*(\d+)\s*$/m.exec(copyDoc);
  if (!documentedVersion || Number(documentedVersion[1]) !== MARKETING_COPY_VERSION) {
    throw new Error(`marketing/copy.md must declare COPY-DATA-VERSION: ${MARKETING_COPY_VERSION}.`);
  }
  const documentedTokens = new Set([...copyDoc.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]));
  const canonicalValues = new Set(MARKETING_COPY_ENTRIES.map((entry) => entry.value));
  const undocumented = [...canonicalValues].filter((value) => !documentedTokens.has(value));
  const unknown = [...documentedTokens].filter((value) => !canonicalValues.has(value));
  if (undocumented.length || unknown.length) {
    throw new Error(`marketing/copy.md mirror mismatch; undocumented=${JSON.stringify(undocumented)}, unknown=${JSON.stringify(unknown)}.`);
  }
  if (/\bsvgText\(\s*['"`]/u.test(renderSource)) {
    throw new Error('Static marketing templates may not pass literal visible copy to svgText().');
  }
  if (/[\u3400-\u9fff]/u.test(videoSource)) {
    throw new Error('marketing/video.js may not contain inline CJK copy; use config.copy.');
  }
  if (/\b(?:text|drawBadge)\(\s*['"`]/u.test(videoSource)) {
    throw new Error('Video text helpers may not receive literal visible copy.');
  }
  if (/\b(?:featureCard|processCard)\([^,\n]+,\s*[^,\n]+,\s*['"`]/u.test(videoSource)) {
    throw new Error('Video card helpers may not receive literal visible titles.');
  }
  const rawProcessNumbers = videoSource.split(/\r?\n/)
    .filter((line) => line.includes('processCard(') && !line.includes('function processCard'))
    .filter((line) => {
      const call = line.slice(line.indexOf('processCard(') + 'processCard('.length).trimStart();
      return !call.startsWith('copy.');
    });
  if (rawProcessNumbers.length) throw new Error('Video process-card numbers must come from config.copy.');
  const referencedKeys = new Set([
    ...referencedCopyKeys(renderSource, 'COPY'), ...referencedCopyKeys(videoSource, 'copy'),
  ]);
  const missingReferences = [...referencedKeys].filter((key) => !entriesByKey.has(key));
  const unusedEntries = [...entriesByKey.keys()].filter((key) => !referencedKeys.has(key));
  if (missingReferences.length || unusedEntries.length) {
    throw new Error(`Marketing template copy references are incomplete; missing=${JSON.stringify(missingReferences)}, unused=${JSON.stringify(unusedEntries)}.`);
  }
  return {
    version: MARKETING_COPY_VERSION,
    entryCount: MARKETING_COPY_ENTRIES.length,
    sourceRecords: [
      makeTextSourceRecord('marketing-copy-data', 'machine-copy-source', COPY_DATA_PATH, 'text/javascript; charset=utf-8', copyDataBuffer),
      makeTextSourceRecord('marketing-copy-doc', 'human-copy-mirror', COPY_DOC_PATH, 'text/markdown; charset=utf-8', copyDocBuffer),
    ],
  };
}

async function readRequiredScreenshot() {
  let buffer;
  try {
    buffer = await fs.readFile(SCREENSHOT_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'Missing required real product screenshot: docs/assets/desktop-v03.png. ' +
          'Capture the final v0.3 app first; no fallback or synthetic UI is allowed.',
      );
    }
    throw error;
  }

  const dimensions = pngDimensions(buffer, 'docs/assets/desktop-v03.png');
  if (dimensions.width < 640 || dimensions.height < 360) {
    throw new Error(
      `Real product screenshot is too small: ${dimensions.width}x${dimensions.height}. ` +
        'docs/assets/desktop-v03.png must be at least 640x360.',
    );
  }
  return {
    buffer,
    dimensions,
    sourceRecord: {
      id: 'desktop-v03',
      kind: 'real-product-screenshot',
      path: rel(SCREENSHOT_PATH),
      mediaType: 'image/png',
      bytes: buffer.length,
      sha256: sha256(buffer),
      ...dimensions,
    },
  };
}

async function verifyDeclaredAsset(manifestPath, entry, label) {
  if (!entry || typeof entry.path !== 'string') {
    throw new Error(`${label} has no declared asset path.`);
  }
  const manifestDir = path.dirname(manifestPath);
  const assetPath = path.resolve(manifestDir, entry.path);
  if (!isInside(manifestDir, assetPath)) {
    throw new Error(`${label} asset path escapes its pack directory: ${entry.path}.`);
  }

  let buffer;
  try {
    buffer = await fs.readFile(assetPath);
  } catch (error) {
    throw new Error(`Missing declared asset for ${label}: ${rel(assetPath)}.`, { cause: error });
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes !== buffer.length) {
    throw new Error(`${label} byte count mismatch: manifest=${entry.bytes}, actual=${buffer.length}.`);
  }
  const actualSha = sha256(buffer);
  if (typeof entry.sha256 !== 'string' || entry.sha256.toLowerCase() !== actualSha) {
    throw new Error(`${label} SHA-256 mismatch: manifest=${entry.sha256}, actual=${actualSha}.`);
  }
  if (!/^image\/(png|webp)$/.test(entry.mediaType ?? '')) {
    throw new Error(`${label} uses unsupported media type ${entry.mediaType}.`);
  }

  return {
    entry,
    path: assetPath,
    buffer,
    sourceRecord: {
      id: entry.id,
      kind: label,
      path: rel(assetPath),
      mediaType: entry.mediaType,
      bytes: buffer.length,
      sha256: actualSha,
      width: entry.width,
      height: entry.height,
    },
  };
}

async function loadPet(id, manifestPath) {
  const { value: manifest, buffer: manifestBuffer } = await readJson(manifestPath, `${id} pet manifest`);
  if (manifest.id !== id || manifest.renderer?.type !== 'sprite-atlas') {
    throw new Error(`${rel(manifestPath)} is not the expected ${id} sprite-atlas pet pack.`);
  }
  const renderer = manifest.renderer;
  const atlasEntry = manifest.assets?.find((asset) => asset.id === renderer.atlasAsset);
  const atlas = await verifyDeclaredAsset(manifestPath, atlasEntry, `${id}-atlas`);
  if (
    atlasEntry.width !== renderer.cellWidth * renderer.columns ||
    atlasEntry.height !== renderer.cellHeight * renderer.rows
  ) {
    throw new Error(`${id} atlas dimensions do not match its declared cell grid.`);
  }
  return {
    id,
    manifest,
    manifestPath,
    atlas,
    sourceRecords: [
      {
        id: `${id}-manifest`,
        kind: 'pet-manifest',
        path: rel(manifestPath),
        mediaType: 'application/json',
        bytes: manifestBuffer.length,
        sha256: sha256(manifestBuffer),
      },
      atlas.sourceRecord,
    ],
  };
}

async function loadItems() {
  const { value: manifest, buffer: manifestBuffer } = await readJson(ITEM_MANIFEST_PATH, 'starter item manifest');
  if (manifest.id !== 'starter-play-kit' || !Array.isArray(manifest.assets) || !Array.isArray(manifest.items)) {
    throw new Error(`${rel(ITEM_MANIFEST_PATH)} is not the expected starter-play-kit item pack.`);
  }
  const assets = new Map();
  const sourceRecords = [
    {
      id: 'starter-play-kit-manifest',
      kind: 'item-manifest',
      path: rel(ITEM_MANIFEST_PATH),
      mediaType: 'application/json',
      bytes: manifestBuffer.length,
      sha256: sha256(manifestBuffer),
    },
  ];
  for (const entry of manifest.assets) {
    const verified = await verifyDeclaredAsset(ITEM_MANIFEST_PATH, entry, `item-${entry.id}`);
    assets.set(entry.id, verified);
    sourceRecords.push(verified.sourceRecord);
  }
  for (const item of manifest.items) {
    if (!assets.has(item.asset)) {
      throw new Error(`Item ${item.id} references undeclared asset ${item.asset}.`);
    }
  }
  return { manifest, assets, sourceRecords };
}

async function loadSources() {
  const [copyContract, screenshot, baobao, feifei, items] = await Promise.all([
    loadCopyContract(),
    readRequiredScreenshot(),
    loadPet('baobao', PET_MANIFEST_PATHS.baobao),
    loadPet('feifei', PET_MANIFEST_PATHS.feifei),
    loadItems(),
  ]);
  return {
    copyContract,
    screenshot,
    pets: { baobao, feifei },
    items,
    sourceRecords: [
      ...copyContract.sourceRecords,
      screenshot.sourceRecord,
      ...baobao.sourceRecords,
      ...feifei.sourceRecords,
      ...items.sourceRecords,
    ],
  };
}

function renderSvg(svg) {
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Microsoft YaHei',
      sansSerifFamily: 'Microsoft YaHei',
    },
  });
  return Buffer.from(renderer.render().asPng());
}

function extractPetFrame(pet, row, column) {
  const { renderer } = pet.manifest;
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(column) ||
    row < 0 ||
    column < 0 ||
    row >= renderer.rows ||
    column >= renderer.columns
  ) {
    throw new Error(`Invalid ${pet.id} atlas cell row=${row}, column=${column}.`);
  }
  const { cellWidth, cellHeight } = renderer;
  const href = dataUri(pet.atlas.buffer, pet.atlas.entry.mediaType);
  return renderSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${cellHeight}" viewBox="0 0 ${cellWidth} ${cellHeight}">
      <image href="${href}" x="${-column * cellWidth}" y="${-row * cellHeight}"
        width="${pet.atlas.entry.width}" height="${pet.atlas.entry.height}" />
    </svg>
  `);
}

function svgText(text, x, y, size, weight = 400, fill = PALETTE.ink, anchor = 'start') {
  return `<text x="${x}" y="${y}" font-family="${FONT_STACK}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${xml(text)}</text>`;
}

function portraitOne({ screenshot, baobao, feifei }) {
  const shot = dataUri(screenshot, 'image/png');
  const bao = dataUri(baobao, 'image/png');
  const fei = dataUri(feifei, 'image/png');
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
    <defs>
      <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${PALETTE.cream}"/><stop offset="1" stop-color="#F6E5CF"/>
      </linearGradient>
      <clipPath id="shotClip"><rect x="74" y="492" width="932" height="606" rx="30"/></clipPath>
    </defs>
    <rect width="1080" height="1440" fill="url(#paper)"/>
    <circle cx="980" cy="92" r="7" fill="${PALETTE.cobalt}"/>
    <rect x="72" y="62" width="168" height="52" rx="26" fill="${PALETTE.coral}"/>
    ${svgText(COPY.shared.internalTest, 156, 98, 25, 700, PALETTE.white, 'middle')}
    ${svgText(COPY.shared.freeCustom, 72, 222, 74, 800)}
    ${svgText(COPY.shared.desktopPet, 72, 312, 74, 800)}
    ${svgText(COPY.shared.valueFull, 74, 382, 31, 500, PALETTE.muted)}
    <rect x="72" y="435" width="936" height="711" rx="38" fill="${PALETTE.white}" stroke="${PALETTE.line}" stroke-width="3"/>
    <rect x="74" y="492" width="932" height="606" rx="30" fill="${PALETTE.softCream}"/>
    <image href="${shot}" x="86" y="504" width="908" height="582" preserveAspectRatio="xMidYMid meet" clip-path="url(#shotClip)"/>
    <rect x="104" y="458" width="166" height="42" rx="21" fill="${PALETTE.sage}"/>
    ${svgText(COPY.shared.realScreen, 187, 487, 20, 700, PALETTE.white, 'middle')}
    <image href="${bao}" x="22" y="925" width="276" height="299" preserveAspectRatio="xMidYMid meet"/>
    <image href="${fei}" x="780" y="928" width="276" height="299" preserveAspectRatio="xMidYMid meet"/>
    <rect x="72" y="1180" width="936" height="194" rx="30" fill="${PALETTE.softCream}"/>
    ${svgText(COPY.shared.participationFull, 540, 1254, 28, 700, PALETTE.ink, 'middle')}
    ${svgText(COPY.shared.voluntaryShareFull, 540, 1311, 26, 500, PALETTE.coral, 'middle')}
    ${svgText(COPY.shared.status, 540, 1350, 20, 400, PALETTE.muted, 'middle')}
  </svg>`;
}

function portraitTwo({ screenshot, baobao, feifei, food, ball, wand }) {
  const shot = dataUri(screenshot, 'image/png');
  const bao = dataUri(baobao, 'image/png');
  const fei = dataUri(feifei, 'image/png');
  const foodImage = dataUri(food, 'image/png');
  const ballImage = dataUri(ball, 'image/png');
  const wandImage = dataUri(wand, 'image/png');
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
    <defs>
      <clipPath id="proofClip"><rect x="90" y="318" width="900" height="488" rx="30"/></clipPath>
    </defs>
    <rect width="1080" height="1440" fill="${PALETTE.cream}"/>
    <rect x="72" y="58" width="168" height="52" rx="26" fill="${PALETTE.coral}"/>
    ${svgText(COPY.shared.internalTest, 156, 94, 25, 700, PALETTE.white, 'middle')}
    ${svgText(COPY.portraitTwo.headlineLead, 72, 190, 58, 800)}
    ${svgText(COPY.portraitTwo.headlineTail, 72, 260, 58, 800, PALETTE.coral)}
    <rect x="72" y="300" width="936" height="538" rx="38" fill="${PALETTE.white}" stroke="${PALETTE.line}" stroke-width="3"/>
    <image href="${shot}" x="90" y="318" width="900" height="488" preserveAspectRatio="xMidYMid meet" clip-path="url(#proofClip)"/>
    <rect x="104" y="315" width="166" height="42" rx="21" fill="${PALETTE.sage}"/>
    ${svgText(COPY.shared.realScreen, 187, 344, 20, 700, PALETTE.white, 'middle')}
    <image href="${bao}" x="0" y="686" width="222" height="241" preserveAspectRatio="xMidYMid meet"/>
    <image href="${fei}" x="858" y="690" width="222" height="241" preserveAspectRatio="xMidYMid meet"/>

    <rect x="72" y="874" width="292" height="330" rx="30" fill="${PALETTE.softCream}"/>
    <circle cx="122" cy="925" r="27" fill="${PALETTE.coral}"/>${svgText(COPY.portraitTwo.step1Number, 122, 934, 25, 800, PALETTE.white, 'middle')}
    ${svgText(COPY.portraitTwo.step1Title, 104, 1000, 32, 800)}
    ${svgText(COPY.portraitTwo.step1DetailLead, 104, 1050, 20, 400, PALETTE.muted)}
    ${svgText(COPY.portraitTwo.step1DetailTail, 104, 1084, 20, 400, PALETTE.muted)}
    <image href="${foodImage}" x="206" y="1081" width="128" height="114" preserveAspectRatio="xMidYMid meet"/>

    <rect x="394" y="874" width="292" height="330" rx="30" fill="${PALETTE.softCream}"/>
    <circle cx="444" cy="925" r="27" fill="${PALETTE.sage}"/>${svgText(COPY.portraitTwo.step2Number, 444, 934, 25, 800, PALETTE.white, 'middle')}
    ${svgText(COPY.portraitTwo.step2Title, 426, 1000, 32, 800)}
    ${svgText(COPY.portraitTwo.step2DetailLead, 426, 1050, 20, 400, PALETTE.muted)}
    ${svgText(COPY.portraitTwo.step2DetailTail, 426, 1084, 20, 400, PALETTE.muted)}
    <image href="${ballImage}" x="536" y="1074" width="126" height="126" preserveAspectRatio="xMidYMid meet"/>

    <rect x="716" y="874" width="292" height="330" rx="30" fill="${PALETTE.softCream}"/>
    <circle cx="766" cy="925" r="27" fill="${PALETTE.cobalt}"/>${svgText(COPY.portraitTwo.step3Number, 766, 934, 25, 800, PALETTE.white, 'middle')}
    ${svgText(COPY.portraitTwo.step3Title, 748, 1000, 32, 800)}
    ${svgText(COPY.portraitTwo.step3DetailLead, 748, 1050, 20, 400, PALETTE.muted)}
    ${svgText(COPY.portraitTwo.step3DetailTail, 748, 1084, 20, 400, PALETTE.muted)}
    <image href="${wandImage}" x="881" y="1054" width="94" height="140" preserveAspectRatio="xMidYMid meet"/>

    <rect x="72" y="1242" width="936" height="134" rx="28" fill="${PALETTE.coral}"/>
    ${svgText(COPY.shared.voluntaryShareFull, 540, 1303, 29, 700, PALETTE.white, 'middle')}
    ${svgText(COPY.shared.status, 540, 1343, 20, 400, '#FCEDE7', 'middle')}
  </svg>`;
}

function githubHero({ screenshot, baobao, feifei }) {
  const shot = dataUri(screenshot, 'image/png');
  const bao = dataUri(baobao, 'image/png');
  const fei = dataUri(feifei, 'image/png');
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
    <defs><clipPath id="heroClip"><rect x="724" y="94" width="486" height="402" rx="26"/></clipPath></defs>
    <rect width="1280" height="640" fill="${PALETTE.cream}"/>
    <circle cx="1210" cy="58" r="7" fill="${PALETTE.cobalt}"/>
    ${svgText(COPY.githubHero.productName, 68, 72, 18, 800, PALETTE.sage)}
    <rect x="68" y="102" width="226" height="42" rx="21" fill="${PALETTE.coral}"/>
    ${svgText(COPY.githubHero.badge, 181, 130, 20, 700, PALETTE.white, 'middle')}
    ${svgText(COPY.githubHero.titleLead, 68, 226, 52, 800)}
    ${svgText(COPY.githubHero.titleMiddle, 68, 292, 52, 800)}
    ${svgText(COPY.githubHero.titleTail, 68, 358, 52, 800, PALETTE.coral)}
    ${svgText(COPY.githubHero.detailLead, 70, 430, 23, 500, PALETTE.muted)}
    ${svgText(COPY.githubHero.detailTail, 70, 466, 23, 500, PALETTE.muted)}
    ${svgText(COPY.shared.featureList, 70, 538, 22, 700, PALETTE.sage)}
    ${svgText(COPY.shared.status, 70, 584, 17, 400, PALETTE.muted)}

    <rect x="700" y="70" width="534" height="474" rx="34" fill="${PALETTE.white}" stroke="${PALETTE.line}" stroke-width="3"/>
    <image href="${shot}" x="724" y="94" width="486" height="402" preserveAspectRatio="xMidYMid meet" clip-path="url(#heroClip)"/>
    <rect x="742" y="87" width="142" height="34" rx="17" fill="${PALETTE.sage}"/>
    ${svgText(COPY.shared.realScreen, 813, 111, 16, 700, PALETTE.white, 'middle')}
    <image href="${bao}" x="614" y="388" width="225" height="244" preserveAspectRatio="xMidYMid meet"/>
    <image href="${fei}" x="1056" y="390" width="210" height="228" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}

function itemBuffer(items, id) {
  const item = items.manifest.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing required marketing item ${id}.`);
  return items.assets.get(item.asset).buffer;
}

function createFrames(sources) {
  const staticFrames = {
    baobao: extractPetFrame(sources.pets.baobao, 3, 2),
    feifei: extractPetFrame(sources.pets.feifei, 0, 2),
  };
  const videoFrames = {
    baobao: [0, 1, 2, 3].map((column) => extractPetFrame(sources.pets.baobao, 3, column)),
    feifei: [0, 1, 2, 3, 4, 5].map((column) => extractPetFrame(sources.pets.feifei, 0, column)),
  };
  return { staticFrames, videoFrames };
}

function renderStaticImages(sources, frames) {
  const shared = {
    screenshot: sources.screenshot.buffer,
    baobao: frames.staticFrames.baobao,
    feifei: frames.staticFrames.feifei,
  };
  const rendered = new Map();
  rendered.set('internal-test-portrait-01.png', renderSvg(portraitOne(shared)));
  rendered.set(
    'internal-test-portrait-02.png',
    renderSvg(
      portraitTwo({
        ...shared,
        food: itemBuffer(sources.items, 'salmon-treat'),
        ball: itemBuffer(sources.items, 'coral-yarn-ball'),
        wand: itemBuffer(sources.items, 'teaser-wand'),
      }),
    ),
  );
  rendered.set('github-hero.png', renderSvg(githubHero(shared)));

  for (const expected of STATIC_OUTPUTS) {
    const buffer = rendered.get(expected.name);
    const actual = pngDimensions(buffer, expected.name);
    if (actual.width !== expected.width || actual.height !== expected.height) {
      throw new Error(
        `${expected.name} rendered at ${actual.width}x${actual.height}; expected ${expected.width}x${expected.height}.`,
      );
    }
  }
  return rendered;
}

function videoConfig(sources, frames) {
  const allItems = {};
  for (const item of sources.items.manifest.items) {
    const asset = sources.items.assets.get(item.asset);
    allItems[item.id] = dataUri(asset.buffer, asset.entry.mediaType);
  }
  return {
    width: 1080,
    height: 1920,
    durationMs: 14000,
    fps: 30,
    palette: PALETTE,
    copy: COPY,
    screenshot: dataUri(sources.screenshot.buffer, 'image/png'),
    pets: {
      baobao: frames.videoFrames.baobao.map((buffer) => dataUri(buffer, 'image/png')),
      feifei: frames.videoFrames.feifei.map((buffer) => dataUri(buffer, 'image/png')),
    },
    items: allItems,
  };
}

async function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        return env;
      })(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function renderVideo(sources, frames, stageDir) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pet-marketing-'));
  const resultPath = path.join(tempDir, 'video-result.json');
  const htmlPath = path.join(tempDir, 'video.html');
  const config = JSON.stringify(videoConfig(sources, frames)).replaceAll('<', '\\u003c');
  const videoScriptUrl = pathToFileURL(path.join(MARKETING_DIR, 'video.js')).href;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file: 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#111;overflow:hidden}canvas{display:block;width:1080px;height:1920px}</style>
</head><body><canvas id="stage" width="1080" height="1920"></canvas>
<script>window.__MARKETING_CONFIG__=${config};</script>
<script src="${videoScriptUrl}"></script></body></html>`;

  try {
    await fs.writeFile(htmlPath, html, { encoding: 'utf8', flag: 'wx' });
    const electronBinary = require('electron');
    if (typeof electronBinary !== 'string') {
      throw new Error('The local Electron package did not resolve to an executable path.');
    }
    const recorderPath = path.join(TOOLS_DIR, 'marketing-video-recorder.cjs');
    const result = await runProcess(
      electronBinary,
      [recorderPath, '--html', htmlPath, '--result', resultPath, '--out-dir', stageDir],
      ROOT,
    );
    let recordingResult = null;
    try {
      recordingResult = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch {
      // The process output below carries the useful failure when no result file exists.
    }
    if (result.code !== 0 || !recordingResult?.ok) {
      const details = [recordingResult?.error, result.stderr.trim(), result.stdout.trim()]
        .filter(Boolean)
        .join('\n') || `exit code ${result.code}`;
      throw new Error(`Marketing video recording failed: ${details}`);
    }
    return recordingResult;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function atomicWrite(filePath, buffer) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, buffer, { flag: 'wx' });
  await fs.rename(tempPath, filePath);
}

async function writeOutputs(sources, images, videoResult, stageDir) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputs = [];
  for (const expected of STATIC_OUTPUTS) {
    const buffer = images.get(expected.name);
    await atomicWrite(path.join(OUTPUT_DIR, expected.name), buffer);
    outputs.push({
      file: expected.name,
      mediaType: 'image/png',
      bytes: buffer.length,
      sha256: sha256(buffer),
      width: expected.width,
      height: expected.height,
    });
  }

  if (videoResult) {
    const videoStagePath = path.join(stageDir, videoResult.fileName);
    const videoBuffer = await fs.readFile(videoStagePath);
    if (videoBuffer.length !== videoResult.bytes || sha256(videoBuffer) !== videoResult.sha256) {
      throw new Error('Recorded video failed its post-recording integrity check.');
    }
    await atomicWrite(path.join(OUTPUT_DIR, videoResult.fileName), videoBuffer);
    outputs.push({
      file: videoResult.fileName,
      mediaType: videoResult.mimeType,
      bytes: videoBuffer.length,
      sha256: sha256(videoBuffer),
      width: videoResult.width,
      height: videoResult.height,
      durationMs: videoResult.durationMs,
      fps: videoResult.fps,
    });
  }

  const manifest = {
    schemaVersion: 1,
    campaign: 'first-internal-test',
    deterministicSceneVersion: 2,
    copyVersion: sources.copyContract.version,
    copyEntryCount: sources.copyContract.entryCount,
    note: 'Video container support is selected by the installed Electron/Chromium MediaRecorder.',
    sources: sources.sourceRecords,
    outputs,
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await atomicWrite(path.join(OUTPUT_DIR, 'manifest.json'), manifestBuffer);
  return manifest;
}

async function main() {
  const sources = await loadSources();
  if (argv.has('--check')) {
    process.stdout.write(
      `Marketing inputs are valid: ${sources.sourceRecords.length} allowlisted source records; ` +
        `copy v${sources.copyContract.version} (${sources.copyContract.entryCount} visible entries); ` +
        `real screenshot ${sources.screenshot.dimensions.width}x${sources.screenshot.dimensions.height}.\n`,
    );
    return;
  }

  const frames = createFrames(sources);
  const images = renderStaticImages(sources, frames);
  const stageDir = await fs.mkdtemp(path.join(MARKETING_DIR, '.render-stage-'));
  try {
    const videoResult = argv.has('--images-only') ? null : await renderVideo(sources, frames, stageDir);
    const manifest = await writeOutputs(sources, images, videoResult, stageDir);
    process.stdout.write(`Rendered ${manifest.outputs.length} marketing assets to ${rel(OUTPUT_DIR)}.\n`);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Marketing render failed: ${error.message}\n`);
  process.exitCode = 1;
});
