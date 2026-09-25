// ZIP mínimo para exportar/importar perfis, sem dependências.
// Grava sem compressão (o áudio já vem comprimido, e assim cada arquivo é só copiado);
// lê arquivos sem compressão ou com deflate, para aceitar um .soundboard recompactado.
// Não há ZIP64: cada arquivo e o total precisam ficar abaixo de 4 GB.

const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const UTF8 = 0x0800; // bit 11: nomes em UTF-8

// data e hora no formato do DOS, que é o que o ZIP guarda
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
const LIMIT = 0xffffffff;

// entries: [{ name, data: Buffer }]; cada data é gravado e solto antes do próximo
function writeZip(outPath, entries) {
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  const { time, date } = dosDateTime();
  let offset = 0;
  const write = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  try {
    for (const entry of entries) {
      const data = typeof entry.data === 'function' ? entry.data() : entry.data;
      const name = Buffer.from(entry.name, 'utf8');
      const crc = crc32(data);
      if (offset + data.length > LIMIT) throw new Error('Arquivo grande demais para exportar (mais de 4 GB)');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // versão necessária
      local.writeUInt16LE(UTF8, 6);
      local.writeUInt16LE(0, 8); // sem compressão
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      central.push({ name, crc, size: data.length, offset });
      write(local);
      write(name);
      write(data);
    }
    const start = offset;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // feito por
      h.writeUInt16LE(20, 6); // versão necessária
      h.writeUInt16LE(UTF8, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      // extra, comentário, disco, atributos internos e externos ficam zerados
      h.writeUInt32LE(e.offset, 42);
      write(h);
      write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
}

// devolve { names, read(name) }; read descomprime e confere o CRC
function readZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  const size = fs.fstatSync(fd).size;
  const readAt = (pos, len) => {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    return buf;
  };
  try {
    // o fim do diretório central fica nos últimos 22 bytes + até 64 KB de comentário
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Não é um arquivo .soundboard válido');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirStart = tail.readUInt32LE(eocd + 16);
    if (dirStart === LIMIT || dirStart + dirSize > size) throw new Error('Arquivo .soundboard corrompido ou grande demais');
    const dir = readAt(dirStart, dirSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('Arquivo .soundboard corrompido');
      const method = dir.readUInt16LE(p + 10);
      const crc = dir.readUInt32LE(p + 16);
      const csize = dir.readUInt32LE(p + 20);
      const usize = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const offset = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLen);
      entries.set(name, { method, crc, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    fs.closeSync(fd);
    return {
      names: [...entries.keys()],
      read(name) {
        const e = entries.get(name);
        if (!e) return null;
        const f = fs.openSync(zipPath, 'r');
        try {
          const local = Buffer.alloc(30);
          fs.readSync(f, local, 0, 30, e.offset);
          if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Arquivo .soundboard corrompido');
          const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
          const raw = Buffer.alloc(e.csize);
          fs.readSync(f, raw, 0, e.csize, start);
          let data;
          if (e.method === 0) data = raw;
          else if (e.method === 8) data = zlib.inflateRawSync(raw);
          else throw new Error('Compressão não suportada no .soundboard');
          if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`"${name}" está corrompido no .soundboard`);
          return data;
        } finally {
          fs.closeSync(f);
        }
      },
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // já fechado
    }
    throw err;
  }
}

module.exports = { writeZip, readZip };
