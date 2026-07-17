import { petBridge } from "./bridge.js";
import { loadImage } from "./sprite.js";
import { PetActor } from "./pet-actor.js";
import { awardAffinity, createPetProgress, normalizeProgressByPet, unlockLevelForItem } from "./progression.js";
import { findLandingPlatform, findSnapPlatform, platformLocalX, readWindowPlatforms } from "./platforms.js";
import { mergePetHistory, migrateRendererState } from "./state.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const now = () => performance.now();
const TARGET_RENDER_INTERVAL_MS = 1000 / 30;
const MAX_CANVAS_PIXELS = 3_200_000;
const MAX_CANVAS_DPR = 1.25;
const MIN_CANVAS_DPR = 0.65;

export function canvasDprForViewport(width, height, deviceDpr = 1) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const safeDeviceDpr = Math.max(MIN_CANVAS_DPR, Number(deviceDpr) || 1);
  const budgetDpr = Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeHeight));
  return clamp(Math.min(safeDeviceDpr, MAX_CANVAS_DPR, budgetDpr), MIN_CANVAS_DPR, MAX_CANVAS_DPR);
}

function joinAssetUrl(base, relative) {
  if (!base) return relative;
  try {
    return new URL(relative, base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return `${base.replace(/[\\/]$/, "")}/${String(relative).replace(/^[\\/]/, "")}`;
  }
}

export function catalogPets(rawCatalog) {
  if (Array.isArray(rawCatalog)) return rawCatalog;
  if (Array.isArray(rawCatalog?.pets)) return rawCatalog.pets;
  if (Array.isArray(rawCatalog?.entries)) return rawCatalog.entries;
  return [];
}

export function catalogItempacks(rawCatalog) {
  return Array.isArray(rawCatalog?.items) ? rawCatalog.items : [];
}

function normalizeCatalogEntry(entry) {
  const manifest = entry?.manifest ?? entry?.pet ?? entry?.petJson ?? entry ?? {};
  const id = String(entry?.id ?? manifest.id ?? "").trim();
  const atlasAssetId = manifest?.renderer?.atlasAsset;
  const declaredAtlas = Array.isArray(manifest?.assets)
    ? manifest.assets.find((asset) => asset?.id === atlasAssetId)?.path
    : undefined;
  const spritePath = entry?.spritesheetUrl ?? entry?.spritesheetURL ?? entry?.assetUrl
    ?? entry?.spriteUrl ?? manifest.spritesheetUrl ?? manifest.spritesheetPath ?? declaredAtlas;
  return {
    id,
    name: entry?.name ?? manifest.displayName ?? manifest.name ?? manifest.identity?.name ?? id,
    displayName: manifest.displayName ?? manifest.name ?? manifest.identity?.name ?? entry?.name ?? id,
    manifest,
    url: entry?.assetBaseUrl && spritePath ? joinAssetUrl(entry.assetBaseUrl, spritePath) : spritePath
  };
}

function normalizeItemCatalogEntry(entry) {
  const manifest = entry?.manifest ?? entry ?? {};
  const assets = new Map(
    Array.isArray(manifest.assets) ? manifest.assets.map((asset) => [String(asset.id).toLowerCase(), asset]) : []
  );
  return (Array.isArray(manifest.items) ? manifest.items : []).flatMap((item) => {
    const asset = assets.get(String(item?.asset ?? "").toLowerCase());
    if (!item?.id || !asset?.path) return [];
    const unlockLevel = unlockLevelForItem(item);
    return [{
      id: `${manifest.id}:${item.id}`,
      packId: String(manifest.id ?? entry?.id ?? ""),
      name: String(item.displayName ?? item.id),
      category: item.category,
      behavior: item.behavior,
      scale: Number(item.scale) || 1,
      durationMs: clamp(Number(item.durationMs ?? item.duration) || 0, 0, 120_000),
      unlockLevel,
      unlock: item.unlock,
      url: entry?.assetBaseUrl ? joinAssetUrl(entry.assetBaseUrl, asset.path) : asset.path,
      manifest
    }];
  });
}

async function loadFirstImage(candidates) {
  let lastError;
  for (const candidate of candidates) {
    try {
      const resolved = await petBridge.resolveAssetUrl(candidate);
      return await loadImage(resolved);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No asset URL was provided");
}

function roundedRegion(bounds, padding = 0) {
  return {
    x: Math.round(bounds.x - padding),
    y: Math.round(bounds.y - padding),
    width: Math.round(bounds.width + padding * 2),
    height: Math.round(bounds.height + padding * 2)
  };
}

function placePetFoot(pet, x, y) {
  if (typeof pet?.placeFootAt === "function") {
    pet.placeFootAt(x, y);
    return;
  }
  pet.x = x - pet.width / 2;
  pet.y = y + 7 - pet.height;
}

function touchInteractionAt(pet, x, y) {
  if (typeof pet?.touchInteractionAt === "function") return pet.touchInteractionAt(x, y);
  const id = pet?.touchZoneAt?.(x, y);
  return id ? { id, event: `pet-${id}` } : null;
}

function defaultToyDuration(item) {
  const declared = Number(item?.durationMs) || 0;
  if (declared) return clamp(declared, 15_000, 120_000);
  if (item?.behavior === "wand") return 30_000;
  if (item?.behavior === "hideout") return 90_000;
  return 45_000;
}

export class PetWorld {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    // Keep the canvas synchronized with Chromium's compositor. The former
    // desynchronized context could bypass the normal page paint cadence, which
    // made transparent pets unreliable in some Windows screen recorders.
    this.context = canvas.getContext("2d", { alpha: true });
    this.callbacks = callbacks;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.catalog = { pets: [], items: [] };
    this.catalogLoadToken = 0;
    this.definitions = [];
    this.itemDefinitions = [];
    this.pets = [];
    this.visiblePetIds = [];
    this.activePetId = null;
    this.petHistory = {};
    this.progressByPet = {};
    this.foods = [];
    this.balls = [];
    this.box = null;
    this.wand = { active: false, x: 0, y: 0, item: null };
    this.toySession = null;
    this.foodDrag = null;
    this.particles = [];
    this.pointer = { x: 0, y: 0, seen: false };
    this.pointerSession = null;
    this.quiet = false;
    this.pettingMode = null;
    this.platformInteractions = false;
    this.platformWatcherEnabled = false;
    this.platforms = [];
    this.platformPollAt = 0;
    this.platformPollPending = null;
    this.platformReader = () => readWindowPlatforms(petBridge);
    this.platformController = (enabled) => petBridge.setWindowPlatformInteractions(enabled);
    this.platformErrorShown = false;
    this.platformHintShown = false;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.lastFrameAt = now();
    this.lastRegionUpdateAt = 0;
    this.lastFrameErrorAt = 0;
    this.contextLost = false;
    this.suspended = false;
    this.running = false;
    this.resize();
    this.bindCanvasEvents();
    this.bindCanvasLifecycle();
  }

  bindCanvasLifecycle() {
    this.canvas.addEventListener("contextlost", (event) => {
      event.preventDefault?.();
      this.contextLost = true;
      console.warn("[pet-world] Canvas context lost; waiting for Chromium to restore it");
    });
    this.canvas.addEventListener("contextrestored", () => {
      this.context = this.canvas.getContext("2d", { alpha: true });
      this.contextLost = false;
      this.resize();
      this.lastFrameAt = now();
      console.info("[pet-world] Canvas context restored");
    });
  }

  async load(rawCatalog, savedState) {
    const token = ++this.catalogLoadToken;
    const shouldStartLoop = !this.running;
    this.catalog = rawCatalog && typeof rawCatalog === "object" ? rawCatalog : { pets: [], items: [] };
    const colors = ["#8fa99a", "#c68d72", "#9b91b5", "#d2ad65", "#779ba8"];
    const entries = catalogPets(this.catalog).map(normalizeCatalogEntry).filter((entry) => entry.id && entry.url);
    const definitions = await Promise.all(entries.map(async (entry, index) => {
      let image = null;
      try {
        image = await loadFirstImage([entry.url]);
      } catch (error) {
        console.error(error);
        this.callbacks.toast(`${entry.name}的动画暂时没加载出来`);
      }
      return {
        ...entry,
        name: String(entry.name || entry.displayName || entry.id).split(/[\s/]/)[0],
        color: colors[index % colors.length],
        image,
        installedIndex: index
      };
    }));
    const itemDefinitions = [];
    for (const definition of catalogItempacks(this.catalog).flatMap(normalizeItemCatalogEntry).filter((item) => item.id && item.url)) {
      try {
        itemDefinitions.push({ ...definition, image: await loadFirstImage([definition.url]) });
      } catch (error) {
        console.error(error);
        itemDefinitions.push({ ...definition, image: null });
        this.callbacks.toast(`${definition.name}道具素材暂时没加载出来`);
      }
    }
    if (token !== this.catalogLoadToken) return false;

    const state = migrateRendererState(savedState, definitions.map((definition) => definition.id));
    this.cancelTransientInteractions("reload", false);
    this.definitions = definitions;
    this.itemDefinitions = itemDefinitions;
    this.petHistory = { ...state.pets };
    this.progressByPet = normalizeProgressByPet(state.progressByPet);
    for (const definition of definitions) {
      this.progressByPet[definition.id] = createPetProgress(this.progressByPet[definition.id]);
    }
    this.visiblePetIds = state.visiblePetIds;
    this.activePetId = state.activePetId;
    this.quiet = state.quiet;
    this.platformInteractions = state.platformInteractions;
    this.platformHintShown = state.platformHintShown;
    this.pets = definitions
      .filter((definition) => this.visiblePetIds.includes(definition.id))
      .map((definition) => new PetActor(this, definition, this.petHistory[definition.id], definition.installedIndex));
    if (!this.pets.some((pet) => pet.id === this.activePetId)) this.activePetId = this.pets[0]?.id ?? null;
    this.visiblePetIds = this.pets.map((pet) => pet.id);
    await this.syncPlatformWatcher();
    this.callbacks.quietChanged(this.quiet, false);
    this.callbacks.petsChanged();
    this.callbacks.itemsChanged();
    if (shouldStartLoop) {
      this.running = true;
      this.lastFrameAt = now();
      requestAnimationFrame((timestamp) => this.frame(timestamp));
    }
    return true;
  }

  async reloadCatalog(rawCatalog) {
    return this.load(rawCatalog, this.serialize());
  }

  resize() {
    const oldWidth = this.width;
    const oldHeight = this.height;
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.dpr = canvasDprForViewport(this.width, this.height, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";
    if (this.pets.length && oldWidth > 1 && oldHeight > 1) {
      for (const pet of this.pets) {
        pet.x *= this.width / oldWidth;
        pet.y *= this.height / oldHeight;
        pet.clampToStage();
      }
      this.callbacks.requestSave();
    }
  }

  bindCanvasEvents() {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.pointerSession) this.setHoveredPet(null);
    });
  }

  frame(timestamp) {
    if (!this.running) return;
    // Schedule first so a transient draw/update exception never permanently
    // kills the animation loop. A full-screen transparent overlay should not
    // compete with video decoders at display refresh rate, so cap work at 30fps.
    requestAnimationFrame((next) => this.frame(next));
    if (this.suspended || this.contextLost) return;
    const elapsed = timestamp - this.lastFrameAt;
    if (elapsed < TARGET_RENDER_INTERVAL_MS - 1) return;
    const deltaSeconds = Math.min(0.05, Math.max(0, elapsed / 1000));
    this.lastFrameAt = timestamp;
    try {
      this.update(deltaSeconds, timestamp);
      this.draw(timestamp);
      if (timestamp - this.lastRegionUpdateAt > 180) {
        this.lastRegionUpdateAt = timestamp;
        this.callbacks.regionsChanged();
      }
    } catch (error) {
      if (timestamp - this.lastFrameErrorAt > 2_000) {
        this.lastFrameErrorAt = timestamp;
        console.error("[pet-world] Frame failed; animation loop will continue", error);
      }
    }
  }

  setSuspended(suspended) {
    this.suspended = Boolean(suspended);
    if (!this.suspended) this.lastFrameAt = now();
  }

  update(deltaSeconds, timestamp) {
    if (this.pettingMode && timestamp >= this.pettingMode.expiresAt) this.cancelPetting("timeout", true);
    if (this.foods[0] && timestamp >= this.foods[0].expiresAt) this.clearFood("timeout", true);
    if (this.toySession && timestamp >= this.toySession.expiresAt) this.clearToy("timeout", true);
    this.updateBalls(deltaSeconds, timestamp);
    this.updateWand(timestamp);
    this.updateHideoutPlay(timestamp);
    if (this.platformInteractions && this.pets.length > 0 && timestamp >= this.platformPollAt) this.pollPlatforms(timestamp);
    for (const pet of this.pets) pet.update(deltaSeconds, timestamp);
    this.updateParticles(deltaSeconds);
  }

  pollPlatforms(timestamp = now()) {
    this.platformPollAt = timestamp + 120;
    if (this.platformPollPending) return this.platformPollPending;

    const request = Promise.resolve()
      .then(() => this.platformReader())
      .then((platforms) => {
        if (!this.platformInteractions) return [];
        this.platforms = platforms;
        this.platformErrorShown = false;
        return platforms;
      })
      .catch((error) => {
        console.warn("Window platform discovery failed", error);
        if (!this.platformErrorShown) {
          this.platformErrorShown = true;
          this.callbacks.toast("暂时没识别到窗口平台，宠物会安全回到桌面");
        }
        return this.platforms;
      });

    let pending;
    pending = request.finally(() => {
      if (this.platformPollPending === pending) {
        this.platformPollPending = null;
      }
    });
    this.platformPollPending = pending;
    return pending;
  }

  attachPetToPlatform(pet, platform) {
    pet.platformAttachment = {
      id: platform.id,
      localX: platformLocalX(platform, pet.foot.x),
      direction: pet.facing === "left" ? -1 : 1
    };
    pet.target = null;
    pet.fallingVelocity = 0;
    pet.insideBox = false;
    pet.setState("platform-idle", 0);
    placePetFoot(pet, platform.left + pet.platformAttachment.localX, platform.top);
    if (!this.platformHintShown) {
      this.platformHintShown = true;
      this.callbacks.toast(`发现窗口平台，${pet.name}会在这里走走`);
      this.callbacks.requestSave();
    }
  }

  async tryAttachToPlatform(pet) {
    if (!this.platformInteractions || !pet) return false;
    if (!this.platforms.length) await this.pollPlatforms(0);
    const platform = findSnapPlatform(this.platforms, pet.foot.x, pet.foot.y, 24);
    if (!platform) {
      pet.platformAttachment = null;
      pet.fallingVelocity = 36;
      pet.setState("fall", 0);
      return false;
    }
    this.attachPetToPlatform(pet, platform);
    return true;
  }

  updatePlatformPet(pet, deltaSeconds, timestamp) {
    if (pet.platformAttachment) {
      const attachment = pet.platformAttachment;
      const platform = this.platforms.find((candidate) => candidate.id === attachment.id);
      if (!platform) {
        pet.platformAttachment = null;
        pet.fallingVelocity = 36;
        pet.setState("fall", 0, timestamp);
        return true;
      }
      const min = 16;
      const max = Math.max(min, platform.width - 16);
      attachment.localX += attachment.direction * 38 * deltaSeconds;
      if (attachment.localX <= min || attachment.localX >= max) {
        attachment.localX = clamp(attachment.localX, min, max);
        attachment.direction *= -1;
      }
      pet.facing = attachment.direction >= 0 ? "right" : "left";
      placePetFoot(pet, platform.left + attachment.localX, platform.top);
      pet.setState(this.quiet || this.reducedMotion ? "platform-idle" : "platform-walk", 0, timestamp);
      return true;
    }
    if (pet.fallingVelocity > 0) {
      const previousFootY = pet.foot.y;
      pet.fallingVelocity += 780 * deltaSeconds;
      pet.y += pet.fallingVelocity * deltaSeconds;
      pet.setState("fall", 0, timestamp);
      const landing = this.platformInteractions
        ? findLandingPlatform(this.platforms, pet.foot.x, previousFootY, pet.foot.y)
        : null;
      if (landing) {
        this.attachPetToPlatform(pet, landing);
      } else if (pet.foot.y >= this.height - 7) {
        placePetFoot(pet, pet.foot.x, this.height - 7);
        pet.fallingVelocity = 0;
        pet.setState("land", 650, timestamp);
        pet.clampToStage();
        this.callbacks.requestSave();
      }
      return true;
    }
    return false;
  }

  setPlatformInteractions(value) {
    this.platformInteractions = Boolean(value);
    if (!this.platformInteractions) {
      this.platforms = [];
      for (const pet of this.pets) {
        if (pet.platformAttachment) {
          pet.platformAttachment = null;
          pet.fallingVelocity = 36;
        }
      }
    } else {
      this.platformPollAt = 0;
    }
    this.callbacks.requestSave();
    return this.syncPlatformWatcher()
      .then(() => this.platformInteractions);
  }

  syncPlatformWatcher() {
    const enabled = Boolean(this.platformInteractions && this.pets.length > 0);
    if (this.platformWatcherEnabled === enabled) return Promise.resolve(enabled);
    this.platformWatcherEnabled = enabled;
    let nativeSync;
    try {
      nativeSync = this.platformController(enabled);
    } catch (error) {
      console.warn("Unable to update native window platform watcher", error);
    }
    return Promise.resolve(nativeSync)
      .catch((error) => {
        console.warn("Unable to update native window platform watcher", error);
      })
      .then(() => enabled);
  }

  updateBalls(deltaSeconds, timestamp) {
    const floor = this.height - 22;
    for (const ball of this.balls) {
      if (ball.dragging) continue;
      ball.vy += 690 * deltaSeconds;
      ball.x += ball.vx * deltaSeconds;
      ball.y += ball.vy * deltaSeconds;
      ball.vx *= Math.pow(0.993, deltaSeconds * 60);
      if (ball.x - ball.radius < 0) {
        ball.x = ball.radius;
        ball.vx = Math.abs(ball.vx) * 0.78;
      } else if (ball.x + ball.radius > this.width) {
        ball.x = this.width - ball.radius;
        ball.vx = -Math.abs(ball.vx) * 0.78;
      }
      if (ball.y + ball.radius > floor) {
        ball.y = floor - ball.radius;
        ball.vy = Math.abs(ball.vy) > 34 ? ball.vy * -0.62 : 0;
        ball.vx *= 0.94;
      }
      if (!this.quiet && timestamp > ball.nextChaseAt) {
        const pet = this.pets.find((candidate) => candidate.id === ball.petId);
        if (pet && !pet.dragging && !pet.insideBox) {
          pet.walkTo(ball.x, ball.y, "ball", { entityId: ball.id, manual: true, radius: 56 });
          ball.nextChaseAt = timestamp + 520;
        }
      }
    }
  }

  updateWand(timestamp) {
    if (!this.wand.active || this.quiet) return;
    const session = this.toySession;
    if (!session || timestamp - (session.lastRetargetAt ?? 0) < 160) return;
    const pet = this.pets.find((candidate) => candidate.id === session.petId);
    if (pet && !pet.dragging && !pet.insideBox) {
      pet.walkTo(this.wand.x, this.wand.y, "wand", { manual: true, radius: 52 });
      session.lastRetargetAt = timestamp;
    }
  }

  updateHideoutPlay(timestamp) {
    if (this.toySession?.kind !== "hideout" || !this.box?.occupantId) return;
    if (timestamp >= (this.toySession.nextHitAt ?? 0)) {
      this.toySession.hits += 1;
      this.toySession.nextHitAt = timestamp + 5000;
    }
  }

  updateParticles(deltaSeconds) {
    for (const particle of this.particles) {
      particle.life -= deltaSeconds;
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;
      particle.vy += particle.kind === "heart" ? -2 : 55 * deltaSeconds;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
  }

  draw(timestamp) {
    const context = this.context;
    context.clearRect(0, 0, this.width, this.height);
    if (this.box) this.drawPackItem(context, this.box.item, this.box.x + this.box.width / 2, this.box.y + this.box.height / 2, Math.max(this.box.width, this.box.height) * 1.18);
    for (const food of this.foods) this.drawPackItem(context, food.item, food.x, food.y, food.radius * 2.5);
    for (const ball of this.balls) this.drawPackItem(context, ball.item, ball.x, ball.y, ball.radius * 2.2);
    for (const pet of [...this.pets].sort((a, b) => a.y - b.y)) pet.draw(context, timestamp, this.reducedMotion || this.quiet);
    if (this.wand.active) this.drawPackItem(context, this.wand.item, this.wand.x, this.wand.y, 88 * (this.wand.item?.scale ?? 1));
    if (this.foodDrag) this.drawPackItem(context, this.foodDrag.item, this.foodDrag.x, this.foodDrag.y, this.foodDrag.radius * 2.5, 0.78);
    for (const particle of this.particles) this.drawParticle(context, particle);
  }

  resolveTarget(target) {
    if (target.reason === "food") return this.foods.find((food) => food.id === target.entityId) ?? null;
    if (target.reason === "ball") return this.balls.find((ball) => ball.id === target.entityId) ?? null;
    if (target.reason === "wand") return this.wand.active ? this.wand : null;
    if (target.reason === "box") return this.box ? { x: this.box.x + this.box.width / 2, y: this.box.y + 30 } : null;
    return target;
  }

  onPetArrived(pet, target, timestamp) {
    // Autonomous wandering must never steal the user's explicit current-pet
    // selection. Manual food/toy targets may reaffirm the pet that owns the
    // interaction, but passive movement leaves activePetId untouched.
    if (target.manual) this.setActivePet(pet.id, false);
    if (target.reason === "food") {
      const food = this.foods.find((item) => item.id === target.entityId);
      if (!food || food.petId !== pet.id) return;
      this.foods = [];
      pet.setState("eat", 1700, timestamp);
      this.spawnCrumbs(food.x, food.y, pet.color);
      this.award(pet.id, "feed");
      this.callbacks.toast(`${pet.name}收下了${food.item?.name ?? "零食"}`);
      this.callbacks.action("feed");
      this.callbacks.itemsChanged();
      this.callbacks.requestSave();
      return;
    }
    if (target.reason === "ball") {
      const ball = this.balls.find((item) => item.id === target.entityId);
      pet.setState("play", 1050, timestamp);
      if (ball) {
        ball.vx = (pet.center.x <= ball.x ? 1 : -1) * randomBetween(160, 260);
        ball.vy = -randomBetween(250, 390);
        ball.nextChaseAt = timestamp + 1000;
        if (this.toySession?.petId === pet.id) this.toySession.hits += 1;
      }
      this.callbacks.action("toy");
      return;
    }
    if (target.reason === "wand") {
      pet.setState("play", 900, timestamp);
      this.spawnToyTufts(this.wand.x, this.wand.y);
      if (this.toySession?.petId === pet.id) this.toySession.hits += 1;
      this.callbacks.action("toy");
      return;
    }
    if (target.reason === "box" && this.box) {
      pet.insideBox = true;
      pet.insideBoxUntil = timestamp + randomBetween(6500, 11000);
      pet.x = this.box.x + (this.box.width - pet.width) / 2;
      pet.y = this.box.y - pet.height + 61;
      pet.setState("idle", 0, timestamp);
      this.box.occupantId = pet.id;
      if (this.toySession?.petId === pet.id) this.toySession.hits += 1;
      this.callbacks.action("toy");
      this.callbacks.requestSave();
      return;
    }
    pet.setState("idle", 0, timestamp);
  }

  releaseBoxOccupant(pet) {
    if (this.box?.occupantId === pet.id) this.box.occupantId = null;
  }

  onPointerDown(event) {
    this.callbacks.closePopovers();
    this.pointer = { x: event.clientX, y: event.clientY, seen: true };
    const pet = this.hitPet(event.clientX, event.clientY);
    if (this.pettingMode) {
      if (pet) {
        this.pointerSession = {
          kind: "petting",
          pointerId: event.pointerId,
          item: pet,
          interaction: touchInteractionAt(pet, event.clientX, event.clientY)
        };
        this.canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      } else if (!this.pettingMode.blankHinted) {
        this.pettingMode.blankHinted = true;
        this.callbacks.toast("还没碰到宠物，再试一次；按 Esc 取消");
      }
      return;
    }
    const ball = this.hitBall(event.clientX, event.clientY);
    const food = this.hitFood(event.clientX, event.clientY);
    if (pet) {
      this.setActivePet(pet.id);
      pet.platformAttachment = null;
      pet.fallingVelocity = 0;
      this.pointerSession = {
        kind: "pet", pointerId: event.pointerId, item: pet,
        startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY,
        moved: false, offsetX: event.clientX - pet.x, offsetY: event.clientY - pet.y
      };
    } else if (ball) {
      ball.dragging = true;
      this.pointerSession = {
        kind: "ball", pointerId: event.pointerId, item: ball,
        startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY, lastAt: event.timeStamp,
        vx: 0, vy: 0, moved: false
      };
    } else if (food) {
      this.pointerSession = { kind: "food", pointerId: event.pointerId, item: food, startX: event.clientX, startY: event.clientY, moved: false };
    } else if (this.wand.active) {
      this.pointerSession = { kind: "wand", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    }
    if (this.pointerSession) {
      this.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }
  }

  onPointerMove(event) {
    this.pointer = { x: event.clientX, y: event.clientY, seen: true };
    if (this.wand.active) {
      this.wand.x = event.clientX;
      this.wand.y = event.clientY;
    }
    const session = this.pointerSession;
    if (!session || session.pointerId !== event.pointerId) {
      this.setHoveredPet(this.hitPet(event.clientX, event.clientY));
      return;
    }
    if (session.kind === "petting") return;
    const movedDistance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (movedDistance > 4) session.moved = true;
    if (session.kind === "pet" && session.moved) {
      const pet = session.item;
      pet.dragging = true;
      pet.target = null;
      pet.insideBox = false;
      this.releaseBoxOccupant(pet);
      pet.x = event.clientX - session.offsetX;
      pet.y = event.clientY - session.offsetY;
      pet.clampToStage();
      this.canvas.dataset.cursor = "drag";
    } else if (session.kind === "ball") {
      const elapsed = Math.max(8, event.timeStamp - session.lastAt);
      session.vx = ((event.clientX - session.lastX) / elapsed) * 1000;
      session.vy = ((event.clientY - session.lastY) / elapsed) * 1000;
      session.lastX = event.clientX;
      session.lastY = event.clientY;
      session.lastAt = event.timeStamp;
      session.item.x = event.clientX;
      session.item.y = event.clientY;
    } else if (session.kind === "food") {
      session.item.x = event.clientX;
      session.item.y = event.clientY;
    }
  }

  onPointerUp(event) {
    const session = this.pointerSession;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.kind === "petting") {
      const pet = session.item;
      const interaction = touchInteractionAt(pet, event.clientX, event.clientY) ?? session.interaction ?? { id: "body", event: "pet-body" };
      this.performPetting(pet, interaction);
    } else if (session.kind === "pet") {
      const pet = session.item;
      if (session.moved) {
        pet.dragging = false;
        pet.setState("idle");
        this.tryAttachToPlatform(pet).then((attached) => {
          if (!attached) this.callbacks.toast(`没有命中窗口顶边，${pet.name}会安全落回桌面`);
          this.callbacks.requestSave();
        });
      } else {
        pet.startLook(event.clientX, event.clientY - 40, 900);
        this.callbacks.petsChanged();
      }
    } else if (session.kind === "ball") {
      session.item.dragging = false;
      session.item.vx = clamp(session.vx, -560, 560);
      session.item.vy = clamp(session.vy, -600, 480);
      session.item.nextChaseAt = now() + 160;
    } else if (session.kind === "food") {
      this.assignFood(session.item);
    }
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.pointerSession = null;
    this.canvas.dataset.cursor = this.pettingMode ? "petting" : this.wand.active ? "play" : "default";
  }

  togglePettingMode() {
    if (this.pettingMode) return this.cancelPetting("button", true);
    if (!this.getActivePet()) {
      this.callbacks.toast("先选择一只要显示的宠物");
      return false;
    }
    this.clearFoodDrag(false);
    this.pettingMode = { expiresAt: now() + 15_000, blankHinted: false };
    this.canvas.dataset.cursor = "petting";
    this.callbacks.pettingChanged(true, "start");
    this.callbacks.regionsChanged(true);
    return true;
  }

  cancelPetting(reason = "cancel", announce = false) {
    if (!this.pettingMode) return false;
    this.pettingMode = null;
    if (this.pointerSession?.kind === "petting") this.pointerSession = null;
    this.canvas.dataset.cursor = this.wand.active ? "play" : "default";
    this.callbacks.pettingChanged(false, reason);
    if (announce) this.callbacks.toast("已取消摸摸");
    this.callbacks.regionsChanged(true);
    return true;
  }

  performPetting(pet, touch) {
    if (!pet) return;
    const interaction = typeof touch === "string"
      ? { id: touch, event: `pet-${touch}` }
      : { id: touch?.id ?? "body", event: touch?.event ?? `pet-${touch?.id ?? "body"}`, label: touch?.label };
    const zone = interaction.id;
    this.setActivePet(pet.id, false);
    pet.reactToPetting(typeof touch === "string" ? zone : interaction);
    const rewardAction = ["head", "back", "tail", "body"].includes(zone) ? `pet-${zone}` : "pet-body";
    const result = this.award(pet.id, rewardAction);
    const labels = { head: "头", back: "背", tail: "尾巴", body: "身体" };
    this.callbacks.toast(result.granted
      ? `${pet.name}喜欢摸${labels[zone] ?? "摸摸"} · +${result.reward} 亲密度`
      : `${pet.name}回应了你的摸摸`);
    this.callbacks.action("pet");
    this.cancelPetting("complete", false);
  }

  award(petId, action) {
    const result = awardAffinity(this.progressByPet[petId], action);
    this.progressByPet[petId] = result.progress;
    this.callbacks.progressChanged(petId, result, action);
    this.callbacks.requestSave();
    return result;
  }

  progressFor(petId) {
    return createPetProgress(this.progressByPet[petId]);
  }

  startFoodDrag(item, x, y) {
    const pet = this.getActivePet();
    if (!pet) {
      this.callbacks.toast("先选择一只要显示的宠物");
      return false;
    }
    this.cancelPetting("switch", false);
    this.clearFood("switch", false);
    this.foodDrag = { id: "food-drag", item, petId: pet.id, x, y, radius: 18 * item.scale };
    this.callbacks.itemsChanged();
    return true;
  }

  moveFoodDrag(x, y) {
    if (this.foodDrag) {
      this.foodDrag.x = x;
      this.foodDrag.y = y;
    }
  }

  finishFoodDrag(x, y, wasDragged) {
    if (!this.foodDrag) return;
    const pet = this.pets.find((candidate) => candidate.id === this.foodDrag.petId);
    if (!pet) return this.clearFoodDrag(false);
    const food = {
      id: `food-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      item: this.foodDrag.item,
      petId: pet.id,
      x: clamp(wasDragged ? x : pet.center.x + (pet.facing === "right" ? 95 : -95), 24, this.width - 24),
      y: clamp(wasDragged ? y : pet.y + pet.height * 0.72, 24, this.height - 28),
      radius: 18 * this.foodDrag.item.scale,
      createdAt: now(),
      expiresAt: now() + 45_000
    };
    this.foodDrag = null;
    this.foods = [food];
    this.assignFood(food);
    this.callbacks.toast(`放下了${food.item.name}`);
    this.callbacks.itemsChanged();
  }

  clearFoodDrag(announce = true) {
    if (!this.foodDrag) return false;
    this.foodDrag = null;
    if (announce) this.callbacks.toast("已取消投喂");
    this.callbacks.itemsChanged();
    this.callbacks.regionsChanged(true);
    return true;
  }

  assignFood(food) {
    const pet = this.pets.find((candidate) => candidate.id === food.petId);
    if (!pet) return;
    pet.walkTo(food.x, food.y, "food", { entityId: food.id, manual: true, radius: 54 });
    this.setActivePet(pet.id, false);
  }

  clearFood(reason = "manual", announce = true) {
    const hadFood = Boolean(this.foods.length || this.foodDrag);
    const ids = new Set(this.foods.map((food) => food.id));
    for (const pet of this.pets) {
      if (pet.target?.reason === "food" && ids.has(pet.target.entityId)) {
        pet.target = null;
        pet.setState("idle");
      }
    }
    if (this.pointerSession?.kind === "food" && ids.has(this.pointerSession.item?.id)) {
      this.canvas.releasePointerCapture?.(this.pointerSession.pointerId);
      this.pointerSession = null;
    }
    this.foods = [];
    this.foodDrag = null;
    if (hadFood && announce) {
      this.callbacks.toast(reason === "timeout" ? "零食先收起来了，需要时可以再放" : "未吃的零食已收起");
    }
    if (hadFood) {
      this.callbacks.itemsChanged();
      this.callbacks.regionsChanged(true);
    }
    return hadFood;
  }

  startToy(item, kind) {
    const pet = this.getActivePet();
    if (!pet) {
      this.callbacks.toast("先选择一只要显示的宠物");
      return null;
    }
    this.cancelPetting("switch", false);
    this.clearToy("switch", false);
    this.setQuiet(false);
    const startedAt = now();
    this.toySession = {
      kind,
      item,
      petId: pet.id,
      startedAt,
      expiresAt: startedAt + defaultToyDuration(item),
      hits: 0,
      lastRetargetAt: 0,
      nextHitAt: startedAt + 5000
    };
    return pet;
  }

  spawnBall(item) {
    const pet = this.startToy(item, "ball");
    if (!pet) return;
    this.balls = [{
      id: `ball-${Date.now()}`,
      x: clamp(pet.center.x + 130, 40, this.width - 40),
      y: Math.max(40, this.height * 0.38),
      radius: 18 * item.scale,
      item,
      petId: pet.id,
      vx: randomBetween(-80, 120),
      vy: -220,
      createdAt: now(),
      nextChaseAt: now() + 260,
      dragging: false
    }];
    this.callbacks.toast(`${item.name}滚出来了`);
    this.callbacks.action("toy");
    this.callbacks.itemsChanged();
  }

  startWand(item) {
    const pet = this.startToy(item, "wand");
    if (!pet) return;
    this.wand = {
      active: true,
      item,
      x: this.pointer.seen ? this.pointer.x : this.width * 0.58,
      y: this.pointer.seen ? this.pointer.y : this.height * 0.48
    };
    this.canvas.dataset.cursor = "play";
    this.callbacks.wandChanged(true);
    this.callbacks.toast(`移动指针，${item.name}会跟着你`);
    this.callbacks.action("toy");
    this.callbacks.itemsChanged();
    this.callbacks.regionsChanged(true);
  }

  spawnBox(item) {
    const pet = this.startToy(item, "hideout");
    if (!pet) return;
    const width = Math.round(136 * item.scale);
    const height = Math.round(88 * item.scale);
    this.box = {
      x: clamp(pet.center.x + 115, 18, this.width - width - 18),
      y: clamp(pet.y + 70, this.height * 0.45, this.height - height - 12),
      width, height, item, occupantId: null
    };
    pet.walkTo(this.box.x + width / 2, this.box.y + 24, "box", { manual: true, radius: 44 });
    this.callbacks.toast(`${item.name}已经摆好`);
    this.callbacks.action("toy");
    this.callbacks.itemsChanged();
  }

  clearToy(reason = "manual", announce = true) {
    const session = this.toySession;
    const hadToy = Boolean(session || this.balls.length || this.box || this.wand.active);
    if (!hadToy) return false;
    const pet = session ? this.pets.find((candidate) => candidate.id === session.petId) : null;
    const qualifies = session && now() - session.startedAt >= 15_000 && session.hits >= 3;
    if (qualifies) this.award(session.petId, "play");
    for (const candidate of this.pets) {
      if (["ball", "wand", "box"].includes(candidate.target?.reason)) candidate.target = null;
      if (candidate.insideBox) {
        candidate.insideBox = false;
        candidate.y = clamp(candidate.y, 4, this.height - candidate.height - 7);
        candidate.setState("idle");
      }
    }
    if (["ball", "wand"].includes(this.pointerSession?.kind)) {
      this.canvas.releasePointerCapture?.(this.pointerSession.pointerId);
      this.pointerSession = null;
    }
    this.balls = [];
    this.box = null;
    this.wand = { active: false, x: 0, y: 0, item: null };
    this.toySession = null;
    this.canvas.dataset.cursor = this.pettingMode ? "petting" : "default";
    this.callbacks.wandChanged(false);
    if (announce) {
      const name = session?.item?.name ?? "玩具";
      this.callbacks.toast(reason === "timeout"
        ? `${pet?.name ?? "宠物"}玩得很开心，${name}已收好`
        : `${name}已收起`);
    }
    this.callbacks.itemsChanged();
    this.callbacks.regionsChanged(true);
    return true;
  }

  cancelTransientInteractions(reason = "cancel", announce = false) {
    this.cancelPetting(reason, false);
    this.clearFood(reason, announce);
    this.clearToy(reason, announce);
    this.pointerSession = null;
  }

  setQuiet(value) {
    const next = Boolean(value);
    if (this.quiet === next) return;
    this.quiet = next;
    if (next) {
      this.cancelTransientInteractions("quiet", false);
      for (const pet of this.pets) {
        if (pet.target && !pet.target.manual) pet.target = null;
        if (!pet.dragging && !pet.target) pet.setState("idle");
      }
    }
    this.callbacks.quietChanged(next, true);
    this.callbacks.action("quiet");
    this.callbacks.requestSave();
  }

  setActivePet(id, announce = true) {
    if (!this.pets.some((pet) => pet.id === id)) return false;
    const changed = this.activePetId !== id;
    this.activePetId = id;
    if (changed) {
      if (announce) this.callbacks.toast(`当前互动：${this.getActivePet()?.name ?? id}`);
      this.callbacks.petsChanged();
      this.callbacks.requestSave();
    }
    return true;
  }

  setPetVisible(id, visible) {
    const definition = this.definitions.find((candidate) => candidate.id === id);
    if (!definition) return false;
    const existing = this.pets.find((pet) => pet.id === id);
    if (visible && !existing) {
      const actor = new PetActor(this, definition, this.petHistory[id], definition.installedIndex);
      this.pets.push(actor);
      this.pets.sort((a, b) => a.index - b.index);
      this.visiblePetIds = this.pets.map((pet) => pet.id);
      if (!this.activePetId) this.activePetId = id;
      this.callbacks.toast(`${actor.name}回到桌面了`);
    } else if (!visible && existing) {
      this.rememberPet(existing);
      if (this.foods.some((food) => food.petId === id) || this.foodDrag?.petId === id) this.clearFood("hide", false);
      if (this.toySession?.petId === id) this.clearToy("hide", false);
      this.pets = this.pets.filter((pet) => pet.id !== id);
      this.visiblePetIds = this.pets.map((pet) => pet.id);
      if (this.activePetId === id) this.activePetId = this.pets[0]?.id ?? null;
      if (!this.pets.length) this.cancelPetting("hidden", false);
      this.callbacks.toast(`${existing.name}去休息了`);
    } else {
      return false;
    }
    this.callbacks.petsChanged();
    this.callbacks.itemsChanged();
    this.callbacks.regionsChanged(true);
    void this.syncPlatformWatcher();
    this.callbacks.requestSave();
    return true;
  }

  rememberPet(pet) {
    this.petHistory[pet.id] = {
      xRatio: this.width > pet.width ? clamp(pet.x / (this.width - pet.width), -0.2, 1.2) : 0.5,
      yRatio: this.height > pet.height ? clamp(pet.y / (this.height - pet.height), 0, 1) : 0.5
    };
  }

  getActivePet() {
    return this.pets.find((pet) => pet.id === this.activePetId) ?? this.pets[0] ?? null;
  }

  installedPetSummaries() {
    return this.definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      displayName: definition.displayName,
      visible: this.visiblePetIds.includes(definition.id),
      active: this.activePetId === definition.id,
      progress: this.progressFor(definition.id)
    }));
  }

  itemsFor(category) {
    return this.itemDefinitions.filter((item) => item.category === category && item.image);
  }

  activeToy() {
    return this.toySession;
  }

  hitPet(x, y) {
    return [...this.pets].reverse().find((pet) => pet.containsPoint(x, y)) ?? null;
  }

  hitBall(x, y) {
    return [...this.balls].reverse().find((ball) => Math.hypot(ball.x - x, ball.y - y) <= Math.max(26, ball.radius * 1.1)) ?? null;
  }

  hitFood(x, y) {
    return [...this.foods].reverse().find((food) => Math.hypot(food.x - x, food.y - y) <= Math.max(26, food.radius * 1.25)) ?? null;
  }

  hitBox(x, y) {
    return Boolean(this.box && x >= this.box.x && x <= this.box.x + this.box.width && y >= this.box.y && y <= this.box.y + this.box.height);
  }

  hitInteractive(x, y) {
    const wandRadius = Math.max(32, 44 * (this.wand.item?.scale ?? 1));
    return Boolean(
      this.hitPet(x, y) || this.hitBall(x, y) || this.hitFood(x, y) || this.hitBox(x, y)
      || (this.wand.active && Math.hypot(this.wand.x - x, this.wand.y - y) <= wandRadius)
    );
  }

  setHoveredPet(pet) {
    for (const candidate of this.pets) candidate.hovered = candidate === pet;
    if (this.pointerSession?.kind === "pet") this.canvas.dataset.cursor = "drag";
    else if (this.pettingMode) this.canvas.dataset.cursor = pet ? "petting" : "default";
    else if (this.wand.active) this.canvas.dataset.cursor = "play";
    else this.canvas.dataset.cursor = pet ? "pet" : "default";
  }

  interactiveRegions() {
    const regions = [];
    for (const pet of this.pets) regions.push({ id: `pet:${pet.id}`, kind: "pet", ...roundedRegion(pet.hitBounds, 8) });
    for (const food of this.foods) {
      const radius = Math.max(26, food.radius * 1.25);
      regions.push({ id: food.id, kind: "food", x: Math.round(food.x - radius), y: Math.round(food.y - radius), width: Math.round(radius * 2), height: Math.round(radius * 2) });
    }
    for (const ball of this.balls) {
      const radius = Math.max(26, ball.radius * 1.1);
      regions.push({ id: ball.id, kind: "toy", x: Math.round(ball.x - radius), y: Math.round(ball.y - radius), width: Math.round(radius * 2), height: Math.round(radius * 2) });
    }
    if (this.box) regions.push({ id: "toy:box", kind: "toy", ...roundedRegion(this.box, 4) });
    if (this.wand.active) {
      const radius = Math.max(32, 44 * (this.wand.item?.scale ?? 1));
      regions.push({ id: "toy:wand", kind: "toy", x: Math.round(this.wand.x - radius), y: Math.round(this.wand.y - radius), width: Math.round(radius * 2), height: Math.round(radius * 2) });
    }
    if (this.foodDrag || this.pointerSession) regions.push({ id: "stage:active", kind: "stage", x: 0, y: 0, width: Math.round(this.width), height: Math.round(this.height) });
    return regions;
  }

  serialize() {
    const visibleRecords = {};
    for (const pet of this.pets) {
      this.rememberPet(pet);
      visibleRecords[pet.id] = this.petHistory[pet.id];
    }
    this.petHistory = mergePetHistory(this.petHistory, visibleRecords);
    return {
      version: 2,
      quiet: this.quiet,
      platformInteractions: this.platformInteractions,
      platformHintShown: this.platformHintShown,
      visiblePetIds: this.pets.map((pet) => pet.id),
      activePetId: this.activePetId,
      pets: { ...this.petHistory },
      progressByPet: normalizeProgressByPet(this.progressByPet)
    };
  }

  spawnHearts(x, y, color, count = 5) {
    for (let index = 0; index < count; index += 1) {
      this.particles.push({
        kind: "heart", x: x + randomBetween(-26, 26), y: y + randomBetween(-5, 15),
        vx: randomBetween(-18, 18), vy: randomBetween(-45, -24),
        life: randomBetween(0.75, 1.25), maxLife: 1.25,
        size: randomBetween(6, 11), color: index % 2 ? color : "#d96f55"
      });
    }
  }

  spawnCrumbs(x, y, color) {
    for (let index = 0; index < 8; index += 1) {
      this.particles.push({
        kind: "crumb", x: x + randomBetween(-12, 12), y: y + randomBetween(-7, 5),
        vx: randomBetween(-34, 34), vy: randomBetween(-52, -24),
        life: randomBetween(0.45, 0.9), maxLife: 0.9,
        size: randomBetween(2, 5), color
      });
    }
  }

  spawnToyTufts(x, y) {
    for (let index = 0; index < 4; index += 1) {
      this.particles.push({
        kind: "crumb", x: x + randomBetween(-8, 8), y: y + randomBetween(-8, 8),
        vx: randomBetween(-25, 25), vy: randomBetween(-35, -12),
        life: randomBetween(0.3, 0.65), maxLife: 0.65,
        size: randomBetween(2, 4), color: index % 2 ? "#e9ad66" : "#d96f55"
      });
    }
  }

  drawPackItem(context, item, x, y, size, alpha = 1) {
    if (!item?.image) return;
    context.save();
    context.globalAlpha = alpha;
    const ratio = item.image.width / item.image.height || 1;
    const width = ratio >= 1 ? size : size * ratio;
    const height = ratio >= 1 ? size / ratio : size;
    context.drawImage(item.image, x - width / 2, y - height / 2, width, height);
    context.restore();
  }

  drawParticle(context, particle) {
    const alpha = clamp(particle.life / particle.maxLife, 0, 1);
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = particle.color;
    if (particle.kind === "heart") {
      const size = particle.size;
      context.translate(particle.x, particle.y);
      context.beginPath();
      context.moveTo(0, size * 0.35);
      context.bezierCurveTo(-size * 0.9, -size * 0.2, -size * 0.45, -size, 0, -size * 0.45);
      context.bezierCurveTo(size * 0.45, -size, size * 0.9, -size * 0.2, 0, size * 0.35);
      context.fill();
    } else {
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }
}
