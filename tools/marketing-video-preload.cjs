'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marketingRecorder', {
  finish(payload) {
    return ipcRenderer.invoke('marketing:finish', payload);
  },
});
