import { ANIMATIONS, drawSpriteFrame, lookCellForVector } from "./sprite.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const randomBetween = (min, max) => min + Math.random() * (max - min);

const EVENT_FALLBACKS = Object.freeze({
  idle: "idle",
  walk: "walkRight",
  happy: "happy",
  pounce: "pounce",
  shy: "shy",
  waiting: "waiting",
  curious: "curious",
  inspect: "inspect",
  "pet-head": "happy",
  "pet-back": "happy",
  "pet-tail": "shy",
  "pet-body": "curious",
  eat: "inspect",
  play: "pounce",
  fall: "pounce",
  land: "waiting",
  "platform-idle": "idle",
  "platform-walk-right": "walkRight",
  "platform-walk-left": "walkLeft"
});

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    const xi = Number(currentPoint?.[0] ?? currentPoint?.x);
    const yi = Number(currentPoint?.[1] ?? currentPoint?.y);
    const xj = Number(previousPoint?.[0] ?? previousPoint?.x);
    const yj = Number(previousPoint?.[1] ?? previousPoint?.y);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 0.00001) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function zoneContains(zone, x, y) {
  const points = zone?.points ?? zone?.polygon;
  if (Array.isArray(points) && points.length >= 3) return pointInPolygon(x, y, points);
  const value = zone?.rect ?? zone?.bounds ?? zone;
  const rect = Array.isArray(value)
    ? { x: value[0], y: value[1], width: value[2], height: value[3] }
    : value;
  if (!rect) return false;
  const left = Number(rect.x ?? rect.left);
  const top = Number(rect.y ?? rect.top);
  const width = Number(rect.width ?? (Number(rect.right) - left));
  const height = Number(rect.height ?? (Number(rect.bottom) - top));
  return [left, top, width, height].every(Number.isFinite)
    && x >= left && x <= left + width && y >= top && y <= top + height;
}

function sequenceIndex(durations, elapsed, reducedMotion, loop = true) {
  if (reducedMotion) return 0;
  const normalized = durations.map((duration) => Math.max(24, Number(duration) || 120));
  const total = normalized.reduce((sum, duration) => sum + duration, 0);
  if (!loop && elapsed >= total) return normalized.length - 1;
  let cursor = loop ? ((elapsed % total) + total) % total : Math.max(0, elapsed);
  for (let index = 0; index < normalized.length; index += 1) {
    cursor -= normalized[index];
    if (cursor < 0) return index;
  }
  return normalized.length - 1;
}

export function animationCell(animation, elapsed, reducedMotion) {
  if (Array.isArray(animation?.frames) && animation.frames.length) {
    const durationsSource = animation.frameDurationsMs
      ?? animation.durations
      ?? animation.frames.map((entry) => entry?.durationMs ?? entry?.duration);
    const durations = animation.frames.map((_, index) => durationsSource?.[index] ?? 120);
    const index = sequenceIndex(durations, elapsed, reducedMotion, animation.loop !== false);
    const frame = animation.frames[index] ?? animation.frames[0];
    const column = typeof frame === "number" ? frame : Number(frame?.column ?? frame?.col) || 0;
    return { row: Number(frame?.row ?? animation?.row) || 0, column };
  }
  const durationsSource = animation?.frameDurationsMs ?? animation?.durations;
  const frameCount = Math.max(1, Number(animation?.frameCount) || durationsSource?.length || 1);
  const durations = Array.isArray(durationsSource) && durationsSource.length
    ? durationsSource
    : Array.from({ length: frameCount }, () => 120);
  const index = sequenceIndex(durations, elapsed, reducedMotion, animation?.loop !== false);
  return { row: Number(animation?.row) || 0, column: index };
}

export class PetActor {
  constructor(world, definition, savedState, index) {
    this.world = world;
    this.definition = definition;
    this.id = definition.id;
    this.name = definition.name;
    this.displayName = definition.displayName;
    this.manifest = definition.manifest ?? {};
    this.color = definition.color;
    this.image = definition.image;
    this.index = index;
    const renderer = this.manifest.renderer ?? {};
    const cellWidth = Math.max(1, Number(renderer.cellWidth) || 192);
    const cellHeight = Math.max(1, Number(renderer.cellHeight) || 208);
    const defaultScale = Number(renderer.defaultScale);
    this.scale = Number.isFinite(defaultScale) && defaultScale > 0 ? clamp(defaultScale, 0.1, 4) : 1;
    this.anchor = {
      x: clamp(Number.isFinite(Number(renderer.anchor?.x)) ? Number(renderer.anchor.x) : 0.5, 0, 1),
      y: clamp(Number.isFinite(Number(renderer.anchor?.y)) ? Number(renderer.anchor.y) : 1, 0, 1)
    };
    this.width = (index === 0 ? 178 : 164) * this.scale;
    this.height = this.width * (cellHeight / cellWidth);
    this.x = 0;
    this.y = 0;
    this.restorePosition(savedState);
    this.state = "idle";
    this.stateStartedAt = performance.now();
    this.stateUntil = 0;
    this.facing = index === 0 ? "right" : "left";
    this.target = null;
    this.lookTarget = null;
    this.dragging = false;
    this.hovered = false;
    this.insideBox = false;
    this.insideBoxUntil = 0;
    this.sceneMotion = null;
    this.platformAttachment = null;
    this.fallingVelocity = 0;
    this.nextDecisionAt = performance.now() + randomBetween(3200, 6200) + index * 850;
  }

