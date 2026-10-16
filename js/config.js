// Конфигурация приложения: хранение настроек, разбор ссылки с токеном.

import { b64urlEncode, b64urlDecode, uid } from './util.js';

const LS_CFG = 'fbr.cfg.v1';
const LS_DEV = 'fbr.device.v1';
const LS_PREFS = 'fbr.prefs.v1';
const LS_STATE = 'fbr.state.v1';

export const DEFAULT_API = 'https://api.github.com';

export function encodeCfg(cfg) {
  const o = {
    o: cfg.owner, r: cfg.repo, b: cfg.branch || 'main', t: cfg.token,
  };
  if (cfg.api && cfg.api !== DEFAULT_API) o.api = cfg.api;
  return b64urlEncode(JSON.stringify(o));
}

export function decodeCfg(s) {
  try {
    const o = JSON.parse(b64urlDecode(s));
    return normalizeCfg(o);
  } catch { return null; }
}

export function normalizeCfg(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.mode === 'local') return { mode: 'local' };
  const owner = String(o.o || o.owner || '').trim();
  const repo = String(o.r || o.repo || '').trim();
  const token = String(o.t || o.token || '').trim();
  if (!owner || !repo || !token) return null;
  return {
    mode: 'github',
    owner,
    repo,
    branch: String(o.b || o.branch || 'main').trim() || 'main',
    token,
    api: String(o.api || DEFAULT_API).replace(/\/+$/, ''),
  };
}

export function saveCfg(cfg) {
  if (!cfg) localStorage.removeItem(LS_CFG);
  else localStorage.setItem(LS_CFG, JSON.stringify(cfg));
}

export function loadCfg() {
  try {
    const raw = localStorage.getItem(LS_CFG);
    return raw ? normalizeCfg(JSON.parse(raw)) : null;
  } catch { return null; }
}

// ---------------- адресная строка ----------------
// Токен живёт во фрагменте (#cfg=...) — фрагмент не уходит на сервер
// и не попадает в Referer, в отличие от query-строки.

export function parseLocation() {
  const raw = location.hash.replace(/^#/, '');
  const p = new URLSearchParams(raw);
  return {
    cfg: p.get('cfg') || null,
    view: p.get('v') || null,
    id: p.get('id') || null,
  };
}

export function buildHash({ cfg, view, id, replace = false }) {
  const p = new URLSearchParams();
  if (cfg) p.set('cfg', cfg);
  if (view) p.set('v', view);
  if (id) p.set('id', id);
  const url = location.pathname + location.search + (p.toString() ? '#' + p.toString() : '');
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

export function shareLink(cfg, view, id) {
  const base = location.origin + location.pathname;
  const p = new URLSearchParams();
  p.set('cfg', encodeCfg(cfg));
  if (view) p.set('v', view);
  if (id) p.set('id', id);
  return base + '#' + p.toString();
}

// ---------------- устройство ----------------
export function device() {
  try {
    const raw = localStorage.getItem(LS_DEV);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  const d = { id: uid('d'), name: guessDeviceName() };
  localStorage.setItem(LS_DEV, JSON.stringify(d));
  return d;
}

export function setDeviceName(name) {
  const d = device();
  d.name = name || guessDeviceName();
  localStorage.setItem(LS_DEV, JSON.stringify(d));
  return d;
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  const os =
    /Windows/i.test(ua) ? 'Windows' :
    /Android/i.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS' :
    /Mac OS X/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' : 'Устройство';
  const br =
    /Edg\//i.test(ua) ? 'Edge' :
    /OPR\//i.test(ua) ? 'Opera' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Chrome\//i.test(ua) ? 'Chrome' :
    /Safari\//i.test(ua) ? 'Safari' : 'браузер';
  return `${os} · ${br}`;
}

// ---------------- настройки читалки ----------------
export const DEFAULT_PREFS = {
  theme: 'light',
  fontSize: 19,
  lineHeight: 1.6,
  pageWidth: 42,
  fontFamily: 'serif',
  align: 'justify',
  hyphens: true,
  custom: false,
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch { return { ...DEFAULT_PREFS }; }
}

export function savePrefs(p) {
  localStorage.setItem(LS_PREFS, JSON.stringify(p));
}

export function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(prefs) {
  const t = prefs.theme === 'auto' ? systemTheme() : prefs.theme;
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? 'dark' : 'light');
  return t;
}

export function applyReaderPrefs(prefs) {
  const r = document.documentElement.style;
  r.setProperty('--reader-size', prefs.fontSize + 'px');
  r.setProperty('--reader-line', String(prefs.lineHeight));
  r.setProperty('--reader-page', prefs.pageWidth + 'rem');
  const fam =
    prefs.fontFamily === 'sans' ? "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" :
    prefs.fontFamily === 'mono' ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" :
    "Georgia, 'Iowan Old Style', 'PT Serif', 'Times New Roman', serif";
  r.setProperty('--reader-font', fam);
}

// ---------------- прочий локальный стейт ----------------
export function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_STATE) || '{}'); } catch { return {}; }
}
export function saveState(s) {
  try { localStorage.setItem(LS_STATE, JSON.stringify(s)); } catch { /* ignore */ }
}

export const LS = { LS_CFG, LS_DEV, LS_PREFS, LS_STATE };
