export const AFFINITY_THRESHOLDS = Object.freeze([0, 40, 120, 300, 600]);
export const LEVEL_NAMES = Object.freeze(["初见", "熟悉", "亲近", "默契", "挚友"]);

const DAILY_LIMITS = Object.freeze({ pet: 5, feed: 3, play: 3 });
const REWARDS = Object.freeze({
  "pet-head": 3,
  "pet-back": 2,
  "pet-tail": 1,
  "pet-body": 2,
  feed: 8,
  play: 10
});

export function localDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function levelForAffinity(value) {
  const affinity = Math.max(0, Number(value) || 0);
  let level = 1;
  for (let index = 1; index < AFFINITY_THRESHOLDS.length; index += 1) {
    if (affinity >= AFFINITY_THRESHOLDS[index]) level = index + 1;
  }
  return level;
}

export function levelName(level) {
  return LEVEL_NAMES[Math.max(1, Math.min(5, Number(level) || 1)) - 1];
}

export function createPetProgress(raw = {}) {
  const affinity = Math.max(0, Math.floor(Number(raw.affinity ?? raw.intimacy) || 0));
  const date = typeof raw.daily?.date === "string" ? raw.daily.date : "";
  return {
    affinity,
    level: levelForAffinity(affinity),
    daily: {
      date,
      pet: Math.max(0, Math.floor(Number(raw.daily?.pet) || 0)),
      feed: Math.max(0, Math.floor(Number(raw.daily?.feed) || 0)),
      play: Math.max(0, Math.floor(Number(raw.daily?.play) || 0))
    },
    cooldowns: raw.cooldowns && typeof raw.cooldowns === "object" ? { ...raw.cooldowns } : {}
  };
}

export function normalizeProgressByPet(raw = {}) {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw).map(([id, progress]) => [id, createPetProgress(progress)])
  );
}

function rewardGroup(action) {
  return action.startsWith("pet-") ? "pet" : action;
}

export function awardAffinity(rawProgress, action, options = {}) {
  const progress = createPetProgress(rawProgress);
  const reward = REWARDS[action] ?? 0;
  const group = rewardGroup(action);
  const at = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
  const today = options.dayKey ?? localDayKey(new Date(at));

  if (progress.daily.date !== today) {
    progress.daily = { date: today, pet: 0, feed: 0, play: 0 };
  }

  const cooldownKey = action.startsWith("pet-") ? action : null;
  const cooldownMs = Math.max(0, Number(options.cooldownMs ?? (cooldownKey ? 30_000 : 0)) || 0);
  const lastRewardAt = cooldownKey ? Number(progress.cooldowns[cooldownKey]) || 0 : 0;
  const onCooldown = Boolean(cooldownKey && lastRewardAt && at - lastRewardAt < cooldownMs);
  const dailyLimit = DAILY_LIMITS[group] ?? Number.POSITIVE_INFINITY;
  const atDailyLimit = (progress.daily[group] ?? 0) >= dailyLimit;
  const granted = reward > 0 && !onCooldown && !atDailyLimit;
  const previousLevel = progress.level;

  if (granted) {
    progress.affinity += reward;
    progress.level = levelForAffinity(progress.affinity);
    progress.daily[group] = (progress.daily[group] ?? 0) + 1;
    if (cooldownKey) progress.cooldowns[cooldownKey] = at;
  }

  return {
    progress,
    granted,
    reward: granted ? reward : 0,
    reason: granted ? "granted" : onCooldown ? "cooldown" : atDailyLimit ? "daily-limit" : "unknown-action",
    leveledUp: progress.level > previousLevel,
    previousLevel,
    level: progress.level
  };
}

export function affinityToNextLevel(progress) {
  const value = createPetProgress(progress);
  const next = AFFINITY_THRESHOLDS[value.level];
  return next === undefined ? 0 : Math.max(0, next - value.affinity);
}

export function unlockLevelForItem(item) {
  return Math.max(
    1,
    Math.min(
      5,
      Math.floor(Number(item?.unlockLevel ?? item?.unlock?.affinityLevel ?? item?.unlock?.level) || 1)
    )
  );
}
