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
  exclusive: false, outputDevice: 'default', theme: 'system', sort: { by: 'added', dir: 'asc' }, inputDevice: null, deviceMode: false, keyboardError: null, stopAccelerator: null, stopKeyLabel: null, failedHotkeys: [],
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

const stopTimers = new Map(); // id -> timeout que para o som no fim do trecho

// trecho tocado de um som, em segundos; end cai na duração quando o som não foi cortado
function span(sound, audio) {
  const start = sound.start || 0;
  const end = sound.end ?? audio.duration;
  return { start, end };
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
      clearTimeout(stopTimers.get(id));
      const row = rows.get(id);
      row?.classList.remove('playing');
      setProgress(id, 0);
    };
    audio.addEventListener('ended', done);
    audio.addEventListener('pause', done);
    audio.addEventListener('timeupdate', () => {
      const current = state.sounds.find((s) => s.id === id);
      if (!current || !audio.duration || audio.paused) return;
      const { start, end } = span(current, audio);
      setProgress(id, (audio.currentTime - start) / (end - start));
    });
    players.set(id, audio);
  }
  clearTimeout(stopTimers.get(id));
  audio.volume = effectiveVolume(sound);
  audio.currentTime = sound.start || 0;
  await applySink(audio);
  audio
    .play()
    .then(() => {
      // o timeupdate só vem ~4x por segundo, então o fim do trecho é por timer
      if (sound.end) stopTimers.set(id, setTimeout(() => audio.pause(), (sound.end - audio.currentTime) * 1000));
    })
    .catch(() => toast('Não foi possível tocar este arquivo'));

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
    }
    updateRow(row, sound);
  }
  empty.hidden = state.sounds.length > 0;
  list.hidden = !state.sounds.length;
  renderList();
}

// ---------- busca e ordenação ----------

const search = $('#search');
// minúsculas e sem acento, para "acao" achar "Ação"
const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function sortedSounds() {
  const { by, dir } = state.sort;
  if (by === 'added') return state.sounds;
  const sign = dir === 'desc' ? -1 : 1;
  return [...state.sounds].sort((a, b) => {
    if (by === 'key') {
      // sons sem tecla ficam sempre no fim
      if (!a.keyLabel || !b.keyLabel) return !a.keyLabel - !b.keyLabel;
      return sign * collator.compare(a.keyLabel, b.keyLabel);
    }
    return sign * collator.compare(a.name, b.name);
  });
}

// ordena as linhas e esconde as que não batem com a busca
function renderList() {
  const query = fold(search.value.trim());
  let shown = 0;
  for (const sound of sortedSounds()) {
    const row = rows.get(sound.id);
    grid.appendChild(row); // appendChild move a linha para o fim, então a ordem final é a do array
    row.hidden = !!query && !fold(sound.name).includes(query);
    if (!row.hidden) shown++;
  }
  const noResults = $('#noResults');
  noResults.hidden = shown > 0 || !state.sounds.length;
  noResults.textContent = `Nenhum som com "${search.value.trim()}"`;
  for (const btn of document.querySelectorAll('.sort')) {
    const active = btn.dataset.sort === state.sort.by;
    btn.classList.toggle('asc', active && state.sort.dir === 'asc');
    btn.classList.toggle('desc', active && state.sort.dir === 'desc');
  }
  renderSelection();
}

// ---------- seleção múltipla ----------

const selected = new Set(); // ids dos sons marcados
let selectAnchor = null; // última linha marcada, de onde parte o Shift+clique
const bulkVol = $('#bulkVol');

// linhas na ordem em que aparecem (ordenação e busca aplicadas)
const visibleIds = () => [...grid.children].filter((r) => !r.hidden).map((r) => r.dataset.id);

function renderSelection() {
  const visible = visibleIds();
  // som removido, de outro perfil ou escondido pela busca sai da seleção: as ações valem só para o que se vê
  for (const id of [...selected]) if (!visible.includes(id)) selected.delete(id);
  for (const [id, row] of rows) {
    const on = selected.has(id);
    row.classList.toggle('selected', on);
    row.querySelector('.select').checked = on;
  }
  const all = $('#selectAll');
  all.checked = visible.length > 0 && selected.size === visible.length;
  all.indeterminate = selected.size > 0 && !all.checked;
  list.classList.toggle('selecting', selected.size > 0);
  $('#bulk').hidden = !selected.size;
  if (!selected.size) return;
  $('#bulkCount').textContent = selected.size === 1 ? '1 selecionado' : `${selected.size} selecionados`;
  if (document.activeElement !== bulkVol) {
    const volumes = state.sounds.filter((s) => selected.has(s.id)).map((s) => s.volume);
    bulkVol.value = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    paintRange(bulkVol);
    $('#bulkVolValue').textContent = `${Math.round(bulkVol.value * 100)}%`;
  }
}

