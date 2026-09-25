const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { KeyboardWatcher } = require('./keyboard');
const { writeZip, readZip } = require('./archive');
const updater = require('./updater');
const i18n = require('./i18n');

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
  language: 'system', // 'system' ou um de i18n.LANGUAGES
  closeToTray: true, // fechar a janela só esconde (false = sai do app)
  trayNoticeShown: false, // o aviso "continua rodando" só aparece no primeiro fechamento
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
      const p = newProfile(i18n.t('main.defaultProfile'));
      p.sounds = config.sounds;
      config.profiles.push(p);
    }
    delete config.sounds;
    saveConfig();
  }
  delete config.globalHotkeys; // era uma chave; hoje os atalhos globais estão sempre ligados
  if (!THEMES.includes(config.theme)) config.theme = 'system';
  if (config.language !== 'system' && !i18n.LANGUAGES.includes(config.language)) config.language = 'system';
  i18n.setLanguage(config.language); // antes do perfil padrão, que nasce com nome no idioma
  if (!SORT_BY.includes(config.sort?.by)) config.sort = { by: 'added', dir: 'asc' };
  if (!config.profiles.length) config.profiles.push(newProfile(i18n.t('main.defaultProfile')));
  if (!activeProfile()) config.activeProfile = config.profiles[0].id;
  // descarta entradas cujo arquivo sumiu
  for (const p of config.profiles) {
    p.sounds = p.sounds.filter((s) => fs.existsSync(path.join(soundsDir, s.file)));
  }
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  updateTrayMenu(); // perfis, nomes e o perfil ativo aparecem no menu
}

function publicState() {
  const { profiles, ...settings } = config;
  return {
    ...settings,
    failedHotkeys,
    openAtLogin,
    canOpenAtLogin: canOpenAtLogin(),
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

// ---------- exportar e importar perfis ----------

// Um .soundboard é um ZIP com soundboard.json (o manifesto) e os áudios em sounds/.
const EXPORT_FORMAT = 'soundboard-export';
const EXPORT_VERSION = 1;

// sem os ids: a importação gera novos, para não colidir com o que já existe
function profileForExport(p) {
  return {
    name: p.name,
    accelerator: p.accelerator,
    keyLabel: p.keyLabel,
    sounds: p.sounds.map(({ id, ...sound }) => sound),
  };
}

function writeExport(outPath, type, profiles, settings) {
  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    type,
    app: app.getVersion(),
    exportedAt: new Date().toISOString(),
    profiles: profiles.map(profileForExport),
    ...(settings && { settings }),
  };
  const files = [...new Set(profiles.flatMap((p) => p.sounds.map((s) => s.file)))];
  writeZip(outPath, [
    { name: 'soundboard.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    // lido só na hora de gravar, um áudio por vez
    ...files.map((f) => ({ name: `sounds/${f}`, data: () => fs.readFileSync(path.join(soundsDir, f)) })),
  ]);
}

function readExport(file) {
  const zip = readZip(file);
  let manifest;
  try {
    manifest = JSON.parse(zip.read('soundboard.json')?.toString('utf8'));
  } catch {
    manifest = null;
  }
  if (manifest?.format !== EXPORT_FORMAT || !Array.isArray(manifest.profiles)) {
    throw new Error(i18n.t('import.notSoundboard'));
  }
  if (manifest.version > EXPORT_VERSION) {
    throw new Error(i18n.t('import.newer'));
  }
  return { manifest, zip };
}

function uniqueProfileName(name) {
  let candidate = name;
  for (let i = 2; config.profiles.some((p) => p.name === candidate); i++) candidate = `${name} (${i})`;
  return candidate;
}

// Cria os perfis do arquivo com ids novos. Os áudios vão para sounds/ com nomes novos
// (o caminho de dentro do ZIP nunca vira caminho no disco). Teclas que já têm dono ficam de
// fora: a do perfil vale em qualquer lugar, então só entra se estiver livre; a de um som só
// perde para "parar tudo" e as teclas de perfil.
function importProfiles(manifest, zip) {
  const created = [];
  let droppedKeys = 0;
  let missing = 0;
  const globalOwner = (acc) =>
    acc === config.stopAccelerator || config.profiles.some((p) => p.accelerator === acc);
  for (const src of manifest.profiles) {
    const p = newProfile(uniqueProfileName(String(src.name || i18n.t('import.defaultName')).slice(0, 60)));
    const inUse = (acc) => globalOwner(acc) || config.profiles.some((x) => x.sounds.some((s) => s.accelerator === acc));
    if (src.accelerator && !inUse(src.accelerator)) {
      p.accelerator = src.accelerator;
      p.keyLabel = src.keyLabel;
    } else if (src.accelerator) droppedKeys++;
    for (const s of Array.isArray(src.sounds) ? src.sounds : []) {
      const ext = path.extname(String(s.file || '')).toLowerCase();
      let data = null;
      try {
        if (isAudio(`x${ext}`)) data = zip.read(`sounds/${s.file}`);
      } catch {
        data = null; // áudio corrompido: pula só ele
      }
      if (!data) {
        missing++;
        continue;
      }
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(soundsDir, id + ext), data);
      const volume = Number(s.volume);
      const sound = {
        id,
        file: id + ext,
        name: String(s.name || i18n.t('name.untitled')).slice(0, 120),
        accelerator: null,
        keyLabel: null,
        volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1,
        color: Number.isInteger(s.color) ? s.color : 0,
        start: 0,
        end: null,
      };
      patchSound(sound, { start: s.start, end: s.end });
      const acc = s.accelerator;
      if (acc && !globalOwner(acc) && acc !== p.accelerator && !p.sounds.some((x) => x.accelerator === acc)) {
        sound.accelerator = acc;
        sound.keyLabel = s.keyLabel;
      } else if (acc) droppedKeys++;
      p.sounds.push(sound);
    }
    config.profiles.push(p);
    created.push(p);
  }
  return { created, droppedKeys, missing };
}

// configurações que vão no backup; saída de áudio e teclado escolhido dependem do computador e ficam
const BACKUP_SETTINGS = ['masterVolume', 'exclusive', 'theme', 'sort', 'closeToTray', 'stopAccelerator', 'stopKeyLabel'];

function applyBackupSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  const volume = Number(settings.masterVolume);
  if (Number.isFinite(volume)) config.masterVolume = Math.min(1, Math.max(0, volume));
  if ('exclusive' in settings) config.exclusive = !!settings.exclusive;
  if (THEMES.includes(settings.theme)) config.theme = settings.theme;
  if (SORT_BY.includes(settings.sort?.by)) config.sort = { by: settings.sort.by, dir: settings.sort.dir === 'desc' ? 'desc' : 'asc' };
  if ('closeToTray' in settings) config.closeToTray = !!settings.closeToTray;
  if ('stopAccelerator' in settings) {
    config.stopAccelerator = settings.stopAccelerator || null;
    config.stopKeyLabel = settings.stopAccelerator ? settings.stopKeyLabel : null;
  }
}

