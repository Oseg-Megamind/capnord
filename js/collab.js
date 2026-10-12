// Carnet partagé entre compagnons de voyage : chacun modifie, tout le monde reçoit.
// Principe : chaque téléphone garde sa copie ; on envoie / reçoit le voyage complet et on
// fusionne « à trois » (version commune d'avant + mes changements + ceux des autres).
import { client, cloudReady } from './cloud.js';
import { SUPABASE_URL } from './config.js';
import { getFile, putFile, registerRemoteFile } from './store.js';

// Ce qui reste propre à chaque téléphone (jamais envoyé aux compagnons)
const LOCAL_KEYS = ['collab', 'share', 'track'];

async function session() {
  const c = client();
  let { data: { session: s } } = await c.auth.getSession();
  if (!s) {
    const r = await c.auth.signInAnonymously();
    if (r.error) throw r.error;
    s = r.data.session;
  }
  return s;
}

// Partie du voyage partagée : sans les clés locales ni les documents privés
export function shareable(trip) {
  const out = {};
  for (const [k, v] of Object.entries(trip)) if (!LOCAL_KEYS.includes(k)) out[k] = v;
  out.documents = (trip.documents || []).filter((d) => !d.private);
  return JSON.parse(JSON.stringify(out));
}

// ---------- Fusion à trois
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Comparaison indépendante de l'ordre des champs (le serveur les range autrement)
const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const hasId = (x) => isObj(x) && 'id' in x;

export function merge3(b, l, r) {
  if (same(l, r)) return l;
  if (same(b, l)) return r;
  if (same(b, r)) return l;
  if (Array.isArray(l) && Array.isArray(r) && l.every(hasId) && r.every(hasId)) {
    const base = Array.isArray(b) ? b.filter(hasId) : [];
    const bm = new Map(base.map((x) => [x.id, x]));
    const lm = new Map(l.map((x) => [x.id, x]));
    const rm = new Map(r.map((x) => [x.id, x]));
    // Si je n'ai pas réordonné, on garde l'ordre des autres
    const localReordered = !same(base.map((x) => x.id).filter((id) => lm.has(id)), l.map((x) => x.id).filter((id) => bm.has(id)));
    const first = localReordered ? l : r, second = localReordered ? r : l;
    const order = [...first.map((x) => x.id), ...second.map((x) => x.id)];
    const out = [], seen = new Set();
    for (const id of order) {
      if (seen.has(id)) continue;
      seen.add(id);
      const B = bm.get(id), L = lm.get(id), R = rm.get(id);
      if (L && R) out.push(merge3(B, L, R));
      else if (L) { if (!B || !same(B, L)) out.push(L); } // supprimé chez les autres, gardé seulement si je l'ai modifié
      else if (R) { if (!B || !same(B, R)) out.push(R); }
    }
    return out;
  }
  if (isObj(l) && isObj(r)) {
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const B = isObj(b) ? b[k] : undefined;
      if (!(k in l)) { if (B === undefined || !same(B, r[k])) out[k] = r[k]; continue; }
      if (!(k in r)) { if (B === undefined || !same(B, l[k])) out[k] = l[k]; continue; }
      out[k] = merge3(B, l[k], r[k]);
    }
    return out;
  }
  return l; // même champ modifié des deux côtés : ma modification, la plus récente, l'emporte
}

// ---------- Fichiers partagés (photos, vidéos, documents)
const fileIds = (t) => [
  ...(t.photos || []).flatMap((p) => [p.fileId, p.thumbId]),
  ...(t.documents || []).flatMap((d) => (d.files || []).map((f) => f.id)),
].filter(Boolean);
const remotePath = (cid, id) => `collab/${cid}/${id}`;

export function registerFiles(trip) {
  const cid = trip.collab?.id;
  if (!cid) return;
  for (const id of fileIds(shareable(trip))) registerRemoteFile(id, async () => {
    const { data, error } = await client().storage.from('trip-photos').download(remotePath(cid, id));
    if (error) throw error;
    return data;
  });
}

async function uploadFiles(trip) {
  const cid = trip.collab.id;
  const done = new Set(trip.collab.files || []);
  for (const id of fileIds(shareable(trip))) {
    if (done.has(id)) continue;
    const blob = await getFile(id).catch(() => null);
    if (!blob) continue; // fichier d'un compagnon pas encore téléchargé : il est déjà en ligne
    if (blob.size > 48e6) { done.add(id); continue; }
    const { error } = await client().storage.from('trip-photos').upload(remotePath(cid, id), blob, { upsert: true, contentType: blob.type || 'application/octet-stream' });
    if (error && !/exists/i.test(error.message)) throw error;
    done.add(id);
  }
  trip.collab.files = [...done];
}

