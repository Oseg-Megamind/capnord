// Page publique d'un voyage partagé : ce que voient les amis (sans compte ni app).
import { $, $$, esc, todayStr, diffDays, fmtDay, fmtRange, fmtWeekday, plural } from './utils.js';
import { MODES } from './constants.js';
import { startPicto } from './picto.js';
startPicto();
import { cloudReady, fetchShare, addComment, deleteComment, toggleLike, photoUrl, deviceId, snapshot } from './cloud.js';
import { state, load as loadLocal, getFile } from './store.js';

// Mode démo (?demo=<id du voyage>) : aperçu de la page des amis à partir d'un voyage local, sans serveur
const DEMO = new URLSearchParams(location.search).get('demo');
const demoUrls = new Map();
const urlOf = (path, thumb = false, ext = 'jpg') => (DEMO ? demoUrls.get(path)?.[thumb ? 'thumb' : 'full'] || '' : photoUrl(path, thumb, ext));

const root = $('#sh');
const token = new URLSearchParams(location.search).get('t') || location.hash.slice(1);
const me = deviceId();
let S = null; // { id, data, comments, likes, updated_at }
let sortRecent = true;
const openThreads = new Set();

const getName = () => { try { return localStorage.getItem('voyage-name') || ''; } catch { return ''; } };
const setName = (n) => { try { localStorage.setItem('voyage-name', n); } catch { /* privé */ } };

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span>`;
  $('#toast-root').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); }, 3500);
}

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d < 7 ? `il y a ${d} j` : new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// ---------- Calculs (mêmes règles que l'app)
const nights = (s) => (s.arrival && s.departure ? Math.max(0, diffDays(s.arrival, s.departure)) : 0);
function currentIdx(steps, d = todayStr()) {
  for (let i = 0; i < steps.length; i++) if (steps[i].arrival && steps[i].arrival <= d && d < (steps[i].departure || steps[i].arrival)) return i;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].arrival === d) return i;
  return -1;
}
function status(D) {
  const d = todayStr();
  if (!D.start) return { key: 'draft', label: 'En préparation' };
  if (d < D.start) { const n = diffDays(d, D.start); return { key: 'soon', label: n === 1 ? 'Départ demain' : `Départ dans ${n} jours` }; }
  if (!D.end || d <= D.end) { const day = diffDays(D.start, d) + 1, tot = D.end ? diffDays(D.start, D.end) + 1 : null; return { key: 'now', label: `En route · jour ${day}${tot ? '/' + tot : ''}` }; }
  return { key: 'past', label: 'Voyage terminé' };
}
const likesOf = (target) => S.likes.filter((l) => l.target === target);
const commentsOf = (target) => S.comments.filter((c) => c.target === target);
const iLike = (target) => S.likes.some((l) => l.target === target && l.device === me);

// ---------- Rendu
function render() {
  const D = S.data;
  document.title = `${D.name} · Cap Nord`;
  document.documentElement.style.setProperty('--trip', D.color || '#7a2436');
  const st = status(D);
  const steps = D.steps || [];
  const idx = currentIdx(steps);
  const today = todayStr();
  const photos = (D.photos || []).slice().sort((a, b) => a.t - b.t);
  const cover = photos.find((p) => steps.some((s) => s.coverId === p.id)) || photos.at(-1);
  const started = steps.filter((s, i) => (s.arrival && s.arrival <= today) || photos.some((p) => p.stepId === s.id) || s.story);
  const upcoming = steps.filter((s) => !started.includes(s));
  const shown = sortRecent ? started.slice().reverse() : started;
  const cur = steps[idx];
  const name = getName();

  root.innerHTML = `
  <header class="sh-hero ${cover ? 'has-cover' : ''}" ${cover ? `style="background-image:url('${urlOf(cover.path, cover.kind === 'video')}')"` : ''}>
    <div class="sh-hero-in">
      <span class="chip sh-chip st-${st.key}">${st.key === 'now' ? '● ' : ''}${st.label}</span>
      <h1>${esc(D.emoji || '')} ${esc(D.name)}</h1>
      <p>${D.author ? `Le voyage de <b>${esc(D.author)}</b> · ` : ''}${D.start ? fmtRange(D.start, D.end) : ''}</p>
    </div>
  </header>

  <main class="sh-main">
    ${cur && D.position !== 'off' ? `<div class="sh-now"><span class="mp-dot now"></span><span>En ce moment à <b>${esc(cur.name)}</b>${steps[idx + 1] ? ` · ensuite ${esc(steps[idx + 1].name)}` : ''}</span></div>` : ''}

    <section class="sh-map-card">
      <div id="sh-map"></div>
      <button class="sh-map-btn" id="map-full">⤢ Agrandir</button>
    </section>

    <div class="sh-stats">
      <span>📍 <b>${steps.length}</b> étapes</span><span>📸 <b>${photos.length}</b> photos</span><span>💬 <b>${S.comments.length}</b></span><span>❤️ <b>${S.likes.length}</b></span>
    </div>

    <div class="sh-sort">
      <h2>Carnet de route</h2>
      <button class="btn sm" id="sort">${sortRecent ? '↓ Plus récent d’abord' : '↑ Depuis le début'}</button>
    </div>

    ${shown.map((s) => stepCard(s, steps.indexOf(s), photos.filter((p) => p.stepId === s.id), idx)).join('') || '<div class="card muted-card">Le voyage n’a pas encore commencé. Revenez bientôt !</div>'}

    ${upcoming.length ? `<section class="card sh-upcoming"><h4>À venir</h4>${upcoming.map((s) => `<div class="sh-up"><span class="num">${steps.indexOf(s) + 1}</span><span><b>${esc(s.name)}</b><small>${s.arrival ? fmtWeekday(s.arrival) : ''}</small></span></div>`).join('')}</section>` : ''}

    <section class="card">
      <h4>💬 Un mot pour ${esc(D.author || 'les voyageurs')} ?</h4>
      ${thread('trip', true)}
    </section>
    <p class="sh-foot">Ajoutez cette page à votre écran d’accueil pour suivre le voyage.<br>Créé avec Cap Nord</p>
  </main>`;

  mountMap(D, steps, photos, idx);
  $('#sort').onclick = () => { sortRecent = !sortRecent; render(); };
  $('#map-full').onclick = () => { $('.sh-map-card').classList.toggle('full'); setTimeout(() => map?.invalidateSize(), 60); };
  if (!name) $$('.cm-form [data-name]').forEach((i) => (i.hidden = false));
}

function stepCard(s, i, ph, idx) {
  const t = `step:${s.id}`;
  const mode = MODES[s.mode];
  const n = nights(s);
  const likes = likesOf(t).length, cms = commentsOf(t).length;
  return `<article class="card sh-step ${i === idx ? 'now' : ''}" id="s-${s.id}">
    <div class="sh-step-head">
      <span class="num">${i + 1}</span>
      <div><h3>${esc(s.name)}</h3>
      <small>${mode && i > 0 ? mode.icon + ' · ' : ''}${s.arrival ? fmtRange(s.arrival, s.departure) : ''}${n ? ' · ' + plural(n, 'nuit') : ''}</small></div>
      ${i === idx ? '<span class="now-badge">Ici maintenant</span>' : ''}
    </div>
    ${s.legStory && i > 0 ? `<p class="sh-story sh-leg">${mode ? mode.icon + ' ' : '🛣️ '}${esc(s.legStory)}</p>` : ''}
    ${s.story ? `<p class="sh-story">${esc(s.story)}</p>` : ''}
    ${ph.length ? `<div class="sh-mosaic n${Math.min(ph.length, 5)}">${ph.slice(0, 5).map((p, k) => `<button class="sh-ph" data-photo="${p.id}" aria-label="Voir la photo"><img loading="lazy" src="${urlOf(p.path, k > 0 || ph.length > 1 || p.kind === 'video')}" alt="${esc(p.caption)}">${p.kind === 'video' ? '<em class="sh-play">▶</em>' : ''}${k === 4 && ph.length > 5 ? `<b>+${ph.length - 5}</b>` : ''}${commentsOf('photo:' + p.id).length ? `<i>💬 ${commentsOf('photo:' + p.id).length}</i>` : ''}</button>`).join('')}</div>` : ''}
    <div class="sh-actions">
      <button class="sh-like ${iLike(t) ? 'on' : ''}" data-like="${t}">${iLike(t) ? '❤️' : '🤍'} ${likes || ''}</button>
      <button class="sh-cm-btn" data-open="${t}">💬 ${cms ? plural(cms, 'commentaire') : 'Commenter'}</button>
    </div>
    ${openThreads.has(t) || (cms && cms <= 2) ? thread(t) : ''}
  </article>`;
}

function thread(target, always = false) {
  const list = commentsOf(target);
  const roots = list.filter((c) => !c.parent_id);
  const one = (c) => `<div class="cm ${c.is_owner ? 'own' : ''}">
    <div class="cm-b"><b>${esc(c.author)}${c.is_owner ? ' ✈️' : ''}</b><p>${esc(c.body)}</p></div>
    <small>${ago(c.created_at)} · <button class="link" data-reply="${c.id}" data-target="${target}" data-who="${esc(c.author)}">Répondre</button></small>
  </div>`;
  return `<div class="thread">
    ${roots.map((c) => `<div class="cm-th">${one(c)}${list.filter((r) => r.parent_id === c.id).map((r) => `<div class="cm-rep">${one(r)}</div>`).join('')}</div>`).join('')}
    ${composer(target)}
  </div>`;
}

function composer(target) {
  return `<form class="cm-form" data-target="${target}">
    <input data-name placeholder="Votre prénom" maxlength="40" value="${esc(getName())}" ${getName() ? 'hidden' : ''} aria-label="Votre prénom">
    <div class="cm-row"><input data-body placeholder="Écrire un commentaire…" maxlength="2000" aria-label="Commentaire" enterkeyhint="send"><button class="btn sm primary">Envoyer</button></div>
    <small class="cm-replying" hidden></small>
  </form>`;
}

// ---------- Carte
let map = null;
function mountMap(D, steps, photos, idx) {
  if (map) { map.remove(); map = null; }
  map = L.map('sh-map', { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const pts = [];
  let prev = null;
  steps.forEach((s, i) => {
    if (!s.place) return;
    const p = [s.place.lat, s.place.lng];
    pts.push(p);
    const done = idx >= 0 ? i <= idx : (s.departure && s.departure < todayStr());
    if (prev) L.polyline([prev, p], { color: done ? MODES[s.mode]?.color || D.color : '#94a3b8', weight: done ? 4 : 3, dashArray: done ? MODES[s.mode]?.dash : '2 8', opacity: 0.9 }).addTo(map);
    prev = p;
    const cls = i === idx ? 'now' : done && i < idx ? 'past' : '';
    L.marker(p, { icon: L.divIcon({ className: 'mk-wrap', html: `<div class="mk ${cls}" style="--c:${D.color}"><span>${cls === 'past' ? '✓' : i + 1}</span></div>`, iconSize: [32, 32], iconAnchor: [16, 16] }) })
      .bindTooltip(esc(s.name), { direction: 'top', offset: [0, -14] })
      .on('click', () => $(`#s-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      .addTo(map);
  });
  if (D.track?.length > 1) L.polyline(D.track, { color: '#e11d48', weight: 3 }).addTo(map);
  for (const p of photos) {
    if (p.lat == null) continue;
    L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'mk-wrap', html: `<div class="mk-photo" style="background-image:url('${urlOf(p.path, true)}')"></div>`, iconSize: [40, 40], iconAnchor: [20, 20] }) })
      .on('click', () => viewPhoto(p.id)).addTo(map);
  }
  if (D.me) { pts.push([D.me.lat, D.me.lng]); L.marker([D.me.lat, D.me.lng], { icon: L.divIcon({ className: 'mk-wrap', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map); }
  if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 11 });
  else if (pts.length) map.setView(pts[0], 9);
  else map.setView([30, 0], 2);
}