// erro que vai para o toast: os do ZIP têm code e viram texto no idioma do app
const errorText = (err) => (err.code && i18n.t(`zip.${err.code}`) !== `zip.${err.code}` ? i18n.t(`zip.${err.code}`) : err.message);

const SOUNDBOARD_FILTER = [{ name: 'Soundboard', extensions: ['soundboard'] }];
const safeFileName = (name) => name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'perfil';

// ---------- iniciar com o sistema ----------

// Ao abrir junto com o sistema, o app começa escondido na bandeja (as teclas já funcionam).
// Windows/Linux recebem --hidden; no Mac não há argumentos, então vale o wasOpenedAtLogin.
const startHidden = process.argv.includes('--hidden') ||
  (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

// o portátil do Windows roda de uma cópia temporária; o caminho que fica é o do .exe original
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
const autostartFile = () => path.join(app.getPath('appData'), 'autostart', 'soundboard.desktop');

// no npm start o executável é o electron "cru", que abriria sem o app
const canOpenAtLogin = () => app.isPackaged;

function readOpenAtLogin() {
  if (!canOpenAtLogin()) return false;
  if (process.platform === 'linux') return fs.existsSync(autostartFile());
  return app.getLoginItemSettings({ path: exePath(), args: ['--hidden'] }).openAtLogin;
}

function setOpenAtLogin(on) {
  if (!canOpenAtLogin()) return;
  if (process.platform === 'linux') {
    // o Electron não tem API de login no Linux; o padrão freedesktop é um .desktop em ~/.config/autostart
    if (!on) {
      fs.rmSync(autostartFile(), { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(autostartFile()), { recursive: true });
    fs.writeFileSync(autostartFile(), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Soundboard',
      `Exec="${exePath()}" --hidden`,
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, path: exePath(), args: ['--hidden'] });
}

let openAtLogin = false; // lido do sistema na abertura e depois de cada mudança

// O tema é aplicado pelo renderer (data-theme + color-scheme). O nativeTheme fica sempre no
// sistema, senão o prefers-color-scheme passaria a refletir o tema escolhido, e não o do sistema.
function isDark() {
  if (config.theme === 'system') return nativeTheme.shouldUseDarkColors;
  return config.theme === 'dark';
}

function createWindow() {
  win = new BrowserWindow({
    show: !startHidden,
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
    if (!config.closeToTray) {
      app.quit();
      return;
    }
    win.hide();
    if (!config.trayNoticeShown) {
      config.trayNoticeShown = true;
      saveConfig();
      showTrayNotice();
    }
  });
}

// no primeiro fechamento, avisa que o app segue rodando (senão parece que fechou e as teclas "funcionam sozinhas")
function showTrayNotice() {
  const where = i18n.t(process.platform === 'darwin' ? 'notice.mac' : 'notice.tray');
  const body = i18n.t('notice.body', { where });
  if (Notification.isSupported()) {
    const n = new Notification({ title: i18n.t('notice.title'), body });
    n.on('click', showWindow);
    n.show();
  } else if (tray && process.platform === 'win32') {
    tray.displayBalloon({ title: i18n.t('notice.title'), content: body });
  }
}

function showWindow() {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// no Mac o ícone do Dock já reabre a janela (activate)
function createTray() {
  if (process.platform === 'darwin') {
    updateTrayMenu(); // no Mac não há bandeja; o menu vai para o ícone no Dock
    return;
  }
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.on('click', showWindow);
  updateTrayMenu();
}

// menu do ícone da bandeja (no Mac, do ícone no Dock): perfis, parar tudo, abrir e sair
function updateTrayMenu() {
  if (!tray && process.platform !== 'darwin') return;
  const profiles = config.profiles.map((p) => ({
    label: p.keyLabel ? `${p.name}   (${p.keyLabel})` : p.name,
    type: 'radio',
    checked: p.id === config.activeProfile,
    click: () => {
      switchProfile(p.id);
      win?.webContents.send('state', publicState());
    },
  }));
  const stop = { label: i18n.t('tray.stopAll'), click: () => win?.webContents.send('stop-all') };
  if (process.platform === 'darwin') {
    // o Dock já tem "Abrir" e "Sair"
    app.dock?.setMenu(Menu.buildFromTemplate([...profiles, { type: 'separator' }, stop]));
    return;
  }
  tray.setToolTip(`Soundboard · ${activeProfile()?.name ?? ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: i18n.t('tray.open'), click: showWindow },
    { type: 'separator' },
    { label: i18n.t('tray.profiles'), enabled: false },
    ...profiles,
    { type: 'separator' },
    stop,
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => app.quit() },
  ]));
}

ipcMain.handle('state:get', () => publicState());
ipcMain.on('i18n:get', (e) => {
  e.returnValue = { language: i18n.language(), dict: i18n.dictionary() };
});

ipcMain.handle('sounds:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: i18n.t('dialog.pickAudio'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: i18n.t('dialog.audioFilter'), extensions: AUDIO_EXTS }],
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

ipcMain.handle('profiles:export', async (_e, id) => {
  const p = config.profiles.find((x) => x.id === id);
  if (!p) return { ok: false };
  const res = await dialog.showSaveDialog(win, {
    title: i18n.t('dialog.exportProfile'),
    defaultPath: path.join(app.getPath('documents'), `${safeFileName(p.name)}.soundboard`),
    filters: SOUNDBOARD_FILTER,
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    writeExport(res.filePath, 'profile', [p]);
    return { ok: true, file: path.basename(res.filePath) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
});

// sem caminho, pergunta o arquivo; com caminho (arquivo solto na janela), importa direto
ipcMain.handle('profiles:import', async (_e, filePath) => {
  let file = filePath;
  if (!file) {
    const res = await dialog.showOpenDialog(win, { title: i18n.t('dialog.importProfile'), properties: ['openFile'], filters: SOUNDBOARD_FILTER });
    if (res.canceled) return { state: publicState() };
    file = res.filePaths[0];
  }
  try {
    const { manifest, zip } = readExport(file);
    const { created, droppedKeys, missing } = importProfiles(manifest, zip);
    if (created.length) config.activeProfile = created[0].id;
    saveConfig();
    registerShortcuts();
    return { state: publicState(), imported: created.map((p) => p.name), droppedKeys, missing };
  } catch (err) {
    return { state: publicState(), error: errorText(err) };
  }
});

ipcMain.handle('backup:export', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: i18n.t('dialog.backup'),
    defaultPath: path.join(app.getPath('documents'), `${i18n.t('dialog.backupFile', { date: stamp })}.soundboard`),
    filters: SOUNDBOARD_FILTER,
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    const settings = Object.fromEntries(BACKUP_SETTINGS.map((k) => [k, config[k]]));
    writeExport(res.filePath, 'backup', config.profiles, settings);
    return { ok: true, file: path.basename(res.filePath) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
});

// Restaurar pergunta se junta aos perfis atuais ou substitui tudo. Substituir importa primeiro
// e só depois apaga os perfis antigos, para um arquivo com problema não deixar o app vazio.
ipcMain.handle('backup:restore', async () => {
  const pick = await dialog.showOpenDialog(win, { title: i18n.t('dialog.restore'), properties: ['openFile'], filters: SOUNDBOARD_FILTER });
  if (pick.canceled) return { state: publicState() };
  let parsed;
  try {
    parsed = readExport(pick.filePaths[0]);
  } catch (err) {
    return { state: publicState(), error: errorText(err) };
  }
  const { manifest, zip } = parsed;
  const count = manifest.profiles.length;
  const sounds = manifest.profiles.reduce((n, p) => n + (p.sounds?.length || 0), 0);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: i18n.t('dialog.restore'),
    message: i18n.t('restore.message', { profiles: i18n.t('restore.profiles', { n: count }), sounds: i18n.t('restore.sounds', { n: sounds }) }),
    detail: i18n.t('restore.detail'),
    buttons: [i18n.t('restore.merge'), i18n.t('restore.replace'), i18n.t('restore.cancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 2) return { state: publicState() };
  const replace = response === 1;
  const old = { profiles: config.profiles, ...Object.fromEntries(BACKUP_SETTINGS.map((k) => [k, config[k]])) };
  try {
    if (replace) {
      // as teclas do backup disputam só entre si, não com os perfis que vão sair
      config.profiles = [];
      applyBackupSettings(manifest.settings);
    }
    const { created, droppedKeys, missing } = importProfiles(manifest, zip);
    if (replace && !created.length) throw new Error(i18n.t('import.emptyBackup'));
    if (replace) {
      for (const p of old.profiles) for (const s of p.sounds) fs.rmSync(path.join(soundsDir, s.file), { force: true });
    }
    if (created.length) config.activeProfile = created[0].id;
    saveConfig();
    registerShortcuts();
    return { state: publicState(), imported: created.map((p) => p.name), droppedKeys, missing, replaced: replace };
  } catch (err) {
    if (replace) {
      // desfaz: apaga o que chegou a ser copiado e volta perfis e configurações
      for (const p of config.profiles) for (const s of p.sounds) fs.rmSync(path.join(soundsDir, s.file), { force: true });
      Object.assign(config, old);
    }
    return { state: publicState(), error: errorText(err) };
  }
});

ipcMain.handle('update:get', () => updater.getStatus());
ipcMain.handle('update:check', () => {
  updater.check();
  return updater.getStatus();
});
ipcMain.handle('update:install', () => {
  updater.install(() => {
    quitting = true;
  });
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
  if ('closeToTray' in patch) config.closeToTray = !!patch.closeToTray;
  let languageChanged = false;
  if ('language' in patch && (patch.language === 'system' || i18n.LANGUAGES.includes(patch.language))) {
    config.language = patch.language;
    const before = i18n.language();
    languageChanged = i18n.setLanguage(config.language) !== before;
  }
  if ('openAtLogin' in patch) {
    setOpenAtLogin(!!patch.openAtLogin);
    openAtLogin = readOpenAtLogin();
  }
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
  // o renderer troca os textos sem recarregar; o menu da bandeja já foi refeito no saveConfig
  if (languageChanged) win?.webContents.send('language', { language: i18n.language(), dict: i18n.dictionary() });
  return publicState();
});

// uma instância só: abrir de novo mostra a janela escondida, em vez de disputar as teclas
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => win && showWindow());

if (process.platform === 'win32') app.setAppUserModelId('com.atzler.soundboard');

app.whenReady().then(() => {
  loadConfig();
  openAtLogin = readOpenAtLogin();
  createWindow();
  createTray();
  updater.start((status) => win?.webContents.send('update', status));
  syncKeyboard();
  registerShortcuts();
  app.on('activate', () => showWindow());
});

app.on('before-quit', () => {
  quitting = true;
  updater.onQuit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keyboard.stop();
});
