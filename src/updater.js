// Atualização pelo próprio app.
// - 'auto': Windows instalado (NSIS) e AppImage. O electron-updater baixa em segundo plano e
//   o usuário só clica em "Reiniciar e atualizar".
// - 'portable': .exe portátil do Windows. O app consulta a API de releases, baixa o .exe novo e,
//   ao reiniciar ou sair, o portable-update.ps1 troca o .exe original pelo novo depois que o app fecha.
//   Se a pasta do .exe não aceitar escrita, cai no 'manual'.
// - 'manual': Mac (o Squirrel.Mac exige assinatura paga) e .deb. O app consulta a última Release
//   no GitHub e o botão abre o download do arquivo certo.
// - 'dev': npm start. Consulta como no 'manual', para dar para testar, mas o botão abre a página
//   da Release.

const { app, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');

const REPO = 'YuriAtzler/soundboard';
const CHECK_EVERY = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let status = { mode: 'dev', current: '', state: 'idle', latest: null, progress: 0, error: null };
let notify = () => {};
let downloaded = null; // caminho do .exe portátil novo, já baixado

function detectMode() {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? portableMode() : 'auto';
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'auto';
  return 'manual';
}

// o portátil só se atualiza sozinho se der para escrever na pasta do .exe (não dá em Program Files, por exemplo)
function portableMode() {
  const probe = path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), `.soundboard-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return 'portable';
  } catch {
    return 'manual';
  }
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
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/.test(msg)) return i18n.t('update.offline');
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
    if (!newer(latest, status.current)) return set({ state: 'none', latest });
    set({ state: 'available', latest });
  } catch (err) {
    return set({ state: 'error', error: friendly(err) });
  }
  if (status.mode === 'portable') downloadPortable(status.latest);
}

// baixa o .exe portátil da versão nova para a pasta temporária, com progresso
async function downloadPortable(version) {
  set({ state: 'downloading', progress: 0 });
  const file = path.join(app.getPath('temp'), `Soundboard-Portatil-${version}.exe`);
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/download/v${version}/${downloadAsset()}`);
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(file);
    let received = 0;
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const progress = total ? Math.round((received / total) * 100) : 0;
        if (progress !== status.progress) set({ progress }); // um aviso por ponto percentual, não por pedaço
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && received !== total) throw new Error(i18n.t('update.badDownload'));
    const head = Buffer.alloc(2);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString() !== 'MZ') throw new Error(i18n.t('update.badDownload'));
    downloaded = file;
    set({ state: 'ready', progress: 100 });
  } catch (err) {
    fs.rmSync(file, { force: true });
    set({ state: 'error', error: friendly(err) });
  }
}

// Troca o .exe portátil depois que o app fechar. O script vai para a pasta temporária porque o
// PowerShell não lê de dentro do app.asar, e roda desanexado, para sobreviver ao fim do app.
function applyPortable(relaunch) {
  if (!downloaded) return;
  const script = path.join(app.getPath('temp'), 'soundboard-portable-update.ps1');
  fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'portable-update.ps1')));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', script, '-New', downloaded, '-Exe', process.env.PORTABLE_EXECUTABLE_FILE];
  if (relaunch) args.push('-Relaunch');
  spawn('powershell.exe', args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  downloaded = null;
}

// ao sair com a versão nova já baixada, instala sem abrir de novo (como o autoInstallOnAppQuit)
function onQuit() {
  if (status.mode === 'portable' && status.state === 'ready') applyPortable(false);
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
  if (status.mode === 'portable' && status.state === 'ready') {
    beforeQuit();
    applyPortable(true);
    app.quit();
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

module.exports = { start, check, install, onQuit, getStatus: () => status };
