// Confere as traduções: npm run check:i18n
// 1. todos os idiomas de src/locales têm as mesmas chaves (e os plurais têm one/other);
// 2. toda chave usada em t(...) e nos data-i18n* do HTML existe;
// 3. não sobrou texto com acento escrito direto no código (que deveria estar num dicionário).
// Chaves que ninguém usa só geram aviso.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const problems = [];

// ---------- 1. dicionários ----------
const localesDir = path.join(root, 'src', 'locales');
const locales = Object.fromEntries(
  fs.readdirSync(localesDir).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'))]),
);
const [base, ...others] = Object.keys(locales);
const baseKeys = Object.keys(locales[base]);
for (const lang of others) {
  const keys = Object.keys(locales[lang]);
  for (const k of baseKeys) if (!(k in locales[lang])) problems.push(`${lang}.json não tem "${k}"`);
  for (const k of keys) if (!(k in locales[base])) problems.push(`${base}.json não tem "${k}"`);
}
for (const [lang, dict] of Object.entries(locales)) {
  for (const [k, v] of Object.entries(dict)) {
    if (v && typeof v === 'object' && (typeof v.one !== 'string' || typeof v.other !== 'string')) {
      problems.push(`${lang}.json: "${k}" é plural, mas não tem one e other`);
    }
  }
}

// ---------- 2. chaves usadas ----------
const jsFiles = ['src/main.js', 'src/updater.js', 'src/link.js', 'src/renderer/renderer.js'];
const used = new Set();
for (const file of jsFiles) {
  const src = read(file);
  // t('a.b'), i18n.t('a.b'), t(cond ? 'a.b' : 'c.d')
  for (const call of src.matchAll(/\bt\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    for (const m of call[1].matchAll(/'([\w.-]+\.[\w.-]+)'/g)) used.add(m[1]);
  }
}
const html = read('src/renderer/index.html');
for (const m of html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria)?="([^"]+)"/g)) used.add(m[1]);
for (const k of used) if (!(k in locales[base])) problems.push(`chave usada mas inexistente: "${k}"`);
// chaves montadas em tempo de execução (zip.${code}, link.${code})
const dynamic = /^(zip|link)\./;
const unused = baseKeys.filter((k) => !used.has(k) && !dynamic.test(k));

// ---------- 3. texto fixo no código ----------
const ACCENT = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;
for (const file of jsFiles) {
  // \r?\n: no runner Windows o checkout vem com CRLF, e o . da regex dos comentários não pega o \r
  read(file).split(/\r?\n/).forEach((line, i) => {
    // tira comentários de linha (o // de uma URL dentro de string vem depois de ':' e não conta)
    const code = line.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    if (/^\s*\*/.test(code)) return; // linhas de comentário em bloco
    for (const m of code.matchAll(/'[^']*'|"[^"]*"|`[^`]*`/g)) {
      if (ACCENT.test(m[0])) problems.push(`${file}:${i + 1} texto fixo: ${m[0]}`);
    }
  });
}
// no HTML, texto visível fora de data-i18n (os nomes dos idiomas ficam no próprio idioma de propósito)
const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<option value="[\w-]+">[^<]*<\/option>/g, '');
for (const m of visible.matchAll(/>([^<>]*[A-Za-zÀ-ú]{3,}[^<>]*)</g)) {
  const text = m[1].trim();
  if (text && !/^(Soundboard|mp3, wav.*)$/.test(text)) problems.push(`index.html: texto fixo: "${text}"`);
}
for (const m of visible.matchAll(/\s(title|placeholder|aria-label)="([^"]*)"/g)) {
  problems.push(`index.html: ${m[1]} fixo: "${m[2]}" (use data-i18n-${m[1] === 'aria-label' ? 'aria' : m[1]})`);
}

// ---------- resultado ----------
console.log(`${Object.keys(locales).join(', ')}: ${baseKeys.length} chaves, ${used.size} usadas no código.`);
if (unused.length) console.log(`aviso: ${unused.length} chave(s) sem uso: ${unused.join(', ')}`);
if (problems.length) {
  console.error(`\n${problems.length} problema(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('ok');
