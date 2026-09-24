const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  pickSounds: () => ipcRenderer.invoke('sounds:pick'),
  importFiles: (files) =>
    ipcRenderer.invoke('sounds:import', Array.from(files).map((f) => webUtils.getPathForFile(f))),
  updateSound: (id, patch) => ipcRenderer.invoke('sounds:update', id, patch),
  removeSound: (id) => ipcRenderer.invoke('sounds:remove', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  onPlay: (cb) => ipcRenderer.on('play', (_e, id) => cb(id)),
  onStopAll: (cb) => ipcRenderer.on('stop-all', () => cb()),
  platform: process.platform,
});