  restorePosition(savedState = {}) {
    const defaultX = [0.14, 0.69, 0.4, 0.83, 0.25, 0.56][this.index] ?? 0.5;
    const defaultY = [0.7, 0.76, 0.58, 0.66, 0.82, 0.48][this.index] ?? 0.7;
    const xRatio = Number.isFinite(savedState.xRatio) ? savedState.xRatio : defaultX;
    const yRatio = Number.isFinite(savedState.yRatio) ? savedState.yRatio : defaultY;
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

  get anchorPoint() {
    return {
      x: this.x + this.width * this.anchor.x,
      y: this.y + this.height * this.anchor.y
    };
  }

  get foot() {
    const anchor = this.anchorPoint;
    return { x: anchor.x, y: anchor.y - 7 };
  }

  placeFootAt(x, y) {
    this.x = x - this.width * this.anchor.x;
    this.y = y + 7 - this.height * this.anchor.y;
  }

  get hitBounds() {
    return {
      x: this.x + this.width * 0.15,
      y: this.y + this.height * 0.12,
      width: this.width * 0.7,
      height: this.height * 0.78
    };
  }

  containsPoint(x, y) {
    const bounds = this.hitBounds;
    return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
  }

  touchInteractionAt(x, y) {
    if (!this.containsPoint(x, y)) return null;
    const localX = clamp((x - this.x) / this.width, 0, 1);
    const localY = clamp((y - this.y) / this.height, 0, 1);
    const declared = this.manifest.interactionZones
      ?? this.manifest.touchZones
      ?? this.manifest.renderer?.interactionZones
      ?? this.manifest.interactions?.touchZones
      ?? this.manifest.renderer?.touchZones;
    if (Array.isArray(declared)) {
      for (const zone of declared) {
        const id = String(zone?.id ?? zone?.name ?? "").toLowerCase();
        if (!id || !zoneContains(zone, localX, localY)) continue;
        const event = String(zone?.event ?? `pet-${id}`).trim();
        return { id, event: event || `pet-${id}`, label: zone?.label };
      }
    }
    if (localY >= 0.12 && localY <= 0.42 && localX >= 0.22 && localX <= 0.78) return { id: "head", event: "pet-head" };
    const tailSide = this.facing === "right" ? localX <= 0.31 : localX >= 0.69;
    if (tailSide && localY >= 0.52 && localY <= 0.9) return { id: "tail", event: "pet-tail" };
    if (localY >= 0.4 && localY <= 0.72 && localX >= 0.16 && localX <= 0.84) return { id: "back", event: "pet-back" };
    return { id: "body", event: "pet-body" };
  }

  touchZoneAt(x, y) {
    return this.touchInteractionAt(x, y)?.id ?? null;
  }

  setState(state, duration = 0, timestamp = performance.now()) {
    if (this.state !== state) {
      this.state = state;
      this.stateStartedAt = timestamp;
    }
    this.stateUntil = duration > 0 ? timestamp + duration : 0;
  }

  walkTo(x, y, reason = "wander", options = {}) {
    this.sceneMotion = null;
    this.platformAttachment = null;
    this.fallingVelocity = 0;
    this.insideBox = false;
    this.target = {
      x, y, reason,
      entityId: options.entityId,
      destination: options.destination,
      manual: Boolean(options.manual),
      radius: options.radius ?? 42
    };
    this.facing = x >= this.center.x ? "right" : "left";
    this.setState("walk");
  }

  reactToPetting(interaction, timestamp = performance.now()) {
    const zone = typeof interaction === "string" ? interaction : interaction?.id ?? "body";
    const event = typeof interaction === "string" ? `pet-${zone}` : interaction?.event ?? `pet-${zone}`;
    this.target = null;
    this.sceneMotion = null;
    this.lookTarget = null;
    this.setState(event, zone === "tail" ? 1250 : 1750, timestamp);
    this.nextDecisionAt = timestamp + randomBetween(3800, 6500);
    this.world.spawnHearts(this.center.x, this.y + this.height * 0.22, this.color, zone === "tail" ? 2 : 5);
  }

  startLook(x, y, duration = 1700, timestamp = performance.now()) {
    this.target = null;
    this.lookTarget = { x, y };
    this.setState("look", duration, timestamp);
  }

  update(deltaSeconds, timestamp) {
    if (this.dragging) return;
    if (this.world.updatePlatformPet(this, deltaSeconds, timestamp)) return;

    if (this.insideBox && timestamp > this.insideBoxUntil && !this.world.quiet) {
      this.insideBox = false;
      this.world.releaseBoxOccupant(this);
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
        const dx = this.target.x - this.center.x;
        const dy = this.target.y - this.center.y;
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

    if (!this.world.quiet && !this.target && !this.insideBox && this.state === "idle" && timestamp >= this.nextDecisionAt) {
      this.chooseAutonomousAction(timestamp);
    }
  }

  chooseAutonomousAction(timestamp) {
    const roll = Math.random();
    if (roll < 0.54) {
      const range = Math.min(300, this.world.width * 0.35);
      this.walkTo(
        clamp(this.center.x + randomBetween(-range, range), this.width * 0.45, this.world.width - this.width * 0.45),
        clamp(this.center.y + randomBetween(-38, 34), this.world.height * 0.5, this.world.height - this.height * 0.35),
        "wander"
      );
    } else if (roll < 0.82) {
      const target = this.world.pointer.seen ? this.world.pointer : { x: randomBetween(0, this.world.width), y: randomBetween(0, this.world.height * 0.65) };
      this.startLook(target.x, target.y, randomBetween(1200, 2300), timestamp);
    } else if (roll < 0.92) {
      this.setState("waiting", randomBetween(1200, 2100), timestamp);
    } else {
      this.setState("happy", 1200, timestamp);
    }
    this.nextDecisionAt = timestamp + randomBetween(5200, 10500);
  }

  clampToStage() {
    const horizontalGuard = this.width * 0.34;
    const minX = horizontalGuard - this.width * this.anchor.x;
    const maxX = Math.max(minX, this.world.width - horizontalGuard - this.width * this.anchor.x);
    const minY = 4;
    const maxY = Math.max(minY, this.world.height - 7 - this.height * this.anchor.y);
    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
  }

  resolveAnimation(eventName) {
    const eventMap = this.manifest.interactions?.eventMap
      ?? this.manifest.eventMap
      ?? this.manifest.renderer?.eventMap
      ?? {};
    const alias = eventName === "walk-right"
      ? "move-right"
      : eventName === "walk-left" ? "move-left" : eventName;
    let mapped = eventMap[eventName] ?? eventMap[alias] ?? eventName;
    if (mapped && typeof mapped === "object") return mapped;
    if (mapped === "walk") mapped = this.facing === "right" ? "walkRight" : "walkLeft";
    if (mapped === "platform-walk") mapped = this.facing === "right" ? "platform-walk-right" : "platform-walk-left";
    const custom = this.manifest.animations?.[mapped]
      ?? this.manifest.renderer?.animations?.[mapped];
    if (custom) return custom;
    const fallback = EVENT_FALLBACKS[mapped] ?? EVENT_FALLBACKS[eventName] ?? "idle";
    return ANIMATIONS[fallback] ?? ANIMATIONS.idle;
  }

  draw(context, timestamp, reducedMotion) {
    let row;
    let column;
    if (this.state === "look" && this.lookTarget) {
      const cell = lookCellForVector(
        this.lookTarget.x - this.center.x,
        this.lookTarget.y - this.center.y,
        this.manifest.renderer?.lookDirections
      );
      if (cell) ({ row, column } = cell);
    }
    if (row === undefined) {
      let eventName = this.state;
      if (this.state === "walk") eventName = this.facing === "right" ? "walk-right" : "walk-left";
      if (this.state === "platform-walk") eventName = this.facing === "right" ? "platform-walk-right" : "platform-walk-left";
      const cell = animationCell(this.resolveAnimation(eventName), timestamp - this.stateStartedAt, reducedMotion);
      row = cell.row;
      column = cell.column;
    }
    const drawn = drawSpriteFrame(
      context,
      this.image,
      row,
      column,
      this.bounds,
      this.dragging ? 0.92 : 1,
      this.manifest.renderer
    );
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
    context.restore();
  }

  drawNameTag(context) {
    const level = this.world.progressFor(this.id).level;
    const label = `${this.name} · Lv.${level}`;
    context.save();
    context.font = '600 12px "PingFang SC", sans-serif';
    const width = context.measureText(label).width + 20;
    const x = this.x + (this.width - width) / 2;
    const y = Math.max(6, this.y + 8);
    context.fillStyle = "rgba(255,249,239,0.92)";
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
