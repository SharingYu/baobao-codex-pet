'use strict';

const EXPECTED_ANIMATIONS = Object.freeze({
  idle: [0, 6],
  'running-right': [1, 8],
  'running-left': [2, 8],
  waving: [3, 4],
  jumping: [4, 5],
  failed: [5, 8],
  waiting: [6, 6],
  running: [7, 6],
  review: [8, 6],
});

function unsupported(message) {
  throw Object.assign(new Error(message), { code: 'UNSUPPORTED_RENDERER' });
}

function assertAlphaRendererCompatibility(manifest) {
  const renderer = manifest?.renderer;
  if (
    renderer?.type !== 'sprite-atlas' ||
    renderer.cellWidth !== 192 ||
    renderer.cellHeight !== 208 ||
    renderer.columns !== 8 ||
    renderer.rows !== 11 ||
    renderer.defaultScale !== 1
  ) {
    unsupported('Alpha currently supports the Codex v2 192x208, 8x11 atlas layout');
  }

  for (const [name, [row, frameCount]] of Object.entries(EXPECTED_ANIMATIONS)) {
    const animation = renderer.animations?.[name];
    if (
      animation?.row !== row ||
      !Array.isArray(animation.frames) ||
      animation.frames.length !== frameCount ||
      animation.frames.some((frame, index) => frame !== index)
    ) {
      unsupported(`Alpha does not support the ${name} animation layout in this petpack`);
    }
  }

  const directions = renderer.lookDirections;
  if (
    !Array.isArray(directions) ||
    directions.length !== 16 ||
    directions.some((direction, index) =>
      direction?.row !== (index < 8 ? 9 : 10) || direction?.column !== index % 8,
    )
  ) {
    unsupported('Alpha requires the Codex v2 16-direction look layout');
  }

  return true;
}

module.exports = { assertAlphaRendererCompatibility, EXPECTED_ANIMATIONS };