// ---------- Visionneuse photo + commentaires
function viewPhoto(id) {
  const D = S.data;
  const ph = (D.photos || []).slice().sort((a, b) => a.t - b.t);
  const p = ph.find((x) => x.id === id);
  if (!p) return;
  const list = ph.filter((x) => x.stepId === p.stepId);
  const i = list.indexOf(p);
  const s = D.steps.find((x) => x.id === p.stepId);
  const t = `photo:${p.id}`;
  const mr = $('#modal-root');
  mr.innerHTML = `<div class="modal-backdrop" data-close></div><div class="modal lightbox" role="dialog" aria-modal="true">
    <div class="lb">
      <div class="lb-img">${p.kind === 'video' ? `<video controls playsinline preload="metadata" poster="${urlOf(p.path, true)}" src="${urlOf(p.path, false, p.ext)}"></video>` : `<img src="${urlOf(p.path)}" alt="${esc(p.caption)}">`}</div>
      ${i > 0 ? `<button class="lb-nav prev" data-photo="${list[i - 1].id}" aria-label="Précédente">‹</button>` : ''}
      ${i < list.length - 1 ? `<button class="lb-nav next" data-photo="${list[i + 1].id}" aria-label="Suivante">›</button>` : ''}
      <button class="lb-close" data-close aria-label="Fermer">✕</button>
      <div class="lb-info sh-lb-info">
        ${p.caption ? `<p class="lb-cap">${esc(p.caption)}</p>` : ''}
        <div class="lb-meta">${new Date(p.t).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}${s ? ' · 📍 ' + esc(s.name) : ''} · ${i + 1}/${list.length}</div>
        <div class="sh-actions"><button class="sh-like ${iLike(t) ? 'on' : ''}" data-like="${t}">${iLike(t) ? '❤️' : '🤍'} ${likesOf(t).length || ''}</button></div>
        ${thread(t)}
      </div>
    </div></div>`;
  mr.classList.add('open', 'dark');
  mr.dataset.photo = p.id;
  let x0 = null;
  const box = $('.lb-img', mr);
  box.addEventListener('touchstart', (e) => (x0 = e.touches[0].clientX), { passive: true });
  box.addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) $(`.lb-nav.${dx < 0 ? 'next' : 'prev'}`, mr)?.click(); });
}
function closeViewer() { const mr = $('#modal-root'); mr.classList.remove('open', 'dark'); mr.innerHTML = ''; delete mr.dataset.photo; }
const rerender = () => { const ph = $('#modal-root').dataset.photo; render(); if (ph) viewPhoto(ph); };

