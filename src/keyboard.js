// Descobre de qual teclado veio cada tecla (só Windows), lendo o Raw Input por meio de um
// processo PowerShell auxiliar (keyboard-helper.ps1). Emite:
//   'key'   { deviceId, label, code, ctrlKey, altKey, shiftKey, metaKey }  a cada tecla apertada
//   'error' mensagem                                                       se o auxiliar cair
// `code` segue o KeyboardEvent.code, então o renderer converte com o mesmo eventToShortcut.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// scancode (set 1) -> KeyboardEvent.code; é a posição física, então não depende do layout nem do NumLock
const SCAN = {
  0x01: 'Escape', 0x0c: 'Minus', 0x0d: 'Equal', 0x0e: 'Backspace', 0x0f: 'Tab',
  0x1a: 'BracketLeft', 0x1b: 'BracketRight', 0x1c: 'Enter', 0x1d: 'ControlLeft',
  0x27: 'Semicolon', 0x28: 'Quote', 0x29: 'Backquote', 0x2a: 'ShiftLeft', 0x2b: 'Backslash',
  0x33: 'Comma', 0x34: 'Period', 0x35: 'Slash', 0x36: 'ShiftRight', 0x37: 'NumpadMultiply',
  0x38: 'AltLeft', 0x39: 'Space', 0x45: 'NumLock',
  0x47: 'Numpad7', 0x48: 'Numpad8', 0x49: 'Numpad9', 0x4a: 'NumpadSubtract',
  0x4b: 'Numpad4', 0x4c: 'Numpad5', 0x4d: 'Numpad6', 0x4e: 'NumpadAdd',
  0x4f: 'Numpad1', 0x50: 'Numpad2', 0x51: 'Numpad3', 0x52: 'Numpad0', 0x53: 'NumpadDecimal',
  0x57: 'F11', 0x58: 'F12', 0x76: 'F24',
};
'QWERTYUIOP'.split('').forEach((k, i) => (SCAN[0x10 + i] = 'Key' + k));
'ASDFGHJKL'.split('').forEach((k, i) => (SCAN[0x1e + i] = 'Key' + k));
'ZXCVBNM'.split('').forEach((k, i) => (SCAN[0x2c + i] = 'Key' + k));
for (let i = 1; i <= 9; i++) SCAN[0x01 + i] = 'Digit' + i;
SCAN[0x0b] = 'Digit0';
for (let i = 1; i <= 10; i++) SCAN[0x3a + i] = 'F' + i;
for (let i = 13; i <= 23; i++) SCAN[0x64 + i - 13] = 'F' + i;

// mesmas posições com o prefixo E0 (teclas "estendidas")
const SCAN_E0 = {
  0x1c: 'NumpadEnter', 0x1d: 'ControlRight', 0x35: 'NumpadDivide', 0x38: 'AltRight',
  0x47: 'Home', 0x48: 'ArrowUp', 0x49: 'PageUp', 0x4b: 'ArrowLeft', 0x4d: 'ArrowRight',
  0x4f: 'End', 0x50: 'ArrowDown', 0x51: 'PageDown', 0x52: 'Insert', 0x53: 'Delete',
  0x5b: 'MetaLeft', 0x5c: 'MetaRight',
};

const MODIFIERS = {
  ControlLeft: 'ctrlKey', ControlRight: 'ctrlKey', ShiftLeft: 'shiftKey', ShiftRight: 'shiftKey',
  AltLeft: 'altKey', AltRight: 'altKey', MetaLeft: 'metaKey', MetaRight: 'metaKey',
};

const RI_KEY_BREAK = 1;
const RI_KEY_E0 = 2;
const RI_KEY_E1 = 4;

function codeFor(scancode, flags, vkey) {
  if (flags & RI_KEY_E1) return null; // Pause
  const code = (flags & RI_KEY_E0 ? SCAN_E0 : SCAN)[scancode];
  if (code) return code;
  // alguns teclados programáveis mandam só o virtual-key, sem scancode
  if (vkey >= 0x70 && vkey <= 0x87) return 'F' + (vkey - 0x6f);
  if (vkey >= 0x60 && vkey <= 0x69) return 'Numpad' + (vkey - 0x60);
  return null;
}

// O mesmo teclado é reconhecido pelo VID/PID (e interface), mesmo trocando de porta USB.
function deviceIdFor(devicePath) {
  const m = devicePath.match(/VID_[0-9A-F]{4}&PID_[0-9A-F]{4}(&MI_[0-9A-F]{2})?/i);
  return (m ? m[0] : devicePath).toUpperCase();
}

function labelFor(devicePath, product) {
  if (product) return product;
  const m = devicePath.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
  if (m) return `Teclado USB ${m[1].toUpperCase()}:${m[2].toUpperCase()}`;
  if (/^\\\\\?\\ACPI#/i.test(devicePath)) return 'Teclado integrado';
  return 'Teclado';
}

class KeyboardWatcher extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.devices = new Map(); // handle -> { id, label, down: Set<code> }
  }

  get running() {
    return !!this.proc;
  }

  start(workDir) {
    if (this.proc) return;
    // o PowerShell não lê arquivos de dentro do app.asar, então o script vai para a pasta de dados
    const script = path.join(workDir, 'keyboard-helper.ps1');
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'keyboard-helper.ps1')));
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(process.pid)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.proc = proc;
    this.devices.clear();
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => this.fail(proc, err.message));
    proc.on('exit', (code) => this.fail(proc, stderr.trim() || `o processo auxiliar saiu (código ${code})`));
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  fail(proc, message) {
    if (this.proc !== proc) return; // já foi parado de propósito
    this.proc = null;
    this.emit('error', message);
  }

  onLine(line) {
    const [type, handle, ...rest] = line.trim().split(' ');
    if (type === 'D') {
      const [devicePath, product] = rest.join(' ').split('\t');
      this.devices.set(handle, { id: deviceIdFor(devicePath), label: labelFor(devicePath, product), down: new Set() });
      return;
    }
    if (type !== 'K') return;
    const device = this.devices.get(handle);
    const [scancode, flags, vkey] = rest.map(Number);
    const code = device && codeFor(scancode, flags, vkey);
    if (!code) return;
    if (flags & RI_KEY_BREAK) {
      device.down.delete(code);
      return;
    }
    if (device.down.has(code)) return; // repetição de tecla segurada
    device.down.add(code);
    if (MODIFIERS[code]) return;
    // modificadores de qualquer teclado valem: um teclado numérico não tem Ctrl,
    // então Ctrl do teclado normal + Num 1 do teclado numérico também é um atalho
    const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    for (const d of this.devices.values()) {
      for (const c of d.down) if (MODIFIERS[c]) mods[MODIFIERS[c]] = true;
    }
    this.emit('key', { deviceId: device.id, label: device.label, code, ...mods });
  }
}

module.exports = { KeyboardWatcher };