function selectRow(id, on, range) {
  const ids = visibleIds();
  if (range && ids.includes(selectAnchor)) {
    const [a, b] = [ids.indexOf(selectAnchor), ids.indexOf(id)].sort((x, y) => x - y);
    for (const x of ids.slice(a, b + 1)) on ? selected.add(x) : selected.delete(x);
  } else if (on) selected.add(id);
  else selected.delete(id);
  selectAnchor = id;
  renderSelection();
}

function clearSelection() {
  selected.clear();
  renderSelection();
}

$('#selectAll').addEventListener('change', (e) => {
  if (e.target.checked) visibleIds().forEach((id) => selected.add(id));
  else selected.clear();
  renderSelection();
});

bulkVol.addEventListener('input', () => {
  const volume = Number(bulkVol.value);
  $('#bulkVolValue').textContent = `${Math.round(volume * 100)}%`;
  for (const sound of state.sounds) {
    if (!selected.has(sound.id)) continue;
    sound.volume = volume;
    const row = rows.get(sound.id);
    const vol = row.querySelector('.vol');
    vol.value = volume;
    paintRange(vol);
    showVolume(row, volume);
    const audio = players.get(sound.id);
    if (audio) audio.volume = effectiveVolume(sound);
  }
});
bulkVol.addEventListener('change', async () => {
  applyState(await sb.setVolumes([...selected], Number(bulkVol.value)));
});

$('#bulkRemove').addEventListener('click', async () => {
  const n = selected.size;
  if (!confirm(n === 1 ? 'Remover o som selecionado?' : `Remover os ${n} sons selecionados?`)) return;
  applyState(await sb.removeSounds([...selected]));
  toast(n === 1 ? 'Som removido' : `${n} sons removidos`);
});
$('#bulkClear').addEventListener('click', clearSelection);

search.addEventListener('input', renderList);
search.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  search.value = '';
  renderList();
  search.blur();
});

// clicar na coluna alterna: crescente → decrescente → ordem de adição
for (const btn of document.querySelectorAll('.sort')) {
  btn.addEventListener('click', () => {
    const { by, dir } = state.sort;
    let next = { by: btn.dataset.sort, dir: 'asc' };
    if (by === btn.dataset.sort) next = dir === 'asc' ? { by, dir: 'desc' } : { by: 'added', dir: 'asc' };
    state.sort = next;
    renderList();
    sb.updateSettings({ sort: next });
  });
}

