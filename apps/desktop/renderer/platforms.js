const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizePlatform(raw, index = 0) {
  const left = Number(raw?.overlayLeft ?? raw?.left ?? raw?.x);
  const top = Number(raw?.overlayTop ?? raw?.top ?? raw?.y);
  const right = Number(raw?.overlayRight ?? raw?.right);
  const bottom = Number(raw?.overlayBottom ?? raw?.bottom);
  const width = Number(raw?.width ?? (right - left));
  const height = Number(raw?.height ?? (bottom - top));
  if (![left, top, width, height].every(Number.isFinite) || width < 64 || height < 24) return null;
  return {
    id: String(raw?.id ?? raw?.handle ?? raw?.hwnd ?? `platform-${index}`),
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height
  };
}

export function normalizePlatforms(payload) {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.platforms) ? payload.platforms : [];
  return raw.map(normalizePlatform).filter(Boolean);
}

function platformsFromPayload(payload) {
  const platforms = normalizePlatforms(payload);
  if (payload && !Array.isArray(payload) && payload.error && platforms.length === 0) {
    if (payload.stale) return [];
    throw new Error("Window platform discovery is temporarily unavailable");
  }
  return platforms;
}

export async function readWindowPlatforms(bridge) {
  if (typeof bridge?.getWindowPlatforms === "function") {
    return platformsFromPayload(await bridge.getWindowPlatforms());
  }
  const native = typeof window !== "undefined" ? window.petDesktop : undefined;
  if (typeof native?.getWindowPlatforms === "function") {
    return platformsFromPayload(await native.getWindowPlatforms());
  }
  return [];
}

export function findSnapPlatform(platforms, footX, footY, tolerance = 24) {
  return platforms
    .filter((platform) => footX >= platform.left + 16 && footX <= platform.right - 16)
    .map((platform) => ({ platform, gap: Math.abs(platform.top - footY) }))
    .filter((candidate) => candidate.gap <= tolerance)
    .sort((a, b) => a.gap - b.gap)[0]?.platform ?? null;
}

export function platformLocalX(platform, footX) {
  return clamp(footX - platform.left, 16, Math.max(16, platform.width - 16));
}

export function findLandingPlatform(platforms, footX, previousFootY, nextFootY) {
  return platforms
    .filter((platform) => footX >= platform.left + 16 && footX <= platform.right - 16)
    .filter((platform) => platform.top >= previousFootY - 2 && platform.top <= nextFootY + 2)
    .sort((a, b) => a.top - b.top)[0] ?? null;
}