// ---------- Interactions
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-photo],[data-close],[data-like],[data-open],[data-reply],[data-del]');
  if (!el) return;
  if (el.dataset.photo) return viewPhoto(el.dataset.photo);
  if (el.hasAttribute('data-close')) return closeViewer();
  if (el.dataset.open) { openThreads.has(el.dataset.open) ? openThreads.delete(el.dataset.open) : openThreads.add(el.dataset.open); render(); $(`.cm-form[data-target="${el.dataset.open}"] [data-body]`)?.focus(); return; }
  if (el.dataset.like) {
    const t = el.dataset.like;
    const on = !iLike(t);
    if (on) S.likes.push({ target: t, device: me, author: getName() }); else S.likes = S.likes.filter((l) => !(l.target === t && l.device === me));
    rerender();
    if (!DEMO) try { await toggleLike(token, t, getName()); } catch { toast('Pas de connexion : réessayez'); }
    return;
  }
  if (el.dataset.reply) {
    const form = el.closest('.thread').querySelector('.cm-form');
    form.dataset.parent = el.dataset.reply;
    const r = $('.cm-replying', form);
    r.hidden = false;
    r.innerHTML = `Réponse à ${el.dataset.who} · <button type="button" class="link" data-cancel-reply>annuler</button>`;
    $('[data-body]', form).placeholder = `Répondre à ${el.dataset.who}…`;
    $('[data-body]', form).focus();
  }
});
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cancel-reply]');
  if (!c) return;
  const form = c.closest('.cm-form');
  delete form.dataset.parent;
  $('.cm-replying', form).hidden = true;
  $('[data-body]', form).placeholder = 'Écrire un commentaire…';
});
document.addEventListener('keydown', (e) => {
  if (!$('#modal-root').dataset.photo) return;
  if (e.key === 'Escape') closeViewer();
  if (e.target.matches('input')) return;
  if (e.key === 'ArrowRight') $('.lb-nav.next')?.click();
  if (e.key === 'ArrowLeft') $('.lb-nav.prev')?.click();
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('.cm-form');
  if (!form) return;
  e.preventDefault();
  const nameIn = $('[data-name]', form), bodyIn = $('[data-body]', form);
  const name = (nameIn.value || getName()).trim(), body = bodyIn.value.trim();
  if (!name) { nameIn.hidden = false; nameIn.focus(); toast('Indiquez votre prénom pour commenter'); return; }
  if (!body) return;
  setName(name);
  const btn = $('button.primary', form);
  btn.disabled = true;
  try {
    const c = DEMO
      ? { id: Math.random().toString(36).slice(2), target: form.dataset.target, parent_id: form.dataset.parent || null, author: name, body, is_owner: false, created_at: new Date().toISOString() }
      : await addComment(token, form.dataset.target, form.dataset.parent || null, name, body);
    S.comments.push({ ...c, device: me });
    openThreads.add(form.dataset.target);
    rerender();
    toast('Commentaire envoyé ✓');
  } catch {
    toast('Envoi impossible. Vérifiez votre connexion.');
    btn.disabled = false;
  }
});

