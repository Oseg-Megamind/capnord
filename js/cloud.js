// Partage en ligne (Supabase) : publication d'un instantané du voyage + photos,
// lecture des commentaires et des « j'aime » laissés par les amis.
import { SUPABASE_URL, SUPABASE_ANON_KEY, PUBLIC_APP_URL } from './config.js';
import { uid, compressImage } from './utils.js';

let sb = null;
export const cloudReady = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);

export function client() {
  if (!sb && cloudReady()) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, storageKey: 'voyage-auth' } });
  }
  return sb;
}

// Le voyageur a un compte anonyme, créé automatiquement : rien à saisir
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

export function deviceId() {
  try {
    let d = localStorage.getItem('voyage-device');
    if (!d) { d = uid(); localStorage.setItem('voyage-device', d); }
    return d;
  } catch { return 'anon'; }
}

const appBase = () => PUBLIC_APP_URL || location.origin + location.pathname.replace(/[^/]*$/, '');
export const shareUrl = (token) => `${appBase().replace(/\/?$/, '/')}share.html?t=${token}`;
export const photoUrl = (path, thumb = false, ext = 'jpg') => `${SUPABASE_URL}/storage/v1/object/public/trip-photos/${path}${thumb ? '_t.jpg' : '.' + ext}`;

// Ce que voient les amis : récits, étapes, photos. Jamais le budget, les documents ni les réservations.
export function snapshot(trip, { start, end, me }) {
  const sh = trip.share || {};
  const pos = sh.position || 'city';
  const r4 = (x) => +(+x).toFixed(4);
  const pts = trip.track || [];
  const step = Math.max(1, Math.ceil(pts.length / 800));
  return {
    v: 1, name: trip.name, emoji: trip.emoji, color: trip.color, author: sh.author || '', start, end,
    position: pos,
    steps: trip.steps.map((s) => ({
      id: s.id, name: s.name, type: s.type, arrival: s.arrival, departure: s.departure, mode: s.transport?.mode || '',
      story: s.story || '', legStory: s.transport?.story || '', coverId: s.coverId || null, place: s.place ? { lat: r4(s.place.lat), lng: r4(s.place.lng) } : null,
    })),
    photos: trip.photos.filter((p) => p.remote).map((p) => ({
      id: p.id, stepId: p.stepId, onLeg: !!p.onLeg, kind: p.kind || 'photo', ext: p.ext || 'jpg', duration: p.duration || null, t: p.t, caption: p.caption || '', w: p.w || null, h: p.h || null, path: p.remote,
      lat: p.approx || p.lat == null ? null : r4(p.lat), lng: p.approx || p.lng == null ? null : r4(p.lng),
    })),
    track: pos === 'exact' ? pts.filter((_, i) => i % step === 0).map((p) => [p[0], p[1]]) : [],
    me: pos === 'exact' && me ? { lat: r4(me.lat), lng: r4(me.lng), t: me.t } : null,
  };
}

// Publie (ou met à jour) le voyage partagé. Les photos déjà envoyées ne sont pas renvoyées.
export async function publish(trip, { getFile, start, end, me, onProgress }) {
  const s = await session();
  const c = client();
  trip.share ||= {};
  if (!trip.share.id) {
    const { data, error } = await c.from('shares').insert({ data: {} }).select('id, token').single();
    if (error) throw error;
    Object.assign(trip.share, { id: data.id, token: data.token });
  }
  // Les vidéos de plus de 48 Mo dépassent la limite du stockage gratuit : elles restent sur le téléphone
  const todo = trip.photos.filter((p) => !p.remote && !(p.kind === 'video' && p.size > 48e6));
  let n = 0;
  for (const p of todo) {
    const full = await getFile(p.fileId).catch(() => null);
    const th = await getFile(p.thumbId).catch(() => null);
    if (!full || !th) continue;
    const base = `${s.user.id}/${trip.share.id}/${p.id}`;
    const video = p.kind === 'video';
    const ext = video ? (/quicktime/.test(p.mime) ? 'mov' : 'mp4') : 'jpg';
    const body = video ? full : await compressImage(full, 1800, 0.84);
    const opt = { upsert: true, contentType: video ? p.mime || 'video/mp4' : 'image/jpeg', cacheControl: '31536000' };
    let r = await c.storage.from('trip-photos').upload(`${base}.${ext}`, body, opt);
    if (r.error) throw r.error;
    p.ext = ext;
    r = await c.storage.from('trip-photos').upload(`${base}_t.jpg`, th, { ...opt, contentType: 'image/jpeg' });
    if (r.error) throw r.error;
    p.remote = base;
    onProgress?.(++n, todo.length);
  }
  const { error } = await c.from('shares').update({ data: snapshot(trip, { start, end, me }), updated_at: new Date().toISOString() }).eq('id', trip.share.id);
  if (error) throw error;
  trip.share.syncedAt = Date.now();
  trip.share.dirty = false;
}

export async function fetchShare(token) {
  const { data, error } = await client().rpc('get_share', { p_token: token });
  if (error) throw error;
  return data;
}

export async function addComment(token, target, parent, author, body) {
  const { data, error } = await client().rpc('add_comment', { p_token: token, p_target: target, p_parent: parent || null, p_author: author, p_body: body, p_device: deviceId() });
  if (error) throw error;
  return data;
}

export async function deleteComment(token, id) {
  const { error } = await client().rpc('delete_comment', { p_token: token, p_id: id, p_device: deviceId() });
  if (error) throw error;
}

export async function toggleLike(token, target, author) {
  const { data, error } = await client().rpc('toggle_like', { p_token: token, p_target: target, p_device: deviceId(), p_author: author || null });
  if (error) throw error;
  return data;
}

export async function stopShare(trip) {
  const s = await session();
  const c = client();
  const id = trip.share?.id;
  if (!id) return;
  const folder = `${s.user.id}/${id}`;
  const { data: files } = await c.storage.from('trip-photos').list(folder, { limit: 1000 });
  if (files?.length) await c.storage.from('trip-photos').remove(files.map((f) => `${folder}/${f.name}`));
  await c.from('shares').delete().eq('id', id);
  trip.photos.forEach((p) => delete p.remote);
  trip.share = { author: trip.share.author, position: trip.share.position };
}

// ---------- Astuces communautaires (partagées entre tous les voyageurs)
export async function getTips(lat, lng, km = 25) {
  const { data, error } = await client().rpc('get_tips', { p_lat: lat, p_lng: lng, p_km: km, p_device: deviceId() });
  if (error) throw error;
  return data || [];
}
export async function addTip(lat, lng, placeName, author, body) {
  const { error } = await client().rpc('add_tip', { p_lat: lat, p_lng: lng, p_place: placeName || '', p_author: author, p_body: body, p_device: deviceId() });
  if (error) throw error;
}
export async function voteTip(id) {
  const { error } = await client().rpc('vote_tip', { p_id: id, p_device: deviceId() });
  if (error) throw error;
}
export async function reportTip(id) {
  const { error } = await client().rpc('report_tip', { p_id: id, p_device: deviceId() });
  if (error) throw error;
}
