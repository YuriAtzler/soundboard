const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { KeyboardWatcher } = require('./keyboard');

const THEMES = ['system', 'light', 'dark'];
const SORT_BY = ['added', 'name', 'key'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm', 'opus'];

let win;
let tray;
// fechar a janela só a esconde, para as teclas continuarem tocando; sair de verdade é
// pelo menu da bandeja (Windows/Linux) ou Cmd+Q (Mac)
let quitting = false;
let dataDir;
let soundsDir;
let configPath;
let config = {
  masterVolume: 1,
  exclusive: false,
  outputDevice: 'default',
  theme: 'system', // 'system' | 'light' | 'dark'
  sort: { by: 'added', dir: 'asc' }, // ordem da tabela de sons; 'added' = ordem de adição
  inputDevice: null, // { id, label } do teclado escolhido (só Windows); null = qualquer teclado
  stopAccelerator: null,
  stopKeyLabel: null,
  activeProfile: null,
  profiles: [],
};
let failedHotkeys = [];
// enquanto o renderer captura uma tecla, os atalhos globais ficam desligados,
// senão o sistema "engole" a tecla antes de ela chegar à janela
let capturing = false;

const keyboard = new KeyboardWatcher();
let keyboardError = null;
let identifying = null; // resolve da promessa de "Identificar teclado", enquanto espera a tecla

// Com um teclado escolhido, as teclas chegam pelo Raw Input (keyboard.js) e o globalShortcut
// fica desligado, senão ele dispararia com a tecla vinda de qualquer teclado.
function deviceMode() {
  return process.platform === 'win32' && !!config.inputDevice && !keyboardError;
}

function syncKeyboard() {
  const needed = process.platform === 'win32' && (!!config.inputDevice || !!identifying);
  if (needed && !keyboard.running && !keyboardError) keyboard.start(dataDir);
  if (!needed && keyboard.running) keyboard.stop();
}

keyboard.on('key', (k) => {
  if (identifying) {
    if (k.code === 'Escape') return; // Esc cancela pelo renderer
    config.inputDevice = { id: k.deviceId, label: k.label };
    saveConfig();
    finishIdentify();
    return;
  }
  if (config.inputDevice && k.deviceId === config.inputDevice.id && !capturing) {
    win?.webContents.send('device-key', k);
  }
});

keyboard.on('error', (message) => {
  keyboardError = message;
  console.error('Leitura de teclados falhou:', message);
  registerShortcuts(); // volta para o globalShortcut
  if (identifying) finishIdentify();
  else win?.webContents.send('state', publicState());
});

function finishIdentify() {
  const resolve = identifying;
  identifying = null;
  syncKeyboard();
  registerShortcuts();
  resolve(publicState());
}

function newProfile(name) {
  return { id: crypto.randomUUID(), name, accelerator: null, keyLabel: null, sounds: [] };
}

function activeProfile() {
  return config.profiles.find((p) => p.id === config.activeProfile);
}

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
  // formato antigo (sem perfis): os sons ficavam na raiz
  if (Array.isArray(config.sounds)) {
    if (!config.profiles.length) {
      const p = newProfile('Principal');
      p.sounds = config.sounds;
      config.profiles.push(p);
    }
    delete config.sounds;
    saveConfig();
  }
  delete config.globalHotkeys; // era uma chave; hoje os atalhos globais estão sempre ligados
  if (!THEMES.includes(config.theme)) config.theme = 'system';
  if (!SORT_BY.includes(config.sort?.by)) config.sort = { by: 'added', dir: 'asc' };
  if (!config.profiles.length) config.profiles.push(newProfile('Principal'));
  if (!activeProfile()) config.activeProfile = config.profiles[0].id;
  // descarta entradas cujo arquivo sumiu
  for (const p of config.profiles) {
    p.sounds = p.sounds.filter((s) => fs.existsSync(path.join(soundsDir, s.file)));
  }
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function publicState() {
  const { profiles, ...settings } = config;
  return {
    ...settings,
    failedHotkeys,
    deviceMode: deviceMode(),
    keyboardError,
    profiles: profiles.map(({ id, name, accelerator, keyLabel, sounds }) => ({
      id, name, accelerator, keyLabel, count: sounds.length,
      // para o renderer avisar quando uma tecla sai de um som de outro perfil
      soundKeys: sounds.filter((s) => s.accelerator).map((s) => ({ name: s.name, accelerator: s.accelerator })),
    })),
    sounds: activeProfile().sounds.map((s) => ({
      ...s,
      url: pathToFileURL(path.join(soundsDir, s.file)).href,
    })),
  };
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  failedHotkeys = failed;
  if (capturing || deviceMode()) return;
  const register = (accelerator, fn) => {
    if (!accelerator) return;
    try {
      if (!globalShortcut.register(accelerator, fn)) failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  };
  register(config.stopAccelerator, () => win?.webContents.send('stop-all'));
  for (const p of config.profiles) {
    register(p.accelerator, () => {
      switchProfile(p.id);
      win?.webContents.send('state', publicState());
    });
  }
  for (const s of activeProfile().sounds) {
    register(s.accelerator, () => win?.webContents.send('play', s.id));
  }
}

// Uma tecla tem um só dono. Sons só valem no próprio perfil, mas "parar tudo" e as
// teclas de troca de perfil valem sempre; por isso estas disputam com os sons de
// todos os perfis (scope), e um som só disputa com os sons do perfil ativo.
function releaseAccelerator(accelerator, owner, scope) {
  if (!accelerator) return;
  for (const p of scope) {
    for (const s of p.sounds) {
      if (s !== owner && s.accelerator === accelerator) {
        s.accelerator = null;
        s.keyLabel = null;
      }
    }
  }
  for (const p of config.profiles) {
    if (p !== owner && p.accelerator === accelerator) {
      p.accelerator = null;
      p.keyLabel = null;
    }
  }
  if (owner !== 'stop' && config.stopAccelerator === accelerator) {
    config.stopAccelerator = null;
    config.stopKeyLabel = null;
  }
}

function switchProfile(id) {
  if (!config.profiles.some((p) => p.id === id) || id === config.activeProfile) return;
  config.activeProfile = id;
  saveConfig();
  registerShortcuts();
}

const isAudio = (file) => AUDIO_EXTS.includes(path.extname(file).toLowerCase().slice(1));

// arquivos que o usuário escolheu, ainda sem copiar: o renderer abre o modal para cada um
function candidates(paths) {
  return paths.filter(isAudio).map((p) => ({
    path: p,
    name: path.basename(p, path.extname(p)),
    url: pathToFileURL(p).href,
  }));
}

// aplica no som os campos editáveis; start/end são o trecho tocado, em segundos (end null = até o fim)
function patchSound(s, patch) {
  for (const k of ['name', 'accelerator', 'keyLabel', 'volume', 'color']) if (k in patch) s[k] = patch[k];
  const ms = (t) => Math.round(Number(t) * 1000) / 1000;
  if ('start' in patch) s.start = Math.max(0, ms(patch.start) || 0);
  if ('end' in patch) s.end = ms(patch.end) > (s.start || 0) ? ms(patch.end) : null;
}

function importFile(srcPath) {
  if (!isAudio(srcPath) || !fs.existsSync(srcPath)) return null;
  const ext = path.extname(srcPath).toLowerCase();
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
    start: 0,
    end: null,
  };
  activeProfile().sounds.push(sound);
  return sound;
}

// O tema é aplicado pelo renderer (data-theme + color-scheme). O nativeTheme fica sempre no
// sistema, senão o prefers-color-scheme passaria a refletir o tema escolhido, e não o do sistema.
function isDark() {
  if (config.theme === 'system') return nativeTheme.shouldUseDarkColors;
  return config.theme === 'dark';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: isDark() ? '#0f1117' : '#f4f5f9',
    title: 'Soundboard',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // mantém o áudio tocando com a janela em segundo plano (atalhos globais)
      backgroundThrottling: false,
      // tema salvo, para a primeira pintura já sair certa (o getState é assíncrono)
      additionalArguments: [`--sb-theme=${config.theme}`],
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // o áudio toca no renderer, então a janela não pode ser destruída
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// no Mac o ícone do Dock já reabre a janela (activate)
function createTray() {
  if (process.platform === 'darwin') return;
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('Soundboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Soundboard', click: showWindow },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

ipcMain.handle('state:get', () => publicState());

ipcMain.handle('sounds:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Escolha arquivos de áudio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Áudio', extensions: AUDIO_EXTS }],
  });
  return res.canceled ? [] : candidates(res.filePaths);
});

