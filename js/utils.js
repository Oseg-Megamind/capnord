// Petites fonctions utilitaires partagées

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clone = (o) => JSON.parse(JSON.stringify(o));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = val;
}

// ---------- Dates (chaînes AAAA-MM-JJ, heure locale)
export const pad = (n) => String(n).padStart(2, '0');
export const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDay(new Date());
export function parseDay(s) {
  if (!s) return null;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseDay(s);
  if (!d) return s;
  d.setDate(d.getDate() + n);
  return toDay(d);
}
export const diffDays = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);

export const fmtDay = (s, opts = { day: 'numeric', month: 'short' }) =>
  s ? parseDay(s).toLocaleDateString('fr-FR', opts) : '';
export const fmtDayLong = (s) => fmtDay(s, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtWeekday = (s) => fmtDay(s, { weekday: 'short', day: 'numeric', month: 'short' });

export function fmtRange(a, b) {
  if (!a) return '';
  if (!b || a === b) return fmtDay(a, { day: 'numeric', month: 'short', year: 'numeric' });
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return `${fmtDay(a, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} → ${fmtDay(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export const fmtTime = (dt) => (dt && dt.includes('T') ? dt.slice(11, 16) : '');
export function fmtDateTime(dt) {
  if (!dt) return '';
  return `${fmtWeekday(dt.slice(0, 10))}${fmtTime(dt) ? ' · ' + fmtTime(dt) : ''}`;
}
export function shiftDateTime(dt, n) {
  if (!dt) return dt;
  return addDays(dt.slice(0, 10), n) + dt.slice(10);
}

export function fmtDuration(min) {
  if (min == null || isNaN(min)) return '';
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.round(h / 24)} j`;
  return m ? `${h} h ${pad(m)}` : `${h} h`;
}

export function fmtCountdown(ms) {
  if (ms <= 0) return 'maintenant';
  const min = Math.round(ms / 60000);
  if (min < 60) return `dans ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `dans ${h} h ${pad(min % 60)}`;
  return `dans ${Math.round(h / 24)} jours`;
}

// ---------- Géo
export function haversine(a, b) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function fmtKm(km) {
  if (km == null || isNaN(km)) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km).toLocaleString('fr-FR')} km`;
}
export const dirUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

// ---------- Divers
export function fmtMoney(n, cur = 'EUR') {
  n = +n || 0;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency', currency: cur,
      maximumFractionDigits: Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`;
  }
}
export const plural = (n, s, p) => `${n} ${n > 1 ? p || s + 's' : s}`;
export const shortLabel = (label = '') => label.split(',').slice(0, 2).join(',').trim();

export function download(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const slug = (s) =>
  (s || 'voyage').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
export async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

// Réduit une photo avant stockage (économise l'espace hors-ligne)
export async function compressImage(file, max = 1600, quality = 0.82) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 600_000) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', quality));
  } catch {
    return file;
  }
}
