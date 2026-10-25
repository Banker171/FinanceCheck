const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('financecheckDesktop', Object.freeze({
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: input => ipcRenderer.invoke('settings:save', input),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getUpdateState: () => ipcRenderer.invoke('updates:get'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
}));
