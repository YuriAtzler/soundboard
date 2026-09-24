const sb = window.api;
const isMac = sb.platform === 'darwin';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const empty = $('#empty');
const tpl = $('#cardTpl');

let state = { sounds: [], globalHotkeys: false, masterVolume: 1, stopAccelerator: null, stopKeyLabel: null, failedHotkeys: [] };
const players = new Map(); // id -> HTMLAudioElement
const cards = new Map(); // id -> element

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

// ---------- reprodução ----------

function effectiveVolume(sound) {
  return Math.max(0, Math.min(1, sound.volume * state.masterVolume));
}

function play(id) {
  const sound = state.sounds.find((s) => s.id === id);
  if (!sound) return;
  let audio = players.get(id);
  if (!audio) {
    audio = new Audio(sound.url);
    audio.preload = 'auto';
    audio.addEventListener('play', () => cards.get(id)?.classList.add('playing'));
    const done = () => {
      const card = cards.get(id);
      card?.classList.remove('playing');
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
  audio.play().catch(() => toast('Não foi possível tocar este arquivo'));

  const card = cards.get(id);
  if (card) {
    card.classList.add('hit');
    setTimeout(() => card.classList.remove('hit'), 110);
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
  const bar = cards.get(id)?.querySelector('.progress span');
  if (bar) bar.style.width = `${ratio * 100}%`;
}

// ---------- render ----------

function applyState(next) {
  state = next;
  $('#global').checked = state.globalHotkeys;
  $('#master').value = state.masterVolume;
  paintRange($('#master'));
  const stopKey = $('#stopKey');
  stopKey.textContent = state.stopKeyLabel || 'Tecla';
  stopKey.classList.toggle('unbound', !state.stopKeyLabel);

  const ids = new Set(state.sounds.map((s) => s.id));
  for (const [id, el] of cards) {
    if (!ids.has(id)) {
      el.remove();
      cards.delete(id);
      players.get(id)?.pause();
      players.delete(id);
    }
  }
  for (const sound of state.sounds) {
    let card = cards.get(sound.id);
    if (!card) {
      card = buildCard(sound.id);
      cards.set(sound.id, card);
      grid.appendChild(card);
    }
    updateCard(card, sound);
  }
  empty.hidden = state.sounds.length > 0;
}

function buildCard(id) {
  const card = tpl.content.firstElementChild.cloneNode(true);
  card.dataset.id = id;

  card.querySelector('.keycap').addEventListener('click', () => captureKey(id));
  card.querySelector('.play').addEventListener('click', () => toggle(id));
  card.querySelector('.remove').addEventListener('click', async () => {
    applyState(await sb.removeSound(id));
  });

  const name = card.querySelector('.name');
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') name.blur();
  });
  name.addEventListener('change', async () => {
    const value = name.value.trim() || 'Sem nome';
    applyState(await sb.updateSound(id, { name: value }));
  });

  const vol = card.querySelector('.vol');
  vol.addEventListener('input', () => {
    const sound = state.sounds.find((s) => s.id === id);
    sound.volume = Number(vol.value);
    const audio = players.get(id);
    if (audio) audio.volume = effectiveVolume(sound);
  });
  vol.addEventListener('change', () => sb.updateSound(id, { volume: Number(vol.value) }));

  return card;
}

function updateCard(card, sound) {
  card.style.setProperty('--c', `var(--c${sound.color % 6})`);
  const key = card.querySelector('.keycap');
  if (sound.keyLabel) {
    key.textContent = sound.keyLabel;
    key.classList.remove('unbound');
  } else {
    key.textContent = 'Vincular tecla';
    key.classList.add('unbound');
  }
  const name = card.querySelector('.name');
  if (document.activeElement !== name) name.value = sound.name;
  const vol = card.querySelector('.vol');
  vol.value = sound.volume;
  paintRange(vol);
}

// preenche a parte do slider até o valor atual (o Chromium não tem pseudo-elemento para isso)
function paintRange(el) {
  const ratio = (el.value - el.min) / (el.max - el.min);
  el.style.setProperty('--fill', `${ratio * 100}%`);
}
document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') paintRange(e.target);
});

// ---------- captura de tecla ----------

const STOP = 'stop'; // alvo da captura quando é a tecla de "parar tudo"
let capturing = null;

function captureKey(id) {
  capturing = id;
  $('#captureTitle').textContent = id === STOP ? 'Tecla para parar tudo' : 'Pressione uma tecla';
  $('#captureKey').textContent = '?';
  $('#capture').hidden = false;
}

// grava a tecla no alvo (som ou "parar tudo"); sc nulo remove o vínculo
function bindKey(id, sc) {
  const keys = sc || { accelerator: null, keyLabel: null };
  if (id === STOP) {
    return sb.updateSettings({ stopAccelerator: keys.accelerator, stopKeyLabel: keys.keyLabel });
  }
  return sb.updateSound(id, keys);
}

async function finishCapture(e) {
  const id = capturing;
  if (e.code === 'Escape') {
    capturing = null;
    $('#capture').hidden = true;
    return;
  }
  if (e.code === 'Backspace') {
    capturing = null;
    $('#capture').hidden = true;
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
  capturing = null;
  $('#captureKey').textContent = sc.keyLabel;
  setTimeout(() => ($('#capture').hidden = true), 180);

  const previous = state.sounds.find((s) => s.accelerator === sc.accelerator && s.id !== id);
  const wasStop = id !== STOP && state.stopAccelerator === sc.accelerator;
  const next = await bindKey(id, sc);
  applyState(next);
  if (previous) toast(`${sc.keyLabel} foi movida de "${previous.name}"`);
  if (wasStop) toast(`${sc.keyLabel} deixou de parar todos os sons`);
  if (next.globalHotkeys && next.failedHotkeys.includes(sc.accelerator)) {
    toast(`${sc.keyLabel} já está em uso pelo sistema — funciona só com o app em foco`);
  }
}

// ---------- teclado ----------

window.addEventListener('keydown', (e) => {
  if (capturing) {
    e.preventDefault();
    finishCapture(e);
    return;
  }
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;

  const sc = eventToShortcut(e);
  // com atalhos globais ativos, o sistema já dispara a ação (evita rodar duas vezes)
  const handledGlobally = (acc) => state.globalHotkeys && !state.failedHotkeys.includes(acc);
  if (sc && sc.accelerator === state.stopAccelerator) {
    e.preventDefault();
    if (!handledGlobally(sc.accelerator)) stopAll();
    return;
  }
  const sound = sc && state.sounds.find((s) => s.accelerator === sc.accelerator);
  if (sound) {
    e.preventDefault();
    if (!handledGlobally(sound.accelerator)) toggle(sound.id);
    return;
  }
  if (e.code === 'Escape') stopAll();
});

sb.onPlay((id) => toggle(id));
sb.onStopAll(stopAll);

// ---------- topo ----------

$('#add').addEventListener('click', async () => applyState(await sb.pickSounds()));
$('#stopAll').addEventListener('click', stopAll);
$('#stopKey').addEventListener('click', () => captureKey(STOP));

$('#global').addEventListener('change', async (e) => {
  const next = await sb.updateSettings({ globalHotkeys: e.target.checked });
  applyState(next);
  if (next.globalHotkeys) {
    toast(next.failedHotkeys.length
      ? `Algumas teclas não puderam ser registradas globalmente (${next.failedHotkeys.length})`
      : 'Atalhos ativos mesmo com o app em segundo plano');
  }
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

sb.getState().then(applyState);
