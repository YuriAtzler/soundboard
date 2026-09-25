const sb = window.api;
const isMac = sb.platform === 'darwin';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const empty = $('#empty');
const tpl = $('#rowTpl');
const list = $('#list');
const tabTpl = $('#tabTpl');
const tabsEl = $('#tabs');

let state = {
  sounds: [], profiles: [], activeProfile: null, masterVolume: 1,
  exclusive: false, outputDevice: 'default', theme: 'system', inputDevice: null, deviceMode: false, keyboardError: null, stopAccelerator: null, stopKeyLabel: null, failedHotkeys: [],
};
const players = new Map(); // id -> HTMLAudioElement
const rows = new Map(); // id -> linha da tabela
const tabs = new Map(); // id do perfil -> element

// ---------- teclas -> accelerator do Electron ----------

const CODE_MAP = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', NumpadEnter: 'Enter',
};

const LABEL_MAP = {
  Space: '␣', Enter: '↵', Tab: '⇥', Delete: 'Del', Insert: 'Ins',
  Up: '↑', Down: '↓', Left: '←', Right: '→', PageUp: 'PgUp', PageDown: 'PgDn',
  numadd: 'Num +', numsub: 'Num −', nummult: 'Num ×', numdiv: 'Num ÷', numdec: 'Num .',
};

function keyFromCode(code) {
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^Numpad(\d)$/))) return 'num' + m[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_MAP[code] || null;
}

function eventToShortcut(e) {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const mods = [];
  const labels = [];
  if (e.ctrlKey) { mods.push('Control'); labels.push(isMac ? '⌃' : 'Ctrl'); }
  if (e.metaKey) { mods.push(isMac ? 'Command' : 'Super'); labels.push(isMac ? '⌘' : 'Win'); }
  if (e.altKey) { mods.push('Alt'); labels.push(isMac ? '⌥' : 'Alt'); }
  if (e.shiftKey) { mods.push('Shift'); labels.push(isMac ? '⇧' : 'Shift'); }
  const keyLabel = LABEL_MAP[key] || (key.startsWith('num') ? 'Num ' + key.slice(3) : key);
  labels.push(keyLabel);
  return {
    accelerator: [...mods, key].join('+'),
    keyLabel: labels.join(isMac ? '' : '+'),
  };
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

// No Windows, com o NumLock desligado o teclado numérico manda End/Seta/PgDn etc.,
// então o atalho global num1..num9 não dispara; nesse caso quem trata é o keydown local.
function numpadWithoutNumLock(e) {
  return sb.platform === 'win32' && /^Numpad\d$/.test(e.code) && !e.getModifierState('NumLock');
}

// Estado do NumLock, para avisar das teclas numN (só dá para ler num evento de teclado ou mouse).
let numLockOff = false;
function trackNumLock(e) {
  const off = sb.platform === 'win32' && e.getModifierState && !e.getModifierState('NumLock');
  if (off === numLockOff) return;
  numLockOff = off;
  if (state.profiles.length) applyState(state); // atualiza os avisos das teclas
}
window.addEventListener('keydown', trackNumLock, true);
window.addEventListener('mousedown', trackNumLock, true);

// por que uma tecla vinculada só funciona com o app em foco; null se estiver tudo certo
function keyProblem(accelerator, keyLabel) {
  if (!accelerator) return null;
  if (state.failedHotkeys.includes(accelerator)) {
    return `O sistema não deixou usar ${keyLabel} como atalho global (outro programa já usa). Ela só funciona com o Soundboard em foco.`;
  }
  if (numLockOff && !state.deviceMode && /^num\d$/.test(accelerator)) {
    return `O NumLock está desligado, então ${keyLabel} só funciona com o Soundboard em foco. Ligue o NumLock.`;
  }
  return null;
}

// marca a tecla com problema (borda de aviso + explicação no tooltip)
function markKey(el, accelerator, keyLabel, title) {
  const problem = keyProblem(accelerator, keyLabel);
  el.classList.toggle('warn', !!problem);
  el.title = problem || title;
  return problem;
}

// ---------- reprodução ----------

function effectiveVolume(sound) {
  return Math.max(0, Math.min(1, sound.volume * state.masterVolume));
}

// '' é a saída padrão para o setSinkId
const sinkId = () => (state.outputDevice === 'default' ? '' : state.outputDevice);

async function applySink(audio) {
  if (audio.sinkId === sinkId()) return;
  try {
    await audio.setSinkId(sinkId());
  } catch {
    toast('Saída de áudio indisponível, tocando na saída padrão');
    await audio.setSinkId('').catch(() => {});
  }
}

async function play(id) {
  const sound = state.sounds.find((s) => s.id === id);
  if (!sound) return;
  if (state.exclusive) players.forEach((a, other) => other !== id && a.pause());
  let audio = players.get(id);
  if (!audio) {
    audio = new Audio(sound.url);
    audio.preload = 'auto';
    audio.addEventListener('play', () => rows.get(id)?.classList.add('playing'));
    const done = () => {
      const row = rows.get(id);
      row?.classList.remove('playing');
      setProgress(id, 0);
    };
    audio.addEventListener('ended', done);
    audio.addEventListener('pause', done);
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) setProgress(id, audio.currentTime / audio.duration);
    });
    players.set(id, audio);
  }
  audio.volume = effectiveVolume(sound);
  audio.currentTime = 0;
  await applySink(audio);
  audio.play().catch(() => toast('Não foi possível tocar este arquivo'));

  const row = rows.get(id);
  if (row) {
    row.classList.add('hit');
    setTimeout(() => row.classList.remove('hit'), 110);
  }
}

