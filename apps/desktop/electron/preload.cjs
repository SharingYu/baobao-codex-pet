'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preloads only receive Electron's restricted require shim, so this
// table intentionally mirrors ipc-contract.cjs instead of importing a local
// Node module.
const IPC = Object.freeze({
  LOAD_PET_CATALOG: 'pet-desktop:catalog:load',
  IMPORT_PETPACK: 'pet-desktop:catalog:import',
  REMOVE_PETPACK: 'pet-desktop:catalog:remove',
  IMPORT_ITEMPACK: 'pet-desktop:item-catalog:import',
  REMOVE_ITEMPACK: 'pet-desktop:item-catalog:remove',
  PET_CATALOG_CHANGED: 'pet-desktop:catalog:changed',
  LOAD_STATE: 'pet-desktop:state:load',
  SAVE_STATE: 'pet-desktop:state:save',
  SET_INTERACTIVE_REGIONS: 'pet-desktop:overlay:set-interactive-regions',
  SET_POINTER_HOVER: 'pet-desktop:overlay:set-pointer-hover',
  SET_IGNORE_MOUSE_EVENTS: 'pet-desktop:overlay:set-ignore-mouse-events',
  GET_SHELL_STATE: 'pet-desktop:shell:get-state',
  SET_SHELL_STATE: 'pet-desktop:shell:set-state',
  SHELL_STATE_CHANGED: 'pet-desktop:shell:state-changed',
  GET_WINDOW_PLATFORMS: 'pet-desktop:platforms:get',
  SET_WINDOW_PLATFORM_INTERACTIONS: 'pet-desktop:platforms:set-enabled',
  QUIT_REQUESTED: 'pet-desktop:shell:quit-requested',
  QUIT_APP: 'pet-desktop:shell:quit',
});

function subscribe(channel, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Listener must be a function');
  }

  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = Object.freeze({
  loadPetCatalog: () => ipcRenderer.invoke(IPC.LOAD_PET_CATALOG),
  importPetpack: () => ipcRenderer.invoke(IPC.IMPORT_PETPACK),
  removePetpack: (id) => ipcRenderer.invoke(IPC.REMOVE_PETPACK, id),
  importItempack: () => ipcRenderer.invoke(IPC.IMPORT_ITEMPACK),
  removeItempack: (id) => ipcRenderer.invoke(IPC.REMOVE_ITEMPACK, id),
  loadState: () => ipcRenderer.invoke(IPC.LOAD_STATE),
  saveState: (state) => ipcRenderer.invoke(IPC.SAVE_STATE, state),

  setInteractiveRegions: (regions) =>
    ipcRenderer.invoke(IPC.SET_INTERACTIVE_REGIONS, regions),
  setPointerHover: (hovered) =>
    ipcRenderer.invoke(IPC.SET_POINTER_HOVER, hovered),
  setIgnoreMouseEvents: (ignore, options = {}) =>
    ipcRenderer.invoke(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, {
      forward: options?.forward !== false,
    }),

  getShellState: () => ipcRenderer.invoke(IPC.GET_SHELL_STATE),
  setShellState: (patch) => ipcRenderer.invoke(IPC.SET_SHELL_STATE, patch),
  getWindowPlatforms: () => ipcRenderer.invoke(IPC.GET_WINDOW_PLATFORMS),
  setWindowPlatformInteractions: (enabled) =>
    ipcRenderer.invoke(IPC.SET_WINDOW_PLATFORM_INTERACTIONS, Boolean(enabled)),
  quitApp: () => ipcRenderer.invoke(IPC.QUIT_APP),

  onPetCatalogChanged: (listener) => subscribe(IPC.PET_CATALOG_CHANGED, listener),
  onShellStateChanged: (listener) => subscribe(IPC.SHELL_STATE_CHANGED, listener),
  onQuitRequested: (listener) => subscribe(IPC.QUIT_REQUESTED, listener),
});

contextBridge.exposeInMainWorld('petDesktop', api);
