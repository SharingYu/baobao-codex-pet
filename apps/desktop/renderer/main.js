import { petBridge } from "./bridge.js";
import {
  ANIMATIONS,
  drawSpriteFrame,
  frameAt,
  loadImage,
  lookCellForVector
} from "./sprite.js";

const DEFAULT_PETS = [
  {
    id: "baobao",
    name: "包包",
    displayName: "包包 Baobao",
    color: "#d6a05f",
    fallbackUrl: new URL("../../../pets/baobao/spritesheet.webp", import.meta.url).href
  },
  {
    id: "feifei",
    name: "菲菲",
    displayName: "菲菲 Feifei",
    color: "#9b9496",
    fallbackUrl: new URL("../../../pets/feifei/spritesheet.webp", import.meta.url).href
  }
];

const GUIDE_STEPS = [
  {
    kicker: "第一次见面",
    title: "先和它们打个招呼",
    copy: "点击猫咪就是摸摸；按住拖动，可以把它们搬到喜欢的位置。",
    action: "pet"
  },
  {
    kicker: "一口小零食",
    title: "投喂不需要打卡",
    copy: "点“投喂”选择食物，也可以把食物直接拖到桌面。它们偶尔也会自己去吃。",
    action: "feed"
  },
  {
    kicker: "玩一小会儿",
    title: "每件玩具都有回应",
    copy: "小球会弹跳，逗猫棒跟着指针，纸箱则是永远不会过时的安全屋。",
    action: "toy"
  },
  {
    kicker: "需要专注时",
    title: "一键安静陪伴",
    copy: "开启“安静”，包包和菲菲会停下主动玩耍，安稳待在桌面边缘。",
    action: "quiet"
  }
];