function stop(id) {
  const audio = players.get(id);
  if (audio) audio.pause();
}

function toggle(id) {
  const audio = players.get(id);
  if (audio && !audio.paused) stop(id);
  else play(id);
}

function stopAll() {
  players.forEach((a) => a.pause());
}

function setProgress(id, ratio) {
  const bar = rows.get(id)?.querySelector('.progress span');
  if (bar) bar.style.width = `${ratio * 100}%`;
}

// ---------- render ----------

function applyState(next) {
  state = next;
  applyTheme();
  $('#exclusive').checked = state.exclusive;
  renderProfiles();
  renderOutputs();
  renderKeyboard();
  $('#master').value = state.masterVolume;
  paintRange($('#master'));
  const stopKey = $('#stopKey');
  stopKey.textContent = state.stopKeyLabel || 'Tecla';
  stopKey.classList.toggle('unbound', !state.stopKeyLabel);
  markKey(stopKey, state.stopAccelerator, state.stopKeyLabel, 'Tecla para parar todos os sons (funciona como atalho global)');

  const ids = new Set(state.sounds.map((s) => s.id));
  for (const [id, el] of rows) {
    if (!ids.has(id)) {
      el.remove();
      rows.delete(id);
      players.get(id)?.pause();
      players.delete(id);
    }
  }
  for (const sound of state.sounds) {
    let row = rows.get(sound.id);
    if (!row) {
      row = buildRow(sound.id);
      rows.set(sound.id, row);
      grid.appendChild(row);
    }
    updateRow(row, sound);
  }
  empty.hidden = state.sounds.length > 0;
  list.hidden = !state.sounds.length;
}

function buildRow(id) {
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.dataset.id = id;

  row.querySelector('.keycap').addEventListener('click', () => captureKey(id));
  row.querySelector('.play').addEventListener('click', () => toggle(id));
  row.querySelector('.remove').addEventListener('click', async () => {
    applyState(await sb.removeSound(id));
  });

  const name = row.querySelector('.name');
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') name.blur();
  });
  name.addEventListener('change', async () => {
    const value = name.value.trim() || 'Sem nome';
    applyState(await sb.updateSound(id, { name: value }));
  });

  const vol = row.querySelector('.vol');
  vol.addEventListener('input', () => {
    const sound = state.sounds.find((s) => s.id === id);
    sound.volume = Number(vol.value);
    showVolume(row, sound.volume);
    const audio = players.get(id);
    if (audio) audio.volume = effectiveVolume(sound);
  });
  vol.addEventListener('change', () => sb.updateSound(id, { volume: Number(vol.value) }));

  return row;
}

