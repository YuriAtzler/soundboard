const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm', 'opus'];

let win;
let dataDir;
let soundsDir;
let configPath;
let config = { globalHotkeys: false, masterVolume: 1, stopAccelerator: null, stopKeyLabel: null, sounds: [] };
let failedHotkeys = [];

function loadConfig() {
  dataDir = app.getPath('userData');
  soundsDir = path.join(dataDir, 'sounds');
  configPath = path.join(dataDir, 'soundboard.json');
  fs.mkdirSync(soundsDir, { recursive: true });
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    // primeira execução ou arquivo corrompido: começa vazio
  }
  // descarta entradas cujo arquivo sumiu
  config.sounds = config.sounds.filter((s) => fs.existsSync(path.join(soundsDir, s.file)));
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function publicState() {
  return {
    ...config,
    failedHotkeys,
    sounds: config.sounds.map((s) => ({
      ...s,
      url: pathToFileURL(path.join(soundsDir, s.file)).href,
    })),
  };
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  failedHotkeys = failed;
  if (!config.globalHotkeys) return;
  if (config.stopAccelerator) {
    try {
      const ok = globalShortcut.register(config.stopAccelerator, () => {
        win?.webContents.send('stop-all');
      });
      if (!ok) failed.push(config.stopAccelerator);
    } catch {
      failed.push(config.stopAccelerator);
    }
  }
  for (const s of config.sounds) {
    if (!s.accelerator) continue;
    try {
      const ok = globalShortcut.register(s.accelerator, () => {
        win?.webContents.send('play', s.id);
      });
      if (!ok) failed.push(s.accelerator);
    } catch {
      failed.push(s.accelerator);
    }
  }
}

function importFile(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!AUDIO_EXTS.includes(ext.slice(1))) return null;
  const id = crypto.randomUUID();
  const file = id + ext;
  fs.copyFileSync(srcPath, path.join(soundsDir, file));
  const sound = {
    id,
    file,
    name: path.basename(srcPath, ext),
    accelerator: null,
    keyLabel: null,
    volume: 1,
    color: Math.floor(Math.random() * 6),
  };
  config.sounds.push(sound);
  return sound;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#0f1117',
    title: 'Soundboard',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // mantém o áudio tocando com a janela em segundo plano (atalhos globais)
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('state:get', () => publicState());

ipcMain.handle('sounds:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Escolha arquivos de áudio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Áudio', extensions: AUDIO_EXTS }],
  });
  if (res.canceled) return publicState();
  res.filePaths.forEach(importFile);
  saveConfig();
  return publicState();
});

ipcMain.handle('sounds:import', (_e, paths) => {
  paths.forEach(importFile);
  saveConfig();
  return publicState();
});

ipcMain.handle('sounds:update', (_e, id, patch) => {
  const s = config.sounds.find((x) => x.id === id);
  if (!s) return publicState();
  const allowed = ['name', 'accelerator', 'keyLabel', 'volume', 'color'];
  for (const k of allowed) if (k in patch) s[k] = patch[k];
  // uma tecla só pode pertencer a um som (ou ao "parar tudo")
  if (patch.accelerator) {
    for (const o of config.sounds) {
      if (o.id !== id && o.accelerator === patch.accelerator) {
        o.accelerator = null;
        o.keyLabel = null;
      }
    }
    if (config.stopAccelerator === patch.accelerator) {
      config.stopAccelerator = null;
      config.stopKeyLabel = null;
    }
  }
  saveConfig();
  if ('accelerator' in patch) registerShortcuts();
  return publicState();
});

ipcMain.handle('sounds:remove', (_e, id) => {
  const s = config.sounds.find((x) => x.id === id);
  if (s) {
    fs.rmSync(path.join(soundsDir, s.file), { force: true });
    config.sounds = config.sounds.filter((x) => x.id !== id);
    saveConfig();
    registerShortcuts();
  }
  return publicState();
});

ipcMain.handle('settings:update', (_e, patch) => {
  if ('globalHotkeys' in patch) config.globalHotkeys = !!patch.globalHotkeys;
  if ('masterVolume' in patch) config.masterVolume = patch.masterVolume;
  if ('stopAccelerator' in patch) {
    config.stopAccelerator = patch.stopAccelerator;
    config.stopKeyLabel = patch.stopKeyLabel;
    for (const o of config.sounds) {
      if (patch.stopAccelerator && o.accelerator === patch.stopAccelerator) {
        o.accelerator = null;
        o.keyLabel = null;
      }
    }
  }
  saveConfig();
  if ('globalHotkeys' in patch || 'stopAccelerator' in patch) registerShortcuts();
  return publicState();
});

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  registerShortcuts();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
