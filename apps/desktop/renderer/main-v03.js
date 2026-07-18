import { petBridge } from "./bridge.js";
import { PetWorld, catalogItempacks, catalogPets } from "./pet-world.js";
import { AFFINITY_THRESHOLDS, levelName } from "./progression.js";
import { unwrapRendererState } from "./state.js";
import { PET_APPEARANCE_SCALE, PET_MOVEMENT_SPEED } from "./pet-settings.js";

const formatMultiplier = (value) => `${Number(Number(value).toFixed(2))}×`;

const GUIDE_STEPS = [
  {
    kicker: "第一次见面",
    title: "先把手掌准备好",
    copy: "点“摸摸”，鼠标会变成手掌；再点击宠物的头、背、尾巴或身体，它会给出不同回应。",
    action: "pet"
  },
  {
    kicker: "一口小零食",
    title: "投喂不需要打卡",
    copy: "点“投喂”选择食物。桌面同一时间只留一份，随时可以从投喂菜单收起。",
    action: "feed"
  },
  {
    kicker: "玩一小会儿",
    title: "玩具用完会收好",
    copy: "小球、逗猫棒和小屋只会出现一件；可以手动收起，也会在一段时间后自动结束。",
    action: "toy"
  },
  {
    kicker: "需要专注时",
    title: "一键安静陪伴",
    copy: "开启“安静”，会收起临时互动，让宠物安稳待在桌面。",
    action: "quiet"
  }
];

function roundedRegion(bounds, padding = 0) {
  return {
    x: Math.round(bounds.x - padding),
    y: Math.round(bounds.y - padding),
    width: Math.round(bounds.width + padding * 2),
    height: Math.round(bounds.height + padding * 2)
  };
}

function drawPetCardPortrait(canvas, definition) {
  const image = definition?.image;
  const renderer = definition?.manifest?.renderer ?? {};
  const idle = renderer.animations?.idle ?? {};
  const cellWidth = Number(renderer.cellWidth);
  const cellHeight = Number(renderer.cellHeight);
  const frame = Number(Array.isArray(idle.frames) ? idle.frames[0] : 0);
  const row = Number(idle.row ?? 0);
  if (!image || !Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
    canvas.dataset.empty = "true";
    return false;
  }
  canvas.width = cellWidth;
  canvas.height = cellHeight;
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.clearRect(0, 0, cellWidth, cellHeight);
  context.drawImage(
    image,
    Math.max(0, frame) * cellWidth,
    Math.max(0, row) * cellHeight,
    cellWidth,
    cellHeight,
    0,
    0,
    cellWidth,
    cellHeight
  );
  canvas.dataset.empty = "false";
  return true;
}

class OnboardingGuide {
  constructor(elements, steps, savedDone, onComplete) {
    this.elements = elements;
    this.steps = steps;
    this.index = 0;
    this.done = Boolean(savedDone);
    this.onComplete = onComplete;
    elements.next.addEventListener("click", () => this.next());
    elements.skip.addEventListener("click", () => this.complete());
  }

  show() {
    if (this.done || !this.steps.length) return;
    this.elements.root.hidden = false;
    this.render();
  }

  render() {
    const step = this.steps[this.index];
    this.elements.kicker.textContent = step.kicker;
    this.elements.title.textContent = step.title;
    this.elements.copy.textContent = step.copy;
    this.elements.next.textContent = this.index === this.steps.length - 1 ? "开始陪伴" : "下一步";
    [...this.elements.progress.children].forEach((node, index) => {
      node.hidden = index >= this.steps.length;
      node.classList.toggle("is-done", index < this.index);
      node.classList.toggle("is-current", index === this.index);
    });
  }

  next() {
    if (this.index >= this.steps.length - 1) return this.complete();
    this.index += 1;
    this.render();
  }

