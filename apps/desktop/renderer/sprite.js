export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;

export const ANIMATIONS = Object.freeze({
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  walkRight: { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  walkLeft: { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  happy: { row: 3, durations: [140, 140, 140, 280] },
  pounce: { row: 4, durations: [140, 140, 140, 140, 280] },
  shy: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  curious: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  inspect: { row: 8, durations: [150, 150, 150, 150, 150, 280] }
});

export function frameAt(animation, elapsedMs, reducedMotion = false) {
  const source = animation?.durations ?? animation?.frameDurationsMs;
  const durations = Array.isArray(source) ? source.map((value) => Math.max(24, Number(value) || 120)) : [];
  if (reducedMotion || durations.length === 0) return 0;
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (animation?.loop === false && elapsedMs >= total) return durations.length - 1;
  let cursor = animation?.loop === false
    ? Math.max(0, Number(elapsedMs) || 0)
    : ((((Number(elapsedMs) || 0) % total) + total) % total);
  for (let index = 0; index < durations.length; index += 1) {
    cursor -= durations[index];
    if (cursor < 0) return index;
  }
  return durations.length - 1;
}

function circularDistance(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

export function lookCellForVector(dx, dy, lookDirections) {
  if (Math.hypot(dx, dy) < 8) return null;
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const normalized = (degrees + 360) % 360;
  const declared = Array.isArray(lookDirections)
    ? lookDirections.filter((entry) => Number.isFinite(Number(entry?.degrees))
      && Number.isInteger(Number(entry?.row))
      && Number.isInteger(Number(entry?.column)))
    : [];
  if (declared.length) {
    const closest = declared.reduce((best, entry) => {
      const distance = circularDistance(normalized, Number(entry.degrees));
      return !best || distance < best.distance ? { entry, distance } : best;
    }, null)?.entry;
    return closest ? { row: Number(closest.row), column: Number(closest.column) } : null;
  }
  const index = Math.round(normalized / 22.5) % 16;
  return {
    row: index < 8 ? 9 : 10,
    column: index % 8
  };
}

export function drawSpriteFrame(context, image, row, column, bounds, alpha = 1, renderer = {}) {
  if (!image?.complete || !image.naturalWidth) return false;
  if (![row, column, bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite)) return false;
  if (row < 0 || column < 0 || bounds.width <= 0 || bounds.height <= 0) return false;
  const cellWidth = Math.max(1, Number(renderer?.cellWidth) || CELL_WIDTH);
  const cellHeight = Math.max(1, Number(renderer?.cellHeight) || CELL_HEIGHT);
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height
  );
  context.restore();
  return true;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load sprite atlas: ${url}`));
    image.src = url;
  });
}
