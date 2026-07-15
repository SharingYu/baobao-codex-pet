'use strict';

/**
 * Keep Electron channel names in one dependency-free module so the main and
 * preload processes cannot silently drift apart.
 */
const IPC = Object.freeze({
  LOAD_PET_CATALOG: 'pet-desktop:catalog:load',
  IMPORT_PETPACK: 'pet-desktop:catalog:import',
  REMOVE_PETPACK: 'pet-desktop:catalog:remove',
  PET_CATALOG_CHANGED: 'pet-desktop:catalog:changed',
  LOAD_STATE: 'pet-desktop:state:load',
  SAVE_STATE: 'pet-desktop:state:save',
  SET_INTERACTIVE_REGIONS: 'pet-desktop:overlay:set-interactive-regions',
  SET_POINTER_HOVER: 'pet-desktop:overlay:set-pointer-hover',
  SET_IGNORE_MOUSE_EVENTS: 'pet-desktop:overlay:set-ignore-mouse-events',
  GET_SHELL_STATE: 'pet-desktop:shell:get-state',
  SET_SHELL_STATE: 'pet-desktop:shell:set-state',
  SHELL_STATE_CHANGED: 'pet-desktop:shell:state-changed',
});

module.exports = { IPC };