const FOOD_NAMES = {
  fish: "小鱼干",
  cube: "冻干",
  can: "罐罐"
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const now = () => performance.now();

function joinAssetUrl(base, relative) {
  if (!base) return relative;
  try {
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    return new URL(relative, normalizedBase).href;
  } catch {
    return `${base.replace(/[\\/]$/, "")}/${String(relative).replace(/^[\\/]/, "")}`;
  }
}

function catalogEntries(rawCatalog) {
  if (Array.isArray(rawCatalog)) return rawCatalog;
  if (Array.isArray(rawCatalog?.pets)) return rawCatalog.pets;
  if (Array.isArray(rawCatalog?.entries)) return rawCatalog.entries;
  return [];
}

function normalizeCatalogEntry(entry) {
  const manifest = entry?.manifest ?? entry?.pet ?? entry?.petJson ?? entry ?? {};
  const id = String(entry?.id ?? manifest.id ?? "").trim();
  const atlasAssetId = manifest?.renderer?.atlasAsset;
  const declaredAtlas = Array.isArray(manifest?.assets)
    ? manifest.assets.find((asset) => asset?.id === atlasAssetId)?.path
    : undefined;
  const spritePath =
    entry?.spritesheetUrl ??
    entry?.spritesheetURL ??
    entry?.assetUrl ??
    entry?.spriteUrl ??
    manifest.spritesheetUrl ??
    manifest.spritesheetPath ??
    declaredAtlas;
  const url = entry?.assetBaseUrl && spritePath
    ? joinAssetUrl(entry.assetBaseUrl, spritePath)
    : spritePath;

  return {
    id,
    name: entry?.name ?? manifest.displayName ?? manifest.name ?? manifest.identity?.name ?? id,
    displayName: manifest.displayName ?? manifest.name ?? manifest.identity?.name ?? entry?.name ?? id,
    manifest,
    url
  };
}

function createImageCandidates(entry, fallback) {
  const candidates = [];
  if (entry?.url) candidates.push(entry.url);
  if (fallback?.fallbackUrl && !candidates.includes(fallback.fallbackUrl)) {
    candidates.push(fallback.fallbackUrl);
  }
  return candidates;
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
  throw lastError ?? new Error("No spritesheet URL was provided");
}

class PetActor {
  constructor(world, definition, savedState, index) {
    this.world = world;
    this.id = definition.id;
    this.name = definition.name;
    this.displayName = definition.displayName;
    this.color = definition.color;
    this.image = definition.image;
    this.index = index;

    this.width = index === 0 ? 178 : 164;
    this.height = this.width * (208 / 192);
    this.x = 0;
    this.y = 0;
    this.restorePosition(savedState);

    this.state = "idle";
    this.stateStartedAt = now();
    this.stateUntil = 0;
    this.facing = index === 0 ? "right" : "left";
    this.target = null;
    this.lookTarget = null;
    this.dragging = false;
    this.hovered = false;
    this.insideBox = false;
    this.insideBoxUntil = 0;
    this.nextDecisionAt = now() + randomBetween(3200, 6200) + index * 850;
  }

  restorePosition(savedState) {
    const state = savedState ?? {};
    const defaultX = [0.14, 0.69, 0.4, 0.83, 0.25, 0.56][this.index] ?? 0.5;
    const defaultY = [0.7, 0.76, 0.58, 0.66, 0.82, 0.48][this.index] ?? 0.7;
    const xRatio = Number.isFinite(state.xRatio) ? state.xRatio : defaultX;
    const yRatio = Number.isFinite(state.yRatio) ? state.yRatio : defaultY;
    this.x = xRatio * Math.max(0, this.world.width - this.width);
    this.y = yRatio * Math.max(0, this.world.height - this.height);
    this.clampToStage();
  }

  get bounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  get center() {
    return { x: this.x + this.width / 2, y: this.y + this.height * 0.58 };
  }

  get hitBounds() {
    return {
      x: this.x + this.width * 0.15,
      y: this.y + this.height * 0.14,
      width: this.width * 0.7,
      height: this.height * 0.76
    };
  }

  containsPoint(x, y) {
    const bounds = this.hitBounds;
    return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
  }

  setState(state, duration = 0, timestamp = now()) {
    if (this.state !== state) {
      this.state = state;
      this.stateStartedAt = timestamp;
    }
    this.stateUntil = duration > 0 ? timestamp + duration : 0;
  }

  walkTo(x, y, reason = "wander", options = {}) {
    this.insideBox = false;
    this.target = {
      x,
      y,
      reason,
      entityId: options.entityId,
      manual: Boolean(options.manual),
      radius: options.radius ?? 42
    };
    this.facing = x >= this.center.x ? "right" : "left";
    this.setState("walk");
  }

  pet(timestamp = now()) {
    this.target = null;
    this.lookTarget = null;
    this.setState("happy", 1700, timestamp);
    this.nextDecisionAt = timestamp + randomBetween(3800, 6500);
    this.world.spawnHearts(this.center.x, this.y + this.height * 0.22, this.color);
  }

  startLook(x, y, duration = 1700, timestamp = now()) {
    this.target = null;
    this.lookTarget = { x, y };
    this.setState("look", duration, timestamp);
  }

  update(deltaSeconds, timestamp) {
    if (this.dragging) return;

    if (this.insideBox && timestamp > this.insideBoxUntil && !this.world.quiet) {
      this.insideBox = false;
      this.walkTo(
        clamp(this.x + randomBetween(-180, 180), 0, this.world.width - this.width),
        clamp(this.y + randomBetween(-26, 22), this.world.height * 0.48, this.world.height - this.height - 10),
        "wander"
      );
    }

    if (this.world.quiet && this.target && !this.target.manual) {
      this.target = null;
      this.setState("idle");
    }

    if (this.target) {
      const dynamicTarget = this.world.resolveTarget(this.target);
      if (!dynamicTarget) {
        this.target = null;
        this.setState("idle");
      } else {
        this.target.x = dynamicTarget.x;
        this.target.y = dynamicTarget.y;
        const center = this.center;
        const dx = this.target.x - center.x;
        const dy = this.target.y - center.y;
        const length = Math.max(0.001, Math.hypot(dx, dy));

        if (length > this.target.radius) {
          const speed = this.target.reason === "ball" || this.target.reason === "wand" ? 148 : 88;
          this.x += (dx / length) * speed * deltaSeconds;
          this.y += (dy / length) * speed * deltaSeconds * 0.62;
          this.facing = dx >= 0 ? "right" : "left";
          this.setState("walk");
          this.clampToStage();
        } else {
          const arrivedTarget = this.target;
          this.target = null;
          this.world.onPetArrived(this, arrivedTarget, timestamp);
        }
      }
    }

    if (!this.target && this.stateUntil && timestamp >= this.stateUntil) {
      this.stateUntil = 0;
      this.lookTarget = null;
      this.setState("idle", 0, timestamp);
    }

    if (
      !this.world.quiet &&
      !this.target &&
      !this.insideBox &&
      this.state === "idle" &&
      timestamp >= this.nextDecisionAt
    ) {
      this.chooseAutonomousAction(timestamp);
    }
  }

  chooseAutonomousAction(timestamp) {
    const roll = Math.random();
    if (roll < 0.54) {
      const range = Math.min(300, this.world.width * 0.35);
      const targetX = clamp(
        this.center.x + randomBetween(-range, range),
        this.width * 0.45,
        this.world.width - this.width * 0.45
      );
      const targetY = clamp(
        this.center.y + randomBetween(-38, 34),
        this.world.height * 0.5,
        this.world.height - this.height * 0.35
      );
      this.walkTo(targetX, targetY, "wander");
    } else if (roll < 0.82) {
      const target = this.world.pointer.seen
        ? this.world.pointer
        : { x: randomBetween(0, this.world.width), y: randomBetween(0, this.world.height * 0.65) };
      this.startLook(target.x, target.y, randomBetween(1200, 2300), timestamp);
    } else if (roll < 0.92) {
      this.setState("waiting", randomBetween(1200, 2100), timestamp);
    } else {
      this.setState("happy", 1200, timestamp);
    }
    this.nextDecisionAt = timestamp + randomBetween(5200, 10500);
  }

  clampToStage() {
    const minX = -this.width * 0.16;
    const maxX = Math.max(minX, this.world.width - this.width * 0.84);
    const minY = 4;
    const maxY = Math.max(minY, this.world.height - this.height - 7);
    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
  }

  draw(context, timestamp, reducedMotion) {
    let row;
    let column;

    if (this.state === "look" && this.lookTarget) {
      const targetCell = lookCellForVector(
        this.lookTarget.x - this.center.x,
        this.lookTarget.y - this.center.y
      );
      if (targetCell) {
        row = targetCell.row;
        column = targetCell.column;
      }
    }

    if (row === undefined) {
      let animationName = "idle";
      if (this.state === "walk") animationName = this.facing === "right" ? "walkRight" : "walkLeft";
      if (this.state === "happy") animationName = "happy";
      if (this.state === "pounce") animationName = "pounce";
      if (this.state === "shy") animationName = "shy";
      if (this.state === "waiting") animationName = "waiting";
      if (this.state === "curious") animationName = "curious";
      if (this.state === "inspect") animationName = "inspect";
      const animation = ANIMATIONS[animationName];
      row = animation.row;
      column = frameAt(animation, timestamp - this.stateStartedAt, reducedMotion);
    }

    const drawn = drawSpriteFrame(context, this.image, row, column, this.bounds, this.dragging ? 0.92 : 1);
    if (!drawn) this.drawPlaceholder(context);
    if (this.hovered && !this.dragging) this.drawNameTag(context);
  }

  drawPlaceholder(context) {
    const center = this.center;
    context.save();
    context.fillStyle = this.color;
    context.beginPath();
    context.ellipse(center.x, center.y + 20, this.width * 0.31, this.height * 0.32, 0, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.arc(center.x, center.y - this.height * 0.18, this.width * 0.24, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(center.x - 33, center.y - 56);
    context.lineTo(center.x - 22, center.y - 92);
    context.lineTo(center.x - 5, center.y - 60);
    context.moveTo(center.x + 33, center.y - 56);
    context.lineTo(center.x + 22, center.y - 92);
    context.lineTo(center.x + 5, center.y - 60);
    context.fill();
    context.restore();
  }

  drawNameTag(context) {
    const label = this.name;
    context.save();
    context.font = '600 12px "PingFang SC", sans-serif';
    const width = context.measureText(label).width + 20;
    const x = this.x + (this.width - width) / 2;
    const y = Math.max(6, this.y + 8);
    context.fillStyle = "rgba(255,249,239,0.9)";
    context.beginPath();
    context.roundRect(x, y, width, 26, 13);
    context.fill();
    context.fillStyle = "#68534a";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, x + width / 2, y + 13);
    context.restore();
  }
}

class PetWorld {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    this.callbacks = callbacks;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.pets = [];
    this.foods = [];
    this.balls = [];
    this.box = null;
    this.wand = { active: false, x: 0, y: 0, lastRetargetAt: 0 };
    this.particles = [];
    this.pointer = { x: 0, y: 0, seen: false };
    this.pointerSession = null;
    this.foodDrag = null;
    this.quiet = false;
    this.activePetId = null;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.lastFrameAt = now();
    this.lastRegionUpdateAt = 0;
    this.running = false;
    this.resize();
    this.bindCanvasEvents();
  }

  async load(rawCatalog, savedState) {
    const shouldStartLoop = !this.running;
    const nativeEntries = catalogEntries(rawCatalog).map(normalizeCatalogEntry).filter((entry) => entry.id);
    const nativeById = new Map(nativeEntries.map((entry) => [entry.id.toLowerCase(), entry]));
    const defaultIds = new Set(DEFAULT_PETS.map((pet) => pet.id));
    const selectedDefaults = DEFAULT_PETS.map((fallback) => ({
      ...fallback,
      ...(nativeById.get(fallback.id) ?? {}),
      name: fallback.name,
      displayName: nativeById.get(fallback.id)?.displayName ?? fallback.displayName
    }));
    const extraColors = ["#8fa99a", "#c68d72", "#9b91b5", "#d2ad65", "#779ba8"];
    const selectedExtras = nativeEntries
      .filter((entry) => !defaultIds.has(entry.id.toLowerCase()))
      .map((entry, index) => ({
        ...entry,
        name: String(entry.name || entry.displayName || entry.id).split(/[\s/]/)[0],
        color: extraColors[index % extraColors.length]
      }));
    const selected = [...selectedDefaults, ...selectedExtras];

    const definitions = await Promise.all(selected.map(async (definition) => {
      let image = null;
      try {
        image = await loadFirstImage(createImageCandidates(definition, definition));
      } catch (error) {
        console.error(error);
        this.callbacks.toast(`${definition.name}的动画暂时没加载出来`);
      }
      return { ...definition, image };
    }));

    const rendererState = savedState?.rendererState ?? savedState?.petState ?? savedState ?? {};
    this.quiet = Boolean(rendererState.quiet);
    this.activePetId = rendererState.activePetId ?? null;
    this.pets = definitions.map((definition, index) => new PetActor(
      this,
      definition,
      rendererState.pets?.[definition.id],
      index
    ));
    if (!this.activePetId) this.activePetId = this.pets[0]?.id ?? null;
    this.callbacks.quietChanged(this.quiet, false);
    if (shouldStartLoop) {
      this.running = true;
      this.lastFrameAt = now();
      requestAnimationFrame((timestamp) => this.frame(timestamp));
    }
  }

  async reloadCatalog(rawCatalog) {
    const currentState = this.serialize();
    const previousPets = this.pets;
    try {
      await this.load(rawCatalog, currentState);
      if (!this.pets.length) this.pets = previousPets;
    } catch (error) {
      this.pets = previousPets;
      throw error;
    }
  }

  resize() {
    const previousWidth = this.width;
    const previousHeight = this.height;
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";

    if (this.pets?.length && previousWidth > 1 && previousHeight > 1) {
      for (const pet of this.pets) {
        pet.x *= this.width / previousWidth;
        pet.y *= this.height / previousHeight;
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
    const deltaSeconds = Math.min(0.04, Math.max(0, (timestamp - this.lastFrameAt) / 1000));
    this.lastFrameAt = timestamp;
    this.update(deltaSeconds, timestamp);
    this.draw(timestamp);
    if (timestamp - this.lastRegionUpdateAt > 180) {
      this.lastRegionUpdateAt = timestamp;
      this.callbacks.regionsChanged();
    }
    requestAnimationFrame((nextTimestamp) => this.frame(nextTimestamp));
  }

  update(deltaSeconds, timestamp) {
    this.updateBalls(deltaSeconds, timestamp);
    this.updateWand(timestamp);
    for (const pet of this.pets) pet.update(deltaSeconds, timestamp);
    this.updateParticles(deltaSeconds);
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
        if (Math.abs(ball.vy) > 34) ball.vy *= -0.62;
        else ball.vy = 0;
        ball.vx *= 0.94;
      }

      if (!this.quiet && timestamp > ball.nextChaseAt) {
        const pet = this.nearestPet(ball.x, ball.y, (candidate) => !candidate.dragging);
        if (pet && !pet.insideBox) {
          pet.walkTo(ball.x, ball.y, "ball", { entityId: ball.id, manual: true, radius: 56 });
          ball.nextChaseAt = timestamp + 520;
        }
      }
    }
    this.balls = this.balls.filter((ball) => timestamp - ball.createdAt < 45000);
  }

  updateWand(timestamp) {
    if (!this.wand.active || this.quiet || timestamp - this.wand.lastRetargetAt < 160) return;
    const pet = this.nearestPet(this.wand.x, this.wand.y, (candidate) => !candidate.dragging);
    if (pet && !pet.insideBox) {
      pet.walkTo(this.wand.x, this.wand.y, "wand", { manual: true, radius: 52 });
      this.wand.lastRetargetAt = timestamp;
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
    if (this.box) this.drawBoxBack(context, this.box);
    for (const food of this.foods) this.drawFood(context, food);
    for (const ball of this.balls) this.drawBall(context, ball);
    for (const pet of [...this.pets].sort((a, b) => a.y - b.y)) {
      pet.draw(context, timestamp, this.reducedMotion || this.quiet);
    }
    if (this.box) this.drawBoxFront(context, this.box);
    if (this.wand.active) this.drawWand(context);
    if (this.foodDrag) this.drawFood(context, this.foodDrag, 0.78);
    for (const particle of this.particles) this.drawParticle(context, particle);
  }

  resolveTarget(target) {
    if (target.reason === "food") {
      return this.foods.find((food) => food.id === target.entityId) ?? null;
    }
    if (target.reason === "ball") {
      return this.balls.find((ball) => ball.id === target.entityId) ?? null;
    }
    if (target.reason === "wand") {
      return this.wand.active ? this.wand : null;
    }
    if (target.reason === "box") {
      return this.box ? { x: this.box.x + this.box.width / 2, y: this.box.y + 30 } : null;
    }
    return target;
  }

  onPetArrived(pet, target, timestamp) {
    this.activePetId = pet.id;
    if (target.reason === "food") {
      const food = this.foods.find((item) => item.id === target.entityId);
      if (!food) return;
      this.foods = this.foods.filter((item) => item.id !== food.id);
      pet.setState("inspect", 520, timestamp);
      setTimeout(() => {
        pet.setState("happy", 1550);
        this.spawnCrumbs(food.x, food.y, pet.color);
      }, 400);
      this.callbacks.toast(`${pet.name}收下了${FOOD_NAMES[food.type] ?? "零食"}`);
      this.callbacks.action("feed");
      this.callbacks.requestSave();
      return;
    }

    if (target.reason === "ball") {
      const ball = this.balls.find((item) => item.id === target.entityId);
      pet.setState("pounce", 1050, timestamp);
      if (ball) {
        const direction = pet.center.x <= ball.x ? 1 : -1;
        ball.vx = direction * randomBetween(160, 260);
        ball.vy = -randomBetween(250, 390);
        ball.nextChaseAt = timestamp + 1000;
      }
      this.callbacks.action("toy");
      return;
    }

    if (target.reason === "wand") {
      pet.setState("pounce", 900, timestamp);
      this.spawnToyTufts(this.wand.x, this.wand.y);
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
      this.callbacks.action("toy");
      this.callbacks.requestSave();
      return;
    }

    pet.setState("idle", 0, timestamp);
  }

  onPointerDown(event) {
    this.closeTransientUi();
    this.pointer.seen = true;
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    const pet = this.hitPet(event.clientX, event.clientY);
    const ball = this.hitBall(event.clientX, event.clientY);
    const food = this.hitFood(event.clientX, event.clientY);

    if (pet) {
      this.activePetId = pet.id;
      this.pointerSession = {
        kind: "pet",
        pointerId: event.pointerId,
        item: pet,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        offsetX: event.clientX - pet.x,
        offsetY: event.clientY - pet.y
      };
    } else if (ball) {
      ball.dragging = true;
      this.pointerSession = {
        kind: "ball",
        pointerId: event.pointerId,
        item: ball,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        lastAt: event.timeStamp,
        vx: 0,
        vy: 0,
        moved: false
      };
    } else if (food) {
      this.pointerSession = {
        kind: "food",
        pointerId: event.pointerId,
        item: food,
        startX: event.clientX,
        startY: event.clientY,
        moved: false
      };
    } else if (this.wand.active) {
      this.pointerSession = {
        kind: "wand",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false
      };
    }

    if (this.pointerSession) {
      this.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }
  }

  onPointerMove(event) {
    this.pointer.seen = true;
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    if (this.wand.active) {
      this.wand.x = event.clientX;
      this.wand.y = event.clientY;
    }

    const session = this.pointerSession;
    if (!session || session.pointerId !== event.pointerId) {
      this.setHoveredPet(this.hitPet(event.clientX, event.clientY));
      return;
    }

    const movedDistance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (movedDistance > 4) session.moved = true;

    if (session.kind === "pet" && session.moved) {
      const pet = session.item;
      pet.dragging = true;
      pet.target = null;
      pet.insideBox = false;
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

    if (session.kind === "pet") {
      const pet = session.item;
      if (session.moved) {
        pet.dragging = false;
        pet.setState("idle");
        this.callbacks.toast(`${pet.name}就待在这里`);
        this.callbacks.requestSave();
      } else {
        this.petPet(pet);
      }
    } else if (session.kind === "ball") {
      session.item.dragging = false;
      session.item.vx = clamp(session.vx, -560, 560);
      session.item.vy = clamp(session.vy, -600, 480);
      session.item.nextChaseAt = now() + 160;
      this.callbacks.action("toy");
    } else if (session.kind === "food") {
      this.assignFood(session.item);
    }

    this.canvas.releasePointerCapture?.(event.pointerId);
    this.pointerSession = null;
    this.canvas.dataset.cursor = this.wand.active ? "play" : "default";
  }

  petPet(pet = this.getActivePet()) {
    if (!pet) return;
    this.activePetId = pet.id;
    pet.pet();
    this.callbacks.toast(`${pet.name}眯起了眼睛`);
    this.callbacks.action("pet");
    this.callbacks.requestSave();
  }

  startFoodDrag(type, x, y) {
    this.foodDrag = { id: "food-drag", type, x, y, radius: 18 };
  }

  moveFoodDrag(x, y) {
    if (!this.foodDrag) return;
    this.foodDrag.x = x;
    this.foodDrag.y = y;
  }

  finishFoodDrag(x, y, wasDragged) {
    if (!this.foodDrag) return;
    const activePet = this.getActivePet() ?? this.pets[0];
    const suggestedX = activePet ? activePet.center.x + (activePet.facing === "right" ? 95 : -95) : this.width / 2;
    const suggestedY = activePet ? activePet.y + activePet.height * 0.72 : this.height * 0.72;
    const food = {
      id: `food-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: this.foodDrag.type,
      x: clamp(wasDragged ? x : suggestedX, 24, this.width - 24),
      y: clamp(wasDragged ? y : suggestedY, 24, this.height - 28),
      radius: 18,
      createdAt: now()
    };
    this.foodDrag = null;
    this.foods.push(food);
    this.assignFood(food);
    this.callbacks.toast(`放下了${FOOD_NAMES[food.type]}`);
  }

  assignFood(food) {
    const pet = this.nearestPet(food.x, food.y, (candidate) => !candidate.dragging);
    if (!pet) return;
    pet.walkTo(food.x, food.y, "food", { entityId: food.id, manual: true, radius: 54 });
    this.activePetId = pet.id;
    this.callbacks.action("feed");
  }

  spawnBall() {
    this.setQuiet(false);
    const activePet = this.getActivePet();
    const x = activePet ? clamp(activePet.center.x + 130, 40, this.width - 40) : this.width / 2;
    const ball = {
      id: `ball-${Date.now()}`,
      x,
      y: Math.max(40, this.height * 0.38),
      radius: 16,
      vx: randomBetween(-80, 120),
      vy: -220,
      createdAt: now(),
      nextChaseAt: now() + 260,
      dragging: false
    };
    this.balls.push(ball);
    this.callbacks.toast("小球滚出来了");
    this.callbacks.action("toy");
  }

  toggleWand(force) {
    const next = force ?? !this.wand.active;
    if (next) this.setQuiet(false);
    this.wand.active = next;
    this.wand.x = this.pointer.seen ? this.pointer.x : this.width * 0.58;
    this.wand.y = this.pointer.seen ? this.pointer.y : this.height * 0.48;
    this.canvas.dataset.cursor = next ? "play" : "default";
    this.callbacks.wandChanged(next);
    this.callbacks.regionsChanged(true);
    if (next) {
      this.callbacks.toast("移动指针，逗猫棒会跟着你");
      this.callbacks.action("toy");
    } else {
      for (const pet of this.pets) {
        if (pet.target?.reason === "wand") pet.target = null;
      }
    }
  }

  spawnBox() {
    this.setQuiet(false);
    const width = 136;
    const height = 88;
    const activePet = this.getActivePet();
    this.box = {
      x: clamp((activePet?.center.x ?? this.width * 0.6) + 115, 18, this.width - width - 18),
      y: clamp((activePet?.y ?? this.height * 0.68) + 70, this.height * 0.45, this.height - height - 12),
      width,
      height,
      occupantId: null
    };
    const pet = this.nearestPet(this.box.x + width / 2, this.box.y, (candidate) => !candidate.dragging);
    pet?.walkTo(this.box.x + width / 2, this.box.y + 24, "box", { manual: true, radius: 44 });
    this.callbacks.toast("纸箱已经摆好，猫会自己决定要不要进去");
    this.callbacks.action("toy");
  }

  setQuiet(value) {
    const next = Boolean(value);
    if (this.quiet === next) return;
    this.quiet = next;
    if (next) {
      this.toggleWand(false);
      for (const pet of this.pets) {
        if (pet.target && !pet.target.manual) pet.target = null;
        if (!pet.dragging && !pet.target) pet.setState("idle");
      }
    }
    this.callbacks.quietChanged(next, true);
    this.callbacks.action("quiet");
    this.callbacks.requestSave();
  }

  getActivePet() {
    return this.pets.find((pet) => pet.id === this.activePetId) ?? this.pets[0] ?? null;
  }

  nearestPet(x, y, predicate = () => true) {
    return this.pets
      .filter(predicate)
      .map((pet) => ({ pet, value: Math.hypot(pet.center.x - x, pet.center.y - y) }))
      .sort((a, b) => a.value - b.value)[0]?.pet ?? null;
  }

  hitPet(x, y) {
    return [...this.pets].reverse().find((pet) => pet.containsPoint(x, y)) ?? null;
  }

  hitBall(x, y) {
    return [...this.balls].reverse().find((ball) => Math.hypot(ball.x - x, ball.y - y) <= ball.radius + 8) ?? null;
  }

  hitFood(x, y) {
    return [...this.foods].reverse().find((food) => Math.hypot(food.x - x, food.y - y) <= food.radius + 8) ?? null;
  }

  hitInteractive(x, y) {
    return Boolean(this.hitPet(x, y) || this.hitBall(x, y) || this.hitFood(x, y) || this.hitBox(x, y) || this.wand.active);
  }

  hitBox(x, y) {
    return this.box && x >= this.box.x && x <= this.box.x + this.box.width && y >= this.box.y && y <= this.box.y + this.box.height;
  }

  setHoveredPet(pet) {
    for (const candidate of this.pets) candidate.hovered = candidate === pet;
    if (this.pointerSession?.kind === "pet") this.canvas.dataset.cursor = "drag";
    else if (this.wand.active) this.canvas.dataset.cursor = "play";
    else this.canvas.dataset.cursor = pet ? "pet" : "default";
  }

  closeTransientUi() {
    this.callbacks.closePopovers();
  }

  interactiveRegions() {
    const regions = [];
    for (const pet of this.pets) {
      const bounds = pet.hitBounds;
      regions.push({ id: `pet:${pet.id}`, kind: "pet", ...roundedRegion(bounds, 8) });
    }
    for (const food of this.foods) {
      regions.push({
        id: food.id,
        kind: "food",
        x: Math.round(food.x - 26),
        y: Math.round(food.y - 26),
        width: 52,
        height: 52
      });
    }
    for (const ball of this.balls) {
      regions.push({
        id: ball.id,
        kind: "toy",
        x: Math.round(ball.x - 26),
        y: Math.round(ball.y - 26),
        width: 52,
        height: 52
      });
    }
    if (this.box) regions.push({ id: "toy:box", kind: "toy", ...roundedRegion(this.box, 4) });
    if (this.wand.active || this.foodDrag || this.pointerSession) {
      regions.push({ id: "stage:active", kind: "stage", x: 0, y: 0, width: Math.round(this.width), height: Math.round(this.height) });
    }
    return regions;
  }

  serialize() {
    const petState = {};
    for (const pet of this.pets) {
      petState[pet.id] = {
        xRatio: this.width > pet.width ? clamp(pet.x / (this.width - pet.width), -0.2, 1.2) : 0.5,
        yRatio: this.height > pet.height ? clamp(pet.y / (this.height - pet.height), 0, 1) : 0.5
      };
    }
    return {
      version: 1,
      quiet: this.quiet,
      activePetId: this.activePetId,
      pets: petState
    };
  }

  spawnHearts(x, y, color) {
    for (let index = 0; index < 5; index += 1) {
      this.particles.push({
        kind: "heart",
        x: x + randomBetween(-26, 26),
        y: y + randomBetween(-5, 15),
        vx: randomBetween(-18, 18),
        vy: randomBetween(-45, -24),
        life: randomBetween(0.75, 1.25),
        maxLife: 1.25,
        size: randomBetween(6, 11),
        color: index % 2 ? color : "#d96f55"
      });
    }
  }

  spawnCrumbs(x, y, color) {
    for (let index = 0; index < 8; index += 1) {
      this.particles.push({
        kind: "crumb",
        x: x + randomBetween(-12, 12),
        y: y + randomBetween(-7, 5),
        vx: randomBetween(-34, 34),
        vy: randomBetween(-52, -24),
        life: randomBetween(0.45, 0.9),
        maxLife: 0.9,
        size: randomBetween(2, 5),
        color
      });
    }
  }

  spawnToyTufts(x, y) {
    for (let index = 0; index < 4; index += 1) {
      this.particles.push({
        kind: "crumb",
        x: x + randomBetween(-8, 8),
        y: y + randomBetween(-8, 8),
        vx: randomBetween(-25, 25),
        vy: randomBetween(-35, -12),
        life: randomBetween(0.3, 0.65),
        maxLife: 0.65,
        size: randomBetween(2, 4),
        color: index % 2 ? "#e9ad66" : "#d96f55"
      });
    }
  }

  drawFood(context, food, alpha = 1) {
    context.save();
    context.globalAlpha = alpha;
    context.translate(food.x, food.y);
    if (food.type === "fish") {
      context.fillStyle = "#df8460";
      context.beginPath();
      context.ellipse(-2, 0, 15, 9, -0.08, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(10, 0);
      context.lineTo(23, -10);
      context.lineTo(22, 10);
      context.closePath();
      context.fillStyle = "#c76b50";
      context.fill();
      context.fillStyle = "#fff8e9";
      context.beginPath();
      context.arc(-9, -2, 2, 0, Math.PI * 2);
      context.fill();
    } else if (food.type === "cube") {
      context.rotate(0.12);
      context.fillStyle = "#ba774d";
      context.beginPath();
      context.roundRect(-14, -14, 28, 28, 7);
      context.fill();
      context.fillStyle = "rgba(255,255,255,0.2)";
      context.beginPath();
      context.roundRect(-10, -10, 16, 7, 3);
      context.fill();
    } else {
      context.fillStyle = "#8da995";
      context.beginPath();
      context.roundRect(-15, -13, 30, 26, 6);
      context.fill();
      context.fillStyle = "#dfe8dc";
      context.fillRect(-15, -9, 30, 6);
      context.fillStyle = "#f5d9c5";
      context.beginPath();
      context.arc(0, 3, 5, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  drawBall(context, ball) {
    const gradient = context.createRadialGradient(ball.x - 6, ball.y - 7, 2, ball.x, ball.y, ball.radius);
    gradient.addColorStop(0, "#fff4cd");
    gradient.addColorStop(0.22, "#e88363");
    gradient.addColorStop(1, "#bd5a47");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    context.fill();
  }

  drawBoxBack(context, box) {
    context.save();
    context.fillStyle = "#bd8550";
    context.beginPath();
    context.roundRect(box.x, box.y + 20, box.width, box.height - 20, 6);
    context.fill();
    context.fillStyle = "#d7aa73";
    context.beginPath();
    context.moveTo(box.x + 2, box.y + 22);
    context.lineTo(box.x + 24, box.y - 5);
    context.lineTo(box.x + box.width / 2, box.y + 20);
    context.closePath();
    context.fill();
    context.beginPath();
    context.moveTo(box.x + box.width - 2, box.y + 22);
    context.lineTo(box.x + box.width - 25, box.y - 5);
    context.lineTo(box.x + box.width / 2, box.y + 20);
    context.closePath();
    context.fill();
    context.restore();
  }

  drawBoxFront(context, box) {
    context.save();
    context.fillStyle = "#c99258";
    context.beginPath();
    context.roundRect(box.x, box.y + 41, box.width, box.height - 41, [2, 2, 7, 7]);
    context.fill();
    context.fillStyle = "rgba(111,70,39,0.2)";
    context.fillRect(box.x + box.width / 2 - 1, box.y + 43, 2, box.height - 45);
    context.strokeStyle = "rgba(111,70,39,0.22)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(box.x + 11, box.y + 51);
    context.lineTo(box.x + box.width - 11, box.y + 51);
    context.stroke();
    context.restore();
  }

  drawWand(context) {
    const { x, y } = this.wand;
    context.save();
    context.strokeStyle = "#6f5d55";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(x - 60, y - 76);
    context.lineTo(x - 6, y - 10);
    context.stroke();
    context.strokeStyle = "rgba(111,93,85,0.55)";
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(x - 6, y - 10);
    context.quadraticCurveTo(x + 4, y - 4, x, y + 3);
    context.stroke();
    context.fillStyle = "#d96f55";
    context.beginPath();
    context.ellipse(x + 3, y + 4, 13, 6, 0.5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#efb875";
    context.beginPath();
    context.ellipse(x - 4, y + 7, 11, 5, -0.28, 0, Math.PI * 2);
    context.fill();
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

function roundedRegion(bounds, padding = 0) {
  return {
    x: Math.round(bounds.x - padding),
    y: Math.round(bounds.y - padding),
    width: Math.round(bounds.width + padding * 2),
    height: Math.round(bounds.height + padding * 2)
  };
}

class OnboardingGuide {
  constructor(elements, savedDone, onComplete) {
    this.elements = elements;
    this.index = 0;
    this.done = Boolean(savedDone);
    this.onComplete = onComplete;
    elements.next.addEventListener("click", () => this.next());
    elements.skip.addEventListener("click", () => this.complete());
  }

  show() {
    if (this.done) return;
    this.elements.root.hidden = false;
    this.render();
  }

  render() {
    const step = GUIDE_STEPS[this.index];
    this.elements.kicker.textContent = step.kicker;
    this.elements.title.textContent = step.title;
    this.elements.copy.textContent = step.copy;
    this.elements.next.textContent = this.index === GUIDE_STEPS.length - 1 ? "开始陪伴" : "下一步";
    [...this.elements.progress.children].forEach((node, index) => {
      node.classList.toggle("is-done", index < this.index);
      node.classList.toggle("is-current", index === this.index);
    });
  }

  next() {
    if (this.index >= GUIDE_STEPS.length - 1) {
      this.complete();
      return;
    }
    this.index += 1;
    this.render();
  }

  noteAction(action) {
    if (this.done || GUIDE_STEPS[this.index]?.action !== action) return;
    window.setTimeout(() => this.next(), 420);
  }

  complete() {
    this.done = true;
    this.elements.root.hidden = true;
    this.onComplete();
  }
}

class DesktopPetApp {
  constructor() {
    this.elements = {
      canvas: document.querySelector("#pet-stage"),
      actionShell: document.querySelector("#action-shell"),
      foodPopover: document.querySelector("#food-popover"),
      toyPopover: document.querySelector("#toy-popover"),
      petpackPopover: document.querySelector("#petpack-popover"),
      petButton: document.querySelector("#pet-button"),
      feedButton: document.querySelector("#feed-button"),
      toyButton: document.querySelector("#toy-button"),
      quietButton: document.querySelector("#quiet-button"),
      petpackButton: document.querySelector("#petpack-button"),
      importPetpackButton: document.querySelector("#import-petpack-button"),
      quietStatus: document.querySelector("#quiet-status"),
      guide: document.querySelector("#guide"),
      guideKicker: document.querySelector("#guide-kicker"),
      guideTitle: document.querySelector("#guide-title"),
      guideCopy: document.querySelector("#guide-copy"),
      guideNext: document.querySelector("#guide-next"),
      guideSkip: document.querySelector("#guide-skip"),
      guideProgress: document.querySelector(".guide-progress"),
      toastStack: document.querySelector("#toast-stack")
    };
    this.world = new PetWorld(this.elements.canvas, {
      toast: (message) => this.toast(message),
      action: (action) => this.guide?.noteAction(action),
      requestSave: () => this.requestSave(),
      quietChanged: (quiet, announce) => this.onQuietChanged(quiet, announce),
      wandChanged: (active) => this.onWandChanged(active),
      regionsChanged: (force) => this.publishRegions(force),
      closePopovers: () => this.closePopovers()
    });
    this.guide = null;
    this.saveTimer = null;
    this.lastRegionsJson = "";
    this.lastHoverState = null;
    this.foodPointerSession = null;
    this.unsubscribeState = () => {};
    this.unsubscribeCatalog = () => {};
    this.bindUi();
  }

  async start() {
    const [catalog, savedState, shellState] = await Promise.all([
      petBridge.loadPetCatalog(),
      petBridge.loadState(),
      petBridge.loadShellState()
    ]);
    const rendererState = savedState?.rendererState ?? savedState?.petState ?? savedState ?? {};
    this.guide = new OnboardingGuide(
      {
        root: this.elements.guide,
        kicker: this.elements.guideKicker,
        title: this.elements.guideTitle,
        copy: this.elements.guideCopy,
        next: this.elements.guideNext,
        skip: this.elements.guideSkip,
        progress: this.elements.guideProgress
      },
      rendererState.guideDone,
      () => {
        this.toast("准备好了，随时和它们玩");
        this.requestSave();
        this.publishRegions(true);
      }
    );

    await this.world.load(catalog, savedState);
    if (typeof shellState?.quiet === "boolean" && shellState.quiet !== this.world.quiet) {
      this.world.quiet = shellState.quiet;
      this.onQuietChanged(shellState.quiet, false);
    }
    window.setTimeout(() => {
      this.guide.show();
      this.publishRegions(true);
    }, 650);
    this.unsubscribeState = petBridge.onStateChanged((state) => this.applyExternalState(state));
    this.unsubscribeCatalog = petBridge.onCatalogChanged((payload) => {
      const nextCatalog = payload?.catalog ?? payload;
      this.world.reloadCatalog(nextCatalog).then(() => {
        this.toast("宠物目录已更新");
        this.requestSave();
      }).catch((error) => console.error("Unable to refresh pet catalog", error));
    });
    this.publishRegions(true);
  }

  bindUi() {
    this.elements.petButton.addEventListener("click", () => this.world.petPet());
    this.elements.feedButton.addEventListener("click", () => this.togglePopover("food"));
    this.elements.toyButton.addEventListener("click", () => this.togglePopover("toy"));
    this.elements.quietButton.addEventListener("click", () => this.world.setQuiet(!this.world.quiet));
    this.elements.petpackButton.addEventListener("click", () => this.togglePopover("petpack"));
    this.elements.importPetpackButton.addEventListener("click", () => this.importPetpack());

    for (const button of this.elements.foodPopover.querySelectorAll("[data-food]")) {
      button.addEventListener("pointerdown", (event) => this.beginFoodPointer(event, button.dataset.food));
    }

    for (const button of this.elements.toyPopover.querySelectorAll("[data-toy]")) {
      button.addEventListener("click", () => {
        const toy = button.dataset.toy;
        this.closePopovers();
        if (toy === "ball") this.world.spawnBall();
        if (toy === "wand") this.world.toggleWand();
        if (toy === "box") this.world.spawnBox();
      });
    }

    window.addEventListener("pointermove", (event) => {
      if (this.foodPointerSession) this.moveFoodPointer(event);
      if (this.world.wand.active) {
        this.world.pointer = { x: event.clientX, y: event.clientY, seen: true };
        this.world.wand.x = event.clientX;
        this.world.wand.y = event.clientY;
      }
      this.updatePointerHover(event);
    }, true);
    window.addEventListener("pointerup", (event) => this.endFoodPointer(event), true);
    window.addEventListener("pointercancel", (event) => this.endFoodPointer(event), true);
    window.addEventListener("resize", () => {
      this.world.resize();
      this.publishRegions(true);
    });
    window.addEventListener("blur", () => this.setPointerHover(false));
    window.addEventListener("beforeunload", () => {
      this.unsubscribeState();
      this.unsubscribeCatalog();
      this.saveNow();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.closePopovers();
        if (this.world.wand.active) this.world.toggleWand(false);
      }
      if (event.altKey && event.key === "1") this.world.petPet();
      if (event.altKey && event.key === "4") this.world.setQuiet(!this.world.quiet);
    });
  }

  beginFoodPointer(event, type) {
    event.preventDefault();
    event.stopPropagation();
    this.foodPointerSession = {
      pointerId: event.pointerId,
      type,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    this.world.startFoodDrag(type, event.clientX, event.clientY);
    this.publishRegions(true);
  }

  moveFoodPointer(event) {
    const session = this.foodPointerSession;
    if (!session || session.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > 5) {
      session.moved = true;
      this.closePopovers();
    }
    this.world.moveFoodDrag(event.clientX, event.clientY);
  }

  endFoodPointer(event) {
    const session = this.foodPointerSession;
    if (!session || session.pointerId !== event.pointerId) return;
    this.world.finishFoodDrag(event.clientX, event.clientY, session.moved);
    this.foodPointerSession = null;
    this.closePopovers();
    this.publishRegions(true);
  }

  togglePopover(name) {
    const mapping = {
      food: [this.elements.foodPopover, this.elements.feedButton],
      toy: [this.elements.toyPopover, this.elements.toyButton],
      petpack: [this.elements.petpackPopover, this.elements.petpackButton]
    };
    const [popover, button] = mapping[name];
    const willOpen = popover.hidden;
    this.closePopovers();
    popover.hidden = !willOpen;
    button.classList.toggle("is-active", willOpen);
    button.setAttribute("aria-expanded", String(willOpen));
    this.publishRegions(true);
  }

  closePopovers() {
    const pairs = [
      [this.elements.foodPopover, this.elements.feedButton],
      [this.elements.toyPopover, this.elements.toyButton],
      [this.elements.petpackPopover, this.elements.petpackButton]
    ];
    for (const [popover, button] of pairs) {
      popover.hidden = true;
      button.classList.remove("is-active");
      button.setAttribute("aria-expanded", "false");
    }
    this.publishRegions(true);
  }

  async importPetpack() {
    this.closePopovers();
    if (!petBridge.canImportPetpack) {
      this.toast("浏览器预览中无法导入，桌面程序里可以使用");
      return;
    }
    this.elements.importPetpackButton.disabled = true;
    try {
      const result = await petBridge.importPetpack();
      if (result?.canceled || result?.cancelled) return;
      if (result?.error) throw new Error(result.error);
      const catalog = result?.catalog ?? await petBridge.loadPetCatalog();
      await this.world.reloadCatalog(catalog);
      const name = result?.manifest?.displayName ?? result?.manifest?.name ?? result?.petId ?? "新宠物";
      this.toast(`${name}已经加入宠物目录`);
      this.requestSave();
    } catch (error) {
      console.error(error);
      this.toast(error?.message ? `导入失败：${error.message}` : "宠物包没有导入成功");
    } finally {
      this.elements.importPetpackButton.disabled = false;
    }
  }

  onQuietChanged(quiet, announce) {
    document.body.classList.toggle("is-quiet", quiet);
    this.elements.quietButton.setAttribute("aria-pressed", String(quiet));
    this.elements.quietButton.classList.toggle("is-active", quiet);
    this.elements.quietStatus.hidden = !quiet;
    if (announce) this.toast(quiet ? "包包和菲菲安静下来了" : "恢复自在活动");
    if (announce) petBridge.setShellState({ quiet });
    this.publishRegions(true);
  }

  onWandChanged(active) {
    this.elements.toyButton.classList.toggle("is-active", active);
    this.elements.toyButton.setAttribute("aria-pressed", String(active));
    this.publishRegions(true);
  }

  applyExternalState(state) {
    if (!state || typeof state !== "object") return;
    if (typeof state.quiet === "boolean" && state.quiet !== this.world.quiet) {
      this.world.setQuiet(state.quiet);
    }
  }

  requestSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 350);
  }

  saveNow() {
    window.clearTimeout(this.saveTimer);
    const rendererState = {
      ...this.world.serialize(),
      guideDone: Boolean(this.guide?.done)
    };
    petBridge.saveState(rendererState);
  }

  toast(message) {
    if (!message) return;
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    this.elements.toastStack.append(node);
    window.setTimeout(() => {
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), 190);
    }, 2200);
  }

  collectDomRegions() {
    const selectors = [
      [this.elements.actionShell, "ui:actions", "ui"],
      [this.elements.foodPopover, "ui:food-popover", "ui"],
      [this.elements.toyPopover, "ui:toy-popover", "ui"],
      [this.elements.petpackPopover, "ui:petpack-popover", "ui"],
      [this.elements.guide, "ui:guide", "ui"]
    ];
    const result = [];
    for (const [element, id, kind] of selectors) {
      if (!element || element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      result.push({ id, kind, ...roundedRegion(rect, 5) });
    }
    return result;
  }

  publishRegions(force = false) {
    const regions = [...this.world.interactiveRegions(), ...this.collectDomRegions()];
    const json = JSON.stringify(regions);
    if (!force && json === this.lastRegionsJson) return;
    this.lastRegionsJson = json;
    petBridge.setInteractiveRegions(regions);
  }

  updatePointerHover(event) {
    const targetIsUi = event.target instanceof Element && Boolean(event.target.closest("button, [role='dialog'], nav"));
    const worldHit = this.world.hitInteractive(event.clientX, event.clientY);
    this.setPointerHover(targetIsUi || worldHit);
  }

  setPointerHover(isHovering) {
    const next = Boolean(isHovering);
    if (this.lastHoverState === next) return;
    this.lastHoverState = next;
    petBridge.setPointerHover(next);
  }
}

const app = new DesktopPetApp();
app.start().catch((error) => {
  console.error("Desktop pet failed to start", error);
  app.toast("桌面宠物启动时遇到问题，请重新打开程序");
});