// ---------- Chargement + mise à jour automatique
async function load(first = false) {
  try {
    const data = await fetchShare(token);
    if (!data) { root.innerHTML = '<div class="sh-msg"><div class="empty-ic">🧭</div><h2>Ce voyage n’est plus partagé</h2><p>Le lien a été désactivé par son auteur.</p></div>'; return; }
    const changed = !S || S.updated_at !== data.updated_at || S.comments.length !== data.comments.length || S.likes.length !== data.likes.length;
    if (!changed) return;
    const typing = document.activeElement?.matches?.('.cm-form input');
    S = data;
    if (first || !typing) rerender();
  } catch {
    if (first) root.innerHTML = '<div class="sh-msg"><div class="empty-ic">📡</div><h2>Connexion impossible</h2><p>Vérifiez votre connexion internet puis rechargez la page.</p></div>';
  }
}

async function startDemo() {
  await loadLocal();
  const t = state.trips.find((x) => x.id === DEMO) || state.trips[0];
  if (!t) { root.innerHTML = '<div class="sh-msg"><h2>Aucun voyage</h2></div>'; return; }
  for (const p of t.photos) {
    const [full, th] = await Promise.all([getFile(p.fileId).catch(() => null), getFile(p.thumbId).catch(() => null)]);
    if (!full) continue;
    const u = { full: URL.createObjectURL(full), thumb: th ? URL.createObjectURL(th) : URL.createObjectURL(full) };
    demoUrls.set(`demo/${p.id}`, u);
  }
  const days = t.steps.map((s) => s.arrival).filter(Boolean).sort();
  const ends = t.steps.map((s) => s.departure || s.arrival).filter(Boolean).sort();
  const copy = { ...t, share: { author: t.share?.author || 'Fanny', position: t.share?.position || 'city' }, photos: t.photos.map((p) => ({ ...p, remote: demoUrls.has(`demo/${p.id}`) ? `demo/${p.id}` : null })) };
  const data = snapshot(copy, { start: days[0], end: ends.at(-1) });
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const firstStep = data.steps.find((s) => data.photos.some((p) => p.stepId === s.id)) || data.steps[1] || data.steps[0];
  const firstPhoto = data.photos[0];
  const c1 = 'c1', c2 = 'c2';
  S = {
    id: 'demo', data, updated_at: ago(0),
    comments: [
      { id: c1, target: 'trip', parent_id: null, author: 'Maman', body: 'Profitez bien mes chéris ! Envoyez des nouvelles 😘', is_owner: false, created_at: ago(30) },
      { id: 'c1r', target: 'trip', parent_id: c1, author: data.author, body: 'Promis ! Tout se passe super bien ☀️', is_owner: true, created_at: ago(28) },
      ...(firstStep ? [{ id: c2, target: `step:${firstStep.id}`, parent_id: null, author: 'Léa', body: `Trop jaloux 😍 Vous avez testé les pastéis ?`, is_owner: false, created_at: ago(5) }] : []),
      ...(firstPhoto ? [{ id: 'c3', target: `photo:${firstPhoto.id}`, parent_id: null, author: 'Tom', body: 'Quelle lumière sur cette photo !', is_owner: false, created_at: ago(2) }] : []),
    ],
    likes: [
      ...(firstStep ? ['d1', 'd2', 'd3'].map((device) => ({ target: `step:${firstStep.id}`, device, author: '' })) : []),
      ...(firstPhoto ? ['d1', 'd4'].map((device) => ({ target: `photo:${firstPhoto.id}`, device, author: '' })) : []),
    ],
  };
  render();
  const b = document.createElement('div');
  b.className = 'demo-banner';
  b.innerHTML = '👁 Aperçu de ce que voient vos amis · commentaires d’exemple';
  document.body.prepend(b);
}

if (DEMO) startDemo();
else if (!cloudReady()) root.innerHTML = '<div class="sh-msg"><div class="empty-ic">🛠️</div><h2>Partage pas encore activé</h2><p>Le service de partage n’est pas configuré.</p></div>';
else if (!token) root.innerHTML = '<div class="sh-msg"><div class="empty-ic">🔗</div><h2>Lien incomplet</h2><p>Demandez à nouveau le lien du voyage.</p></div>';
else {
  load(true);
  setInterval(() => document.visibilityState === 'visible' && load(), 45000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
}
