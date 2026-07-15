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
  if (reducedMotion) return 0;
  const total = animation.durations.reduce((sum, value) => sum + value, 0);
  let cursor = ((elapsedMs % total) + total) % total;
  for (let index = 0; index < animation.durations.length; index += 1) {
    cursor -= animation.durations[index];
    if (cursor < 0) return index;
  }
  return animation.durations.length - 1;
}

export function lookCellForVector(dx, dy) {
  if (Math.hypot(dx, dy) < 8) return null;
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const normalized = (degrees + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  return {
    row: index < 8 ? 9 : 10,
    column: index % 8
  };
}

export function drawSpriteFrame(context, image, row, column, bounds, alpha = 1) {
  if (!image?.complete || !image.naturalWidth) return false;
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(
    image,
    column * CELL_WIDTH,
    row * CELL_HEIGHT,
    CELL_WIDTH,
    CELL_HEIGHT,
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
