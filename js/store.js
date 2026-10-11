// Persistance locale : IndexedDB (données + fichiers), repli localStorage.
import { uid } from './utils.js';
import { COLORS, LIST_TEMPLATES } from './constants.js';

export const state = {
  version: 1,
  trips: [],
  settings: { theme: 'auto', routing: true, basemap: 'auto', recordingTripId: null },
  routeCache: {},
};

let db = null;
const LS_KEY = 'voyage-state';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('voyage-app', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('kv');
      r.result.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function load() {
  let saved = null;
  try {
    db = await openDB();
    saved = await tx('kv', 'readonly', (s) => s.get('state'));
  } catch (e) {
    console.warn('IndexedDB indisponible, repli sur localStorage', e);
    db = null;
  }
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* vide */ }
  }
  if (saved) {
    state.trips = saved.trips || [];
    Object.assign(state.settings, saved.settings || {});
    state.routeCache = saved.routeCache || {};
  }
  state.trips.forEach(normalizeTrip);
  navigator.storage?.persist?.().catch(() => {});
}

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

export async function flush() {
  clearTimeout(timer);
  const data = { version: state.version, trips: state.trips, settings: state.settings, routeCache: state.routeCache };
  try {
    if (db) await tx('kv', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(data)), 'state'));
    else localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Échec de la sauvegarde', e);
  }
}

addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

// ---------- Fichiers (photos, billets, PDF…)
export async function putFile(blob, id = uid()) {
  if (!db) throw new Error('Stockage de fichiers indisponible sur ce navigateur');
  await tx('files', 'readwrite', (s) => s.put(blob, id));
  return id;
}
const localFile = (id) => (db ? tx('files', 'readonly', (s) => s.get(id)) : Promise.resolve(null));
// Fichiers ajoutés par un compagnon de voyage : téléchargés à la première ouverture, puis gardés hors-ligne
const remoteFiles = new Map();
const fetching = new Map();
export const registerRemoteFile = (id, loader) => remoteFiles.set(id, loader);
export async function getFile(id) {
  const f = await localFile(id);
  if (f || !remoteFiles.has(id)) return f;
  if (!fetching.has(id)) {
    fetching.set(id, remoteFiles.get(id)().then(async (blob) => { await putFile(blob, id).catch(() => {}); return blob; }).catch(() => null).finally(() => setTimeout(() => fetching.delete(id), 5000)));
  }
  return fetching.get(id);
}
export const delFile = (id) => (db && id ? tx('files', 'readwrite', (s) => s.delete(id)) : Promise.resolve());

// ---------- Fabriques
export function defaultLists() {
  return ['Avant le départ', 'Bagages'].map((name) => ({
    id: uid(), name, items: LIST_TEMPLATES[name].map((text) => ({ id: uid(), text, done: false })),
  }));
}

export function newTrip(d = {}) {
  return normalizeTrip({
    id: uid(), name: 'Nouveau voyage', emoji: '🌍', color: COLORS[Math.floor(Math.random() * COLORS.length)],
    currency: 'EUR', budget: null, travelers: 1, start: '', end: '', notes: '', kind: 'mixed', vehicle: 'car', conso: null, fuelPrice: null,
    steps: [], expenses: [], checklists: defaultLists(), documents: [], track: [], photos: [], rates: {},
    createdAt: Date.now(), updatedAt: Date.now(), ...d,
  });
}

export const newTransport = () => ({ mode: '', depart: '', arrive: '', company: '', ref: '', price: null, status: '', notes: '', story: '' });

export function newStep(d = {}) {
  return { id: uid(), name: '', type: 'city', place: null, arrival: '', departure: '', notes: '', transport: newTransport(), stays: [], subs: [], ...d };
}
export function newStay(d = {}) {
  return { id: uid(), name: '', place: null, checkIn: '', checkInTime: '', checkOut: '', checkOutTime: '', status: 'todo', confirmation: '', price: null, link: '', phone: '', notes: '', ...d };
}
export function newSub(d = {}) {
  return { id: uid(), name: '', type: 'visit', date: '', time: '', place: null, cost: null, link: '', notes: '', done: false, ...d };
}

export function normalizeTrip(t) {
  for (const k of ['steps', 'expenses', 'checklists', 'documents', 'track', 'photos']) t[k] ||= [];
  // Ancien carnet de bord -> photos
  for (const j of t.journal || []) if (j.fileId) t.photos.push({ id: j.id, fileId: j.fileId, thumbId: j.fileId, t: j.t, lat: j.lat, lng: j.lng, caption: j.text || '', stepId: null });
  delete t.journal;
  t.rates ||= {};
  t.currency ||= 'EUR';
  t.travelers ||= 1;
  t.kind ||= 'mixed';
  t.vehicle ||= 'car';
  t.documents.forEach((d) => {
    d.private ??= ['passport', 'license', 'health'].includes(d.type);
    if (!d.files) d.files = d.fileId ? [{ id: d.fileId, name: d.fileName || 'document', type: '' }] : [];
    delete d.fileId; delete d.fileName;
  });
  t.checklists.forEach((l) => l.items.forEach((x) => { x.subs ||= []; x.note ??= ''; x.due ??= ''; }));
  t.steps.forEach((s) => {
    s.stays ||= [];
    s.story ??= '';
    s.subs ||= [];
    s.transport = { ...newTransport(), ...(s.transport || {}) };
  });
  return t;
}
