const STORAGE_KEY = "pet-desktop-companion-state-v2";
const LEGACY_STORAGE_KEYS = ["baobao-feifei-desktop-state-v1"];

function getNativeBridge() {
  return typeof window !== "undefined" ? window.petDesktop : undefined;
}

async function invokeFirst(methodNames, ...args) {
  const native = getNativeBridge();
  if (!native) return undefined;

  for (const methodName of methodNames) {
    if (typeof native[methodName] !== "function") continue;
    try {
      return await native[methodName](...args);
    } catch (error) {
      console.warn(`[petDesktop] ${methodName} failed`, error);
    }
  }
  return undefined;
}

async function invokeRequired(methodNames, ...args) {
  const native = getNativeBridge();
  if (!native) throw new Error("桌面程序接口不可用");

  const methodName = methodNames.find((name) => typeof native[name] === "function");
  if (!methodName) throw new Error("当前版本不支持这个宠物包操作");
  return native[methodName](...args);
}

function readFallbackState() {
  try {
    for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = JSON.parse(raw);
      if (key !== STORAGE_KEY) localStorage.setItem(STORAGE_KEY, raw);
      return state;
    }
    return null;
  } catch (error) {
    console.warn("Unable to read local pet state", error);
    return null;
  }
}

function writeFallbackState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn("Unable to save local pet state", error);
    return false;
  }
}

export const petBridge = {
  get isNative() {
    return Boolean(getNativeBridge());
  },

  async loadPetCatalog() {
    return invokeFirst(["loadPetCatalog", "getPetCatalog", "listPets", "loadPets"]);
  },

  async loadState() {
    const state = await invokeFirst([
      "loadState",
      "getState",
      "restoreState",
      "getShellState"
    ]);
    return state ?? readFallbackState();
  },

  async saveState(state) {
    const nativeResult = await invokeFirst([
      "saveState",
      "setState",
      "persistState",
      "setShellState"
    ], state);
    if (nativeResult === undefined) return writeFallbackState(state);
    return nativeResult;
  },

  async loadShellState() {
    return invokeFirst(["getShellState"]);
  },

  async setShellState(patch) {
    return invokeFirst(["setShellState"], patch);
  },

  async getWindowPlatforms() {
    return invokeFirst(["getWindowPlatforms"]);
  },

  async setWindowPlatformInteractions(enabled) {
    return invokeFirst(["setWindowPlatformInteractions"], Boolean(enabled));
  },

  async quitApp() {
    return invokeRequired(["quitApp", "exitApp"]);
  },

  async importPetpack() {
    return invokeRequired(["importPetpack", "installPetpack", "addPetpack"]);
  },

  async removePetpack(id) {
    return invokeRequired(["removePetpack", "uninstallPetpack"], id);
  },

  async importItempack() {
    return invokeRequired(["importItempack", "installItempack", "addItempack"]);
  },

  async removeItempack(id) {
    return invokeRequired(["removeItempack", "uninstallItempack"], id);
  },

  get canImportPetpack() {
    const native = getNativeBridge();
    return Boolean(native && ["importPetpack", "installPetpack", "addPetpack"].some((name) => typeof native[name] === "function"));
  },

  get canImportItempack() {
    const native = getNativeBridge();
    return Boolean(native && ["importItempack", "installItempack", "addItempack"].some((name) => typeof native[name] === "function"));
  },

  async resolveAssetUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    if (/^(https?:|file:|data:|blob:|petpack:)/i.test(pathOrUrl)) return pathOrUrl;

    const resolved = await invokeFirst([
      "resolveAssetUrl",
      "getAssetUrl",
      "toAssetUrl"
    ], pathOrUrl);
    if (resolved) return resolved;

    if (/^[A-Za-z]:[\\/]/.test(pathOrUrl)) {
      return `file:///${pathOrUrl.replace(/\\/g, "/")}`;
    }
    return pathOrUrl;
  },

  async setInteractiveRegions(regions) {
    return invokeFirst([
      "setInteractiveRegions",
      "updateInteractiveRegions",
      "notifyInteractiveRegions"
    ], regions);
  },

  async setPointerHover(isHovering) {
    const native = getNativeBridge();
    if (!native) return undefined;

    for (const methodName of ["setPointerHover", "notifyPointerHover", "setHover"]) {
      if (typeof native[methodName] !== "function") continue;
      try {
        return await native[methodName](Boolean(isHovering));
      } catch (error) {
        console.warn(`[petDesktop] ${methodName} failed`, error);
      }
    }

    if (typeof native.setIgnoreMouseEvents === "function") {
      try {
        return await native.setIgnoreMouseEvents(!isHovering, { forward: true });
      } catch (error) {
        console.warn("[petDesktop] setIgnoreMouseEvents failed", error);
      }
    }
    return undefined;
  },

  onQuitRequested(callback) {
    const native = getNativeBridge();
    if (!native || typeof native.onQuitRequested !== "function") return () => {};
    try {
      const unsubscribe = native.onQuitRequested(callback);
      return typeof unsubscribe === "function" ? unsubscribe : () => {};
    } catch (error) {
      console.warn("[petDesktop] onQuitRequested subscription failed", error);
      return () => {};
    }
  },

  onStateChanged(callback) {
    const native = getNativeBridge();
    if (!native) return () => {};
    for (const methodName of ["onShellStateChanged", "onStateChanged"]) {
      if (typeof native[methodName] !== "function") continue;
      try {
        const unsubscribe = native[methodName](callback);
        return typeof unsubscribe === "function" ? unsubscribe : () => {};
      } catch (error) {
        console.warn(`[petDesktop] ${methodName} subscription failed`, error);
      }
    }
    return () => {};
  },

  onCatalogChanged(callback) {
    const native = getNativeBridge();
    if (!native) return () => {};
    for (const methodName of ["onPetCatalogChanged", "onCatalogChanged"]) {
      if (typeof native[methodName] !== "function") continue;
      try {
        const unsubscribe = native[methodName](callback);
        return typeof unsubscribe === "function" ? unsubscribe : () => {};
      } catch (error) {
        console.warn(`[petDesktop] ${methodName} subscription failed`, error);
      }
    }
    return () => {};
  }
};