  noteAction(action) {
    if (this.done || this.steps[this.index]?.action !== action) return;
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
      petSelectorPopover: document.querySelector("#pet-selector-popover"),
      petpackPopover: document.querySelector("#petpack-popover"),
      foodChoices: document.querySelector("#food-choices"),
      toyChoices: document.querySelector("#toy-choices"),
      petList: document.querySelector("#pet-list"),
      currentPetSummary: document.querySelector("#current-pet-summary"),
      currentPetLabel: document.querySelector("#current-pet-label"),
      petButton: document.querySelector("#pet-button"),
      feedButton: document.querySelector("#feed-button"),
      toyButton: document.querySelector("#toy-button"),
      petSelectorButton: document.querySelector("#pet-selector-button"),
      quietButton: document.querySelector("#quiet-button"),
      petpackButton: document.querySelector("#petpack-button"),
      foodClearButton: document.querySelector("#food-clear-button"),
      toyClearButton: document.querySelector("#toy-clear-button"),
      foodActiveStatus: document.querySelector("#food-active-status"),
      toyActiveStatus: document.querySelector("#toy-active-status"),
      platformToggle: document.querySelector("#platform-toggle"),
      importPetpackButton: document.querySelector("#import-petpack-button"),
      petSelectorImportButton: document.querySelector("#pet-selector-import-button"),
      importItempackButton: document.querySelector("#import-itempack-button"),
      installedPacks: document.querySelector("#installed-packs"),
      quitAppButton: document.querySelector("#quit-app-button"),
      emptyShell: document.querySelector("#empty-shell"),
      emptyImportPet: document.querySelector("#empty-import-pet"),
      emptyImportItem: document.querySelector("#empty-import-item"),
      restingShell: document.querySelector("#resting-shell"),
      restingChoosePet: document.querySelector("#resting-choose-pet"),
      quietStatus: document.querySelector("#quiet-status"),
      interactionStatus: document.querySelector("#interaction-status"),
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
      pettingChanged: (active, reason) => this.onPettingChanged(active, reason),
      progressChanged: (id, result, action) => this.onProgressChanged(id, result, action),
      petsChanged: () => this.onPetsChanged(),
      itemsChanged: () => this.onItemsChanged(),
      regionsChanged: (force) => this.publishRegions(force),
      closePopovers: () => this.closePopovers()
    });
    this.guide = null;
    this.saveTimer = null;
    this.lastRegionsJson = "";
    this.lastHoverState = null;
    this.foodPointerSession = null;
    this.interactionBarVisible = true;
    this.unsubscribeState = () => {};
    this.unsubscribeCatalog = () => {};
    this.unsubscribeQuit = () => {};
    this.quitting = false;
    this.bindUi();
  }

  async start() {
    const [catalog, savedState, shellState] = await Promise.all([
      petBridge.loadPetCatalog(),
      petBridge.loadState(),
      petBridge.loadShellState()
    ]);
    const rendererState = unwrapRendererState(savedState);
    await this.world.load(catalog, savedState);
    // Keep the complete first-run journey even when the empty shell starts
    // before any itempack is installed. Feed/toy controls become available as
    // soon as the user imports a resource pack, so dropping those guide steps
    // at startup would make them impossible to discover later.
    const guideSteps = GUIDE_STEPS;
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
      guideSteps,
      rendererState.guideDone,
      () => {
        this.toast("准备好了，随时和宠物互动");
        this.requestSave();
        this.publishRegions(true);
      }
    );
    this.syncCatalogUi();
    if (typeof shellState?.quiet === "boolean" && shellState.quiet !== this.world.quiet) {
      this.world.quiet = shellState.quiet;
      this.onQuietChanged(shellState.quiet, false);
    }
    this.world.setSuspended(shellState?.visible === false);
    this.setInteractionBarVisible(shellState?.interactionBarVisible !== false);
    window.setTimeout(() => {
      if (this.world.pets.length) this.guide.show();
      this.publishRegions(true);
    }, 650);
    this.unsubscribeState = petBridge.onStateChanged((state) => this.applyExternalState(state));
    this.unsubscribeCatalog = petBridge.onCatalogChanged((payload) => {
      const nextCatalog = payload?.catalog ?? payload;
      this.world.reloadCatalog(nextCatalog).then(() => {
        this.syncCatalogUi();
        this.toast("宠物与道具目录已更新");
        this.requestSave();
      }).catch((error) => console.error("Unable to refresh pet catalog", error));
    });
    this.unsubscribeQuit = petBridge.onQuitRequested(() => {
      void this.quitApp();
    });
    this.publishRegions(true);
  }

  bindUi() {
    this.elements.petButton.addEventListener("click", () => this.world.togglePettingMode());
    this.elements.feedButton.addEventListener("click", () => this.togglePopover("food"));
    this.elements.toyButton.addEventListener("click", () => this.togglePopover("toy"));
    this.elements.petSelectorButton.addEventListener("click", () => this.togglePopover("petSelector"));
    this.elements.quietButton.addEventListener("click", () => this.world.setQuiet(!this.world.quiet));
    this.elements.petpackButton.addEventListener("click", () => this.togglePopover("petpack"));
    this.elements.foodClearButton.addEventListener("click", () => {
      if (!this.world.clearFoodDrag()) this.world.clearFood("manual", true);
      this.closePopovers();
    });
    this.elements.toyClearButton.addEventListener("click", () => {
      this.world.clearToy("manual", true);
      this.closePopovers();
    });
    this.elements.platformToggle.addEventListener("change", () => {
      void this.world.setPlatformInteractions(this.elements.platformToggle.checked);
    });
    this.elements.importPetpackButton.addEventListener("click", () => this.importPetpack());
    this.elements.petSelectorImportButton.addEventListener("click", () => this.importPetpack());
    this.elements.importItempackButton.addEventListener("click", () => this.importItempack());
    this.elements.emptyImportPet.addEventListener("click", () => this.importPetpack());
    this.elements.emptyImportItem.addEventListener("click", () => this.importItempack());
    this.elements.restingChoosePet.addEventListener("click", () => this.togglePopover("petSelector"));
    this.elements.petList.addEventListener("change", (event) => {
      const input = event.target.closest("[data-pet-visible]");
      if (input) this.world.setPetVisible(input.dataset.petVisible, input.checked);
    });
    this.elements.petList.addEventListener("input", (event) => {
      const scaleInput = event.target.closest("[data-pet-scale]");
      const speedInput = event.target.closest("[data-pet-speed]");
      if (scaleInput) {
        const value = this.world.setPetAppearanceScale(scaleInput.dataset.petScale, scaleInput.value);
        const output = scaleInput.closest("label")?.querySelector("output");
        if (output) output.value = `${Math.round(value * 100)}%`;
        this.publishRegions(true);
      } else if (speedInput) {
        const value = this.world.setPetMovementSpeed(speedInput.dataset.petSpeed, speedInput.value);
        const output = speedInput.closest("label")?.querySelector("output");
        if (output) output.value = formatMultiplier(value);
      }
    });
    this.elements.petList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-active-pet]");
      if (!button) return;
      const petId = button.dataset.activePet;
      const summary = this.world.installedPetSummaries().find((pet) => pet.id === petId);
      if (summary && !summary.visible) this.world.setPetVisible(petId, true);
      this.world.setActivePet(petId);
    });
    this.elements.installedPacks.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-kind][data-pack-id]");
      if (button) this.removePack(button.dataset.removeKind, button.dataset.packId, button.dataset.packName);
    });
    this.elements.quitAppButton.addEventListener("click", () => this.quitApp());

    this.elements.foodChoices.addEventListener("pointerdown", (event) => {
      const button = event.target.closest("[data-item-id]:not(:disabled)");
      if (button) this.beginFoodPointer(event, button.dataset.itemId);
    });
    this.elements.toyChoices.addEventListener("click", (event) => {
      const button = event.target.closest("[data-item-id]:not(:disabled)");
      if (button) this.playToy(button.dataset.itemId);
    });

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
      this.unsubscribeQuit();
      this.world.cancelTransientInteractions("shutdown", false);
      this.saveNow();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.world.cancelPetting("escape", true)) return;
        if (this.world.clearFoodDrag(true)) {
          this.foodPointerSession = null;
          return;
        }
        this.closePopovers();
      }
      if (event.altKey && event.key === "1") this.world.togglePettingMode();
      if (event.altKey && event.key === "4") this.world.setQuiet(!this.world.quiet);
    });
  }

  beginFoodPointer(event, itemId) {
    const item = this.world.itemsFor("food").find((candidate) => candidate.id === itemId);
    if (!item || !this.world.startFoodDrag(item, event.clientX, event.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
    this.foodPointerSession = {
      pointerId: event.pointerId,
      itemId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
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
      petSelector: [this.elements.petSelectorPopover, this.elements.petSelectorButton],
      petpack: [this.elements.petpackPopover, this.elements.petpackButton]
    };
    const pair = mapping[name];
    if (!pair) return;
    const [popover, button] = pair;
    const willOpen = popover.hidden;
    this.closePopovers();
    popover.hidden = !willOpen;
    button.classList.toggle("is-active", willOpen);
    button.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      if (name === "petSelector") this.renderPetSelector();
      if (name === "food" || name === "toy") this.renderItemChoicesForCurrentPet();
    }
    this.publishRegions(true);
  }

  closePopovers() {
    const pairs = [
      [this.elements.foodPopover, this.elements.feedButton],
      [this.elements.toyPopover, this.elements.toyButton],
      [this.elements.petSelectorPopover, this.elements.petSelectorButton],
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
    if (!petBridge.canImportPetpack) return this.toast("浏览器预览中无法导入，桌面程序里可以使用");
    const installedBefore = this.world.definitions.length;
    this.elements.importPetpackButton.disabled = true;
    this.elements.petSelectorImportButton.disabled = true;
    this.elements.emptyImportPet.disabled = true;
    try {
      const result = await petBridge.importPetpack();
      if (result?.canceled || result?.cancelled) return;
      if (result?.error) throw new Error(result.error);
      const catalog = result?.catalog ?? await petBridge.loadPetCatalog();
      await this.world.reloadCatalog(catalog);
      const id = String(result?.petId ?? result?.manifest?.id ?? "");
      if (installedBefore === 0 && id) this.world.setPetVisible(id, true);
      this.syncCatalogUi();
      const name = result?.manifest?.displayName ?? result?.manifest?.name ?? result?.petId ?? "新宠物";
      this.toast(installedBefore === 0 ? `${name}已经加入桌面` : `${name}已加入宠物目录，可在“宠物”中选择显示`);
      this.requestSave();
    } catch (error) {
      console.error(error);
      this.toast(error?.message ? `导入失败：${error.message}` : "宠物包没有导入成功");
    } finally {
      this.elements.importPetpackButton.disabled = false;
      this.elements.petSelectorImportButton.disabled = false;
      this.elements.emptyImportPet.disabled = false;
    }
  }

  async importItempack() {
    this.closePopovers();
    if (!petBridge.canImportItempack) return this.toast("浏览器预览中无法导入，桌面程序里可以使用");
    this.elements.importItempackButton.disabled = true;
    this.elements.emptyImportItem.disabled = true;
    try {
      const result = await petBridge.importItempack();
      if (result?.canceled || result?.cancelled) return;
      if (result?.error) throw new Error(result.error);
      const catalog = result?.catalog ?? await petBridge.loadPetCatalog();
      await this.world.reloadCatalog(catalog);
      this.syncCatalogUi();
      const name = result?.manifest?.displayName ?? result?.itempackId ?? "新道具包";
      this.toast(`${name}已经加入互动道具目录`);
      this.requestSave();
    } catch (error) {
      console.error(error);
      this.toast(error?.message ? `导入失败：${error.message}` : "道具包没有导入成功");
    } finally {
      this.elements.importItempackButton.disabled = false;
      this.elements.emptyImportItem.disabled = false;
    }
  }

  async removePack(kind, id, name) {
    const label = name || id;
    const message = kind === "pet"
      ? `移除“${label}”宠物包？\n宠物会从桌面消失，但亲密度和位置记录会保留；重新导入后可以恢复。`
      : `确定移除“${label}”道具包吗？正在使用的同包道具会同时收起。`;
    if (!window.confirm(message)) return;
    this.closePopovers();
    if (kind === "item" && this.world.activeToy()?.item?.packId === id) this.world.clearToy("remove", false);
    if (kind === "item" && this.world.foods.some((food) => food.item?.packId === id)) this.world.clearFood("remove", false);
    try {
      const result = kind === "pet" ? await petBridge.removePetpack(id) : await petBridge.removeItempack(id);
      const catalog = result?.catalog ?? await petBridge.loadPetCatalog();
      await this.world.reloadCatalog(catalog);
      this.syncCatalogUi();
      this.toast(`${label}已从本机移除`);
      this.requestSave();
    } catch (error) {
      console.error(error);
      this.toast(error?.message ? `移除失败：${error.message}` : "没有移除成功");
    }
  }

  async quitApp() {
    if (this.quitting) return;
    this.quitting = true;
    this.elements.quitAppButton.disabled = true;
    this.closePopovers();
    this.world.cancelTransientInteractions("shutdown", false);
    await this.saveNow();
    try {
      await petBridge.quitApp();
    } catch (error) {
      console.error(error);
      this.quitting = false;
      this.elements.quitAppButton.disabled = false;
      this.toast("暂时无法退出，请从系统托盘菜单选择“退出”");
    }
  }

  playToy(itemId) {
    const item = this.world.itemsFor("toy").find((candidate) => candidate.id === itemId);
    if (!item) return;
    if (this.world.activeToy()?.item?.id === item.id) {
      this.world.clearToy("manual", true);
      this.closePopovers();
      return;
    }
    this.closePopovers();
    if (item.behavior === "ball") this.world.spawnBall(item);
    else if (item.behavior === "wand") this.world.startWand(item);
    else if (item.behavior === "hideout") this.world.spawnBox(item);
    else this.toast("这个第三方玩具暂时没有可用行为");
  }

  syncCatalogUi() {
    const hasInstalledPets = this.world.definitions.length > 0;
    const hasVisiblePets = this.world.pets.length > 0;
    const foods = this.world.itemsFor("food");
    const toys = this.world.itemsFor("toy");
    this.elements.emptyShell.hidden = hasInstalledPets;
    this.elements.restingShell.hidden = !hasInstalledPets || hasVisiblePets;
    this.elements.petButton.disabled = !hasVisiblePets;
    this.elements.feedButton.disabled = !hasVisiblePets || foods.length === 0;
    this.elements.toyButton.disabled = !hasVisiblePets || toys.length === 0;
    this.elements.petSelectorButton.disabled = !hasInstalledPets;
    this.elements.quietButton.disabled = !hasVisiblePets;
    this.elements.platformToggle.checked = this.world.platformInteractions;
    this.renderPetSelector();
    this.renderItemChoicesForCurrentPet();
    this.renderInstalledPacks();
    if (hasVisiblePets && this.guide && !this.guide.done) this.guide.show();
    this.publishRegions(true);
  }

  renderPetSelector() {
    const active = this.world.getActivePet();
    const progress = active ? this.world.progressFor(active.id) : null;
    this.elements.currentPetSummary.textContent = active
      ? `当前互动：${active.name} · Lv.${progress.level} ${levelName(progress.level)} · ${progress.affinity} 亲密度`
      : "当前没有显示中的宠物";
    this.elements.currentPetLabel.textContent = active ? `当前：${active.name}` : "选择宠物";
    const root = this.elements.petList;
    root.replaceChildren();
    for (const pet of this.world.installedPetSummaries()) {
      const definition = this.world.definitions.find((candidate) => candidate.id === pet.id);
      const row = document.createElement("article");
      row.className = `pet-option pet-card${pet.active ? " is-current" : ""}${pet.visible ? "" : " is-resting"}`;
      row.setAttribute("role", "listitem");

      const select = document.createElement("button");
      select.type = "button";
      select.className = "pet-option-main";
      select.dataset.activePet = pet.id;
      select.setAttribute("aria-pressed", String(pet.active));
      select.setAttribute("aria-label", pet.visible
        ? `选择 ${pet.name} 作为当前互动宠物`
        : `唤醒 ${pet.name} 并设为当前互动宠物`);

      const selectionDot = document.createElement("span");
      selectionDot.className = "pet-selection-dot";
      selectionDot.setAttribute("aria-hidden", "true");

      const portraitFrame = document.createElement("span");
      portraitFrame.className = "pet-card-portrait-frame";
      const portrait = document.createElement("canvas");
      portrait.className = "pet-card-portrait";
      portrait.setAttribute("aria-hidden", "true");
      drawPetCardPortrait(portrait, definition);
      portraitFrame.append(portrait);

      const copy = document.createElement("span");
      copy.className = "pet-card-copy";
      const name = document.createElement("strong");
      name.textContent = pet.name;
      const status = document.createElement("span");
      status.className = "pet-card-status";
      status.textContent = pet.active ? "当前互动" : pet.visible ? "桌面陪伴中" : "休息中";
      const meta = document.createElement("small");
      meta.textContent = `Lv.${pet.progress.level} ${levelName(pet.progress.level)} · ${pet.progress.affinity} 亲密度`;
      copy.append(name, status, meta);
      select.append(selectionDot, portraitFrame, copy);

      const toggle = document.createElement("label");
      toggle.className = "visibility-toggle pet-card-visibility";
      toggle.title = pet.visible ? `让 ${pet.name} 暂时休息` : `让 ${pet.name} 出现在桌面`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = pet.visible;
      input.dataset.petVisible = pet.id;
      input.setAttribute("aria-label", `${pet.name} 桌面显示`);
      const visual = document.createElement("span");
      visual.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = "桌面显示";
      toggle.append(input, visual, text);

      const controls = document.createElement("div");
      controls.className = "pet-card-controls";
      const createRange = ({ kind, label, value, min, max, step, display }) => {
        const control = document.createElement("label");
        control.className = "pet-card-range";
        const header = document.createElement("span");
        header.className = "pet-card-range-head";
        const title = document.createElement("span");
        title.textContent = label;
        const output = document.createElement("output");
        output.value = display;
        header.append(title, output);
        const range = document.createElement("input");
        range.type = "range";
        range.min = String(min);
        range.max = String(max);
        range.step = String(step);
        range.value = String(value);
        range.dataset[kind] = pet.id;
        range.setAttribute("aria-label", `${pet.name}${label}`);
        control.append(header, range);
        return control;
      };
      controls.append(
        createRange({
          kind: "petScale", label: "大小", value: pet.settings.appearanceScale,
          min: PET_APPEARANCE_SCALE.min,
          max: PET_APPEARANCE_SCALE.max,
          step: PET_APPEARANCE_SCALE.step,
          display: `${Math.round(pet.settings.appearanceScale * 100)}%`
        }),
        createRange({
          kind: "petSpeed", label: "速度", value: pet.settings.movementSpeed,
          min: PET_MOVEMENT_SPEED.min,
          max: PET_MOVEMENT_SPEED.max,
          step: PET_MOVEMENT_SPEED.step,
          display: formatMultiplier(pet.settings.movementSpeed)
        })
      );

      row.append(select, toggle, controls);
      root.append(row);
    }
  }

  renderItemChoicesForCurrentPet() {
    this.renderItemChoices(this.elements.foodChoices, this.world.itemsFor("food"));
    this.renderItemChoices(this.elements.toyChoices, this.world.itemsFor("toy"));
    const food = this.world.foods[0] ?? this.world.foodDrag;
    this.elements.foodActiveStatus.textContent = food ? `未吃：${food.item.name}` : "同一时间只放一份零食";
    this.elements.foodClearButton.hidden = !food;
    const toy = this.world.activeToy();
    this.elements.toyActiveStatus.textContent = toy ? `正在玩：${toy.item.name}` : "同一时间只使用一件玩具";
    this.elements.toyClearButton.hidden = !toy;
  }

  renderItemChoices(root, items) {
    root.replaceChildren();
    const active = this.world.getActivePet();
    const progress = active ? this.world.progressFor(active.id) : { level: 1, affinity: 0 };
    for (const item of items) {
      const locked = progress.level < item.unlockLevel;
      const button = document.createElement("button");
      button.className = `choice${locked ? " is-locked" : ""}`;
      button.type = "button";
      button.dataset.itemId = item.id;
      button.disabled = locked;
      const image = document.createElement("img");
      image.className = "choice-thumb";
      image.src = item.url;
      image.alt = "";
      const label = document.createElement("span");
      label.textContent = item.name;
      button.append(image, label);
      if (locked) {
        const lock = document.createElement("small");
        lock.className = "choice-lock";
        lock.textContent = `Lv.${item.unlockLevel} 解锁`;
        const remaining = Math.max(0, AFFINITY_THRESHOLDS[item.unlockLevel - 1] - progress.affinity);
        button.title = `亲密等级 ${item.unlockLevel} 解锁，还差 ${remaining} 点`;
        button.append(lock);
      }
      root.append(button);
    }
  }

  renderInstalledPacks() {
    const root = this.elements.installedPacks;
    root.replaceChildren();
    const pets = catalogPets(this.world.catalog).map((entry) => ({
      id: String(entry.id ?? entry.manifest?.id ?? ""),
      name: String(entry.name ?? entry.manifest?.displayName ?? entry.id ?? "宠物包"),
      kind: "pet",
      type: "宠物包"
    }));
    const items = catalogItempacks(this.world.catalog).map((entry) => ({
      id: String(entry.id ?? entry.manifest?.id ?? ""),
      name: String(entry.name ?? entry.manifest?.displayName ?? entry.id ?? "道具包"),
      kind: "item",
      type: "道具包"
    }));
    const installed = [...pets, ...items].filter((entry) => entry.id);
    if (!installed.length) {
      const empty = document.createElement("p");
      empty.className = "installed-pack-empty";
      empty.textContent = "还没有安装内容包";
      root.append(empty);
      return;
    }
    for (const entry of installed) {
      const row = document.createElement("div");
      row.className = "installed-pack-row";
      const copy = document.createElement("span");
      copy.className = "installed-pack-copy";
      const strong = document.createElement("strong");
      strong.textContent = entry.name;
      const small = document.createElement("small");
      small.textContent = entry.type;
      copy.append(strong, small);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-pack-button";
      remove.textContent = "移除";
      remove.dataset.removeKind = entry.kind;
      remove.dataset.packId = entry.id;
      remove.dataset.packName = entry.name;
      row.append(copy, remove);
      root.append(row);
    }
  }

  onQuietChanged(quiet, announce) {
    document.body.classList.toggle("is-quiet", quiet);
    this.elements.quietButton.setAttribute("aria-pressed", String(quiet));
    this.elements.quietButton.classList.toggle("is-active", quiet);
    this.elements.quietStatus.hidden = !quiet;
    if (announce) this.toast(quiet ? "宠物安静下来了" : "恢复自在活动");
    if (announce) petBridge.setShellState({ quiet });
    this.publishRegions(true);
  }

  setInteractionBarVisible(visible) {
    const next = visible !== false;
    if (this.interactionBarVisible === next && this.elements.actionShell.hidden === !next) return;
    this.interactionBarVisible = next;
    if (!next) this.closePopovers();
    this.elements.actionShell.hidden = !next;
    this.publishRegions(true);
  }

  onWandChanged(active) {
    this.elements.toyButton.classList.toggle("is-active", active);
    this.elements.toyButton.setAttribute("aria-pressed", String(active));
    this.publishRegions(true);
  }

  onPettingChanged(active, reason) {
    this.elements.petButton.classList.toggle("is-active", active);
    this.elements.petButton.setAttribute("aria-pressed", String(active));
    this.elements.interactionStatus.hidden = !active;
    if (active) {
      this.elements.interactionStatus.textContent = "✋ 手掌准备好了：点击宠物的头、背、尾巴或身体 · Esc 取消";
      this.toast("手掌准备好了，点击宠物的头、背或尾巴；按 Esc 取消");
    } else if (reason === "complete") {
      this.elements.interactionStatus.textContent = "";
    }
    this.publishRegions(true);
  }

  onProgressChanged(id, result) {
    if (result.leveledUp) {
      this.toast(`亲密等级提升：${levelName(result.level)} · 新道具已解锁`);
    }
    this.renderPetSelector();
    this.renderItemChoicesForCurrentPet();
  }

  onPetsChanged() {
    if (!this.elements?.petList) return;
    this.renderPetSelector();
    this.renderItemChoicesForCurrentPet();
    const hasInstalledPets = this.world.definitions.length > 0;
    const hasVisiblePets = this.world.pets.length > 0;
    this.elements.emptyShell.hidden = hasInstalledPets;
    this.elements.restingShell.hidden = !hasInstalledPets || hasVisiblePets;
    this.elements.petButton.disabled = !hasVisiblePets;
    this.elements.feedButton.disabled = !hasVisiblePets || this.world.itemsFor("food").length === 0;
    this.elements.toyButton.disabled = !hasVisiblePets || this.world.itemsFor("toy").length === 0;
    this.elements.quietButton.disabled = !hasVisiblePets;
    this.publishRegions(true);
  }

  onItemsChanged() {
    if (!this.elements?.foodChoices) return;
    this.renderItemChoicesForCurrentPet();
    this.publishRegions(true);
  }

  applyExternalState(state) {
    if (!state || typeof state !== "object") return;
    if (typeof state.visible === "boolean") this.world.setSuspended(!state.visible);
    if (typeof state.quiet === "boolean" && state.quiet !== this.world.quiet) this.world.setQuiet(state.quiet);
    if (typeof state.interactionBarVisible === "boolean") {
      this.setInteractionBarVisible(state.interactionBarVisible);
    }
  }

  requestSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 350);
  }

  saveNow() {
    window.clearTimeout(this.saveTimer);
    return petBridge.saveState({ ...this.world.serialize(), guideDone: Boolean(this.guide?.done) });
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
    }, 2600);
  }

  collectDomRegions() {
    const selectors = [
      [this.elements.actionShell, "ui:actions", "ui"],
      [this.elements.foodPopover, "ui:food-popover", "ui"],
      [this.elements.toyPopover, "ui:toy-popover", "ui"],
      [this.elements.petSelectorPopover, "ui:pet-selector", "ui"],
      [this.elements.petpackPopover, "ui:petpack-popover", "ui"],
      [this.elements.emptyShell, "ui:empty-shell", "ui"],
      [this.elements.restingShell, "ui:resting-shell", "ui"],
      [this.elements.interactionStatus, "ui:interaction-status", "ui"],
      [this.elements.guide, "ui:guide", "ui"]
    ];
    const result = [];
    for (const [element, id, kind] of selectors) {
      if (!element || element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) result.push({ id, kind, ...roundedRegion(rect, 5) });
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
    const targetIsUi = event.target instanceof Element && Boolean(event.target.closest("button, input, label, [role='dialog'], nav"));
    this.setPointerHover(targetIsUi || this.world.hitInteractive(event.clientX, event.clientY));
  }

  setPointerHover(value) {
    const next = Boolean(value);
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
