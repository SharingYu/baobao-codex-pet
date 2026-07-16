'use strict';

const EXPECTED_ANIMATIONS = Object.freeze(['idle']);

function unsupported(message) {
  throw Object.assign(new Error(message), { code: 'UNSUPPORTED_RENDERER' });
}

function assertAlphaRendererCompatibility(manifest) {
  const renderer = manifest?.renderer;
  if (renderer?.type !== 'sprite-atlas') {
    unsupported('This runtime supports declarative sprite-atlas petpacks');
  }
  const integers = ['cellWidth', 'cellHeight', 'columns', 'rows'];
  if (integers.some((key) => !Number.isInteger(renderer[key]) || renderer[key] < 1)) {
    unsupported('The sprite atlas grid is invalid');
  }
  if (renderer.cellWidth > 2048 || renderer.cellHeight > 2048 || renderer.columns > 64 || renderer.rows > 64) {
    unsupported('The sprite atlas grid exceeds runtime limits');
  }
  if (!Number.isFinite(renderer.defaultScale) || renderer.defaultScale < 0.1 || renderer.defaultScale > 4) {
    unsupported('The sprite atlas scale is invalid');
  }

  for (const name of EXPECTED_ANIMATIONS) {
    if (!renderer.animations?.[name]) unsupported(`The ${name} animation is required`);
  }
  for (const [name, animation] of Object.entries(renderer.animations ?? {})) {
    if (!Number.isInteger(animation?.row) || animation.row < 0 || animation.row >= renderer.rows) {
      unsupported(`Animation ${name} references an invalid row`);
    }
    if (!Array.isArray(animation.frames) || animation.frames.length < 1 || animation.frames.length > 64) {
      unsupported(`Animation ${name} has an invalid frame list`);
    }
    if (animation.frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= renderer.columns)) {
      unsupported(`Animation ${name} references an invalid column`);
    }
    if (!Array.isArray(animation.frameDurationsMs) || animation.frameDurationsMs.length !== animation.frames.length) {
      unsupported(`Animation ${name} frame durations do not match its frames`);
    }
  }

  for (const direction of renderer.lookDirections ?? []) {
    if (!Number.isInteger(direction?.row) || direction.row < 0 || direction.row >= renderer.rows ||
        !Number.isInteger(direction?.column) || direction.column < 0 || direction.column >= renderer.columns) {
      unsupported('A look direction references a cell outside the atlas');
    }
  }
  return true;
}

module.exports = { assertAlphaRendererCompatibility, EXPECTED_ANIMATIONS };