function updateRow(row, sound) {
  row.style.setProperty('--c', `var(--c${sound.color % 6})`);
  const key = row.querySelector('.keycap');
  key.textContent = sound.keyLabel || 'Sem tecla';
  key.classList.toggle('unbound', !sound.keyLabel);
  const problem = markKey(key, sound.accelerator, sound.keyLabel, 'Clique para trocar a tecla');
  const warn = row.querySelector('.key-warn');
  warn.hidden = !problem && !!sound.keyLabel;
  warn.title = problem || 'Este som não tem tecla: só toca pelo botão ▶. Clique em "Sem tecla" para vincular uma.';
  const name = row.querySelector('.name');
  if (document.activeElement !== name) name.value = sound.name;
  const vol = row.querySelector('.vol');
  vol.value = sound.volume;
  paintRange(vol);
  showVolume(row, sound.volume);
}

function showVolume(row, volume) {
  row.querySelector('.vol-value').textContent = `${Math.round(volume * 100)}%`;
}

// ---------- perfis ----------

function renderProfiles() {
  const ids = new Set(state.profiles.map((p) => p.id));
  for (const [id, el] of tabs) {
    if (!ids.has(id)) {
      el.remove();
      tabs.delete(id);
    }
  }
  for (const profile of state.profiles) {
    let tab = tabs.get(profile.id);
    if (!tab) {
      tab = buildTab(profile.id);
      tabs.set(profile.id, tab);
    }
    tabsEl.appendChild(tab); // mantém a ordem do estado
    tab.classList.toggle('active', profile.id === state.activeProfile);
    const name = tab.querySelector('.tab-name');
    if (document.activeElement !== name) name.value = profile.name;
    tab.querySelector('.tab-count').textContent = profile.count;
    const key = tab.querySelector('.keycap');
    key.textContent = profile.keyLabel || '+tecla';
    key.classList.toggle('unbound', !profile.keyLabel);
    markKey(key, profile.accelerator, profile.keyLabel, 'Tecla para abrir este perfil (vale em qualquer perfil)');
  }
  tabsEl.classList.toggle('single', state.profiles.length === 1);
  const active = state.profiles.find((p) => p.id === state.activeProfile);
  $('#profileName').textContent = active.name;
  $('#profileCount').textContent = active.count === 1 ? '1 som' : `${active.count} sons`;
  tabs.get(state.activeProfile)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function buildTab(id) {
  const tab = tabTpl.content.firstElementChild.cloneNode(true);
  tab.addEventListener('click', () => switchProfile(id));

  tab.addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) renameProfile(id);
  });

  const name = tab.querySelector('.tab-name');
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') name.blur();
  });
  name.addEventListener('blur', async () => {
    if (name.readOnly) return;
    name.readOnly = true;
    const value = name.value.trim() || 'Sem nome';
    applyState(await sb.updateProfile(id, { name: value }));
  });

  tab.querySelector('.keycap').addEventListener('click', (e) => {
    e.stopPropagation();
    captureKey(profileTarget(id));
  });
  tab.querySelector('.tab-x').addEventListener('click', async (e) => {
    e.stopPropagation();
    const profile = state.profiles.find((p) => p.id === id);
    if (profile.count && !confirm(`Apagar o perfil "${profile.name}" e os ${profile.count} sons dele?`)) return;
    applyState(await sb.removeProfile(id));
  });
  return tab;
}

function renameProfile(id) {
  const name = tabs.get(id)?.querySelector('.tab-name');
  if (!name) return;
  name.readOnly = false;
  name.focus();
  name.select();
}

async function switchProfile(id) {
  if (id !== state.activeProfile) applyState(await sb.switchProfile(id));
}

