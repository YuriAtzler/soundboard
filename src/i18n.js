// Textos da interface. Cada idioma é um JSON em src/locales com chaves planas ("settings.title").
// Um valor pode ser { one, other } para singular/plural, escolhido por vars.n.
// Chave que falta no idioma cai no inglês, e depois na própria chave (para aparecer no teste).

const { app } = require('electron');

const LANGUAGES = ['pt-BR', 'en'];
const cache = {};
const load = (lang) => (cache[lang] ??= require(`./locales/${lang}.json`));

let current = 'en';

// 'system' vira o idioma do sistema quando o app o tem; senão, inglês
function resolve(setting) {
  if (LANGUAGES.includes(setting)) return setting;
  return app.getLocale().toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

function setLanguage(setting) {
  current = resolve(setting);
  return current;
}

// o dicionário do idioma atual completado pelo inglês; é o que vai para o renderer
function dictionary() {
  return { ...load('en'), ...load(current) };
}

function format(value, vars) {
  let text = value;
  if (text && typeof text === 'object') text = vars.n === 1 ? text.one : text.other;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function t(key, vars = {}) {
  return format(load(current)[key] ?? load('en')[key] ?? key, vars);
}

module.exports = { LANGUAGES, setLanguage, dictionary, t, format, language: () => current };