function buildRow(id) {
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.dataset.id = id;

  row.querySelector('.keycap').addEventListener('click', () => captureKey(id));
  row.querySelector('.play').addEventListener('click', () => toggle(id));
  row.querySelector('.select').addEventListener('click', (e) => selectRow(id, e.target.checked, e.shiftKey));
  row.querySelector('.remove').addEventListener('click', async () => {
    applyState(await sb.removeSound(id));
  });

  row.querySelector('.name').addEventListener('click', () => editSound(id));
  row.querySelector('.edit').addEventListener('click', () => editSound(id));

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
  row.querySelector('.name').textContent = sound.name;
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

// alvos da captura: id de um som, STOP (tecla de "parar tudo"), profileTarget(id) ou EDITOR (o modal)
const STOP = 'stop';
const PROFILE = 'profile:';
const EDITOR = 'editor';
const profileTarget = (id) => PROFILE + id;
// som é obrigado a ter tecla, então só "parar tudo" e perfis aceitam o Backspace para remover
const canUnbind = (id) => id === STOP || id.startsWith(PROFILE);
let capturing = null;

function captureKey(id) {
  capturing = id;
  let title = 'Pressione uma tecla';
  if (id === STOP) title = 'Tecla para parar tudo';
  if (id.startsWith(PROFILE)) {
    const profile = state.profiles.find((p) => profileTarget(p.id) === id);
    title = `Tecla para abrir "${profile.name}"`;
  }
  if (id === EDITOR) title = `Tecla para "${$('#edName').value.trim() || 'este som'}"`;
  $('#captureTitle').textContent = title;
  $('#captureKey').textContent = '?';
  $('#captureHint').innerHTML = canUnbind(id)
    ? captureHint
    : 'Pode combinar com Ctrl, Alt, Shift ou Cmd.<br/><kbd>Esc</kbd> cancela';
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

// quem perde a tecla se ela for para o alvo (o main faz a troca; aqui é só para avisar)
function keyConflicts(accelerator, id) {
  const self = id === EDITOR ? editor.draft.id : id;
  const lost = [];
  const sound = state.sounds.find((s) => s.accelerator === accelerator && s.id !== self);
  if (sound) lost.push(`sai de "${sound.name}"`);
  // "parar tudo" e as teclas de perfil valem em qualquer perfil, então tiram a tecla dos outros também
  if (id === STOP || id.startsWith(PROFILE)) {
    for (const p of state.profiles) {
      if (p.id === state.activeProfile) continue;
      const other = p.soundKeys.find((s) => s.accelerator === accelerator);
      if (other) lost.push(`sai de "${other.name}" (${p.name})`);
    }
  }
  const profile = state.profiles.find((p) => p.accelerator === accelerator && profileTarget(p.id) !== id);
  if (profile) lost.push(`deixa de abrir o perfil "${profile.name}"`);
  if (id !== STOP && state.stopAccelerator === accelerator) lost.push('deixa de parar todos os sons');
  return lost;
}

async function finishCapture(e) {
  const id = capturing;
  if (e.code === 'Escape') {
    $('#capture').hidden = true;
    applyState(await endCapture());
    return;
  }
  if (e.code === 'Backspace') {
    if (!canUnbind(id)) return; // tecla de som é obrigatória
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
  const lost = keyConflicts(sc.accelerator, id);
  if (id === EDITOR) {
    // no modal a tecla só vale ao salvar
    applyState(await endCapture());
    setEditorKey(sc, lost, numpadWithoutNumLock(e));
    return;
  }
  await endCapture();

  const next = await bindKey(id, sc);
  applyState(next);
  if (lost.length) toast(`${sc.keyLabel} ${lost.join(' e ')}`);
  if (numpadWithoutNumLock(e) && !next.deviceMode) {
    toast('Ligue o NumLock: com ele desligado, o teclado numérico só funciona com o app em foco');
  } else if (next.failedHotkeys.includes(sc.accelerator)) {
    toast(`${sc.keyLabel} já está em uso pelo sistema — funciona só com o app em foco`);
  }
}

// ---------- modal de adicionar/editar ----------

const MIN_SPAN = 0.1; // trecho mínimo, em segundos
const editor = {
  queue: [], // candidatos ({ path, name, url }) ainda não abertos
  total: 0, // tamanho da fila atual, para o "2 de 5"
  draft: null, // o som sendo editado; tem id quando já existe
  duration: 0, // 0 enquanto não decodificou (ou se falhou)
  peaks: null,
  load: 0, // descarta decodificações de um rascunho anterior
  preview: null,
};
const ed = {
  modal: $('#editor'), name: $('#edName'), wave: $('#edWave'), canvas: $('#edWave canvas'),
  msg: $('#edWave .wave-msg'), playhead: $('#edWave .playhead'), times: $('#edTimes'),
  key: $('#edKey'), note: $('#edKeyNote'), save: $('#edSave'), skip: $('#edSkip'), preview: $('#edPreview'),
};
const editorOpen = () => !ed.modal.hidden;

// escolhidos pelo botão ou soltos na janela: entram na fila do modal
function enqueue(files) {
  if (!files.length) {
    toast('Nenhum arquivo de áudio reconhecido');
    return;
  }
  editor.queue.push(...files);
  editor.total += files.length;
  if (!editor.draft) nextInQueue();
  else renderEditor();
}

function nextInQueue() {
  const c = editor.queue.shift();
  if (!c) {
    closeEditor();
    return;
  }
  openEditor({ path: c.path, url: c.url, name: c.name, start: 0, end: null, accelerator: null, keyLabel: null, volume: 1 });
}

function editSound(id) {
  const s = state.sounds.find((x) => x.id === id);
  if (!s || editor.draft) return;
  editor.total = 0;
  openEditor({ id, url: s.url, name: s.name, start: s.start || 0, end: s.end ?? null, accelerator: s.accelerator, keyLabel: s.keyLabel, volume: s.volume });
}

async function openEditor(draft) {
  stopPreview();
  editor.draft = draft;
  editor.duration = 0;
  editor.peaks = null;
  ed.note.textContent = '';
  ed.note.classList.remove('warn');
  ed.name.value = draft.name;
  ed.msg.textContent = 'Carregando…';
  ed.modal.hidden = false;
  renderEditor();
  ed.name.focus();
  ed.name.select();

  const load = ++editor.load;
  try {
    const bytes = await sb.readAudio(draft.id ? { id: draft.id } : { path: draft.path });
    if (!bytes) throw new Error('sem bytes');
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
    if (load !== editor.load) return;
    editor.duration = buffer.duration;
    editor.peaks = computePeaks(buffer, 800);
    ed.msg.textContent = '';
  } catch {
    if (load !== editor.load) return;
    ed.msg.textContent = 'Não foi possível ler este áudio';
  }
  renderEditor();
}

function closeEditor() {
  stopPreview();
  editor.load++;
  editor.queue = [];
  editor.total = 0;
  editor.draft = null;
  ed.modal.hidden = true;
}

// maior amplitude de cada fatia do áudio (todos os canais), de 0 a 1
function computePeaks(buffer, bins) {
  const peaks = new Float32Array(bins);
  const size = buffer.length / bins;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < bins; i++) {
      let max = peaks[i];
      const end = Math.min(data.length, Math.floor((i + 1) * size));
      // pula amostras nas fatias grandes; o pico visual quase não muda
      const step = Math.max(1, Math.floor(size / 400));
      for (let j = Math.floor(i * size); j < end; j += step) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
  }
  const top = Math.max(...peaks) || 1;
  return peaks.map((p) => p / top);
}

const trimEnd = () => editor.draft.end ?? editor.duration;

function formatTime(t) {
  const m = Math.floor(t / 60);
  const sec = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

function renderEditor() {
  const d = editor.draft;
  if (!d) return;
  const editing = !!d.id;
  const step = editor.total - editor.queue.length;
  $('#edTitle').textContent = editing ? 'Editar som' : 'Adicionar áudio';
  $('#edStep').textContent = !editing && editor.total > 1 ? `${step} de ${editor.total}` : '';
  ed.skip.hidden = editing || editor.total < 2;
  ed.save.textContent = editing ? 'Salvar' : 'Adicionar';

  ed.key.textContent = d.keyLabel || 'Escolher tecla';
  ed.key.classList.toggle('unbound', !d.keyLabel);
  if (!ed.note.textContent) ed.note.textContent = d.keyLabel ? 'Clique para trocar' : 'Clique e aperte a tecla que vai tocar o som';

  const loaded = editor.duration > 0;
  // som novo que não decodifica provavelmente nem toca; um existente ainda pode ter nome e tecla trocados
  ed.save.disabled = !d.keyLabel || (!editing && !loaded);
  ed.save.title = !d.keyLabel ? 'Escolha uma tecla para continuar' : '';
  ed.wave.classList.toggle('empty', !loaded);
  ed.preview.disabled = !loaded;
  $('#edReset').disabled = !loaded || (d.start === 0 && d.end === null);
  if (!loaded) {
    ed.times.textContent = '';
    drawWave();
    return;
  }
  const end = trimEnd();
  ed.wave.style.setProperty('--start', `${(d.start / editor.duration) * 100}%`);
  ed.wave.style.setProperty('--end', `${(end / editor.duration) * 100}%`);
  ed.times.textContent = `${formatTime(d.start)} → ${formatTime(end)} · ${(end - d.start).toFixed(1)} s`;
  drawWave();
}

function drawWave() {
  const canvas = ed.canvas;
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const peaks = editor.peaks;
  if (!peaks) return;
  const css = getComputedStyle(document.documentElement);
  const on = css.getPropertyValue('--accent');
  const off = css.getPropertyValue('--track');
  const bar = 2 * dpr;
  const gap = 1 * dpr;
  const start = editor.draft.start / editor.duration;
  const end = trimEnd() / editor.duration;
  for (let x = 0; x < w; x += bar + gap) {
    const ratio = x / w;
    const peak = peaks[Math.floor(ratio * peaks.length)];
    const bh = Math.max(2 * dpr, peak * (h - 16 * dpr));
    ctx.fillStyle = ratio >= start && ratio <= end ? on : off;
    ctx.fillRect(x, (h - bh) / 2, bar, bh);
  }
}

// arrastar na forma de onda move a alça mais próxima do ponteiro
ed.wave.addEventListener('pointerdown', (e) => {
  if (!editor.duration) return;
  const rect = ed.wave.getBoundingClientRect();
  const timeAt = (x) => Math.min(editor.duration, Math.max(0, ((x - rect.left) / rect.width) * editor.duration));
  const t = timeAt(e.clientX);
  const d = editor.draft;
  const which = Math.abs(t - d.start) <= Math.abs(t - trimEnd()) ? 'start' : 'end';
  ed.wave.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const time = timeAt(ev.clientX);
    if (which === 'start') d.start = Math.min(time, trimEnd() - MIN_SPAN);
    // end colado no fim vira null ("até o fim"), para não cortar por arredondamento
    else d.end = time >= editor.duration - 0.05 ? null : Math.max(time, d.start + MIN_SPAN);
    d.start = Math.max(0, d.start);
    renderEditor();
  };
  move(e);
  ed.wave.addEventListener('pointermove', move);
  ed.wave.addEventListener('lostpointercapture', () => ed.wave.removeEventListener('pointermove', move), { once: true });
});

$('#edReset').addEventListener('click', () => {
  editor.draft.start = 0;
  editor.draft.end = null;
  renderEditor();
});

// pré-escuta do trecho, na mesma saída e volume em que o som vai tocar
async function togglePreview() {
  if (editor.preview) {
    stopPreview();
    return;
  }
  const d = editor.draft;
  const audio = new Audio(d.url);
  editor.preview = audio;
  audio.volume = Math.max(0, Math.min(1, (d.volume ?? 1) * state.masterVolume));
  audio.currentTime = d.start;
  await applySink(audio);
  if (editor.preview !== audio) return;
  ed.preview.classList.add('playing');
  ed.preview.querySelector('span').textContent = 'Parar';
  ed.playhead.hidden = false;
  audio.addEventListener('ended', stopPreview);
  audio.play().catch(stopPreview);
  const tick = () => {
    if (editor.preview !== audio) return;
    if (audio.currentTime >= trimEnd()) {
      stopPreview();
      return;
    }
    ed.playhead.style.left = `${(audio.currentTime / editor.duration) * 100}%`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopPreview() {
  editor.preview?.pause();
  editor.preview = null;
  ed.preview.classList.remove('playing');
  ed.preview.querySelector('span').textContent = 'Ouvir trecho';
  ed.playhead.hidden = true;
}

ed.preview.addEventListener('click', togglePreview);
ed.key.addEventListener('click', () => captureKey(EDITOR));

function setEditorKey(sc, lost, numLockOff) {
  const d = editor.draft;
  if (!d) return;
  d.accelerator = sc.accelerator;
  d.keyLabel = sc.keyLabel;
  let note = '';
  if (lost.length) note = `Ao salvar, ${sc.keyLabel} ${lost.join(' e ')}`;
  else if (numLockOff) note = 'Ligue o NumLock: com ele desligado, o teclado numérico só funciona com o app em foco';
  ed.note.textContent = note;
  ed.note.classList.toggle('warn', !!note);
  renderEditor();
}

async function saveEditor() {
  const d = editor.draft;
  if (!d || ed.save.disabled) return;
  ed.save.disabled = true; // Enter duas vezes não adiciona duas vezes; o renderEditor do próximo reabilita
  stopPreview();
  const fields = {
    name: ed.name.value.trim() || 'Sem nome',
    accelerator: d.accelerator,
    keyLabel: d.keyLabel,
  };
  if (editor.duration) Object.assign(fields, { start: d.start, end: d.end });
  if (d.id) {
    applyState(await sb.updateSound(d.id, fields));
  } else {
    applyState(await sb.addSound({ path: d.path, ...fields }));
    if (state.failedHotkeys.includes(d.accelerator)) toast(`${d.keyLabel} já está em uso pelo sistema — funciona só com o app em foco`);
  }
  // segue para o próximo da fila (arquivos soltos durante a edição também entram nela)
  editor.draft = null;
  nextInQueue();
}

$('#editorForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveEditor();
});
ed.skip.addEventListener('click', nextInQueue);
$('#edCancel').addEventListener('click', closeEditor);
$('#edClose').addEventListener('click', closeEditor);
ed.modal.addEventListener('mousedown', (e) => {
  if (e.target === ed.modal) closeEditor();
});
window.addEventListener('resize', () => editorOpen() && drawWave());

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
  if (editorOpen()) {
    // com o modal aberto, as teclas são dele (Enter confirma pelo submit do form)
    if (e.code === 'Escape') {
      e.preventDefault();
      closeEditor();
    }
    return;
  }
  if (e.repeat) return;
  // Ctrl/Cmd+F foca a busca, a não ser que a combinação esteja vinculada a algo
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF' && !e.altKey && !e.shiftKey && !isBound(eventToShortcut(e).accelerator)) {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  // Esc também limpa a seleção (e segue parando os sons)
  if (e.code === 'Escape' && selected.size) clearSelection();

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

$('#add').addEventListener('click', async () => enqueue(await sb.pickSounds()));
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
  enqueue(await sb.checkFiles(e.dataTransfer.files));
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