ipcMain.handle('sounds:check', (_e, paths) => candidates(paths));

// bytes do áudio para a forma de onda: de um candidato ({ path }) ou de um som já importado ({ id })
ipcMain.handle('sounds:read', (_e, src) => {
  let file = src.path;
  if (src.id) {
    const s = activeProfile().sounds.find((x) => x.id === src.id);
    if (!s) return null;
    file = path.join(soundsDir, s.file);
  }
  if (!file || !isAudio(file)) return null;
  return fs.promises.readFile(file).catch(() => null);
});

// só aqui o arquivo é copiado: cancelar o modal não deixa nada para trás
ipcMain.handle('sounds:add', (_e, draft) => {
  const s = importFile(draft.path);
  if (!s) return publicState();
  patchSound(s, draft);
  releaseAccelerator(s.accelerator, s, [activeProfile()]);
  saveConfig();
  registerShortcuts();
  return publicState();
});

ipcMain.handle('sounds:update', (_e, id, patch) => {
  const s = activeProfile().sounds.find((x) => x.id === id);
  if (!s) return publicState();
  patchSound(s, patch);
  releaseAccelerator(patch.accelerator, s, [activeProfile()]);
  saveConfig();
  if ('accelerator' in patch) registerShortcuts();
  return publicState();
});

