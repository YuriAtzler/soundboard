const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  pickSounds: () => ipcRenderer.invoke('sounds:pick'),
  importFiles: (files) =>
    ipcRenderer.invoke('sounds:import', Array.from(files).map((f) => webUtils.getPathForFile(f))),
  updateSound: (id, patch) => ipcRenderer.invoke('sounds:update', id, patch),
  removeSound: (id) => ipcRenderer.invoke('sounds:remove', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  updateProfile: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  switchProfile: (id) => ipcRenderer.invoke('profiles:switch', id),
  setCapturing: (on) => ipcRenderer.invoke('capture:set', on),
  identifyKeyboard: () => ipcRenderer.invoke('keyboard:identify'),
  cancelIdentify: () => ipcRenderer.invoke('keyboard:cancel'),
  onPlay: (cb) => ipcRenderer.on('play', (_e, id) => cb(id)),
  onStopAll: (cb) => ipcRenderer.on('stop-all', () => cb()),
  onDeviceKey: (cb) => ipcRenderer.on('device-key', (_e, key) => cb(key)),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  platform: process.platform,
});
