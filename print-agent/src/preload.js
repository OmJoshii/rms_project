'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printRelay', {
  openHealth: () => ipcRenderer.invoke('relay:open-health'),
  getHealth: () => ipcRenderer.invoke('relay:get-health'),
  getStatus: () => ipcRenderer.invoke('relay:get-status'),
  getDebug: () => ipcRenderer.invoke('relay:get-debug'),
  openConfig: () => ipcRenderer.invoke('relay:open-config'),
  hide: () => ipcRenderer.invoke('relay:hide-window'),
  saveConfig: (config) => ipcRenderer.invoke('relay:save-config', config),
  pairOdoo: (pairing) => ipcRenderer.invoke('relay:pair-odoo', pairing),
});