// gaveta da sidebar (janela estreita)
const setNav = (open) => document.body.classList.toggle('nav-open', open);
$('#menu').addEventListener('click', () => setNav(true));
$('#scrim').addEventListener('click', () => setNav(false));
// trocar de perfil fecha a gaveta; clicar no perfil já aberto não, para dar o duplo clique de renomear
tabsEl.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && !tab.classList.contains('active') && !e.target.closest('button')) setNav(false);
});

$('#addProfile').addEventListener('click', async () => {
  applyState(await sb.createProfile(`Perfil ${state.profiles.length + 1}`));
  renameProfile(state.activeProfile);
});

// ---------- tema ----------

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// 'light' ou 'dark' de fato, resolvendo o 'system'
function resolvedTheme(theme = state.theme) {
  if (theme === 'system') return systemDark.matches ? 'dark' : 'light';
  return theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  for (const btn of $('#theme').children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === state.theme));
  }
}

// troca o tema abrindo o novo num círculo a partir de (x, y)
function setTheme(theme, x, y) {
  const changes = resolvedTheme(theme) !== resolvedTheme();
  const apply = () => {
    state.theme = theme;
    applyTheme();
  };
  sb.updateSettings({ theme });
  if (!changes || !document.startViewTransition || reducedMotion.matches) {
    apply();
    return;
  }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 500, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
}

$('#theme').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.theme === state.theme) return;
  const r = btn.getBoundingClientRect();
  setTheme(btn.dataset.theme, r.left + r.width / 2, r.top + r.height / 2);
});
// no 'system', acompanha o sistema operacional
systemDark.addEventListener('change', applyTheme);
state.theme = sb.initialTheme;
applyTheme();

// ---------- saída de áudio ----------

let outputs = []; // MediaDeviceInfo das saídas

async function refreshOutputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // "default" e "communications" (Windows) são apelidos de outros dispositivos
    outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    outputs = [];
  }
  renderOutputs();
}

function renderOutputs() {
  const sel = $('#output');
  const options = [['default', 'Saída padrão do sistema']];
  outputs.forEach((d, i) => options.push([d.deviceId, d.label || `Saída ${i + 1}`]));
  if (state.outputDevice !== 'default' && !outputs.some((d) => d.deviceId === state.outputDevice)) {
    options.push([state.outputDevice, 'Dispositivo desconectado']);
  }
  const current = [...sel.options].map((o) => o.value + '\n' + o.text).join('\n');
  if (current !== options.map((o) => o.join('\n')).join('\n')) {
    sel.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  }
  sel.value = state.outputDevice;
}

$('#output').addEventListener('change', async (e) => {
  applyState(await sb.updateSettings({ outputDevice: e.target.value }));
  players.forEach(applySink);
});
navigator.mediaDevices.addEventListener('devicechange', refreshOutputs);

// ---------- teclado escolhido (só Windows) ----------

const IDENTIFY = '__identify';
let identifying = false;
const captureHint = $('#captureHint').innerHTML;

function renderKeyboard() {
  $('#keyboardWrap').hidden = sb.platform !== 'win32';
  const options = [['', 'Qualquer teclado']];
  if (state.inputDevice) options.push([state.inputDevice.id, state.inputDevice.label]);
  options.push([IDENTIFY, state.inputDevice ? 'Identificar outro teclado…' : 'Identificar teclado…']);
  $('#keyboard').replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  $('#keyboard').value = state.inputDevice?.id || '';
}

async function identifyKeyboard() {
  identifying = true;
  $('#captureTitle').textContent = 'Aperte uma tecla no teclado dos sons';
  $('#captureKey').textContent = '⌨';
  $('#captureHint').innerHTML = 'Daí em diante só ele dispara os sons.<br/><kbd>Esc</kbd> cancela';
  $('#capture').hidden = false;
  const before = state.inputDevice?.id;
  const next = await sb.identifyKeyboard();
  identifying = false;
  $('#capture').hidden = true;
  $('#captureHint').innerHTML = captureHint;
  applyState(next);
  if (next.keyboardError) toast('Não foi possível ler os teclados; usando qualquer teclado');
  else if (next.inputDevice && next.inputDevice.id !== before) toast(`Só "${next.inputDevice.label}" dispara os sons agora`);
}

