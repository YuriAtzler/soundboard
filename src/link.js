// Baixa um áudio a partir de um link: o próprio arquivo (.mp3 etc.) ou uma página que aponte para
// ele, como as do MyInstants (og:audio). Usa o net.fetch do Electron, que passa pela pilha de rede
// do Chromium; o fetch do Node leva 403 do Cloudflare em sites como o MyInstants.
// Lança erros com `code` ('invalid', 'http', 'network', 'no-audio', 'too-big'), traduzidos no main.
const { net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT = 30_000;

// tipo do servidor -> extensão, para links sem extensão no caminho
const MIME_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
  'audio/x-flac': 'flac', 'audio/webm': 'webm', 'audio/opus': 'opus',
};

function fail(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  return err;
}

async function get(url) {
  let res;
  try {
    res = await net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw fail('network', err.message);
  }
  if (!res.ok) throw fail('http', String(res.status));
  return res;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function meta(html, prop) {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i'));
  const content = tag && tag[0].match(/content=["']([^"']+)["']/i);
  return content ? decodeEntities(content[1]).trim() : null;
}

// endereço do áudio numa página: og:audio, o play('...') dos botões do MyInstants ou o
// primeiro link para um arquivo de áudio
function findAudio(html, exts) {
  const og = meta(html, 'og:audio') || meta(html, 'og:audio:url') || meta(html, 'og:audio:secure_url');
  if (og) return og;
  const play = html.match(/play\(\s*['"]([^'"]+)['"]/);
  if (play) return decodeEntities(play[1]);
  const link = html.match(new RegExp(`["']([^"'\\s]+\\.(?:${exts.join('|')}))(?:\\?[^"'\\s]*)?["']`, 'i'));
  return link ? decodeEntities(link[1]) : null;
}

// nome do som: o título do botão no MyInstants, o og:title ou o <title>
function findName(html) {
  const h1 = html.match(/<h1[^>]*id=["']instant-page-title["'][^>]*>([^<]+)</i);
  const title = h1?.[1] || meta(html, 'og:title') || html.match(/<title[^>]*>([^<]+)</i)?.[1];
  return title ? decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 120) : null;
}

const isHtml = (res) => /text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '');

function extOf(res, url, exts) {
  const fromPath = path.extname(new URL(url).pathname).toLowerCase().slice(1);
  if (exts.includes(fromPath)) return fromPath;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[type] || null;
}

async function save(res, file) {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw fail('too-big');
  const out = fs.createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw fail('too-big');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err.code ? err : fail('network', err.message);
  }
  await new Promise((r) => out.end(r));
}

// baixa o áudio do link para `dir` e devolve { path, name }; `exts` são as extensões aceitas
async function download(link, dir, exts) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw fail('invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('invalid');

  let res = await get(url.href);
  let name = null;
  if (isHtml(res)) {
    const html = await res.text();
    const audio = findAudio(html, exts);
    if (!audio) throw fail('no-audio');
    name = findName(html);
    url = new URL(audio, res.url || url.href);
    res = await get(url.href);
    if (isHtml(res)) throw fail('no-audio');
  }
  const ext = extOf(res, res.url || url.href, exts);
  if (!ext) throw fail('no-audio');

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  await save(res, file);
  if (!name) name = decodeURIComponent(path.basename(url.pathname, path.extname(url.pathname))) || 'audio';
  return { path: file, name };
}

module.exports = { download };