// ---------- Créer / rejoindre / synchroniser / quitter
export async function createCollab(trip, name) {
  await session();
  const { data, error } = await client().rpc('create_collab', { p_trip: shareable(trip), p_name: name });
  if (error) throw error;
  trip.collab = { id: data.id, code: data.code, version: data.version, base: shareable(trip), me: name, files: [] };
  await uploadFiles(trip);
  return trip.collab;
}

export async function joinCollab(code, name) {
  await session();
  const { data, error } = await client().rpc('join_collab', { p_code: code, p_name: name });
  if (error) throw error;
  const trip = data.trip;
  trip.collab = { id: data.id, code: data.code, version: data.version, base: JSON.parse(JSON.stringify(data.trip)), me: name, files: fileIds(data.trip) };
  return trip;
}

// Renvoie { changed, by, members } : changed = le voyage a été modifié par quelqu'un d'autre
export async function syncCollab(trip) {
  await session();
  const c = client();
  const col = trip.collab;
  const local = shareable(trip);
  const { data: remote, error } = await c.rpc('pull_collab', { p_id: col.id });
  if (error) throw error;
  let merged = local, changed = false, by = null;
  if (remote.version !== col.version) {
    merged = merge3(col.base, local, remote.trip);
    changed = !same(merged, local);
    by = remote.updated_by;
  }
  let version = remote.version;
  // J'envoie si j'ai des modifications que les autres n'ont pas
  for (let tries = 0; tries < 4 && !same(merged, remote.trip); tries++) {
    await uploadFiles(trip);
    const { data: res, error: e2 } = await c.rpc('push_collab', { p_id: col.id, p_trip: merged, p_base: version, p_name: col.me || '' });
    if (e2) throw e2;
    if (res.ok) { version = res.version; remote.trip = merged; break; }
    // Quelqu'un a enregistré entre-temps : on refusionne avec sa version
    const again = merge3(col.base, merged, res.trip);
    changed = changed || !same(again, merged);
    by = res.updated_by;
    merged = again;
    version = res.version;
    remote.trip = res.trip;
  }
  // Ce qui a été saisi PENDANT la synchronisation est conservé (et partira au prochain envoi)
  const now = shareable(trip);
  const result = same(now, local) ? merged : merge3(local, now, merged);
  // Applique le résultat « sur place » : les écrans ouverts restent reliés aux mêmes objets
  const priv = (trip.documents || []).filter((d) => d.private);
  const target = { ...result, documents: [...(result.documents || []), ...priv] };
  for (const k of Object.keys(trip)) if (!LOCAL_KEYS.includes(k) && !(k in target)) delete trip[k];
  for (const [k, v] of Object.entries(target)) trip[k] = applyInPlace(trip[k], v);
  col.version = version;
  col.base = JSON.parse(JSON.stringify(merged));
  col.members = remote.members || col.members || [];
  col.syncedAt = Date.now();
  registerFiles(trip);
  return { changed, by, members: col.members };
}

// Recopie src dans dst en réutilisant les objets existants (même identifiant = même objet)
function applyInPlace(dst, src) {
  src = JSON.parse(JSON.stringify(src));
  if (Array.isArray(src)) {
    if (!Array.isArray(dst) || !src.every(hasId)) return src;
    const old = new Map(dst.filter(hasId).map((x) => [x.id, x]));
    const out = src.map((x) => (old.has(x.id) ? applyInPlace(old.get(x.id), x) : x));
    dst.length = 0;
    dst.push(...out);
    return dst;
  }
  if (isObj(src) && isObj(dst)) {
    for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
    for (const [k, v] of Object.entries(src)) dst[k] = applyInPlace(dst[k], v);
    return dst;
  }
  return src;
}

export async function leaveCollab(trip) {
  await session();
  await client().rpc('leave_collab', { p_id: trip.collab.id });
  delete trip.collab;
}

// Mises à jour en direct : prévient dès qu'un compagnon enregistre
const channels = new Map();
export function watchCollab(trip, onRemote) {
  if (!cloudReady() || !trip.collab?.id || channels.has(trip.collab.id)) return;
  const ch = client().channel('collab-' + trip.collab.id)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'collab_trips', filter: `id=eq.${trip.collab.id}` }, (p) => {
      if (p.new?.version !== trip.collab?.version) onRemote();
    })
    .subscribe();
  channels.set(trip.collab.id, ch);
}
export function unwatchAll() {
  for (const ch of channels.values()) client()?.removeChannel(ch);
  channels.clear();
}
export const inviteLink = (trip, url) => `${url}#/join/${trip.collab.code}`;
export const inviteText = (trip, url) => `Rejoins notre voyage « ${trip.name} » sur Etapa : on prépare et on complète le carnet de route ensemble.\n\nTouche ce lien pour nous rejoindre :\n${inviteLink(trip, url)}\n\n(Code d’invitation si besoin : ${trip.collab.code.slice(0, 3)}-${trip.collab.code.slice(3)})`;
export const SUPA = SUPABASE_URL;