$('#keyboard').addEventListener('change', async (e) => {
  if (e.target.value === IDENTIFY) {
    renderKeyboard(); // volta a seleção enquanto espera
    identifyKeyboard();
    return;
  }
  applyState(await sb.updateSettings({ inputDevice: null }));
});

// tecla vinda do teclado escolhido (o main já filtrou o dispositivo)
sb.onDeviceKey((key) => {
  if (capturing || identifying) return;
  const sc = eventToShortcut(key);
  if (sc) trigger(sc.accelerator);
});

// preenche a parte do slider até o valor atual (o Chromium não tem pseudo-elemento para isso)
function paintRange(el) {
  const ratio = (el.value - el.min) / (el.max - el.min);
  el.style.setProperty('--fill', `${ratio * 100}%`);
}
document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') paintRange(e.target);
});

// ---------- captura de tecla ----------

// alvos da captura: id de um som, STOP (tecla de "parar tudo") ou profileTarget(id)
const STOP = 'stop';
const PROFILE = 'profile:';
const profileTarget = (id) => PROFILE + id;
let capturing = null;

function captureKey(id) {
  capturing = id;
  let title = 'Pressione uma tecla';
  if (id === STOP) title = 'Tecla para parar tudo';
  if (id.startsWith(PROFILE)) {
    const profile = state.profiles.find((p) => profileTarget(p.id) === id);
    title = `Tecla para abrir "${profile.name}"`;
  }
  $('#captureTitle').textContent = title;
  $('#captureKey').textContent = '?';
  $('#capture').hidden = false;
  // desliga os atalhos globais para a tecla chegar aqui mesmo se já estiver registrada
  sb.setCapturing(true);
}

function endCapture() {
  capturing = null;
  return sb.setCapturing(false);
}

// grava a tecla no alvo; sc nulo remove o vínculo
function bindKey(id, sc) {
  const keys = sc || { accelerator: null, keyLabel: null };
  if (id === STOP) {
    return sb.updateSettings({ stopAccelerator: keys.accelerator, stopKeyLabel: keys.keyLabel });
  }
  if (id.startsWith(PROFILE)) return sb.updateProfile(id.slice(PROFILE.length), keys);
  return sb.updateSound(id, keys);
}

async function finishCapture(e) {
  const id = capturing;
  if (e.code === 'Escape') {
    $('#capture').hidden = true;
    applyState(await endCapture());
    return;
  }
  if (e.code === 'Backspace') {
    $('#capture').hidden = true;
    await endCapture();
    applyState(await bindKey(id, null));
    return;
  }
  if (MODIFIER_CODES.test(e.code)) {
    // mostra o modificador enquanto espera a tecla principal
    const mods = [e.ctrlKey && 'Ctrl', e.metaKey && (isMac ? '⌘' : 'Win'), e.altKey && 'Alt', e.shiftKey && 'Shift'];
    $('#captureKey').textContent = mods.filter(Boolean).join('+') + '+…';
    return;
  }
  const sc = eventToShortcut(e);
  if (!sc) {
    toast('Essa tecla não é suportada');
    return;
  }
  $('#captureKey').textContent = sc.keyLabel;
  setTimeout(() => ($('#capture').hidden = true), 180);
  await endCapture();

  // quem perde a tecla (o main faz a troca; aqui é só para avisar)
  const lost = [];
  const sound = state.sounds.find((s) => s.accelerator === sc.accelerator && s.id !== id);
  if (sound) lost.push(`foi movida de "${sound.name}"`);
  // "parar tudo" e as teclas de perfil valem em qualquer perfil, então tiram a tecla dos outros também
  if (id === STOP || id.startsWith(PROFILE)) {
    for (const p of state.profiles) {
      if (p.id === state.activeProfile) continue;
      const other = p.soundKeys.find((s) => s.accelerator === sc.accelerator);
      if (other) lost.push(`foi removida de "${other.name}" (${p.name})`);
    }
  }
  const profile = state.profiles.find((p) => p.accelerator === sc.accelerator && profileTarget(p.id) !== id);
  if (profile) lost.push(`deixou de abrir o perfil "${profile.name}"`);
  if (id !== STOP && state.stopAccelerator === sc.accelerator) lost.push('deixou de parar todos os sons');

  const next = await bindKey(id, sc);
  applyState(next);
  if (lost.length) toast(`${sc.keyLabel} ${lost.join(' e ')}`);
  if (numpadWithoutNumLock(e) && !next.deviceMode) {
    toast('Ligue o NumLock: com ele desligado, o teclado numérico só funciona com o app em foco');
  } else if (next.failedHotkeys.includes(sc.accelerator)) {
    toast(`${sc.keyLabel} já está em uso pelo sistema — funciona só com o app em foco`);
  }
}

