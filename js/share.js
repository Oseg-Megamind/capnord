// Page publique d'un voyage partagé : la carte d'abord, les photos là où elles ont été prises,
// et de quoi participer (j'aime, commentaires) sur chaque étape, chaque photo et chaque vidéo.
import { $, $$, esc, todayStr, diffDays, fmtDay, fmtRange, plural } from './utils.js';
import { MODES, icon } from './constants.js';
import { startPicto } from './picto.js';
startPicto();
import { cloudReady, fetchShare, addComment, toggleLike, photoUrl, deviceId, snapshot } from './cloud.js';
import { state, load as loadLocal, getFile } from './store.js';

// Mode démo (?demo=<id du voyage>) : aperçu à partir d'un voyage local, sans serveur
const DEMO = new URLSearchParams(location.search).get('demo');
const demoUrls = new Map();
const urlOf = (path, thumb = false, ext = 'jpg') => (DEMO ? demoUrls.get(path)?.[thumb ? 'thumb' : 'full'] || '' : photoUrl(path, thumb, ext));

const root = $('#sh');
const token = new URLSearchParams(location.search).get('t') || location.hash.slice(1);
const me = deviceId();
let S = null; // { data, comments, likes, updated_at }
const ui = { view: null, stepId: null, sheet: 'closed', viewer: null, first: true };

// Mes commentaires sur ce voyage (ids) et date de la dernière lecture des notifications
const mineKey = () => `etapa-mine-${token || DEMO}`, seenKey = () => `etapa-seen-${token || DEMO}`;
const myIds = () => { try { return JSON.parse(localStorage.getItem(mineKey()) || '[]'); } catch { return ui.demoMine || []; } };
const addMine = (id) => { try { localStorage.setItem(mineKey(), JSON.stringify([...myIds(), id])); } catch { /* privé */ } };
const seenAt = () => { try { return +localStorage.getItem(seenKey()) || 0; } catch { return 0; } };
function myNotifs() {
  const mine = new Set([...myIds(), ...(ui.demoMine || [])]);
  const out = [
    ...S.comments.filter((c) => c.parent_id && mine.has(c.parent_id) && !mine.has(c.id)).map((c) => ({ kind: 'reply', who: c.author, owner: c.is_owner, body: c.body, target: c.target, at: c.created_at })),
    ...S.likes.filter((l) => l.target.startsWith('comment:') && mine.has(l.target.slice(8)) && l.device !== me).map((l) => ({ kind: 'like', who: l.author || 'Quelqu’un', target: (S.comments.find((c) => c.id === l.target.slice(8)) || {}).target || 'trip', at: l.created_at || '' })),
  ];
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}
const unread = () => myNotifs().filter((n) => n.at && new Date(n.at).getTime() > seenAt()).length;

const getName = () => { try { return localStorage.getItem('voyage-name') || ''; } catch { return ''; } };
const setName = (n) => { try { localStorage.setItem('voyage-name', n); } catch { /* privé */ } };