// remove sons do perfil ativo (um ou vários, da seleção múltipla)
function removeSounds(ids) {
  const profile = activeProfile();
  const gone = profile.sounds.filter((x) => ids.includes(x.id));
  if (!gone.length) return;
  for (const s of gone) fs.rmSync(path.join(soundsDir, s.file), { force: true });
  profile.sounds = profile.sounds.filter((x) => !ids.includes(x.id));
  saveConfig();
  registerShortcuts();
}

ipcMain.handle('sounds:remove', (_e, id) => {
  removeSounds([id]);
  return publicState();
});

ipcMain.handle('sounds:removeMany', (_e, ids) => {
  removeSounds(ids);
  return publicState();
});

// ajuste em lote: por enquanto só o volume
ipcMain.handle('sounds:volumeMany', (_e, ids, volume) => {
  for (const s of activeProfile().sounds) if (ids.includes(s.id)) s.volume = volume;
  saveConfig();
  return publicState();
});

ipcMain.handle('profiles:create', (_e, name) => {
  const p = newProfile(name);
  config.profiles.push(p);
  switchProfile(p.id);
  return publicState();
});

ipcMain.handle('profiles:update', (_e, id, patch) => {
  const p = config.profiles.find((x) => x.id === id);
  if (!p) return publicState();
  for (const k of ['name', 'accelerator', 'keyLabel']) if (k in patch) p[k] = patch[k];
  releaseAccelerator(patch.accelerator, p, config.profiles);
  saveConfig();
  if ('accelerator' in patch) registerShortcuts();
  return publicState();
});

ipcMain.handle('profiles:remove', (_e, id) => {
  const p = config.profiles.find((x) => x.id === id);
  if (!p || config.profiles.length === 1) return publicState();
  for (const s of p.sounds) fs.rmSync(path.join(soundsDir, s.file), { force: true });
  config.profiles = config.profiles.filter((x) => x !== p);
  if (config.activeProfile === id) config.activeProfile = config.profiles[0].id;
  saveConfig();
  registerShortcuts();
  return publicState();
});

ipcMain.handle('profiles:switch', (_e, id) => {
  switchProfile(id);
  return publicState();
});

ipcMain.handle('capture:set', (_e, on) => {
  capturing = !!on;
  registerShortcuts();
  return publicState();
});

ipcMain.handle('keyboard:identify', () => {
  if (process.platform !== 'win32') return publicState();
  identifying?.(publicState()); // um pedido anterior ainda aberto
  keyboardError = null; // tenta de novo se o auxiliar tinha falhado
  return new Promise((resolve) => {
    identifying = resolve;
    syncKeyboard();
  });
});

ipcMain.handle('keyboard:cancel', () => {
  if (identifying) finishIdentify();
  return publicState();
});

ipcMain.handle('settings:update', (_e, patch) => {
  if ('masterVolume' in patch) config.masterVolume = patch.masterVolume;
  if ('exclusive' in patch) config.exclusive = !!patch.exclusive;
  if ('outputDevice' in patch) config.outputDevice = patch.outputDevice || 'default';
  if ('theme' in patch && THEMES.includes(patch.theme)) config.theme = patch.theme;
  if ('sort' in patch && SORT_BY.includes(patch.sort?.by)) {
    config.sort = { by: patch.sort.by, dir: patch.sort.dir === 'desc' ? 'desc' : 'asc' };
  }
  // o renderer só limpa; quem escolhe o teclado é o keyboard:identify
  if ('inputDevice' in patch && !patch.inputDevice) config.inputDevice = null;
  if ('stopAccelerator' in patch) {
    config.stopAccelerator = patch.stopAccelerator;
    config.stopKeyLabel = patch.stopKeyLabel;
    releaseAccelerator(patch.stopAccelerator, 'stop', config.profiles);
  }
  saveConfig();
  if ('inputDevice' in patch) syncKeyboard();
  if ('stopAccelerator' in patch || 'inputDevice' in patch) registerShortcuts();
  return publicState();
});

// uma instância só: abrir de novo mostra a janela escondida, em vez de disputar as teclas
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => win && showWindow());

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  createTray();
  syncKeyboard();
  registerShortcuts();
  app.on('activate', () => showWindow());
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keyboard.stop();
});