// ---------- teclado ----------

// executa o que estiver vinculado ao accelerator; false se não houver nada
function trigger(accelerator) {
  if (accelerator === state.stopAccelerator) {
    stopAll();
    return true;
  }
  const profile = state.profiles.find((p) => p.accelerator === accelerator);
  if (profile) {
    switchProfile(profile.id);
    return true;
  }
  const sound = state.sounds.find((s) => s.accelerator === accelerator);
  if (sound) {
    toggle(sound.id);
    return true;
  }
  return false;
}

const isBound = (accelerator) =>
  accelerator === state.stopAccelerator ||
  state.profiles.some((p) => p.accelerator === accelerator) ||
  state.sounds.some((s) => s.accelerator === accelerator);

window.addEventListener('keydown', (e) => {
  if (identifying) {
    e.preventDefault();
    if (e.code === 'Escape') sb.cancelIdentify();
    return;
  }
  if (capturing) {
    e.preventDefault();
    finishCapture(e);
    return;
  }
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;

  const sc = eventToShortcut(e);
  if (sc && isBound(sc.accelerator)) {
    e.preventDefault();
    // Com um teclado escolhido, quem dispara é o onDeviceKey (as teclas dos outros teclados não valem).
    // Com o atalho global registrado, o sistema já dispara a ação, então aqui não roda de novo.
    const handledGlobally = !state.failedHotkeys.includes(sc.accelerator) && !numpadWithoutNumLock(e);
    if (!state.deviceMode && !handledGlobally) trigger(sc.accelerator);
    return;
  }
  if (e.code === 'Escape') stopAll();
});

sb.onPlay((id) => toggle(id));
sb.onStopAll(stopAll);
sb.onState(applyState);

// ---------- topo ----------

$('#add').addEventListener('click', async () => applyState(await sb.pickSounds()));
$('#stopAll').addEventListener('click', stopAll);
$('#stopKey').addEventListener('click', () => captureKey(STOP));

$('#exclusive').addEventListener('change', async (e) => {
  applyState(await sb.updateSettings({ exclusive: e.target.checked }));
});

$('#master').addEventListener('input', (e) => {
  state.masterVolume = Number(e.target.value);
  for (const s of state.sounds) {
    const audio = players.get(s.id);
    if (audio) audio.volume = effectiveVolume(s);
  }
});
$('#master').addEventListener('change', (e) => sb.updateSettings({ masterVolume: Number(e.target.value) }));

// ---------- arrastar e soltar ----------

const drop = $('#drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const before = state.sounds.length;
  const next = await sb.importFiles(e.dataTransfer.files);
  applyState(next);
  const added = next.sounds.length - before;
  if (added === 0) toast('Nenhum arquivo de áudio reconhecido');
});

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

sb.getState().then((s) => {
  applyState(s);
  refreshOutputs();
});
