// Atualização pelo próprio app.
// - 'auto': Windows instalado (NSIS) e AppImage. O electron-updater baixa em segundo plano e
//   o usuário só clica em "Reiniciar e atualizar".
// - 'manual': Mac (o Squirrel.Mac exige assinatura paga), .exe portátil e .deb. O app consulta a
//   última Release no GitHub e o botão abre o download do arquivo certo.
// - 'dev': npm start. Consulta como no 'manual', para dar para testar, mas o botão abre a página
//   da Release.

const { app, shell } = require('electron');

const REPO = 'YuriAtzler/soundboard';
const CHECK_EVERY = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let status = { mode: 'dev', current: '', state: 'idle', latest: null, progress: 0, error: null };
let notify = () => {};

function detectMode() {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE) return 'auto';
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'auto';
  return 'manual';
}

// o nome fixo de cada instalador (artifactName no package.json), para o link latest/download
function downloadAsset() {
  if (process.platform === 'darwin') return `Soundboard-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'Soundboard-Portatil.exe' : 'Soundboard-Setup.exe';
  return process.env.APPIMAGE ? 'Soundboard-linux.AppImage' : 'soundboard-linux.deb';
}

// 1.10.0 > 1.9.3; ignora sufixos como -beta
function newer(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// o electron-updater manda a resposta HTTP inteira na mensagem; aqui vira uma frase
function friendly(err) {
  const msg = String(err?.message || err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/.test(msg)) return 'sem conexão com o GitHub';
  return msg.split('\n')[0].slice(0, 120);
}

function set(patch) {
  status = { ...status, ...patch };
  notify(status);
}

async function checkGitHub() {
  set({ state: 'checking', error: null });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const latest = String((await res.json()).tag_name || '').replace(/^v/, '');
    status.current = app.getVersion();
    set(newer(latest, status.current) ? { state: 'available', latest } : { state: 'none', latest });
  } catch (err) {
    set({ state: 'error', error: friendly(err) });
  }
}

function check() {
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return;
  if (status.mode === 'auto') {
    set({ state: 'checking', error: null });
    // Se a Release não tiver os latest*.yml (as publicadas antes do updater), ainda dá para
    // avisar pela API e oferecer o download, como no modo manual.
    autoUpdater.checkForUpdates().catch(checkGitHub);
  } else {
    checkGitHub();
  }
}

// "Reiniciar e atualizar" (auto) ou abrir o download (manual/dev)
function install(beforeQuit) {
  if (status.mode === 'auto' && status.state === 'ready') {
    beforeQuit(); // libera o fechamento da janela, que normalmente só esconde
    autoUpdater.quitAndInstall(true, true);
    return;
  }
  if (status.state !== 'available') return;
  const url = status.mode === 'dev'
    ? `https://github.com/${REPO}/releases/latest`
    : `https://github.com/${REPO}/releases/latest/download/${downloadAsset()}`;
  shell.openExternal(url);
}

function start(onChange) {
  notify = onChange;
  status = { ...status, mode: detectMode(), current: app.getVersion() };
  if (status.mode === 'auto') {
    // só carrega onde é usado: no Mac e no dev ele não tem o que fazer
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', latest: info.version, progress: 0 }));
    autoUpdater.on('update-not-available', (info) => set({ state: 'none', latest: info.version }));
    autoUpdater.on('download-progress', (p) => set({ state: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', latest: info.version, progress: 100 }));
    // erro na consulta é tratado no catch do check(); aqui sobra o erro do download
    autoUpdater.on('error', (err) => {
      if (status.state === 'downloading') set({ state: 'error', error: friendly(err) });
    });
  }
  // dá tempo do app abrir antes da primeira consulta
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY);
}

module.exports = { start, check, install, getStatus: () => status };