// Pictos propres à la page
const P = {
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.6 0 5.8 3.6 4.5 7.1-1.8 4.8-9.3 9.4-9.3 9.4z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
};
const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span>`;
  $('#toast-root').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); }, 3000);
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

// ---------- Données dérivées
const nights = (s) => (s.arrival && s.departure ? Math.max(0, diffDays(s.arrival, s.departure)) : 0);
function currentIdx(steps, d = todayStr()) {
  for (let i = 0; i < steps.length; i++) if (steps[i].arrival && steps[i].arrival <= d && d < (steps[i].departure || steps[i].arrival)) return i;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].arrival === d) return i;
  return -1;
}
// Trajet en cours (entre l'heure de départ et d'arrivée, ou la durée estimée)
function liveLeg(steps, now = Date.now()) {
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i], p = steps[i - 1];
    if (!s.depart) continue;
    const a = new Date(s.depart).getTime();
    const est = p.place && s.place ? (km(p.place, s.place) / (MODES[s.mode]?.speed || 60)) * 3600e3 + (MODES[s.mode]?.arc ? 2 * 3600e3 : 0) : 0;
    const b = s.arrive ? new Date(s.arrive).getTime() : est ? a + est : null;
    if (b && now >= a && now <= b) return { id: s.id, i, f: (now - a) / (b - a) };
  }
  return null;
}
function alongPath(pts, f) {
  if (pts.length < 2) return pts[0];
  const seg = []; let tot = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); tot += d; }
  let g = Math.min(1, Math.max(0, f)) * tot;
  for (let i = 0; i < seg.length; i++) { if (g <= seg[i]) { const k = seg[i] ? g / seg[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; } g -= seg[i]; }
  return pts.at(-1);
}

// Dernière étape atteinte : celle en cours, ou la plus loin déjà commencée (dates passées ou photos prises)
function lastDone(steps, d = todayStr()) {
  let k = currentIdx(steps, d);
  steps.forEach((s, i) => { if ((s.arrival && s.arrival <= d) || (S && stepPhotos(s.id).length)) k = Math.max(k, i); });
  return k;
}
// Date affichée d'une étape ; le point de départ sans date prend celle du début du voyage
function stepDate(s, i, D, long = false) {
  const a = s.arrival || (i === 0 ? D.start : '');
  if (!a) return i <= lastDone(D.steps) ? '' : 'À venir';
  return long ? fmtRange(a, s.departure || (i === 0 && !s.arrival ? '' : s.departure)) : fmtDay(a, { day: 'numeric', month: 'short' });
}
function status(D) {
  const d = todayStr();
  if (!D.start) return { key: 'draft', label: 'En préparation' };
  if (d < D.start) { const n = diffDays(d, D.start); return { key: 'soon', label: n === 1 ? 'Départ demain' : `Départ dans ${n} jours` }; }
  if (!D.end || d <= D.end) { const day = diffDays(D.start, d) + 1, tot = D.end ? diffDays(D.start, D.end) + 1 : null; return { key: 'now', label: `Jour ${day}${tot ? ' / ' + tot : ''}`, day, tot }; }
  return { key: 'past', label: 'Voyage terminé' };
}
const likesOf = (t) => S.likes.filter((l) => l.target === t);
const commentsOf = (t) => S.comments.filter((c) => c.target === t);
const iLike = (t) => S.likes.some((l) => l.target === t && l.device === me);
const photosAll = () => (S.data.photos || []).slice().sort((a, b) => a.t - b.t);
const stepById = (id) => (S.data.steps || []).find((s) => s.id === id);
const stepPhotos = (id) => photosAll().filter((p) => p.stepId === id);
const coverOf = (s) => photosAll().find((p) => p.id === s.coverId) || stepPhotos(s.id).at(-1);
const km = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r; const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// Photos regroupées par endroit : celles prises au même endroit (moins de 600 m) forment une pile sur la carte
function photoClusters() {
  const out = [];
  for (const p of photosAll()) {
    const s = stepById(p.stepId);
    // GPS de la photo s'il est cohérent avec son étape (ou son trajet), sinon l'étape ou le milieu du trajet
    const prev = p.onLeg ? (S.data.steps || [])[(S.data.steps || []).indexOf(s) - 1] : null;
    const mid = prev?.place && s?.place ? { lat: (prev.place.lat + s.place.lat) / 2, lng: (prev.place.lng + s.place.lng) / 2 } : null;
    const home = p.onLeg && mid ? mid : s?.place;
    let at = p.lat != null ? { lat: p.lat, lng: p.lng } : home;
    const limit = p.onLeg && mid ? km(prev.place, s.place) / 2 + 50 : 50;
    if (home && at && km(at, home) > limit) at = home;
    if (!at) continue;
    const c = out.find((x) => x.stepId === p.stepId && x.leg === !!p.onLeg && km(x.at, at) < 0.6);
    if (c) c.photos.push(p); else out.push({ id: p.id, stepId: p.stepId, leg: !!p.onLeg, at, photos: [p] });
  }
  return out;
}

// ---------- Rendu de la page
function render() {
  const D = S.data;
  document.title = `${D.name} · Etapa`;
  if (!$('#sh-map')) {
    root.innerHTML = `
      <div id="sh-map" class="shm"></div>
      <header class="shx-top" id="shx-top"></header>
      <nav class="sx-bar" id="sx-bar" aria-label="Étapes du voyage"></nav>
      <section class="shx-sheet ${ui.sheet}" id="sheet" aria-label="Détail">
        <div class="shx-grip" id="grip" aria-hidden="true"><i></i></div>
        <div class="shx-body" id="sheet-body"></div>
      </section>`;
    // La visionneuse vit au niveau de la page, au-dessus de tout
    if (!$('#viewer-root')) { const v = document.createElement('div'); v.id = 'viewer-root'; document.body.appendChild(v); }
    mountSheetDrag();
  }
  renderTop();
  renderBar();
  renderSheet();
  drawMap();
  if (ui.first) welcome(D);
  if (ui.viewer) renderViewer();
  ui.first = false;
}

// Message d'accueil flottant : affiché à la première visite seulement, il disparaît au toucher
function welcome(D) {
  const key = `etapa-hello-${token || DEMO}`;
  try { if (!DEMO && localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* privé */ }
  const w = document.createElement('button');
  w.className = 'shx-welcome';
  w.innerHTML = `<span class="shx-av">${esc((D.author || '?').slice(0, 1).toUpperCase())}</span><span><b>${esc(D.author || 'On')} vous invite à suivre son voyage « ${esc(D.name)} »</b><small>Explorez la carte, ouvrez les étapes, aimez et commentez les photos. Touchez pour commencer.</small></span>`;
  const bye = () => { w.classList.add('out'); setTimeout(() => w.remove(), 300); };
  w.onclick = bye;
  document.body.appendChild(w);
  setTimeout(bye, 9000);
}

function renderTop() {
  const D = S.data, st = status(D), steps = D.steps || [], idx = currentIdx(steps), cur = steps[idx], live = liveLeg(steps);
    $('#shx-top').innerHTML = `
    <div class="shx-who"><span class="shx-av">${esc((D.author || '?').slice(0, 1).toUpperCase())}</span>
      <div><small>Le voyage de ${esc(D.author || 'vos proches')}</small><h1>${esc(D.name)}</h1></div></div>
    <div class="shx-status">
      <span class="shx-chip st-${st.key}">${st.key === 'now' ? '<i class="pulse"></i>' : ''}${st.label}</span>
      ${live ? `<span class="shx-here live">${icon(steps[live.i].mode || 'route')} En route vers ${esc(steps[live.i].name)}</span>` : cur ? `<span class="shx-here">${icon('pin')} ${esc(cur.name)}</span>` : ''}
      <span class="shx-acts"><button class="shx-act" data-panel="guest" aria-label="Écrire à ${esc(D.author || 'au voyageur')}">${P.chat}</button><button class="shx-act" data-panel="notifs" aria-label="Notifications">${BELL}${unread() ? `<i class="nb">${unread()}</i>` : ''}</button></span>
    </div>
    ${st.tot ? `<div class="shx-prog"><i style="--w:${Math.min(100, (st.day / st.tot) * 100)}%"></i></div>` : ''}`;
}

function renderSheet() {
  const body = $('#sheet-body');
  const keep = body.scrollTop;
  const strip0 = $('#strip')?.scrollLeft;
  body.innerHTML = ui.view === 'step' && stepById(ui.stepId) ? stepView(stepById(ui.stepId)) : ui.view === 'guest' ? guestView() : ui.view === 'notifs' ? notifsView() : '';
  body.scrollTop = ui.first ? 0 : keep;
  const strip = $('#strip');
  if (strip) {
    if (strip0 != null && !ui.first && !ui.centerStrip) strip.scrollLeft = strip0;
    else { const c = $('.shx-cw.now, .shx-cw.go', strip) || $$('.shx-cw.done', strip).at(-1); if (c) strip.scrollLeft = c.offsetLeft - (strip.clientWidth - c.offsetWidth) / 2; }
    ui.centerStrip = false;
  }
}

function homeView() {
  const D = S.data, steps = D.steps || [], idx = currentIdx(steps), today = todayStr();
  const photos = photosAll();
  const recent = photos.slice().reverse().slice(0, 12);
  const ld = lastDone(steps, today), live = liveLeg(steps);
  // État de chaque étape : visitée, en cours (ou en route vers), à venir
  const stateOf = (i) => (live && i === live.i ? 'go' : i === idx && !live ? 'now' : i <= ld ? 'done' : 'todo');
  const label = { done: 'Visitée', now: 'Ici maintenant', go: 'En route', todo: 'À venir' };
  const card = (s, i) => {
    const c = coverOf(s), n = stepPhotos(s.id).length, st = stateOf(i);
    const t = `step:${s.id}`;
    return `<div class="shx-cw ${st}" style="--i:${i}">
      <span class="shx-rail"><i></i><em>${label[st]}</em></span>
      <button class="shx-card ${st === 'now' || st === 'go' ? 'now' : ''} ${st === 'todo' ? 'todo' : ''}" data-step="${s.id}">
      <span class="shx-card-img">${c ? `<img src="${urlOf(c.path, true)}" alt="" loading="lazy">` : `<span class="shx-card-ph">${icon('pin')}</span>`}
        <em class="shx-num">${st === 'done' ? '✓' : i + 1}</em></span>
      <span class="shx-card-txt"><b>${esc(s.name)}</b><small>${i === 0 && !s.arrival ? 'Départ' + (D.start ? ' · ' + stepDate(s, i, D) : '') : stepDate(s, i, D)}${nights(s) ? ' · ' + plural(nights(s), 'nuit') : ''}</small>
        <span class="shx-mini">${n ? `<span>${icon('camera')}${n}</span>` : ''}${likesOf(t).length ? `<span>${P.heart}${likesOf(t).length}</span>` : ''}${commentsOf(t).length ? `<span>${P.chat}${commentsOf(t).length}</span>` : ''}</span></span>
      </button></div>`;
  };
  // Encart « où en est-on » : maintenant, ensuite, et une frise avec une case par étape
  const curI = live ? live.i : idx >= 0 ? idx : -1;
  const next = steps[(live ? live.i : idx) + 1] || (curI < 0 ? steps[ld + 1] : null);
  const st0 = status(D);
  const where = st0.key === 'soon' ? `<b>Départ ${esc(st0.label.toLowerCase().replace('départ ', ''))}</b><small>Première étape : ${esc(steps[0]?.name || '')}</small>`
    : st0.key === 'past' ? `<b>Voyage terminé</b><small>${plural(steps.length, 'étape')} · ${plural(photos.length, 'photo')}</small>`
      : live ? `<b>En route vers ${esc(steps[live.i].name)}</b><small>Depuis ${esc(steps[live.i - 1]?.name || '')} · ${Math.round(live.f * 100)} % du trajet</small>`
        : curI >= 0 ? `<b>À ${esc(steps[curI].name)}</b><small>Étape ${curI + 1} sur ${steps.length}${nights(steps[curI]) ? ` · jusqu’au ${fmtDay(steps[curI].departure, { day: 'numeric', month: 'short' })}` : ''}</small>`
          : `<b>Entre deux étapes</b><small>Dernière : ${esc(steps[ld]?.name || '')}</small>`;
  const prog = `<div class="shx-where">
      <div class="shx-where-top"><span class="shx-where-ic ${live ? 'go' : ''}">${live ? icon(steps[live.i].mode || 'route') : icon('pin')}</span><span class="shx-where-txt">${where}</span>${curI >= 0 ? `<button class="shx-where-go" data-step="${steps[curI].id}">Voir ›</button>` : ''}</div>
      <div class="shx-segs">${steps.map((s, i) => `<button class="shx-seg ${stateOf(i)}" data-step="${s.id}" aria-label="${esc(s.name)}" title="${esc(s.name)}"><i></i></button>`).join('')}</div>
      <div class="shx-segs-lbl"><span>${esc(steps[0]?.name || '')}</span>${next ? `<span class="nx">Ensuite : <b>${esc(next.name)}</b>${next.arrival ? ' · ' + fmtDay(next.arrival, { weekday: 'short', day: 'numeric', month: 'short' }) : ''}</span>` : ''}<span>${esc(steps.at(-1)?.name || '')}</span></div>
    </div>`;
  return `
    ${prog}
    <div class="shx-sec-h"><h2>Étapes</h2><small>${Math.max(0, ld + 1)} / ${steps.length} visitées · ${plural(photos.length, 'photo')}</small></div>
    <div class="shx-strip" id="strip">${steps.map(card).join('')}</div>

    ${recent.length ? `<div class="shx-sec-h"><h2>Derniers moments</h2><small>Touchez pour aimer et commenter</small></div>
    <div class="shx-feed">${recent.map((p, k) => momentCard(p, k)).join('')}</div>` : `<div class="shx-empty">${icon('camera')}<p>Les photos du voyage apparaîtront ici, au fil de la route.</p></div>`}

    <div class="shx-sec-h"><h2>Un mot pour ${esc(D.author || 'les voyageurs')}</h2></div>
    <div class="shx-guest">${thread('trip')}</div>
    <p class="shx-foot">Créé avec <b>Etapa</b></p>`;
}

// ---------- Barrette des étapes : un point par étape, photos au-dessus, nom en dessous
function renderBar() {
  const D = S.data, steps = D.steps || [], idx = currentIdx(steps), ld = lastDone(steps), live = liveLeg(steps);
  const bar = $('#sx-bar');
  const keep = $('#sx-track')?.scrollLeft;
  bar.innerHTML = `<div class="sx-track" id="sx-track">${steps.map((s, i) => {
    const st = live && i === live.i ? 'go' : i === idx && !live ? 'now' : i <= ld ? 'done' : 'todo';
    const n = stepPhotos(s.id).length;
    return `<button class="sx-pt ${st} ${ui.stepId === s.id ? 'sel' : ''}" data-step="${s.id}" style="--i:${i}" aria-label="${i + 1}. ${esc(s.name)}">
      <small class="sx-ph">${n ? `${icon('camera')}${n}` : ''}</small>
      <span class="sx-dot"><em>${st === 'done' ? '✓' : i + 1}</em></span>
      <b class="sx-name">${esc(s.name)}</b>
    </button>`;
  }).join('')}</div>`;
  const tr = $('#sx-track');
  if (keep != null && !ui.first) tr.scrollLeft = keep;
  else { const c = $('.sx-pt.now, .sx-pt.go', tr) || $$('.sx-pt.done', tr).at(-1); if (c) tr.scrollLeft = c.offsetLeft - (tr.clientWidth - c.offsetWidth) / 2; }
}

function guestView() {
  const D = S.data;
  return `<div class="shx-step-h"><button class="shx-back" data-close-sheet aria-label="Fermer">${P.close}</button><div><small>Livre d’or</small><h2>Un mot pour ${esc(D.author || 'les voyageurs')}</h2></div></div>
    <div class="shx-guest">${thread('trip')}</div>`;
}
function notifsView() {
  const list = myNotifs(), seen = seenAt();
  try { localStorage.setItem(seenKey(), String(Date.now())); } catch { /* privé */ }
  setTimeout(renderTop, 50);
  const where = (t) => (t === 'trip' ? 'le livre d’or' : t.startsWith('step:') ? `l’étape ${esc(stepById(t.slice(5))?.name || '')}` : 'une photo');
  return `<div class="shx-step-h"><button class="shx-back" data-close-sheet aria-label="Fermer">${P.close}</button><div><small>Pour vous</small><h2>Notifications</h2></div></div>
    <div class="sx-notifs">${list.map((n) => `<button class="sx-nt ${n.at && new Date(n.at).getTime() > seen ? 'new' : ''}" data-goto="${esc(n.target)}">
      <span class="cm-av ${n.owner ? 'own' : ''}">${esc((n.who || '?').slice(0, 1).toUpperCase())}<i class="${n.kind}">${n.kind === 'like' ? P.heart : P.chat}</i></span>
      <span><b>${esc(n.who)}</b> ${n.kind === 'like' ? 'a aimé votre commentaire' : 'vous a répondu'} sur ${where(n.target)}${n.body ? `<em>« ${esc(n.body.slice(0, 100))} »</em>` : ''}<small>${n.at ? ago(n.at) : ''}</small></span>
    </button>`).join('') || '<div class="shx-empty"><p>Rien de nouveau. Quand le voyageur vous répondra ou aimera vos commentaires, vous le verrez ici.</p></div>'}</div>`;
}
function openPanel(view) {
  ui.view = view; ui.stepId = null;
  renderSheet(); renderBar();
  setSheet(innerWidth < 900 ? 'half' : 'full');
}

function momentCard(p, k = 0) {
  const s = stepById(p.stepId), t = `photo:${p.id}`;
  return `<article class="shx-moment" style="--i:${k}">
    <button class="shx-m-img" data-photo="${p.id}" data-scope="step" aria-label="Voir">
      <img src="${urlOf(p.path, p.kind === 'video' || k > 1)}" alt="${esc(p.caption)}" loading="lazy">${p.kind === 'video' ? `<em class="shx-play">${P.play}</em>` : ''}
      <span class="shx-m-place">${p.onLeg ? icon('route') + ' Route vers ' : icon('pin') + ' '}${esc(s?.name || '')}</span>
    </button>
    ${p.caption ? `<p class="shx-m-cap">${esc(p.caption)}</p>` : ''}
    <div class="shx-react">${likeBtn(t)}<button class="shx-cmb" data-photo="${p.id}" data-scope="step" data-cm="1">${P.chat}<span>${commentsOf(t).length || 'Commenter'}</span></button><small>${new Date(p.t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</small></div>
  </article>`;
}

function stepView(s) {
  const D = S.data, steps = D.steps, i = steps.indexOf(s), idx = currentIdx(steps), prev = steps[i - 1];
  const all = stepPhotos(s.id), legPh = all.filter((p) => p.onLeg), ph = all.filter((p) => !p.onLeg), t = `step:${s.id}`, mode = MODES[s.mode];
  const grid = (list, n0 = 0) => `<div class="shx-grid n${Math.min(list.length, 3)}">${list.map((p, k) => `<button class="shx-g" data-photo="${p.id}" data-scope="step" style="--i:${k + n0}"><img src="${urlOf(p.path, true)}" alt="" loading="lazy">${p.kind === 'video' ? `<em class="shx-play sm">${P.play}</em>` : ''}${likesOf('photo:' + p.id).length || commentsOf('photo:' + p.id).length ? `<i>${likesOf('photo:' + p.id).length ? P.heart + likesOf('photo:' + p.id).length : ''}${commentsOf('photo:' + p.id).length ? ' ' + P.chat + commentsOf('photo:' + p.id).length : ''}</i>` : ''}</button>`).join('')}</div>`;
  return `
    <div class="shx-step-h">
      <button class="shx-back" data-close-sheet aria-label="Fermer">${P.close}</button>
      <div><small>Étape ${i + 1} sur ${steps.length}${i === idx ? ' · ici maintenant' : ''}</small><h2>${esc(s.name)}</h2>
        <p>${i === 0 && !s.arrival ? 'Point de départ' + (D.start ? ' · ' + stepDate(s, i, D) : '') : stepDate(s, i, D, true) || 'Étape passée'}${nights(s) ? ' · ' + plural(nights(s), 'nuit') : ''}</p></div>
    </div>
    ${prev && (mode || s.legStory) ? `<div class="shx-leg">${mode ? icon(s.mode) : icon('route')}<span>${mode ? `En ${mode.label.toLowerCase()} depuis ${esc(prev.name)}` : `Depuis ${esc(prev.name)}`}${s.legStory ? `<em>${esc(s.legStory)}</em>` : ''}</span></div>` : ''}
    ${s.story ? `<p class="shx-story">${esc(s.story)}</p>` : ''}
    ${legPh.length ? `<div class="shx-sub-h">${mode ? icon(s.mode) : icon('route')}<span>Sur la route${prev ? ` depuis ${esc(prev.name)}` : ''}</span><small>${plural(legPh.length, legPh.some((p) => p.kind === 'video') ? 'moment' : 'photo')}</small></div>${grid(legPh)}` : ''}
    ${ph.length ? `${legPh.length ? `<div class="shx-sub-h">${icon('pin')}<span>À ${esc(s.name)}</span><small>${plural(ph.length, 'photo')}</small></div>` : ''}${grid(ph, legPh.length)}`
      : legPh.length ? '' : `<div class="shx-empty">${icon('camera')}<p>${i > lastDone(steps) ? 'Étape à venir : revenez pendant le voyage !' : 'Pas de photos sur cette étape.'}</p></div>`}
    <div class="shx-react big">${likeBtn(t)}<span class="shx-cmcount">${P.chat}${commentsOf(t).length ? plural(commentsOf(t).length, 'commentaire') : 'Commenter l’étape'}</span></div>
    ${thread(t)}
    <div class="shx-stepnav">
      ${prev ? `<button data-step="${prev.id}">‹ ${esc(prev.name)}</button>` : '<span></span>'}
      ${steps[i + 1] ? `<button data-step="${steps[i + 1].id}">${esc(steps[i + 1].name)} ›</button>` : ''}
    </div>`;
}

const likeBtn = (t) => `<button class="shx-like ${iLike(t) ? 'on' : ''}" data-like="${t}" aria-pressed="${iLike(t)}">${P.heart}<span>${likesOf(t).length || ''}</span></button>`;

function thread(target) {
  const list = commentsOf(target);
  const roots = list.filter((c) => !c.parent_id);
  const one = (c) => `<div class="cm ${c.is_owner ? 'own' : ''}">
    <span class="cm-av">${esc((c.author || '?').slice(0, 1).toUpperCase())}</span>
    <div><div class="cm-b"><b>${esc(c.author)}${c.is_owner ? ' <em>voyageur</em>' : ''}</b><p>${esc(c.body)}</p></div>
    <small>${ago(c.created_at)} · <button class="link" data-reply="${c.id}" data-who="${esc(c.author)}">Répondre</button> <button class="cm-like ${iLike('comment:' + c.id) ? 'on' : ''}" data-like="comment:${c.id}" aria-label="Aimer ce commentaire">${P.heart}<span>${likesOf('comment:' + c.id).length || ''}</span></button></small></div>
  </div>`;
  return `<div class="thread" data-thread="${target}">
    ${roots.map((c) => `<div class="cm-th">${one(c)}${list.filter((r) => r.parent_id === c.id).map((r) => `<div class="cm-rep">${one(r)}</div>`).join('')}</div>`).join('')}
    <form class="cm-form" data-target="${target}">
      <input data-name placeholder="Votre prénom" maxlength="40" value="${esc(getName())}" ${getName() ? 'hidden' : ''} aria-label="Votre prénom">
      <div class="cm-row"><input data-body placeholder="Écrire un commentaire…" maxlength="2000" aria-label="Commentaire" enterkeyhint="send"><button class="cm-send" aria-label="Envoyer">${P.send}</button></div>
      <small class="cm-replying" hidden></small>
    </form>
  </div>`;
}

// ---------- Carte : tracé, stations, piles de photos
let map = null, layer = null, stLayer = null;
function drawMap() {
  const D = S.data, steps = D.steps || [], idx = currentIdx(steps), today = todayStr(), live = liveLeg(steps);
  if (!map) {
    map = L.map('sh-map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    layer = L.layerGroup().addTo(map);
    stLayer = L.layerGroup().addTo(map);
    map.on('zoomend', () => drawStations());
    // Toucher ou déplacer la carte : elle passe en grand, le tiroir se range en bas
    map.on('click', () => { if (ui.sheet !== 'closed') closeSheet(); });
  }
  layer.clearLayers();
  const anim = ui.first;
  const pts = [];
  let prev = null, k = 0;
  steps.forEach((s, i) => {
    if (!s.place) return;
    const p = [s.place.lat, s.place.lng];
    pts.push(p);
    const done = i <= lastDone(steps, today);
    if (prev) {
      const m = MODES[s.mode];
      if (live && live.id === s.id) {
        const seg = [prev, p];
        L.polyline(seg, { color: '#5fd0c8', weight: 12, opacity: 0.35, lineCap: 'round', className: 'leg-live-halo', interactive: false }).addTo(layer);
        L.polyline(seg, { color: '#5fd0c8', weight: 4, dashArray: '10 14', lineCap: 'round', className: 'leg-live', interactive: false }).addTo(layer);
        L.marker(alongPath(seg, live.f), { zIndexOffset: 4000, icon: L.divIcon({ className: 'mk-wrap', iconSize: [40, 40], iconAnchor: [20, 20], html: `<div class="leg-veh">${icon(s.mode || 'route')}<b>${esc(D.author || 'En route')} en route</b></div>` }) })
          .on('click', () => openStep(s.id)).addTo(layer);
      }
      L.polyline([prev, p], { color: '#f7f8f4', weight: (m?.w || 3) + 5, opacity: 0.8, interactive: false }).addTo(layer);
      L.polyline([prev, p], done
        ? { color: m?.color === '#3d6fb6' ? '#3d6fb6' : '#10231f', weight: m?.w || 3, dashArray: m?.dash || null, lineCap: 'round', className: anim && !m?.dash ? 'shx-draw' : '', interactive: false }
        : { color: '#10231f', weight: 2.5, opacity: 0.55, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(layer);
    }
    prev = p;
  });
  ui.stationPts = steps.map((s, i) => (s.place ? { s, i, status: i === idx && !live ? 'now' : i <= lastDone(steps, today) ? 'past' : 'todo' } : null)).filter(Boolean);
  if (ui.first) {
    const pad = sheetPad();
    if (pts.length > 1) map.fitBounds(pts, { paddingTopLeft: [30, 150], paddingBottomRight: [30, pad + 20], maxZoom: 11 });
    else if (pts.length) map.setView(pts[0], 9);
    else map.setView([30, 0], 2);
  }
  drawStations();
}
// Stations (faite ✓ / en cours / à venir) regroupées quand elles se touchent, puis photos : comme la carte de l'app
function drawStations() {
  if (!stLayer || !ui.stationPts || !map._loaded) return;
  stLayer.clearLayers();
  const D = S.data, live = liveLeg(D.steps || []), ll = (pl) => [pl.lat, pl.lng];
  let groups = ui.stationPts.map((p) => ({ pt: map.latLngToLayerPoint(ll(p.s.place)), items: [p] }));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
      if (groups[a].pt.distanceTo(groups[b].pt) < 46) {
        const items = [...groups[a].items, ...groups[b].items], pts = items.map((x) => map.latLngToLayerPoint(ll(x.s.place)));
        groups[a] = { items, pt: L.point(pts.reduce((n, q) => n + q.x, 0) / pts.length, pts.reduce((n, q) => n + q.y, 0) / pts.length) };
        groups.splice(b, 1); merged = true; break outer;
      }
    }
  }
  const here = `<b class="mk-here">${esc(D.author || 'Ici')} est ici</b>`;
  for (const g of groups) {
    if (g.items.length === 1) {
      const { s, i, status } = g.items[0];
      L.marker(ll(s.place), { zIndexOffset: status === 'now' ? 800 : 400, icon: L.divIcon({ className: 'mk-wrap', iconSize: [34, 34], iconAnchor: [17, 17],
        html: `<div class="mk st-${status} ${status === 'now' ? 'now' : status === 'past' ? 'past' : ''} ${live ? 'calm' : ''}"><span>${status === 'past' ? '✓' : i + 1}</span>${status === 'now' && !live ? here : ''}</div>` }) })
        .on('click', () => openStep(s.id)).addTo(stLayer);
    } else {
      const it = g.items.sort((x, y) => x.i - y.i), nums = it.map((x) => x.i + 1);
      const lbl = nums.every((n, k) => !k || n === nums[k - 1] + 1) ? `${nums[0]}–${nums.at(-1)}` : nums.length <= 3 ? nums.join(' · ') : `${nums[0]}…${nums.at(-1)}`;
      const hasNow = it.some((x) => x.status === 'now'), cls = hasNow ? 'now' : it.every((x) => x.status === 'past') ? 'past' : it.every((x) => x.status === 'todo') ? 'todo' : 'mix';
      const lat = it.reduce((n, x) => n + x.s.place.lat, 0) / it.length, lng = it.reduce((n, x) => n + x.s.place.lng, 0) / it.length;
      L.marker([lat, lng], { zIndexOffset: 900, icon: L.divIcon({ className: 'mk-wrap', iconSize: [60, 34], iconAnchor: [30, 17], html: `<div class="mk-group ${cls}"><span>${lbl}</span>${hasNow && !live ? here : ''}</div>` }) })
        .on('click', () => map.flyToBounds(it.map((x) => ll(x.s.place)), { paddingTopLeft: [60, 150], paddingBottomRight: [60, sheetPad() + 30], maxZoom: 13, duration: 0.8 }))
        .addTo(stLayer);
    }
  }
  // Photos : petites, à côté du point, visibles en zoomant
  if (map.getZoom() >= 8) for (const c of photoClusters()) {
    const p = c.photos.at(-1);
    L.marker([c.at.lat, c.at.lng], { zIndexOffset: 100, icon: L.divIcon({ className: 'mk-wrap', iconSize: [30, 30], iconAnchor: [-6, 40],
      html: `<div class="mk-photo" style="background-image:url('${urlOf(p.path, true)}')">${c.photos.length > 1 ? `<i>${c.photos.length}</i>` : ''}</div>` }) })
      .on('click', () => openViewer(c.photos[0].id, c.photos.map((x) => x.id))).addTo(stLayer);
  }
}
const sheetPad = () => (innerWidth >= 900 ? 0 : ui.sheet === 'closed' ? 150 : Math.round(innerHeight * 0.55));
// Vole jusqu'à un lieu en le gardant au-dessus du tiroir
function flyTo(place, zoom = 11) {
  if (!place) return;
  const off = innerWidth >= 900 ? [-210, 0] : [0, Math.round((ui.sheet === 'full' ? innerHeight * 0.3 : sheetPad()) / 2)];
  const target = map.unproject(map.project([place.lat, place.lng], zoom).add(off), zoom);
  map.flyTo(target, zoom, { duration: 1.1 });
}

// ---------- Tiroir : glisser pour l'agrandir ou le réduire
function setSheet(s) { ui.sheet = s; $('#sheet').className = `shx-sheet ${s}`; document.body.classList.toggle('sheet-open', s !== 'closed'); }
function closeSheet() { setSheet('closed'); ui.view = null; ui.stepId = null; renderBar(); }
function mountSheetDrag() {
  const sheet = $('#sheet'), grip = $('#grip'), body = $('#sheet-body');
  let y0 = null, dy = 0, t0 = 0;
  const start = (y) => { y0 = y; dy = 0; t0 = Date.now(); sheet.style.transition = 'none'; };
  const move = (y) => { if (y0 == null) return; dy = y - y0; sheet.style.setProperty('--drag', `${dy}px`); };
  const end = () => {
    if (y0 == null) return;
    sheet.style.transition = ''; sheet.style.removeProperty('--drag');
    const fast = Math.abs(dy) / Math.max(1, Date.now() - t0) > 0.5;
    if (Math.abs(dy) < 6) setSheet(ui.sheet === 'full' ? 'half' : 'full');
    else if (dy < -60 || (fast && dy < 0)) setSheet('full');
    else if (dy > 60 || (fast && dy > 0)) { if (ui.sheet === 'full' && dy < 260) setSheet('half'); else closeSheet(); }
    y0 = null;
  };
  grip.addEventListener('touchstart', (e) => start(e.touches[0].clientY), { passive: true });
  grip.addEventListener('touchmove', (e) => move(e.touches[0].clientY), { passive: true });
  grip.addEventListener('touchend', end);
  grip.addEventListener('mousedown', (e) => { start(e.clientY); const mm = (ev) => move(ev.clientY); const mu = () => { end(); removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); }; addEventListener('mousemove', mm); addEventListener('mouseup', mu); });
  // Défiler vers le bas en haut du contenu agrandit le tiroir, tirer vers le bas en haut le réduit
  let by0 = null;
  body.addEventListener('touchstart', (e) => { by0 = body.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (by0 == null) return;
    const d = e.touches[0].clientY - by0;
    if (ui.sheet === 'half' && d < -30) { setSheet('full'); by0 = null; }
    else if (d > 80 && body.scrollTop <= 0) { if (ui.sheet === 'full') setSheet('half'); else closeSheet(); by0 = null; }
  }, { passive: true });
}

function openStep(id) {
  const s = stepById(id);
  if (!s) return;
  ui.view = 'step'; ui.stepId = id;
  const body = $('#sheet-body');
  body.classList.remove('slide-in'); void body.offsetWidth; body.classList.add('slide-in');
  renderSheet(); renderBar();
  body.scrollTop = 0;
  if (ui.sheet !== 'full') setSheet('half');
  flyTo(s.place, 12);
}
function goHome() {
  ui.view = 'home'; ui.stepId = null; ui.centerStrip = true;
  const body = $('#sheet-body');
  body.classList.remove('slide-in'); void body.offsetWidth; body.classList.add('slide-in');
  renderSheet();
  const pts = (S.data.steps || []).filter((s) => s.place).map((s) => [s.place.lat, s.place.lng]);
  if (pts.length > 1) map.flyToBounds(pts, { paddingTopLeft: [30, 150], paddingBottomRight: [30, sheetPad() + 20], maxZoom: 11, duration: 1 });
}

// ---------- Visionneuse plein écran : glisser entre les photos, double-toucher pour aimer, commenter
function openViewer(id, ids = null) {
  const p = photosAll().find((x) => x.id === id);
  if (!p) return;
  ui.viewer = { id, ids: ids || stepPhotos(p.stepId).map((x) => x.id), cm: false };
  renderViewer(true);
}
function renderViewer(enter = false) {
  const v = ui.viewer;
  const all = photosAll();
  const list = v.ids.map((i) => all.find((x) => x.id === i)).filter(Boolean);
  const k = Math.max(0, list.findIndex((x) => x.id === v.id));
  const p = list[k], s = stepById(p.stepId), t = `photo:${p.id}`;
  const vr = $('#viewer-root');
  const typing = document.activeElement?.closest?.('#viewer-root .cm-form');
  if (typing && !enter) { $('.shx-v-react', vr).innerHTML = vReact(t); $('.shx-v-thread', vr).innerHTML = thread(t); return; }
  vr.innerHTML = `<div class="shx-viewer ${enter ? 'enter' : ''} ${v.cm ? 'cm-open' : ''}">
    <div class="shx-v-top"><span>${p.onLeg ? `Sur la route vers ${esc(s?.name || '')}` : esc(s?.name || '')}<small>${k + 1} / ${list.length}</small></span><button class="shx-v-close" data-vclose aria-label="Fermer">${P.close}</button></div>
    <div class="shx-v-dots">${list.map((x, i) => `<i class="${i === k ? 'on' : ''}"></i>`).join('')}</div>
    <div class="shx-v-media" id="v-media">
      ${p.kind === 'video' ? `<video controls playsinline autoplay preload="metadata" poster="${urlOf(p.path, true)}" src="${urlOf(p.path, false, p.ext)}"></video>` : `<img src="${urlOf(p.path)}" alt="${esc(p.caption)}">`}
      <span class="shx-burst" id="burst">${P.heart}</span>
      ${k > 0 ? `<button class="shx-v-nav prev" data-vgo="${list[k - 1].id}" aria-label="Précédente">‹</button>` : ''}
      ${k < list.length - 1 ? `<button class="shx-v-nav next" data-vgo="${list[k + 1].id}" aria-label="Suivante">›</button>` : ''}
    </div>
    <div class="shx-v-info">
      ${p.caption ? `<p class="shx-v-cap">${esc(p.caption)}</p>` : ''}
      <small class="shx-v-meta">${new Date(p.t).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</small>
      <div class="shx-v-react">${vReact(t)}</div>
      <div class="shx-v-thread">${thread(t)}</div>
    </div>
  </div>`;
  const media = $('#v-media', vr);
  let x0 = null, lastTap = 0;
  media.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  media.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) { $(`.shx-v-nav.${dx < 0 ? 'next' : 'prev'}`, vr)?.click(); return; }
    const now = Date.now();
    if (now - lastTap < 300 && p.kind !== 'video') { likeBurst(t); lastTap = 0; } else lastTap = now;
  });
  media.addEventListener('dblclick', () => p.kind !== 'video' && likeBurst(t));
}
const vReact = (t) => `${likeBtn(t)}<button class="shx-cmb" data-vcm>${P.chat}<span>${commentsOf(t).length ? plural(commentsOf(t).length, 'commentaire') : 'Commenter'}</span></button>`;
function likeBurst(t) {
  const b = $('#burst');
  if (b) { b.classList.remove('go'); void b.offsetWidth; b.classList.add('go'); }
  if (!iLike(t)) doLike(t);
}
function closeViewer() {
  const v = $('.shx-viewer');
  if (!v) return;
  v.classList.add('leave');
  setTimeout(() => { $('#viewer-root').innerHTML = ''; ui.viewer = null; renderSheet(); }, 220);
}

// ---------- J'aime et commentaires
async function doLike(t) {
  const on = !iLike(t);
  if (on) S.likes.push({ target: t, device: me, author: getName() }); else S.likes = S.likes.filter((l) => !(l.target === t && l.device === me));
  $$(`[data-like="${t}"]`).forEach((b) => { b.classList.toggle('on', on); b.classList.remove('pop'); void b.offsetWidth; if (on) b.classList.add('pop'); $('span', b).textContent = likesOf(t).length || ''; });
  renderTop();
  if (!DEMO) try { await toggleLike(token, t, getName()); } catch { toast('Pas de connexion : réessayez'); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-step],[data-home],[data-photo],[data-like],[data-vclose],[data-vgo],[data-vcm],[data-reply],[data-cancel-reply],[data-panel],[data-close-sheet],[data-goto]');
  if (!el) return;
  if (el.dataset.panel) return ui.view === el.dataset.panel && ui.sheet !== 'closed' ? closeSheet() : openPanel(el.dataset.panel);
  if (el.hasAttribute('data-close-sheet')) return closeSheet();
  if (el.dataset.goto) {
    const t = el.dataset.goto;
    if (t === 'trip') return openPanel('guest');
    if (t.startsWith('step:')) return openStep(t.slice(5));
    if (t.startsWith('photo:')) { openViewer(t.slice(6)); ui.viewer.cm = true; return renderViewer(); }
  }
  if (el.dataset.like) return doLike(el.dataset.like);
  if (el.dataset.step) return openStep(el.dataset.step);
  if (el.hasAttribute('data-home')) return goHome();
  if (el.dataset.photo) { openViewer(el.dataset.photo); if (el.dataset.cm) { ui.viewer.cm = true; renderViewer(); $('.shx-v-thread [data-body]')?.focus(); } return; }
  if (el.hasAttribute('data-vclose')) return closeViewer();
  if (el.dataset.vgo) { ui.viewer.id = el.dataset.vgo; return renderViewer(); }
  if (el.hasAttribute('data-vcm')) { ui.viewer.cm = !ui.viewer.cm; $('.shx-viewer').classList.toggle('cm-open', ui.viewer.cm); if (ui.viewer.cm) $('.shx-v-thread [data-body]')?.focus(); return; }
  if (el.hasAttribute('data-cancel-reply')) {
    const form = el.closest('.cm-form');
    delete form.dataset.parent; $('.cm-replying', form).hidden = true; $('[data-body]', form).placeholder = 'Écrire un commentaire…';
    return;
  }
  if (el.dataset.reply) {
    const form = el.closest('.thread').querySelector('.cm-form');
    form.dataset.parent = el.dataset.reply;
    const r = $('.cm-replying', form);
    r.hidden = false;
    r.innerHTML = `Réponse à ${esc(el.dataset.who)} · <button type="button" class="link" data-cancel-reply>annuler</button>`;
    $('[data-body]', form).placeholder = `Répondre à ${el.dataset.who}…`;
    $('[data-body]', form).focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (!ui.viewer) return;
  if (e.key === 'Escape') closeViewer();
  if (e.target.matches('input')) return;
  if (e.key === 'ArrowRight') $('.shx-v-nav.next')?.click();
  if (e.key === 'ArrowLeft') $('.shx-v-nav.prev')?.click();
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
  const btn = $('.cm-send', form);
  btn.disabled = true;
  try {
    const c = DEMO
      ? { id: Math.random().toString(36).slice(2), target: form.dataset.target, parent_id: form.dataset.parent || null, author: name, body, is_owner: false, created_at: new Date().toISOString() }
      : await addComment(token, form.dataset.target, form.dataset.parent || null, name, body);
    S.comments.push({ ...c, device: me });
    addMine(c.id); (ui.demoMine ||= []).push(c.id);
    document.activeElement?.blur();
    if (ui.viewer) renderViewer(); else renderSheet();
    renderTop();
    toast('Commentaire envoyé');
  } catch {
    toast('Envoi impossible. Vérifiez votre connexion.');
    btn.disabled = false;
  }
});
addEventListener('resize', () => map?.invalidateSize());
setInterval(() => { if (S && liveLeg(S.data.steps || [])) { drawMap(); renderTop(); } }, 60000);

// ---------- Chargement + mise à jour automatique
async function load(first = false) {
  try {
    const data = await fetchShare(token);
    if (!data) { root.innerHTML = `<div class="sh-msg">${icon('route')}<h2>Ce voyage n’est plus partagé</h2><p>Le lien a été désactivé par son auteur.</p></div>`; return; }
    const changed = !S || S.updated_at !== data.updated_at || S.comments.length !== data.comments.length || S.likes.length !== data.likes.length;
    if (!changed) return;
    const typing = document.activeElement?.matches?.('.cm-form input');
    S = data;
    if (first || !typing) render();
  } catch {
    if (first) root.innerHTML = `<div class="sh-msg">${icon('route')}<h2>Connexion impossible</h2><p>Vérifiez votre connexion internet puis rechargez la page.</p></div>`;
  }
}

async function startDemo() {
  await loadLocal();
  const t = state.trips.find((x) => x.id === DEMO) || state.trips[0];
  if (!t) { root.innerHTML = '<div class="sh-msg"><h2>Aucun voyage</h2></div>'; return; }
  for (const p of t.photos) {
    const [full, th] = await Promise.all([getFile(p.fileId).catch(() => null), getFile(p.thumbId).catch(() => null)]);
    if (!full) continue;
    demoUrls.set(`demo/${p.id}`, { full: URL.createObjectURL(full), thumb: th ? URL.createObjectURL(th) : URL.createObjectURL(full) });
  }
  const days = t.steps.map((s) => s.arrival).filter(Boolean).sort();
  const ends = t.steps.map((s) => s.departure || s.arrival).filter(Boolean).sort();
  const copy = { ...t, share: { author: t.share?.author || 'Fanny' }, photos: t.photos.map((p) => ({ ...p, remote: demoUrls.has(`demo/${p.id}`) ? `demo/${p.id}` : null })) };
  const data = snapshot(copy, { start: days[0], end: ends.at(-1) });
  const h = (n) => new Date(Date.now() - n * 3600_000).toISOString();
  const firstStep = data.steps.find((s) => data.photos.some((p) => p.stepId === s.id)) || data.steps[1] || data.steps[0];
  const firstPhoto = data.photos[0];
  S = {
    id: 'demo', data, updated_at: h(0),
    comments: [
      { id: 'c1', target: 'trip', parent_id: null, author: 'Maman', body: 'Profitez bien mes chéris ! Envoyez des nouvelles', is_owner: false, created_at: h(30) },
      { id: 'c1r', target: 'trip', parent_id: 'c1', author: data.author, body: 'Promis ! Tout se passe super bien', is_owner: true, created_at: h(28) },
      ...(firstStep ? [{ id: 'c2', target: `step:${firstStep.id}`, parent_id: null, author: 'Léa', body: 'Trop jalouse ! Vous avez testé les pastéis ?', is_owner: false, created_at: h(5) }] : []),
      ...(firstPhoto ? [{ id: 'c3', target: `photo:${firstPhoto.id}`, parent_id: null, author: 'Vous', body: 'Quelle lumière sur cette photo !', is_owner: false, created_at: h(2) },
        { id: 'c3r', target: `photo:${firstPhoto.id}`, parent_id: 'c3', author: data.author, body: 'Merci ! On a eu de la chance avec le soleil', is_owner: true, created_at: h(1) }] : []),
    ],
    likes: [
      ...(firstStep ? ['d1', 'd2', 'd3'].map((device) => ({ target: `step:${firstStep.id}`, device, author: '' })) : []),
      ...(firstPhoto ? ['d1', 'd4'].map((device) => ({ target: `photo:${firstPhoto.id}`, device, author: '' })) : []),
      ...(firstPhoto ? [{ target: 'comment:c3', device: 'owner', author: data.author, created_at: h(0.5) }] : []),
    ],
  };
  ui.demoMine = ['c3'];
  render();
  const b = document.createElement('div');
  b.className = 'demo-banner';
  b.textContent = 'Aperçu · commentaires d’exemple';
  document.body.prepend(b);
}

if (DEMO) startDemo();
else if (!cloudReady()) root.innerHTML = '<div class="sh-msg"><h2>Partage pas encore activé</h2><p>Le service de partage n’est pas configuré.</p></div>';
else if (!token) root.innerHTML = '<div class="sh-msg"><h2>Lien incomplet</h2><p>Demandez à nouveau le lien du voyage.</p></div>';
else {
  load(true);
  setInterval(() => document.visibilityState === 'visible' && load(), 45000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
}
