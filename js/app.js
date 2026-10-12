import {
  $, $$, esc, uid, clone, debounce, getPath, setPath, todayStr, addDays, diffDays, fmtDay, fmtDayLong, fmtWeekday,
  fmtRange, fmtTime, fmtDateTime, shiftDateTime, fmtDuration, fmtCountdown, haversine, fmtKm, dirUrl, fmtMoney, plural,
  shortLabel, download, slug, blobToDataURL, dataURLToBlob, compressImage,
} from './utils.js';
import { MODES, STEP_TYPES, SUB_TYPES, EXP_CATS, DOC_TYPES, BOOK_STATUS, COLORS, CURRENCIES, LIST_TEMPLATES, WEATHER, COUNTRY_CURRENCY, VEHICLES, icon } from './constants.js';
import { state, load, save, flush, putFile, getFile, delFile, newTrip, newStep, newStay, newSub, normalizeTrip } from './store.js';
import * as svc from './services.js';
import { MapView, BASEMAPS } from './mapview.js';
import * as cloud from './cloud.js';
import { startPicto } from './picto.js';
import * as collab from './collab.js';

// =====================================================================
// État de l'interface
// =====================================================================
const app = $('#app');
const ui = {
  tripId: null, tab: 'itin', drawer: null, open: new Set(), day: null,
  watchId: null, me: null, follow: false, recording: false, wake: null, addMode: false,
  shiftNext: true, installEvt: null,
};
let mapView = null;
const isMobile = () => matchMedia('(max-width: 899px)').matches;

const MARK = '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M96 500 L246 290 H266 L416 500 Z" fill="currentColor"/><path d="M256 30 C264 120 280 148 330 160 C280 172 264 200 256 290 C248 200 232 172 182 160 C232 148 248 120 256 30 Z" fill="#d9a441"/></svg>';
const getTrip = (id) => state.trips.find((t) => t.id === id);
const T = () => getTrip(ui.tripId);
// Toute modification marque le voyage et part chez les compagnons (envoi groupé après 1,5 s)
const touch = (t = T()) => { if (t) { t.updatedAt = Date.now(); if (t.collab) scheduleCollab(t); } };
const commit = (opts) => { touch(); save(); refresh(opts); scheduleSync(); scheduleCollab(); };

// =====================================================================
// Calculs dérivés
// =====================================================================
const nights = (s) => (s.arrival && s.departure ? Math.max(0, diffDays(s.arrival, s.departure)) : 0);
const tripStart = (t) => t.start || t.steps.map((s) => s.arrival).filter(Boolean).sort()[0] || '';
const tripEnd = (t) => t.end || t.steps.map((s) => s.departure || s.arrival).filter(Boolean).sort().at(-1) || '';
const totalNights = (t) => t.steps.reduce((n, s) => n + nights(s), 0);

function tripStatus(t) {
  const a = tripStart(t), b = tripEnd(t), d = todayStr();
  if (!a) return { key: 'draft', label: 'À planifier' };
  if (d < a) { const n = diffDays(d, a); return { key: 'soon', label: n === 1 ? 'Demain !' : `Dans ${n} jours`, n }; }
  if (!b || d <= b) {
    const day = diffDays(a, d) + 1, tot = b ? diffDays(a, b) + 1 : null;
    return { key: 'now', label: `En cours · J${day}${tot ? '/' + tot : ''}`, day, tot };
  }
  return { key: 'past', label: 'Terminé' };
}

function currentStepIdx(t, d = todayStr()) {
  const s = t.steps;
  for (let i = 0; i < s.length; i++) if (s[i].arrival && s[i].arrival <= d && d < (s[i].departure || s[i].arrival)) return i;
  for (let i = s.length - 1; i >= 0; i--) if (s[i].arrival === d) return i;
  return -1;
}

function conv(t, amount, cur) {
  amount = +amount || 0;
  if (!cur || cur === t.currency) return amount;
  return t.rates[cur] ? amount * t.rates[cur] : amount;
}

// ---------- Monnaies locales : détectées d'après le pays de chaque étape
const curName = (c) => { try { return new Intl.DisplayNames('fr', { type: 'currency' }).of(c); } catch { return c; } };
const stepCurrency = (s) => COUNTRY_CURRENCY[s?.place?.cc] || null;
function ensureCurrency(t, cur, { quiet = false } = {}) {
  if (!cur || cur === t.currency || cur in t.rates) return;
  t.rates[cur] = null;
  save();
  svc.fetchRates(t.currency, [cur]).then((r) => {
    Object.assign(t.rates, r);
    commit({ map: false });
    if (!quiet && r[cur]) toast(`💱 ${esc(curName(cur))} ajouté · 1 ${cur} = ${r[cur].toLocaleString('fr-FR', { maximumSignificantDigits: 4 })} ${t.currency}`);
  }).catch(() => { if (!quiet) toast(`💱 ${cur} ajouté : taux à saisir dans le Budget (hors-ligne)`); });
}
// Retrouve le pays des étapes créées avant cette fonctionnalité (1 requête/seconde, règle OpenStreetMap)
async function backfillCountries(t) {
  const todo = t.steps.filter((s) => s.place && !s.place.cc).slice(0, 20);
  for (const s of todo) {
    const r = await svc.reverse(s.place.lat, s.place.lng);
    if (r.cc) s.place.cc = r.cc;
    await new Promise((res) => setTimeout(res, 1100));
  }
  if (todo.length) save();
  t.steps.forEach((s) => ensureCurrency(t, stepCurrency(s), { quiet: true }));
}

function stepCost(t, s) {
  let c = s.stays.reduce((n, x) => n + (+x.price || 0), 0) + (+s.transport.price || 0) + s.subs.reduce((n, x) => n + (+x.cost || 0), 0);
  c += t.expenses.filter((e) => e.stepId === s.id).reduce((n, e) => n + conv(t, e.amount, e.currency), 0);
  return c;
}

// ---------- Road trip : kilomètres au volant et carburant estimé
const isRoad = (t) => t.kind === 'roadtrip';
const ownLeg = (t, s) => isRoad(t) && s.transport.mode === t.vehicle;
function driveStats(t) {
  let km = 0, min = 0, exact = true;
  t.steps.forEach((s, i) => {
    if (!i || !ownLeg(t, s)) return;
    const info = legInfo(t.steps[i - 1], s);
    if (!info) return;
    // Sans itinéraire routier calculé : distance à vol d'oiseau majorée de 25 %
    km += info.exact ? info.km : info.km * 1.25;
    min += info.min || 0;
    if (!info.exact) exact = false;
  });
  const conso = +t.conso || VEHICLES[t.vehicle]?.conso || 7;
  const price = +t.fuelPrice || 1.85;
  const liters = (km * conso) / 100;
  return { km, min, exact, liters, fuel: liters * price, conso, price };
}

function tripCosts(t) {
  const cats = Object.fromEntries(Object.keys(EXP_CATS).map((k) => [k, 0]));
  let booked = 0, paid = 0, spent = 0;
  for (const s of t.steps) {
    for (const st of s.stays) { const p = +st.price || 0; cats.stay += p; booked += p; if (st.status === 'paid') paid += p; }
    const tp = +s.transport.price || 0; cats.transport += tp; booked += tp; if (s.transport.status === 'paid') paid += tp;
    for (const x of s.subs) { const c = +x.cost || 0; cats.activity += c; booked += c; }
  }
  for (const e of t.expenses) { const v = conv(t, e.amount, e.currency); cats[e.category in cats ? e.category : 'other'] += v; spent += v; }
  // Road trip : carburant estimé, diminué de ce qui a déjà été payé à la pompe
  let fuelLeft = 0, fuelEst = 0;
  if (isRoad(t)) {
    fuelEst = driveStats(t).fuel;
    fuelLeft = Math.max(0, fuelEst - cats.fuel);
    cats.fuel += fuelLeft;
  }
  return { cats, booked, paid, spent, fuelEst, fuelLeft, total: booked + spent + fuelLeft };
}

function stayForNight(t, d) {
  for (const s of t.steps) for (const st of s.stays) {
    if (st.checkIn && st.checkOut ? st.checkIn <= d && d < st.checkOut : s.arrival <= d && d < s.departure) return { stay: st, step: s };
  }
  return null;
}

function tripWarnings(t) {
  const w = [];
  const missing = [];
  for (const s of t.steps) for (let k = 0; k < nights(s); k++) {
    const d = addDays(s.arrival, k);
    if (!stayForNight(t, d)) missing.push({ d, s });
  }
  if (missing.length) {
    w.push({ icon: '🛏️', text: `${plural(missing.length, 'nuit')} sans hébergement : ${missing.slice(0, 4).map((m) => `${fmtDay(m.d)} (${esc(m.s.name || 'étape')})`).join(', ')}${missing.length > 4 ? '…' : ''}`, act: 'open-step', id: missing[0].s.id, focus: 'stays' });
  }
  const todo = t.steps.flatMap((s) => s.stays.filter((x) => x.status === 'todo').map((x) => ({ s, x })));
  if (todo.length) w.push({ icon: '⏳', text: `${plural(todo.length, 'hébergement')} encore à réserver`, act: 'open-step', id: todo[0].s.id, focus: 'stays' });
  const ttodo = t.steps.filter((s) => s.transport.status === 'todo');
  if (ttodo.length) w.push({ icon: '🎫', text: `${plural(ttodo.length, 'trajet')} encore à réserver`, act: 'open-leg', id: ttodo[0].id });
  for (let i = 1; i < t.steps.length; i++) {
    const p = t.steps[i - 1], s = t.steps[i];
    if (p.departure && s.arrival && s.arrival < p.departure) { w.push({ icon: '📅', text: `Dates qui se chevauchent entre « ${esc(p.name)} » et « ${esc(s.name)} »`, act: 'chain-dates', btn: 'Réaligner' }); break; }
    if (p.departure && s.arrival && s.arrival > p.departure) { w.push({ icon: '📅', text: `${plural(diffDays(p.departure, s.arrival), 'jour')} non planifié entre « ${esc(p.name)} » et « ${esc(s.name)} »`, act: 'chain-dates', btn: 'Réaligner' }); break; }
  }
  const noPlace = t.steps.filter((s) => !s.place).length;
  if (noPlace) w.push({ icon: '📍', text: `${plural(noPlace, 'étape')} sans lieu (invisible sur la carte)`, act: 'open-step', id: t.steps.find((s) => !s.place).id, focus: 'place' });
  const end = tripEnd(t);
  for (const d of t.documents) {
    if (d.expiry && end && d.expiry < addDays(end, d.type === 'passport' ? 180 : 0)) {
      w.push({ icon: '🛂', text: `« ${esc(d.name)} » expire le ${fmtDay(d.expiry, { day: 'numeric', month: 'long', year: 'numeric' })}${d.type === 'passport' ? ' (moins de 6 mois après le retour)' : ''}`, act: 'tab', tab: 'docs' });
    }
  }
  return w;
}

const trackKm = (pts) => pts.reduce((n, p, i) => (i ? n + haversine({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: p[0], lng: p[1] }) : 0), 0);

function legInfo(prev, s) {
  if (!prev?.place || !s.place) return null;
  const mode = MODES[s.transport.mode];
  let km = haversine(prev.place, s.place), min = null, exact = false;
  if (mode?.road) {
    const r = svc.cachedRoute(prev.place, s.place);
    if (r?.c) { km = r.km; min = r.min; exact = true; }
  }
  if (s.transport.depart && s.transport.arrive) {
    const m = (new Date(s.transport.arrive) - new Date(s.transport.depart)) / 60000;
    if (m > 0) { min = m; exact = true; }
  }
  if (min == null && mode) min = (km / mode.speed) * 60 + (mode.arc ? 120 : 0);
  return { km, min, exact };
}

// =====================================================================
// Primitives d'interface : actions, toasts, modales, panneau latéral
// =====================================================================
const A = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.act];
  if (fn) fn(el, e);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#modal-root').childElementCount) closeModal();
  else if (ui.drawer) closeDrawer();
  else if (ui.addMode) setAddMode(false);
});

function toast(msg, { undo, ms = 4500 } = {}) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span>${undo ? '<button class="toast-btn">Annuler</button>' : ''}`;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const kill = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); };
  if (undo) el.querySelector('button').onclick = () => { undo(); kill(); };
  setTimeout(kill, ms);
}

function undoable(msg, t = T()) {
  const snap = clone(t);
  return () => toast(msg, {
    undo: () => {
      const i = state.trips.findIndex((x) => x.id === snap.id);
      if (i >= 0) state.trips[i] = snap; else state.trips.push(snap);
      save();
      if (ui.drawer) renderDrawer();
      route();
    },
  });
}

function openModal(html, mount, cls = '') {
  const root = $('#modal-root');
  root.classList.remove('dark');
  root.innerHTML = `<div class="modal-backdrop" data-act="close-modal"></div><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  const m = $('.modal', root);
  mount?.(m);
  requestAnimationFrame(() => root.classList.add('open'));
  setTimeout(() => $('[autofocus]', m)?.focus(), 60);
  return m;
}
function closeModal() {
  const root = $('#modal-root');
  root.classList.remove('open', 'dark');
  root.innerHTML = '';
}
A['close-modal'] = closeModal;

function closeDrawer() {
  ui.drawer = null;
  $('#drawer-root').classList.remove('open');
  setTimeout(() => { if (!ui.drawer) $('#drawer-root').innerHTML = ''; }, 260);
  refresh({ panel: true, map: true });
}
A['close-drawer'] = closeDrawer;

// Liaison automatique champ <-> objet (sauvegarde instantanée, pas de bouton "Enregistrer")
function bindFields(scope, obj, onChange) {
  $$('[data-f]', scope).filter((el) => el.closest('[data-scope]') === scope).forEach((el) => {
    const path = el.dataset.f;
    const v = getPath(obj, path);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === (v ?? '');
    else el.value = v ?? '';
    const handler = (ev) => {
      if (el.type === 'radio' && !el.checked) return;
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') val = el.value === '' ? null : parseFloat(el.value.replace(',', '.'));
      const prev = getPath(obj, path);
      if (ev.type === 'input' && prev === val) return;
      setPath(obj, path, val);
      touch();
      save();
      if (ev.type === 'change' || el.type === 'checkbox' || el.type === 'radio') onChange?.(path, val, prev, el);
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
}

// Champ "lieu" avec recherche OpenStreetMap
function placeFieldHTML(place, label = 'Lieu', ph = 'Rechercher une ville, une adresse, un lieu…') {
  return `<div class="place-field">
    <span class="fld-l">${label}</span>
    <div class="place-cur ${place ? '' : 'hidden'}"><span class="pc-ic">${icon('pin')}</span><span class="pc-label">${esc(shortLabel(place?.label))}</span><button type="button" class="link" data-pf="change">Modifier</button></div>
    <div class="place-search ${place ? 'hidden' : ''}">
      <input type="search" placeholder="${ph}" autocomplete="off" enterkeyhint="search">
      <button type="button" class="icon-btn sm" data-pf="here" title="Utiliser ma position">◎</button>
    </div>
    <div class="place-results"></div>
  </div>`;
}

function mountPlaceFields(scope, obj, onPick) {
  $$('.place-field', scope).filter((el) => el.closest('[data-scope]') === scope).forEach((pf) => {
    const input = $('input', pf), results = $('.place-results', pf);
    const show = (on) => { $('.place-cur', pf).classList.toggle('hidden', !on); $('.place-search', pf).classList.toggle('hidden', on); };
    const pick = (p) => {
      obj.place = { lat: p.lat, lng: p.lng, label: p.label, ...(p.cc ? { cc: p.cc } : {}) };
      $('.pc-label', pf).textContent = shortLabel(p.label);
      results.innerHTML = '';
      input.value = '';
      show(true);
      touch(); save();
      onPick?.(p);
    };
    let seq = 0;
    const search = async () => {
      const q = input.value.trim();
      if (q.length < 3) { results.innerHTML = ''; return; }
      const my = ++seq;
      results.innerHTML = '<div class="pr-msg">Recherche…</div>';
      try {
        const list = await svc.geocode(q);
        if (my !== seq) return;
        results.innerHTML = list.length
          ? list.map((r, i) => `<button type="button" class="pr-item" data-i="${i}"><b>${esc(r.name)}</b><small>${esc(r.label)}</small></button>`).join('')
          : '<div class="pr-msg">Aucun résultat. Essayez « ville, pays ».</div>';
        $$('.pr-item', results).forEach((b) => (b.onclick = () => pick(list[+b.dataset.i])));
      } catch {
        results.innerHTML = '<div class="pr-msg">Recherche impossible (hors-ligne ?). Astuce : ajoutez l’étape en touchant la carte.</div>';
      }
    };
    const deb = debounce(search, 550);
    input.addEventListener('input', deb);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    $('[data-pf="change"]', pf).onclick = () => { show(false); input.focus(); };
    $('[data-pf="here"]', pf).onclick = async () => {
      results.innerHTML = '<div class="pr-msg">Localisation…</div>';
      try {
        const me = ui.me || (await getPositionOnce());
        pick(await svc.reverse(me.lat, me.lng));
      } catch (e) {
        results.innerHTML = `<div class="pr-msg">${esc(geoErr(e))}</div>`;
      }
    };
  });
}

// =====================================================================
// Routage (#/ , #/trip/<id>/<onglet>)
// =====================================================================
function route() {
  closeModal();
  const [, page, id, tab] = location.hash.slice(1).split('/');
  if (page === 'join') { renderHome(); setTimeout(() => joinModal(id), 100); return; }
  if (page === 'trip' && getTrip(id)) renderTrip(id, tab === 'today' ? 'map' : tab || 'itin');
  else renderHome();
}
addEventListener('hashchange', route);
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };

function refresh({ panel = true, map = true, header = true } = {}) {
  const t = T();
  if (!t || !$('#trip-layout')) return;
  if (header) renderTripHeader(t);
  if (panel) renderPanel();
  if (map) renderMap();
}

// =====================================================================
// Accueil
// =====================================================================
function renderHome() {
  if (ui.drawer) { ui.drawer = null; $('#drawer-root').innerHTML = ''; $('#drawer-root').classList.remove('open'); }
  if (mapView) { mapView.destroy(); mapView = null; }
  ui.tripId = null;
  document.body.classList.remove('show-map');
  document.title = 'Cap Nord';
  const groups = { now: [], soon: [], draft: [], past: [] };
  state.trips.forEach((t) => groups[tripStatus(t).key].push(t));
  groups.soon.sort((a, b) => tripStart(a).localeCompare(tripStart(b)));
  groups.past.sort((a, b) => tripStart(b).localeCompare(tripStart(a)));
  const sec = (title, list) => (list.length ? `<section class="h-group"><h2 class="h-sec">${title} <small>${list.length}</small></h2><div class="trip-list">${list.map(tripRow).join('')}</div></section>` : '');
  const all = state.trips;
  const km = all.reduce((n, t) => n + trackKm(t.track), 0);
  app.innerHTML = `
  <div class="home-wrap">
    <header class="home-top">
      <div><span class="brandmark"><svg viewBox="0 0 512 512" aria-hidden="true"><path d="M96 500 L246 290 H266 L416 500 Z" fill="currentColor"/><path d="M256 30 C264 120 280 148 330 160 C280 172 264 200 256 290 C248 200 232 172 182 160 C232 148 248 120 256 30 Z" fill="#d9a441"/></svg>Cap Nord</span><h1>Mes voyages</h1></div>
      <div class="home-btns">
        ${ui.installEvt ? '<button class="btn sm" data-act="install">Installer</button>' : ''}
        <button class="icon-btn" data-act="settings" title="Réglages" aria-label="Réglages">⚙︎</button>
        <button class="btn" data-act="join-trip">Rejoindre</button>
        <button class="btn primary" data-act="new-trip">＋ Nouveau</button>
      </div>
    </header>
    <main class="home">
      ${all.length ? `
        ${groups.now.map(featuredCard).join('')}
        ${sec('À venir', groups.soon)}${sec('À planifier', groups.draft)}${sec('Passés', groups.past)}
        <p class="home-foot">${plural(all.length, 'voyage')} · ${plural(all.reduce((n, t) => n + t.steps.length, 0), 'étape')} · ${plural(all.reduce((n, t) => n + totalNights(t), 0), 'nuit')}${km ? ' · ' + fmtKm(km) + ' parcourus' : ''}</p>`
      : `<section class="home-empty">
        <img class="empty-logo" src="icons/icon.svg" alt="" width="96" height="96">
        <h2>Votre premier voyage commence ici</h2>
        <p>Itinéraire, trajets, hébergements, budget, documents et suivi GPS en direct. Gratuit, sans compte, fonctionne hors-ligne.</p>
        <div class="row-btns wrap center-row"><button class="btn primary lg" data-act="new-trip">＋ Créer un voyage</button><button class="btn lg" data-act="join-trip">Rejoindre un voyage</button><button class="btn lg ghost" data-act="demo">Voir un exemple</button></div>
      </section>`}
    </main>
  </div>`;
}

function featuredCard(t) {
  const st = tripStatus(t), c = tripCosts(t);
  const idx = currentStepIdx(t), s = t.steps[idx];
  const pct = st.tot ? Math.min(100, (st.day / st.tot) * 100) : 0;
  return `<button class="feat-card" data-act="open-trip" data-id="${t.id}" data-tab="map" style="--c:${t.color}">
    <div class="fc-top"><span class="chip live-chip">● En cours</span><span class="fc-day">Jour ${st.day}${st.tot ? ' / ' + st.tot : ''}</span></div>
    <div class="fc-main"><span class="fc-emoji trip-badge light">${MARK}</span><div><h2>${esc(t.name)}</h2><p>${s ? `Vous êtes à <b>${esc(s.name)}</b>` : fmtRange(tripStart(t), tripEnd(t))}</p></div></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="fc-meta"><span>📍 ${t.steps.length} étapes</span><span>🌙 ${totalNights(t)} nuits</span>${c.total ? `<span>💶 ${fmtMoney(c.total, t.currency)}</span>` : ''}<span class="fc-go">Ouvrir ›</span></div>
  </button>`;
}

function tripRow(t) {
  const st = tripStatus(t), a = tripStart(t), b = tripEnd(t);
  return `<button class="trip-row" data-act="open-trip" data-id="${t.id}" style="--c:${t.color}">
    <span class="tr-emoji trip-badge" style="--c:${t.color}">${MARK}</span>
    <span class="tr-main"><b>${esc(t.name)}</b><small>${isRoad(t) ? `${VEHICLES[t.vehicle].icon} Road trip · ` : ''}${a ? fmtRange(a, b) : 'Dates à définir'} · ${plural(t.steps.length, 'étape')}</small></span>
    <span class="chip st-${st.key}">${st.label}</span>
    <span class="tr-chev">›</span>
  </button>`;
}

A['open-trip'] = (el) => go(`#/trip/${el.dataset.id}/${el.dataset.tab || 'itin'}`);
A.home = () => go('#/');
A.install = async () => { ui.installEvt?.prompt(); ui.installEvt = null; renderHome(); };

A['new-trip'] = () => openModal(`
  <h2>Nouveau voyage</h2>
  <form class="form" id="f-new">
    <div class="row"><input type="hidden" name="emoji" value=""><input name="name" placeholder="Nom du voyage (ex : Road trip Portugal)" required autofocus></div>
    <div class="kind-pick" role="radiogroup" aria-label="Type de voyage">
      <label class="kind"><input type="radio" name="kind" value="roadtrip"><span><b>🚗 Road trip</b><small>Avec mon véhicule : voiture, van, moto</small></span></label>
      <label class="kind"><input type="radio" name="kind" value="mixed" checked><span><b>✈️ Voyage multi-transports</b><small>Avion, train, bus, bateau… entre les étapes</small></span></label>
    </div>
    <div class="road-opts hidden">
      <div class="pills">${Object.entries(VEHICLES).map(([k, v], i) => `<label class="pill"><input type="radio" name="vehicle" value="${k}" ${i === 0 ? 'checked' : ''}><span>${v.icon} ${v.label}</span></label>`).join('')}</div>
      <div class="grid2">
        <label class="fld"><span>Consommation (L/100 km)</span><input type="number" name="conso" step="0.1" min="0" inputmode="decimal" placeholder="6.5"></label>
        <label class="fld"><span>Prix du carburant (/L)</span><input type="number" name="fuelPrice" step="0.01" min="0" inputmode="decimal" placeholder="1.85"></label>
      </div>
    </div>
    <div class="grid2">
      <label class="fld"><span>Début (facultatif)</span><input type="date" name="start"></label>
      <label class="fld"><span>Fin (facultatif)</span><input type="date" name="end"></label>
    </div>
    <div class="grid3">
      <label class="fld"><span>Devise</span><select name="currency">${CURRENCIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label class="fld"><span>Budget total</span><input type="number" name="budget" min="0" step="any" inputmode="decimal"></label>
      <label class="fld"><span>Voyageurs</span><input type="number" name="travelers" value="1" min="1" inputmode="numeric"></label>
    </div>
    <div class="colors">${COLORS.map((c, i) => `<label class="color"><input type="radio" name="color" value="${c}" ${i === 0 ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
    <div class="actions"><button type="button" class="btn" data-act="close-modal">Annuler</button><button class="btn primary">Créer le voyage</button></div>
  </form>`, (m) => {
  const syncRoad = () => {
    const road = $('[name=kind]:checked', m).value === 'roadtrip';
    $('.road-opts', m).classList.toggle('hidden', !road);
    const v = VEHICLES[$('[name=vehicle]:checked', m).value];
    $('[name=conso]', m).placeholder = v.conso;
  };
  $$('[name=kind], [name=vehicle]', m).forEach((r) => (r.onchange = syncRoad));
  $('form', m).onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const road = f.kind === 'roadtrip';
    const t = newTrip({ name: f.name.trim() || 'Nouveau voyage', emoji: f.emoji === '🌍' && road ? VEHICLES[f.vehicle].icon : f.emoji || '🌍', start: f.start, end: f.end, currency: f.currency, budget: f.budget ? +f.budget : null, travelers: +f.travelers || 1, color: f.color,
      kind: f.kind, vehicle: f.vehicle || 'car', conso: f.conso ? +f.conso : null, fuelPrice: f.fuelPrice ? +f.fuelPrice : null });
    if (road) t.checklists.push({ id: uid(), name: 'Road trip', collapsed: false, items: (templates()['Road trip'] || LIST_TEMPLATES['Road trip']).map((text) => ({ id: uid(), text, done: false, note: '', due: '', subs: [] })) });
    state.trips.push(t);
    save();
    closeModal();
    go(`#/trip/${t.id}/itin`);
  };
});

// =====================================================================
// Écran voyage : coquille + onglets
// =====================================================================
const TABS = [
  ['budget', '💶', 'Budget'], ['itin', '🧭', 'Étapes'], ['map', '🗺️', 'Carte'], ['lists', '✅', 'Listes'], ['docs', '🗂️', 'Docs'],
];

function renderTrip(id, tab) {
  const t = getTrip(id);
  if (ui.tripId !== id || !$('#trip-layout')) buildTripShell(t);
  ui.tab = tab;
  $$('[data-act="tab"]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.body.classList.toggle('show-map', tab === 'map');
  renderTripHeader(t);
  renderPanel();
  renderMap();
  if (tab === 'map') { mapView.invalidate(); if (!ui.mapFitted) { ui.mapFitted = true; setTimeout(fitTrip, 80); } }
}

function buildTripShell(t) {
  if (mapView) { mapView.destroy(); mapView = null; }
  ui.tripId = t.id;
  ui.day = null;
  ui.mapFitted = false;
  ui.open.clear();
  app.innerHTML = `
  <div class="trip-layout" id="trip-layout">
    <header class="trip-top" id="trip-top"></header>
    <section class="panel">
      <div class="panel-body" id="panel"></div>
    </section>
    <section class="mapwrap" id="mapwrap">
      <div id="map"></div>
      <div class="map-ctl">
        <button class="mbtn" data-act="locate" title="Ma position">◎</button>
        <button class="mbtn" data-act="fit" title="Voir tout le voyage">⤢</button>
        <button class="mbtn" data-act="layers" title="Fond de carte">▦</button>
        <button class="mbtn" data-act="add-mode" id="btn-add-mode" title="Nouvelle étape">＋</button>
      </div>
      <div class="map-banner hidden" id="map-banner"></div>
      <div class="rec-pill hidden" id="rec-pill" data-act="toggle-rec" title="Arrêter l’enregistrement">● Trajet enregistré</div>
      <div class="map-progress hidden" id="map-progress"></div>
    </section>
    <nav class="bottomnav">${TABS.map(([k, i, l]) => `<button class="bn" data-act="tab" data-tab="${k}"><span>${i}</span>${l}</button>`).join('')}</nav>
  </div>`;
  mapView = new MapView($('#map'), {
    onStepClick: (sid, focus) => openStepDrawer(sid, focus),
    onLegClick: (sid) => openLegDrawer(sid),
    onPhotoClick: (pid) => viewPhoto(pid),
    thumbUrl: (id, onReady) => {
      if (thumbCache.has(id)) return thumbCache.get(id);
      getFile(id).then((b) => { if (b) { thumbCache.set(id, URL.createObjectURL(b)); onReady?.(); } }).catch(() => {});
      return '';
    },
    onMapClick: (latlng) => ui.addMode && addStepAt(latlng),
    onUserPan: () => { if (ui.follow) { ui.follow = false; updateRecUI(); } },
  });
  applyBasemap();
  renderMap();
  fitTrip();
  if (ui.me) mapView.setMe(ui.me);
  // Reprise automatique du suivi si l'app a été fermée pendant un enregistrement
  if (state.settings.recordingTripId === t.id && !ui.recording) startRecording(true);
  backfillCountries(t);
  if (t.collab) { collab.registerFiles(t); collabSync(t); collab.watchCollab(t, () => collabSync(t)); }
  if (isShared(t)) { pullFeedback(t); if (t.share.dirty || t.photos.some((p) => !p.remote)) scheduleSync(t, 3000); }
  updateRecUI();
}

function renderTripHeader(t) {
  const el = $('#trip-top');
  if (!el) return;
  const st = tripStatus(t);
  document.title = `${t.name} · Cap Nord`;
  $('#trip-layout').style.setProperty('--trip', t.color);
  el.innerHTML = `
    <div class="trip-title" data-act="trip-settings" title="Options du voyage">
      <span class="trip-badge" style="--c:${t.color}">${MARK}</span>
      <div><h1>${esc(t.name)}</h1><small>${t.collab ? `<span class="with">avec ${esc((t.collab.members || []).filter((m) => !m.me).map((m) => m.name).join(', ') || 'vos compagnons')}</span> · ` : ''}${tripStart(t) ? fmtRange(tripStart(t), tripEnd(t)) + ' · ' : ''}<span class="st-${st.key}">${st.label}</span></small></div>
    </div>
    <button class="icon-btn share-btn ${isShared(t) ? 'on' : ''}" data-act="share" aria-label="Partager le voyage" title="Partager avec vos proches">📤${newComments(t) ? `<i class="nb">${newComments(t)}</i>` : ''}</button>
    <button class="icon-btn" data-act="trip-settings" aria-label="Options du voyage">⋯</button>
    <button class="btn sm my-trips" data-act="home"><span class="mt-ic">🧳</span><span>Mes voyages</span></button>`;
}

A.tab = (el) => go(`#/trip/${ui.tripId}/${el.dataset.tab}`);

function renderPanel() {
  const t = T(), p = $('#panel');
  if (!t || !p) return;
  const tab = ['itin', 'budget', 'lists', 'docs'].includes(ui.tab) ? ui.tab : 'itin';
  const changed = ui.panelTab !== tab;
  const top = changed ? 0 : p.scrollTop;
  ui.panelTab = tab;
  p.innerHTML = { itin: renderItin, budget: renderBudget, lists: renderLists, docs: renderDocs }[tab](t);
  ({ itin: mountItin, budget: null, lists: mountLists, docs: mountDocs })[tab]?.(t, p);
  if (changed) p.firstElementChild?.classList.add('fresh');
  loadThumbs(p);
  p.scrollTop = top;
}

function renderMap() {
  const t = T();
  if (!mapView || !t) return;
  mapView.render(t, { selectedId: ui.drawer?.type === 'step' ? ui.drawer.id : null, selectedLegId: ui.drawer?.type === 'leg' ? ui.drawer.id : null, states: stepStates(t), routing: state.settings.routing });
  renderMapProgress(t);
}


// État de chaque étape selon la date du jour : faite, en cours, à venir
function stepStates(t, d = todayStr()) {
  const cur = currentStepIdx(t, d);
  return t.steps.map((s, i) => {
    if (i === cur) return 'now';
    const end = s.departure || s.arrival;
    if ((end && end < d) || (cur >= 0 && i < cur)) return 'done';
    return 'todo';
  });
}

function renderMapProgress(t) {
  const el = $('#map-progress');
  if (!el) return;
  const st = tripStatus(t), states = stepStates(t);
  const done = states.filter((x) => x === 'done').length, n = t.steps.length;
  const idx = states.indexOf('now'), cur = t.steps[idx];
  const next = t.steps[idx >= 0 ? idx + 1 : states.indexOf('todo')];
  if (!n || st.key === 'draft') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('collapsed', !!ui.mpCollapsed);
  const pct = n ? ((done + (cur ? 0.5 : 0)) / n) * 100 : 0;
  let head, body = '';
  if (st.key === 'soon') { head = `<b>Départ ${st.n === 1 ? 'demain' : `dans ${st.n} jours`}</b><small>${fmtDayLong(tripStart(t))}</small>`; }
  else if (st.key === 'past') { head = '<b>Voyage terminé 🏁</b>'; body = `<p>${plural(n, 'étape')} · ${plural(totalNights(t), 'nuit')}${t.track.length ? ' · ' + fmtKm(trackKm(t.track)) + ' enregistrés' : ''}</p>`; }
  else { head = `<b>Jour ${st.day}${st.tot ? ' / ' + st.tot : ''}</b><small>${fmtDayLong(todayStr())}</small>`; }
  if (st.key === 'now') {
    const night = stayForNight(t, todayStr());
    body = `${cur ? `<button class="mp-row" data-act="open-step" data-id="${cur.id}"><span class="mp-dot now"></span><span><small>Vous êtes à</small><b>${esc(cur.name)}</b>${night ? `<small>🛏️ ${esc(night.stay.name || 'Hébergement')}</small>` : ''}</span><i>›</i></button>` : ''}
      ${next ? `<button class="mp-row" data-act="open-step" data-id="${next.id}"><span class="mp-dot"></span><span><small>Ensuite${next.arrival ? ' · ' + fmtWeekday(next.arrival) : ''}</small><b>${esc(next.name)}</b></span><i>›</i></button>` : ''}`;
  } else if (st.key === 'soon' && t.steps[0]) {
    body = `<button class="mp-row" data-act="open-step" data-id="${t.steps[0].id}"><span class="mp-dot"></span><span><small>Première étape</small><b>${esc(t.steps[0].name)}</b></span><i>›</i></button>`;
  }
  el.innerHTML = `
    <div class="mp-head" data-act="mp-toggle" title="Réduire / agrandir">${head}<span class="mp-count">${done}/${n} étapes faites</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${body}
    <div class="mp-legend"><span><i class="lgd done"></i>Fait</span><span><i class="lgd now"></i>Aujourd’hui</span><span><i class="lgd todo"></i>À venir</span></div>`;
}

function applyBasemap() {
  if (!mapView) return;
  let k = state.settings.basemap;
  if (k === 'auto' || !BASEMAPS[k]) k = isDark() ? 'dark' : 'osm';
  mapView.setBase(k);
}

// =====================================================================
// Onglet Étapes (itinéraire)
// =====================================================================
function renderItin(t) {
  const w = tripWarnings(t);
  const km = t.steps.reduce((n, s, i) => n + (legInfo(t.steps[i - 1], s)?.km || 0), 0);
  const cur = currentStepIdx(t);
  const today = todayStr();
  return `
  <div class="itin">
    ${isRoad(t) ? (() => { const d = driveStats(t); return `<div class="road-banner"><span class="rb-ic">${VEHICLES[t.vehicle].icon}</span>
      <div><b>${d.km ? fmtKm(d.km) : '— km'}${d.min ? ` · ${fmtDuration(d.min)} de route` : ''}</b><small>${d.exact ? '' : '~'}${Math.round(d.liters)} L de carburant ≈ ${fmtMoney(d.fuel, t.currency)} · ${d.conso} L/100 km</small></div></div>`; })() : ''}
    <div class="stats">
      <div><b>${t.steps.length}</b><span>étapes</span></div>
      <div><b>${totalNights(t)}</b><span>nuits</span></div>
      ${isRoad(t) ? '' : `<div><b>${km ? fmtKm(km) : '—'}</b><span>distance</span></div>`}
      <div><b>${fmtMoney(tripCosts(t).total, t.currency)}</b><span>coût</span></div>
    </div>
    ${w.length ? `<div class="warns">${w.map((x) => `<button class="warn" data-act="${x.act}" data-id="${x.id || ''}" data-focus="${x.focus || ''}" data-tab="${x.tab || ''}"><span>${x.icon}</span><span>${x.text}</span>${x.btn ? `<b>${x.btn}</b>` : '<b>›</b>'}</button>`).join('')}</div>` : ''}
    <div class="steps" id="steps">
      ${t.steps.map((s, i) => `${i ? connectorHTML(t, i) : ''}${stepCardHTML(t, s, i, cur, today)}`).join('')}
    </div>
    ${t.steps.length ? '' : `<div class="empty">
      <div class="empty-ic">🗺️</div>
      <h3>Construisez votre itinéraire</h3>
      <p>Ajoutez votre première étape en recherchant une ville, ou touchez <b>＋</b> sur la carte pour la placer directement.</p>
    </div>`}
    <button class="add-step" data-act="add-step">＋ Ajouter une étape</button>
    ${t.steps.length > 1 ? '<p class="hint center">Maintenez ⋮⋮ pour réorganiser · ＋ entre deux étapes pour en insérer une</p>' : ''}
  </div>`;
}

function stepCardHTML(t, s, i, cur, today) {
  const n = nights(s);
  const status = cur === i ? 'now' : (s.departure && s.departure < today) || (cur > i) ? 'past' : '';
  const staysOk = s.stays.filter((x) => x.status !== 'todo');
  const done = s.subs.filter((x) => x.done).length;
  const cost = stepCost(t, s);
  const chips = [];
  if (s.stays.length) chips.push(`<button class="chip ${staysOk.length === s.stays.length ? 'ok' : 'warn'}" data-act="open-step" data-id="${s.id}" data-focus="stays">🛏️ ${esc(s.stays[0].name || 'Hébergement')}${s.stays.length > 1 ? ' +' + (s.stays.length - 1) : ''}</button>`);
  else if (n) chips.push(`<button class="chip warn" data-act="open-step" data-id="${s.id}" data-focus="stays">🛏️ Nuit à trouver</button>`);
  if (s.subs.length) chips.push(`<button class="chip" data-act="open-step" data-id="${s.id}" data-focus="subs">📌 ${done}/${s.subs.length}</button>`);
  if (s.notes) chips.push(`<button class="chip" data-act="open-step" data-id="${s.id}" data-focus="notes" aria-label="Notes">📝</button>`);
  const nph = stepPhotos(t, s).length;
  if (nph) chips.push(`<button class="chip" data-act="open-step" data-id="${s.id}" data-focus="photos">📸 ${nph}</button>`);
  if (cost) chips.push(`<span class="chip">💶 ${fmtMoney(cost, t.currency)}</span>`);
  return `<article class="step ${status} ${ui.drawer?.type === 'step' && ui.drawer.id === s.id ? 'sel' : ''}" data-id="${s.id}">
    <div class="step-rail"><span class="num">${status === 'past' ? '✓' : i + 1}</span></div>
    <div class="step-main" data-act="open-step" data-id="${s.id}" tabindex="0">
      <div class="step-top">
        <h3>${esc(s.name || 'Étape sans nom')}</h3>
        ${status === 'now' ? '<span class="now-badge">Vous êtes ici</span>' : ''}
      </div>
      <div class="step-dates">${s.arrival ? `${fmtWeekday(s.arrival)}${n ? ' → ' + fmtWeekday(s.departure) : ''} · ${n ? plural(n, 'nuit') : 'de passage'}` : '<span class="muted">Dates à définir</span>'}${s.place ? '' : ' · <span class="muted">lieu à définir</span>'}</div>
      ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
      ${photoStripHTML(t, s)}
    </div>
    <span class="drag" title="Glisser pour déplacer" aria-label="Déplacer">⋮⋮</span>
  </article>`;
}

function connectorHTML(t, i) {
  const s = t.steps[i], prev = t.steps[i - 1], tr = s.transport, mode = MODES[tr.mode];
  const info = legInfo(prev, s);
  const bits = [];
  if (tr.depart) bits.push(fmtDateTime(tr.depart));
  if (info) bits.push(fmtKm(info.km));
  if (info?.min) bits.push((info.exact ? '' : '~') + fmtDuration(info.min));
  const st = tr.status ? `<span class="badge ${BOOK_STATUS[tr.status].cls}">${BOOK_STATUS[tr.status].label}</span>` : '';
  return `<div class="conn" style="--mc:${mode?.color || 'var(--line)'}">
    <span class="conn-line"></span>
    <button class="conn-label ${ui.drawer?.type === 'leg' && ui.drawer.id === s.id ? 'sel' : ''}" data-act="open-leg" data-id="${s.id}">${mode ? `${icon(s.transport.mode)} ${mode.label}` : '＋ Transport'}${bits.length ? ` <small>${bits.join(' · ')}</small>` : ''}${st}</button>
    <button class="conn-add" data-act="add-step" data-index="${i}" title="Insérer une étape ici">＋</button>
  </div>`;
}

function mountItin(t, p) {
  const list = $('#steps', p);
  if (list && t.steps.length > 1 && window.Sortable) {
    Sortable.create(list, {
      handle: '.drag', draggable: '.step', animation: 160, ghostClass: 'ghost',
      onStart: () => list.classList.add('sorting'),
      onEnd: () => {
        list.classList.remove('sorting');
        const order = $$('.step', list).map((el) => el.dataset.id);
        const before = t.steps.map((s) => s.id).join();
        if (order.join() === before) return refresh({ map: false, header: false });
        const notify = undoable('Étapes réorganisées');
        t.steps.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        commit();
        notify();
      },
    });
  }
  $$('.step-main', p).forEach((el) => el.addEventListener('keydown', (e) => e.key === 'Enter' && openStepDrawer(el.dataset.id)));
}

A['open-step'] = (el) => openStepDrawer(el.dataset.id, el.dataset.focus || null);
A['add-step'] = (el) => newStepModal(el.dataset.index != null ? +el.dataset.index : undefined);

function newStepModal(index) {
  const t = T();
  if (ui.addMode) setAddMode(false);
  const first = !t.steps.length;
  const tmp = { place: null };
  openModal(`
    <h2>${first ? '🚩 Point de départ' : '📍 Nouvelle étape'}</h2>
    <div class="form" data-scope id="ns-form">
      ${placeFieldHTML(null, first ? 'D’où partez-vous ?' : 'Où allez-vous ?')}
      <div class="ns-quick">
        <button type="button" class="btn" data-act="ns-here">◎ Ma position actuelle</button>
        <button type="button" class="btn" data-act="ns-map">🗺️ Toucher la carte</button>
      </div>
      ${first ? '<p class="hint">Ce sera le point de départ de votre itinéraire. Vous ajouterez ensuite les étapes suivantes.</p>'
        : `<label class="fld"><span>Placer après</span><select id="ns-after">${t.steps.map((x, i) => `<option value="${i + 1}" ${(index ?? t.steps.length) === i + 1 ? 'selected' : ''}>${i + 1}. ${esc(x.name || 'Étape')}</option>`).join('')}</select></label>`}
    </div>
    <div class="actions"><button class="btn" data-act="close-modal">Annuler</button></div>`, (m) => {
    ui.nsIndex = index;
    const create = (p) => {
      const at = $('#ns-after', m) ? +$('#ns-after', m).value : t.steps.length;
      closeModal();
      const st = addStep(at, p);
      ensureCurrency(T(), stepCurrency(st));
    };
    mountPlaceFields($('#ns-form', m), tmp, (p) => create(p));
    $('[data-act="ns-here"]', m).onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Localisation…';
      try {
        const me = ui.me || (await getPositionOnce());
        create(await svc.reverse(me.lat, me.lng));
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = '◎ Ma position actuelle';
        toast(esc(geoErr(err)));
      }
    };
    $('[data-act="ns-map"]', m).onclick = () => {
      ui.nsIndex = $('#ns-after', m) ? +$('#ns-after', m).value : undefined;
      closeModal();
      if (isMobile() && ui.tab !== 'map') go(`#/trip/${ui.tripId}/map`);
      setTimeout(() => setAddMode(true), 150);
    };
  });
}

function addStep(index, place = null) {
  const t = T();
  const idx = index ?? t.steps.length;
  const prev = t.steps[idx - 1];
  const arrival = prev ? prev.departure || prev.arrival : t.start || '';
  const s = newStep({ arrival, departure: arrival ? addDays(arrival, 1) : '', place: place ? { lat: place.lat, lng: place.lng, label: place.label } : null, name: place?.name || '' });
  if (isRoad(t)) s.transport.mode = t.vehicle;
  else if (prev && idx > 0) s.transport.mode = prev.transport.mode || '';
  t.steps.splice(idx, 0, s);
  commit();
  openStepDrawer(s.id, place ? null : 'place');
  return s;
}

async function addStepAt(latlng) {
  setAddMode(false);
  const p = await svc.reverse(latlng.lat, latlng.lng);
  const s = addStep(ui.nsIndex, p);
  ui.nsIndex = undefined;
  toast(`Étape « ${esc(p.name)} » ajoutée`);
  ensureCurrency(T(), stepCurrency(s));
}

function setAddMode(on) {
  ui.addMode = on;
  $('#btn-add-mode')?.classList.toggle('on', on);
  $('#map')?.classList.toggle('adding', on);
  const b = $('#map-banner');
  if (b) { b.classList.toggle('hidden', !on); b.innerHTML = on ? 'Touchez la carte à l’endroit de la nouvelle étape <button class="link" data-act="add-mode">Annuler</button>' : ''; }
}
A['add-mode'] = () => (ui.addMode ? setAddMode(false) : newStepModal());

function shiftStep(s, d) {
  if (!d) return;
  if (s.arrival) s.arrival = addDays(s.arrival, d);
  if (s.departure) s.departure = addDays(s.departure, d);
  s.transport.depart = shiftDateTime(s.transport.depart, d);
  s.transport.arrive = shiftDateTime(s.transport.arrive, d);
  s.stays.forEach((x) => { if (x.checkIn) x.checkIn = addDays(x.checkIn, d); if (x.checkOut) x.checkOut = addDays(x.checkOut, d); });
  s.subs.forEach((x) => { if (x.date) x.date = addDays(x.date, d); });
}
const shiftFollowing = (t, s, d) => t.steps.slice(t.steps.indexOf(s) + 1).forEach((x) => shiftStep(x, d));

A['chain-dates'] = () => {
  const t = T();
  const notify = undoable('Dates réalignées : chaque étape commence quand la précédente se termine');
  for (let i = 1; i < t.steps.length; i++) {
    const p = t.steps[i - 1], s = t.steps[i];
    const start = p.departure || p.arrival;
    if (!start) continue;
    if (s.arrival) shiftStep(s, diffDays(s.arrival, start));
    else { s.arrival = start; s.departure = addDays(start, 1); }
  }
  commit();
  if (ui.drawer) renderDrawer();
  notify();
};

// =====================================================================
// Panneau d'édition d'une étape
// =====================================================================
function openStepDrawer(id, focus = null) {
  if (focus === 'transport') return openLegDrawer(id);
  const t = T();
  if (!t.steps.find((s) => s.id === id)) return;
  if (ui.addMode) setAddMode(false);
  if (focus?.startsWith('stay:') || focus?.startsWith('sub:')) ui.open.add(focus.split(':')[1]);
  const tabFor = { place: 'place', stays: 'stays', stay: 'stays', sub: 'subs', subs: 'subs', photos: 'photos', notes: 'notes' };
  if (focus) ui.dtab = tabFor[focus.split(':')[0]] || ui.dtab;
  const st0 = t.steps.find((x) => x.id === id);
  const days0 = stepDays(st0);
  if (days0.length && st0.subs.some((x) => !x.date)) { st0.subs.forEach((x) => { if (!x.date) x.date = days0[0]; }); touch(t); save(); }
  if (ui.drawer?.id !== id || ui.drawer?.type !== 'step') ui.dday = days0.includes(todayStr()) ? todayStr() : days0[0] || 'all';
  if (ui.dday === 'all' && days0.length) ui.dday = days0.includes(todayStr()) ? todayStr() : days0[0];
  // Raccourcis : « nuit à trouver » ouvre la Nuit, le lieu ouvre l'onglet Lieu
  if (days0.length && (focus === 'stays' || focus?.startsWith('stay:'))) ui.dtab = 'night';
  ui.drawer = { type: 'step', id };
  renderDrawer(true);
  refresh({ header: false });
  const s = t.steps.find((x) => x.id === id);
  if (s.place && mapView && !isMobile()) mapView.focus(s.place, 9);
  const body = $('#drawer-body');
  requestAnimationFrame(() => {
    if (focus === 'place') $('.place-search:not(.hidden) input', body)?.focus();
    else if (focus?.includes(':')) $(`[data-id="${focus.split(':')[1]}"]`, body)?.scrollIntoView({ block: 'center' });
  });
}

function renderDrawer(reset = false) {
  const t = T();
  if (!ui.drawer || !t) return;
  const root = $('#drawer-root');
  const s = t.steps.find((x) => x.id === ui.drawer.id);
  if (!s) return closeDrawer();
  const prevBody = $('#drawer-body');
  const top = reset ? 0 : prevBody?.scrollTop || 0;
  const active = document.activeElement?.closest('#drawer-root') ? document.activeElement.dataset.keep : null;
  const leg = ui.drawer.type === 'leg';
  const lm = MODES[s.transport.mode];
  root.innerHTML = `<div class="drawer-backdrop" data-act="close-drawer"></div><aside class="drawer ${leg ? 'leg' : 'dest'}" style="--c:${t.color};--mc:${lm?.color || '#64748b'}">${leg ? legDrawerHTML(t, s) : stepDrawerHTML(t, s)}
    <div class="drawer-foot"><button class="btn primary lg full" data-act="drawer-save">✓ Enregistrer</button></div></aside>`;
  root.classList.add('open');
  leg ? mountLegDrawer(t, s, root) : mountStepDrawer(t, s, root);
  $('#drawer-body').scrollTop = top;
  if (reset) { $('#drawer-body').classList.add('fresh'); $('.drawer-head', root)?.classList.add('fresh'); }
  loadThumbs(root);
  if (active) $(`[data-keep="${active}"]`, root)?.focus();
}

function stepDrawerHTML(t, s) {
  const i = t.steps.indexOf(s), prev = t.steps[i - 1], next = t.steps[i + 1];
  const n = nights(s), tr = s.transport;
  const done = s.subs.filter((x) => x.done).length;
  const info = legInfo(prev, s);
  const days = stepDays(s);
  if (ui.dday !== 'all' && !days.includes(ui.dday)) ui.dday = days[0] || 'all';
  const D = ui.dday;
  const dayMode = D !== 'all';
  const okTabs = dayMode ? ['subs', 'photos', 'night', 'notes', 'place'] : ['place', 'stays', 'subs', 'photos', 'notes'];
  if (!okTabs.includes(ui.dtab)) ui.dtab = dayMode ? 'subs' : 'place';
  const pane = (k) => (ui.dtab === k ? '' : 'hidden');
  const cover = t.photos.find((p) => p.id === s.coverId) || stepPhotos(t, s).at(-1);
  const daySubs = dayMode ? s.subs.filter((x) => x.date === D) : s.subs;
  const dayPh = dayMode ? stepPhotos(t, s).filter((p) => photoDay(p) === D) : stepPhotos(t, s);
  const nightStays = dayMode ? s.stays.filter((st) => (st.checkIn && st.checkOut ? st.checkIn <= D && D < st.checkOut : true)) : s.stays;
  const tabs = dayMode
    ? [['subs', icon('list'), 'Activités', daySubs.length ? `${daySubs.filter((x) => x.done).length}/${daySubs.length}` : ''], ['photos', icon('camera'), 'Photos', dayPh.length || ''],
      ['night', icon('bed'), 'Nuit', nightStays.length ? '✓' : (n ? '!' : '')], ['notes', icon('note'), 'Notes', s.dayNotes?.[D] ? '•' : ''], ['place', icon('pin'), 'Lieu', '']]
    : [['place', icon('pin'), 'Lieu', ''], ['stays', icon('bed'), 'Hébergement', s.stays.length || (n ? '!' : '')],
      ['subs', icon('list'), 'Activités', s.subs.length ? `${done}/${s.subs.length}` : ''], ['photos', icon('camera'), 'Photos', stepPhotos(t, s).length || ''], ['notes', icon('note'), 'Notes', s.notes ? '•' : '']];
  const today = todayStr();
  return `
  <div class="drawer-head dest-head ${cover ? 'has-cover' : ''}" data-scope>
    ${cover ? `<img class="dh-cover" data-thumb="${cover.thumbId}" alt="">` : ''}
    <button class="icon-btn dh-close" data-act="close-drawer" aria-label="Fermer">✕</button>
    <div class="dh-title"><span class="pin" aria-hidden="true"><i class="pin-wave"></i><i class="pin-wave w2"></i><svg class="pin-svg" viewBox="0 0 48 60"><path class="pin-body" d="M24 2C12.4 2 3 11.2 3 22.6 3 37.4 24 58 24 58s21-20.6 21-35.4C45 11.2 35.6 2 24 2Z"/><circle class="pin-dot" cx="24" cy="22.5" r="8"/></svg></span><input class="title-input" data-f="name" placeholder="Nom de l’étape" autocomplete="off" aria-label="Nom de l’étape"></div>
    <p class="dh-sub">${s.arrival ? (n ? `Du ${fmtDay(s.arrival, { day: 'numeric', month: 'long' })} au ${fmtDay(s.departure, { day: 'numeric', month: 'long' })}` : fmtDayLong(s.arrival)) : 'Dates à définir'} · ${n ? plural(n, 'nuit') : 'de passage'} · étape ${i + 1} sur ${t.steps.length}</p>
  </div>
  ${days.length ? `<div class="dayline" role="tablist" aria-label="Jours de l’étape">
    ${days.map((d, k) => `<button class="dl-day ${D === d ? 'on' : ''} ${d === today ? 'today' : ''}" data-act="dday" data-d="${d}" role="tab" ${d === today ? 'aria-label="Aujourd’hui"' : ''}><small>Jour ${k + 1}</small><b>${fmtDay(d, { day: 'numeric' })}</b><small>${fmtDay(d, { weekday: 'short' })}</small></button>`).join('')}
  </div>` : ''}
  <div class="drawer-nav">
    ${prev ? `<button class="btn sm" data-act="open-leg" data-id="${s.id}">‹ Trajet depuis ${esc(prev.name)}</button>` : '<button class="btn sm" disabled>‹ Départ</button>'}
    ${s.place ? `<button class="btn sm" data-act="focus-step" data-id="${s.id}">${icon('map')} Carte</button>` : ''}
    ${next ? `<button class="btn sm" data-act="open-leg" data-id="${next.id}">Trajet vers ${esc(next.name)} ›</button>` : '<button class="btn sm" disabled>Arrivée ›</button>'}
  </div>
  <nav class="dtabs" role="tablist">
    ${tabs
      .map(([k, ic, l, b]) => `<button class="dtab ${ui.dtab === k ? 'active' : ''}" data-act="dtab" data-k="${k}" role="tab" aria-selected="${ui.dtab === k}"><span class="dt-ic">${ic}</span><span class="dt-l">${l}</span>${b !== '' ? `<i class="dt-b ${b === '!' ? 'warn' : ''}">${b}</i>` : ''}</button>`).join('')}
  </nav>
  <div class="drawer-body" id="drawer-body" data-scope>
    <section class="sec ${pane('place')}">
      ${placeFieldHTML(s.place)}
      <div class="grid2">
        <label class="fld"><span>Arrivée</span><input type="date" data-f="arrival"></label>
        <label class="fld"><span>Départ</span><input type="date" data-f="departure"></label>
      </div>
      <div class="nights">
        <span>${n ? plural(n, 'nuit') : 'De passage'}</span>
        <div class="stepper"><button data-act="nights" data-d="-1" aria-label="Une nuit de moins">−</button><button data-act="nights" data-d="1" aria-label="Une nuit de plus">＋</button></div>
        <label class="check"><input type="checkbox" id="shift-next" ${ui.shiftNext ? 'checked' : ''}> Décaler les étapes suivantes</label>
      </div>
    </section>
    ${s.place ? `<section class="sec ${pane('place')}">
      <h4>Météo</h4>
      <div id="weather" class="weather"><div class="wx-msg">Chargement…</div></div>
    </section>
    <section class="sec ${pane('place')}">
      <h4>Actualité & conseils</h4>
      <div id="news" class="news"><div class="wx-msg">Recherche des dernières nouvelles…</div></div>
      <div class="row-btns wrap">
        ${s.place.cc ? `<a class="btn sm" href="${diploUrl(s.place.cc)}" target="_blank" rel="noopener">Conseils aux voyageurs (France Diplomatie)</a>` : ''}
        <a class="btn sm" href="https://news.google.com/search?q=${encodeURIComponent(s.name || shortLabel(s.place.label))}&hl=fr&gl=FR&ceid=FR:fr" target="_blank" rel="noopener">Plus d’actualités</a>
      </div>
    </section>
    <section class="sec ${pane('place')}">
      <h4>Astuces des voyageurs <small>partagées avec tous</small></h4>
      <div id="tips" class="tips"></div>
    </section>` : ''}
    ${dayMode ? `<section class="sec ${pane('place')}"><h4>Notes générales de l’étape</h4><textarea data-f="notes" rows="4" placeholder="Infos valables pour tout le séjour : codes, contacts, idées…"></textarea></section>` : ''}
    <div class="${pane('place')} del-step-row"><button class="link danger-link" data-act="del-step">Supprimer cette étape</button></div>


    <section class="sec ${pane('stays')}" id="sec-stays">
      <h4>Hébergement${n ? ` <small>${plural(n, 'nuit')}</small>` : ''}</h4>
      ${s.stays.map((st) => stayHTML(t, s, st)).join('')}
      <button class="btn ghost full" data-act="add-stay">＋ Ajouter un hébergement</button>
    </section>

    <section class="sec ${pane('subs')}">
      ${dayMode ? '' : `<h4>Activités ${s.subs.length ? `<small>${done}/${s.subs.length} faites</small>` : ''}</h4>`}
      ${dayMode ? subsOfDayHTML(t, s, D) : subsByDayHTML(t, s)}
    </section>

    <section class="sec ${pane('photos')}">
      ${photosPaneHTML(t, s, false, dayMode ? D : null)}
    </section>

    ${dayMode ? `<section class="sec ${pane('night')}">
      <h4>Nuit du ${fmtDayLong(D)}</h4>
      ${nightStays.map((st) => stayHTML(t, s, st)).join('') || '<p class="hint">Aucun hébergement pour cette nuit.</p>'}
      <button class="btn ghost full" data-act="add-stay-night" data-day="${D}">＋ Ajouter un hébergement ${s.stays.length ? 'pour cette nuit' : 'pour le séjour'}</button>
    </section>` : ''}
    <section class="sec ${pane('notes')}">
      <h4>${dayMode ? `Notes du ${fmtDayLong(D)}` : 'Notes de l’étape'}</h4>
      <textarea data-f="${dayMode ? `dayNotes.${D}` : 'notes'}" rows="10" placeholder="${dayMode ? 'Programme, horaires, réservations, idées pour cette journée…' : 'Infos pratiques, idées, codes, contacts…'}"></textarea>
    </section>
  </div>`;
}

const stayDoc = (t, st) => t.documents.find((d) => d.stayId === st.id);

function stayHTML(t, s, st) {
  const b = BOOK_STATUS[st.status] || BOOK_STATUS.todo;
  const doc = stayDoc(t, st), files = doc ? docFiles(doc) : [];
  return `<details class="dcard" data-scope data-stay="${st.id}" data-id="${st.id}" ${ui.open.has(st.id) ? 'open' : ''}>
    <summary><span class="sum-t">${esc(st.name || 'Hébergement sans nom')}</span>${st.checkIn ? `<small>${fmtDay(st.checkIn)} → ${fmtDay(st.checkOut)}</small>` : ''}${files.length ? `<span class="clip" title="Réservation jointe">${icon('link')}</span>` : ''}<span class="badge ${b.cls}">${b.label}</span></summary>
    <div class="d-body">
      <label class="fld"><span>Nom</span><input data-f="name" placeholder="Hôtel, Airbnb, camping, chez l’habitant…"></label>
      ${placeFieldHTML(st.place, 'Adresse', 'Rechercher l’adresse ou le nom de l’établissement…')}
      <div class="grid2">
        <label class="fld"><span>Arrivée</span><input type="date" data-f="checkIn"></label>
        <label class="fld"><span>Check-in à partir de</span><input type="time" data-f="checkInTime"></label>
        <label class="fld"><span>Départ</span><input type="date" data-f="checkOut"></label>
        <label class="fld"><span>Check-out avant</span><input type="time" data-f="checkOutTime"></label>
        <label class="fld"><span>Statut</span><select data-f="status">${Object.entries(BOOK_STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
        <label class="fld"><span>Prix total (${t.currency})</span><input type="number" step="any" min="0" inputmode="decimal" data-f="price"></label>
        <label class="fld"><span>N° de confirmation</span><input data-f="confirmation"></label>
        <label class="fld"><span>Téléphone</span><input type="tel" data-f="phone"></label>
      </div>
      <label class="fld"><span>Lien (réservation, annonce)</span><input type="url" data-f="link" placeholder="https://"></label>
      <label class="fld"><span>Notes (code d’accès, parking, wifi…)</span><textarea rows="2" data-f="notes"></textarea></label>
      <div class="stay-docs">
        <span class="fld-l">Justificatif de réservation</span>
        <div class="doc-pages">
          ${files.map((x, i) => `<div class="doc-page">
            <button class="doc-page-open" data-act="view-doc" data-doc="${doc.id}" data-i="${i}" aria-label="Voir la page ${i + 1}">${x.type?.startsWith('image/') ? `<img data-thumb="${x.id}" alt="">` : '<span><small>PDF</small></span>'}</button>
            <button class="icon-btn sm doc-page-del" data-act="del-stay-file" data-doc="${doc.id}" data-id="${x.id}" aria-label="Retirer">✕</button>
          </div>`).join('')}
          <label class="doc-page add"><span>${icon('camera')}<small>Scanner</small></span><input type="file" accept="image/*" capture="environment" data-stay-file="scan" hidden></label>
          <label class="doc-page add"><span>${icon('link')}<small>PDF / capture</small></span><input type="file" accept="image/*,application/pdf" multiple data-stay-file="files" hidden></label>
        </div>
        ${files.length ? '<small class="hint">Aussi rangé dans l’onglet Docs.</small>' : ''}
      </div>
      <div class="row-btns">
        ${st.place ? `<a class="btn sm" href="${dirUrl(st.place)}" target="_blank" rel="noopener">${icon('nav')} Y aller</a>` : ''}
        ${st.phone ? `<a class="btn sm" href="tel:${esc(st.phone)}">${icon('phone')} Appeler</a>` : ''}
        ${st.link ? `<a class="btn sm" href="${esc(st.link)}" target="_blank" rel="noopener">${icon('link')} Ouvrir</a>` : ''}
        <span class="spacer"></span>
        <button class="btn sm danger" data-act="del-stay" data-id="${st.id}">Supprimer</button>
      </div>
    </div>
  </details>`;
}

// Jours d'une étape : Jour 1 = jour d'arrivée, autant de jours que de nuits (au moins 1)
function stepDays(s) {
  if (!s.arrival) return [];
  const n = Math.max(1, nights(s));
  return Array.from({ length: n }, (_, k) => addDays(s.arrival, k));
}

const photoDay = (p) => p.day || toDayStr(p.t);

function subsGroupHTML(t, s, key, title, sub, list, ph) {
  return `
    <div class="day-group ${key === todayStr() ? 'today' : ''}">
      <div class="day-h"><span class="day-n">${title}</span><small>${sub}</small><span class="day-c">${list.length ? `${list.filter((x) => x.done).length}/${list.length}` : ''}</span></div>
      <div class="subs" data-subs-day="${key}">${list.map((x) => subHTML(t, s, x)).join('')}</div>
      <form class="quick-add sm" data-sub-add-day="${key}"><input placeholder="${ph}" enterkeyhint="done" aria-label="${ph}"><button class="btn sm">Ajouter</button></form>
    </div>`;
}
// Vue d'une journée : ses activités, puis les idées pas encore placées (à glisser dans la journée)
function subsOfDayHTML(t, s, d) {
  const k = stepDays(s).indexOf(d) + 1;
  const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99');
  return subsGroupHTML(t, s, d, `Jour ${k}`, fmtDayLong(d), s.subs.filter((x) => x.date === d).sort(byTime), 'Ajouter une activité à cette journée…');
}

function subsByDayHTML(t, s) {
  const days = stepDays(s);
  const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99');
  const group = (...a) => subsGroupHTML(t, s, ...a);
  if (!days.length) {
    return `<p class="hint">Ajoutez les dates de l’étape (onglet Lieu) pour organiser les activités jour par jour.</p>
      ${group('', 'Activités', '', s.subs, 'Ajouter : musée, resto, rando…')}`;
  }
  const inDays = new Set(days);
  const loose = s.subs.filter((x) => !x.date);
  const other = s.subs.filter((x) => x.date && !inDays.has(x.date));
  return days.map((d, k) => group(d, `Jour ${k + 1}`, fmtDayLong(d), s.subs.filter((x) => x.date === d).sort(byTime), `Ajouter une activité au jour ${k + 1}…`)).join('')
    + (other.length ? `<div class="day-group other"><div class="day-h"><span class="day-n">Autres dates</span><small>en dehors de l’étape</small></div><div class="subs" data-subs-day="${other[0].date}">${other.map((x) => subHTML(t, s, x)).join('')}</div></div>` : '');
}

function subHTML(t, s, x) {
  const open = ui.open.has(x.id);
  return `<div class="sub ${x.done ? 'done' : ''}" data-scope data-sub="${x.id}" data-id="${x.id}">
    <div class="sub-row">
      <span class="drag sm" aria-label="Déplacer">⋮⋮</span>
      <input type="checkbox" class="chk" data-f="done" aria-label="Fait">
      <button type="button" class="sub-main" data-act="toggle-open" data-id="${x.id}">
        
        <span class="sub-name">${esc(x.name || 'Sans titre')}</span>
        <span class="sub-meta">${x.time || ''}${x.place ? ' · ' + icon('pin') : ''}${x.cost ? ' · ' + fmtMoney(x.cost, t.currency) : ''}</span>
      </button>
    </div>
    <div class="sub-body ${open ? '' : 'hidden'}">
      <label class="fld"><span>Nom</span><input data-f="name"></label>
      <div class="grid3">
        <label class="fld"><span>Type</span><select data-f="type">${Object.entries(SUB_TYPES).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}</select></label>
        <label class="fld"><span>Jour</span><input type="date" data-f="date"></label>
        <label class="fld"><span>Heure</span><input type="time" data-f="time"></label>
      </div>
      ${placeFieldHTML(x.place)}
      <div class="grid2">
        <label class="fld"><span>Coût (${t.currency})</span><input type="number" step="any" min="0" inputmode="decimal" data-f="cost"></label>
        <label class="fld"><span>Lien / billet</span><input type="url" data-f="link" placeholder="https://"></label>
      </div>
      <label class="fld"><span>Notes</span><textarea rows="2" data-f="notes"></textarea></label>
      <div class="row-btns">
        ${x.place ? `<a class="btn sm" href="${dirUrl(x.place)}" target="_blank" rel="noopener">${icon('nav')} Y aller</a>` : ''}
        ${x.link ? `<a class="btn sm" href="${esc(x.link)}" target="_blank" rel="noopener">${icon('link')} Ouvrir</a>` : ''}
        <span class="spacer"></span>
        <button class="btn sm danger" data-act="del-sub" data-id="${x.id}">Supprimer</button>
      </div>
    </div>
  </div>`;
}

function mountStepDrawer(t, s, root) {
  const head = $('.drawer-head', root), body = $('#drawer-body', root);
  const light = () => { refresh({ header: false }); };
  bindFields(head, s, light);
  bindFields(body, s, (path, val, prev) => {
    if (path === 'arrival' && val && prev) {
      const d = diffDays(prev, val);
      if (s.departure) s.departure = addDays(s.departure, d);
      if (ui.shiftNext && d) shiftFollowing(t, s, d);
      renderDrawer();
    } else if (path === 'departure' && val && prev && ui.shiftNext) {
      shiftFollowing(t, s, diffDays(prev, val));
      renderDrawer();
    } else if (path === 'departure' || path === 'arrival') renderDrawer();
    light();
  });
  mountPlaceFields(body, s, (p) => {
    if (!s.name) { s.name = p.name; $('.title-input', head).value = p.name; }
    ensureCurrency(t, stepCurrency(s));
    loadWeather(s);
    light();
    mapView?.focus(p, 10);
  });
  $('#shift-next', body).onchange = (e) => (ui.shiftNext = e.target.checked);

  $$('[data-stay]', body).forEach((el) => {
    const st = s.stays.find((x) => x.id === el.dataset.stay);
    el.addEventListener('toggle', () => (el.open ? ui.open.add(st.id) : ui.open.delete(st.id)));
    bindFields(el, st, () => {
      $('.sum-t', el).textContent = st.name || 'Hébergement sans nom';
      const b = BOOK_STATUS[st.status] || BOOK_STATUS.todo;
      const badge = $('summary .badge', el);
      badge.className = `badge ${b.cls}`;
      badge.textContent = b.label;
      light();
    });
    mountPlaceFields(el, st, (p) => { if (!st.name) { st.name = p.name; $('[data-f="name"]', el).value = p.name; $('.sum-t', el).textContent = p.name; } light(); });
    $$('[data-stay-file]', el).forEach((input) => (input.onchange = async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      let d = stayDoc(t, st);
      if (!d) {
        d = { id: uid(), name: `Réservation ${st.name || s.name || 'hébergement'}`, type: 'booking', number: st.confirmation || '', expiry: '', notes: '', files: [], stayId: st.id };
        t.documents.unshift(d);
      }
      await addDocFiles(d, files, input.dataset.stayFile === 'scan');
      if (st.status === 'todo') st.status = 'booked';
      commit({ map: false });
      renderDrawer();
      toast('Réservation jointe à l’hébergement');
    }));
  });

  $$('[data-sub]', body).forEach((el) => {
    const x = s.subs.find((y) => y.id === el.dataset.sub);
    bindFields(el, x, (path) => {
      el.classList.toggle('done', !!x.done);
      $('.sub-name', el).textContent = x.name || 'Sans titre';
      if (path !== 'done' && path !== 'name' && path !== 'notes') renderDrawer();
      light();
    });
    mountPlaceFields(el, x, () => { renderDrawer(); light(); });
  });

  // Glisser une activité d'un jour à l'autre (ou vers « À planifier ») change sa date
  if (window.Sortable) {
    $$('[data-subs-day]', body).forEach((list) => Sortable.create(list, {
      group: 'subs-' + s.id, handle: '.drag', animation: 150, ghostClass: 'ghost', emptyInsertThreshold: 24,
      onEnd: (ev) => {
        const moved = s.subs.find((x) => x.id === ev.item.dataset.sub);
        if (moved && ev.from !== ev.to) moved.date = ev.to.dataset.subsDay;
        const order = $$('[data-sub]', body).map((el) => el.dataset.sub);
        s.subs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        commit({ map: false });
        if (ev.from !== ev.to) renderDrawer();
      },
    }));
  }

  // Ajout rapide : chaque jour a son propre champ, l'activité prend la date du jour
  $$('[data-sub-add-day]', body).forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const input = $('input', f);
    const name = input.value.trim();
    if (!name) return;
    const guess = /resto|restaurant|déj|dîner|diner|brunch|tapas/i.test(name) ? 'food' : /café|bar|cocktail/i.test(name) ? 'cafe' : /rando|trek|sentier/i.test(name) ? 'hike' : /plage/i.test(name) ? 'beach' : /musée|église|cathédrale|château|palais|monument/i.test(name) ? 'visit' : /vue|belvédère|miradouro|sunset|coucher/i.test(name) ? 'view' : 'activity';
    const day = f.dataset.subAddDay;
    s.subs.push(newSub({ name, type: guess, date: day }));
    touch(); save();
    renderDrawer();
    refresh({ header: false, map: false });
    $(`[data-sub-add-day="${day}"] input`)?.focus();
  }));
  if (s.place && ui.dtab === 'place') { loadWeather(s); loadNews(s); loadTips(s); }
}

async function loadWeather(s) {
  const box = $('#weather');
  if (!box || !s.place) return;
  const today = todayStr();
  const from = s.arrival && s.arrival > today ? s.arrival : today;
  const to = s.departure && s.departure > from ? s.departure : from;
  try {
    // Plus de 15 jours avant : on montre les normales de saison (même période l'an dernier)
    if (s.arrival && diffDays(today, s.arrival) > 15) {
      const c = await svc.climate(s.place.lat, s.place.lng, s.arrival, s.departure && s.departure > s.arrival ? s.departure : s.arrival);
      if (!c) throw new Error();
      box.innerHTML = `<div class="wx-norm">
        <span class="wx-big">${icon(c.max >= 25 ? 'sun' : c.max >= 17 ? 'sunCloud' : c.max >= 8 ? 'cloud' : 'snow', 'wx-ico')}</span>
        <div><b>${Math.round(c.min)}° / ${Math.round(c.max)}°</b><small>Normales de saison${c.rainy ? ` · pluie ${c.rainy} jour${c.rainy > 1 ? 's' : ''} sur ${c.days}` : ' · peu de pluie'}</small>
        <small class="muted">Prévisions précises à partir du ${fmtDay(addDays(s.arrival, -15), { day: 'numeric', month: 'long' })}</small></div>
      </div>`;
      return;
    }
    if (s.departure && s.departure < today) { box.innerHTML = '<div class="wx-msg">Étape passée.</div>'; return; }
    const w = await svc.weather(s.place.lat, s.place.lng);
    const days = w.days.filter((d) => d.date >= from && d.date <= to).slice(0, 10);
    box.innerHTML = days.length
      ? `${w.current && from === today ? `<p class="wx-now">Actuellement <b>${Math.round(w.current.temp)}°</b> · ${WEATHER(w.current.code)[1]}</p>` : ''}<div class="wx">${days.map((d) => { const [ic, lb] = WEATHER(d.code); return `<div class="wx-d" title="${lb}"><small>${fmtDay(d.date, { weekday: 'short', day: 'numeric' })}</small><span>${ic}</span><b>${Math.round(d.max)}°</b><small>${Math.round(d.min)}°${d.rain ? ` · ${d.rain}% pluie` : ''}</small></div>`; }).join('')}</div>`
      : '<div class="wx-msg">Pas de prévision pour ces dates.</div>';
  } catch {
    box.innerHTML = '<div class="wx-msg">Météo indisponible (hors-ligne ?).</div>';
  }
}

const countryFr = (cc) => { try { return new Intl.DisplayNames('fr', { type: 'region' }).of(cc); } catch { return cc; } };
const diploUrl = (cc) => `https://www.diplomatie.gouv.fr/fr/conseils-aux-voyageurs/conseils-par-pays-destination/${slug(countryFr(cc))}/`;

// Actualité : les sites d'actualité refusent les appels directs depuis une app web.
// La liste d'articles passera par le service en ligne (relais) ; en attendant, liens directs.
async function loadNews(s) {
  const box = $('#news');
  if (!box) return;
  const q = s.name || shortLabel(s.place.label).split(',')[0];
  box.innerHTML = `<div class="wx-msg">Les dernières nouvelles de ${esc(q)} et les conseils officiels du pays :</div>`;
}

// ---------- Astuces laissées par les voyageurs (communauté, via le service en ligne)
async function loadTips(s) {
  const box = $('#tips');
  if (!box) return;
  if (!cloud.cloudReady()) {
    box.innerHTML = '<div class="wx-msg">Les astuces des autres voyageurs (bons plans, pièges à éviter, adresses) apparaîtront ici dès que le service en ligne sera connecté.</div>';
    return;
  }
  box.innerHTML = '<div class="wx-msg">Chargement des astuces…</div>';
  try {
    const tips = await cloud.getTips(s.place.lat, s.place.lng);
    if ($('#tips') !== box) return;
    box.innerHTML = `
      ${tips.length ? tips.map((x) => `<div class="tip">
        <p>${esc(x.body)}</p>
        <div class="tip-meta"><span>${esc(x.author)} · ${esc(x.place_name || '')} · ${fmtDay(x.created_at.slice(0, 10), { month: 'short', year: 'numeric' })}</span>
          <button class="tip-up ${x.mine ? 'on' : ''}" data-act="tip-vote" data-id="${x.id}">👍 ${x.votes || ''}</button>
          <button class="link muted" data-act="tip-report" data-id="${x.id}" title="Signaler un contenu inapproprié">Signaler</button></div>
      </div>`).join('') : '<div class="wx-msg">Aucune astuce pour ce lieu. Soyez le premier à aider les prochains voyageurs !</div>'}
      <form class="tip-form" id="tip-form">
        <textarea rows="2" maxlength="600" placeholder="Une astuce pour les prochains : bon plan, adresse, piège à éviter…" aria-label="Votre astuce"></textarea>
        <div class="row-btns"><input id="tip-name" placeholder="Votre prénom" maxlength="40" value="${esc(state.settings.tipName || T()?.share?.author || '')}" aria-label="Votre prénom"><button class="btn sm primary">Publier</button></div>
      </form>`;
    $('#tip-form', box).onsubmit = async (e) => {
      e.preventDefault();
      const body = $('textarea', e.target).value.trim();
      const author = $('#tip-name', e.target).value.trim();
      if (!body) return;
      if (!author) { $('#tip-name', e.target).focus(); return toast('Indiquez votre prénom'); }
      state.settings.tipName = author;
      save();
      try { await cloud.addTip(s.place.lat, s.place.lng, s.name, author, body); toast('Merci pour votre astuce ! 🙏'); loadTips(s); }
      catch (err) { toast(`Publication impossible : ${esc(err.message || 'réseau')}`); }
    };
  } catch {
    box.innerHTML = '<div class="wx-msg">Astuces indisponibles (hors-ligne ?).</div>';
  }
}
A['tip-vote'] = async (el) => { try { await cloud.voteTip(el.dataset.id); loadTips(curStep()); } catch { toast('Pas de connexion'); } };
A['tip-report'] = async (el) => {
  if (!confirm('Signaler cette astuce comme inappropriée ?')) return;
  try { await cloud.reportTip(el.dataset.id); toast('Merci, c’est signalé.'); loadTips(curStep()); } catch { toast('Pas de connexion'); }
};

// =====================================================================
// Panneau d'un trajet (entre deux étapes)
// =====================================================================
// « Lisbonne » → « LIS », comme sur une carte d'embarquement
const cityCode = (name = '') => (name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || '···');

function openLegDrawer(id, tab = 'trip') {
  ui.legModes = false;
  ui.ltab = tab;
  const t = T();
  const i = t.steps.findIndex((s) => s.id === id);
  if (i < 1) return openStepDrawer(id);
  if (ui.addMode) setAddMode(false);
  ui.drawer = { type: 'leg', id };
  renderDrawer(true);
  refresh({ header: false });
  const s = t.steps[i], prev = t.steps[i - 1];
  if (s.place && prev.place && mapView && !isMobile()) mapView.fitLeg(prev.place, s.place);
}
A['open-leg'] = (el) => openLegDrawer(el.dataset.id);

function legDrawerHTML(t, s) {
  const i = t.steps.indexOf(s), prev = t.steps[i - 1];
  const tr = s.transport, mode = MODES[tr.mode];
  const info = legInfo(prev, s);
  const own = ownLeg(t, s);
  const lt = ui.ltab === 'photos' ? 'photos' : 'trip';
  const nph = stepPhotos(t, s, true).length;
  return `
  <div class="drawer-head leg-head">
    <div class="dh-row"><span class="kind-chip">${icon('route')} Trajet${mode ? ` · ${mode.label}` : ''}</span><button class="icon-btn" data-act="close-drawer" aria-label="Fermer">✕</button></div>
    <div class="ticket">
      <div class="tk-end"><b>${cityCode(prev.name)}</b><small>${esc(prev.name || 'Départ')}</small><em>${fmtTime(tr.depart) || (prev.departure ? fmtDay(prev.departure) : '')}</em></div>
      <div class="tk-mid"><span class="tk-line"></span><i class="tk-veh">${icon(tr.mode || 'other')}</i><small>${info ? `${fmtKm(info.km)}${info.min ? ' · ' + fmtDuration(info.min) : ''}` : ''}</small></div>
      <div class="tk-end r"><b>${cityCode(s.name)}</b><small>${esc(s.name || 'Arrivée')}</small><em>${fmtTime(tr.arrive) || (s.arrival ? fmtDay(s.arrival) : '')}</em></div>
    </div>
  </div>
  <div class="drawer-nav">
    <button class="btn sm" data-act="open-step" data-id="${prev.id}">‹ ${esc(prev.name || 'Étape précédente')}</button>
    ${prev.place && s.place ? `<button class="btn sm" data-act="focus-leg" data-id="${s.id}">${icon('map')} Carte</button>` : ''}
    <button class="btn sm" data-act="open-step" data-id="${s.id}">${esc(s.name || 'Étape suivante')} ›</button>
  </div>
  <nav class="dtabs" role="tablist">
    <button class="dtab ${lt === 'trip' ? 'active' : ''}" data-act="ltab" data-k="trip" role="tab"><span class="dt-ic">${icon('route')}</span><span class="dt-l">Trajet</span></button>
    <button class="dtab ${lt === 'photos' ? 'active' : ''}" data-act="ltab" data-k="photos" role="tab"><span class="dt-ic">${icon('camera')}</span><span class="dt-l">Photos</span>${nph ? `<i class="dt-b">${nph}</i>` : ''}</button>
  </nav>
  <div class="drawer-body" id="drawer-body" data-scope>
    ${lt === 'photos' ? `<section class="sec">${photosPaneHTML(t, s, true)}</section>` : `
    <section class="sec">
      ${own ? `<div class="own-leg"><span class="own-ic">${icon(t.vehicle)}</span><div><b>En ${VEHICLES[t.vehicle].short}</b><small>Votre véhicule</small></div><button class="link" data-act="leg-modes">Autre mode (ferry, train…)</button></div>` : ''}
      <label class="fld mode-pick ${own && !ui.legModes ? 'hidden' : ''}"><span>Mode de transport</span>
        <span class="mode-row"><span class="mode-ic" style="color:${mode?.color || 'var(--muted)'}">${icon(tr.mode || 'other')}</span>
        <select data-f="transport.mode" aria-label="Mode de transport"><option value="">Choisir…</option>${Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></span>
      </label>
      ${info ? `<div class="leg-info">${fmtKm(info.km)}${info.min ? ` · ${info.exact ? '' : '~'}${fmtDuration(info.min)}` : ''}${own ? ` · carburant ~${Math.round((info.km * (+t.conso || VEHICLES[t.vehicle].conso)) / 100)} L ≈ ${fmtMoney((info.km * (+t.conso || VEHICLES[t.vehicle].conso)) / 100 * (+t.fuelPrice || 1.85), t.currency)}` : ''}${mode?.road && !info.exact && state.settings.routing ? ' <small>(calcul de la route…)</small>' : ''}</div>` : '<p class="hint">Ajoutez un lieu aux deux étapes pour voir la distance.</p>'}
    </section>
    <section class="sec ${tr.mode ? '' : 'hidden'}">
      <h4>${own ? 'Horaires & frais' : 'Horaires & réservation'}</h4>
      <div class="grid2">
        <label class="fld"><span>Départ</span><input type="datetime-local" data-f="transport.depart"></label>
        <label class="fld"><span>Arrivée</span><input type="datetime-local" data-f="transport.arrive"></label>
        ${own ? '' : `<label class="fld"><span>Compagnie / n°</span><input data-f="transport.company" placeholder="ex : TP 433"></label>
        <label class="fld"><span>Référence de réservation</span><input data-f="transport.ref" placeholder="ex : XK7P2L"></label>`}
        <label class="fld"><span>${own ? 'Péages, parking, vignette' : 'Prix'} (${t.currency})</span><input type="number" step="any" min="0" inputmode="decimal" data-f="transport.price"></label>
        ${own ? '' : `<label class="fld"><span>Statut</span><select data-f="transport.status"><option value="">—</option>${Object.entries(BOOK_STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>`}
      </div>
    </section>
    <section class="sec ${tr.mode ? '' : 'hidden'}">
      <h4>Notes du trajet</h4>
      <textarea rows="4" data-f="transport.notes" placeholder="${own ? 'Pauses, aire de repos, plein, route panoramique…' : 'Terminal, siège, voiture, quai…'}"></textarea>
      ${prev.place && s.place ? `<a class="btn sm" href="https://www.google.com/maps/dir/?api=1&origin=${prev.place.lat},${prev.place.lng}&destination=${s.place.lat},${s.place.lng}${tr.mode === 'train' || tr.mode === 'bus' ? '&travelmode=transit' : tr.mode === 'walk' ? '&travelmode=walking' : tr.mode === 'bike' ? '&travelmode=bicycling' : ''}" target="_blank" rel="noopener">${icon('nav')} Itinéraire détaillé (Google Maps)</a>` : ''}
    </section>
    ${tr.mode && !own ? `<div class="del-step-row"><button class="link danger-link" data-act="${isRoad(t) ? 'leg-own' : 'clear-transport'}">${isRoad(t) ? `Revenir à mon ${VEHICLES[t.vehicle].short}` : 'Retirer ce transport'}</button></div>` : ''}`}
  </div>`;
}

function mountLegDrawer(t, s, root) {
  bindFields($('#drawer-body', root), s, (path) => {
    if (path === 'transport.mode') renderDrawer();
    refresh({ header: false });
  });
}

A['drawer-save'] = () => {
  document.activeElement?.blur?.(); // valide le champ en cours de saisie
  const d = ui.drawer;
  if (!d) return;
  const t = T();
  closeDrawer();
  toast('✓ Enregistré');
  go(`#/trip/${t.id}/map`);
  setTimeout(() => {
    const i = t.steps.findIndex((x) => x.id === d.id);
    const s = t.steps[i], prev = t.steps[i - 1];
    if (d.type === 'leg' && prev?.place && s?.place) mapView?.fitLeg(prev.place, s.place);
    else if (s?.place) mapView?.focus(s.place, 12);
  }, 250);
};
A.dday = (el) => { ui.dday = el.dataset.d; renderDrawer(true); };
A['add-stay-night'] = (el) => {
  const s = curStep();
  const d = el.dataset.day;
  const st = s.stays.length ? newStay({ checkIn: d, checkOut: addDays(d, 1) }) : newStay({ checkIn: s.arrival, checkOut: s.departure });
  s.stays.push(st);
  ui.open.add(st.id);
  commit({ map: false });
  renderDrawer();
};
A.ltab = (el) => { ui.ltab = el.dataset.k; renderDrawer(true); };
A['leg-modes'] = () => { ui.legModes = !ui.legModes; renderDrawer(); };
A['leg-own'] = () => { const t = T(), s = curStep(); s.transport.mode = t.vehicle; s.transport.company = ''; s.transport.ref = ''; s.transport.status = ''; ui.legModes = false; commit(); renderDrawer(); };

A['focus-leg'] = (el) => {
  const t = T();
  const i = t.steps.findIndex((x) => x.id === el.dataset.id);
  const a = t.steps[i - 1].place, b = t.steps[i].place;
  if (isMobile()) { ui.drawer = null; $('#drawer-root').classList.remove('open'); $('#drawer-root').innerHTML = ''; go(`#/trip/${ui.tripId}/map`); }
  setTimeout(() => mapView?.fitLeg(a, b), 150);
};

A.dtab = (el) => {
  ui.dtab = el.dataset.k;
  renderDrawer(true);
  if (ui.dtab === 'notes') $('#drawer-body textarea[data-f="notes"]')?.focus();
};

const curStep = () => T().steps.find((s) => s.id === ui.drawer?.id);

A.nights = (el) => {
  const t = T(), s = curStep();
  if (!s.arrival) { toast('Choisissez d’abord la date d’arrivée'); return; }
  const d = +el.dataset.d;
  const cur = nights(s);
  if (cur + d < 0) return;
  s.departure = addDays(s.departure || s.arrival, d);
  if (!s.departure || s.departure < s.arrival) s.departure = s.arrival;
  s.stays.forEach((x) => { if (x.checkOut && x.checkOut === addDays(s.departure, -d)) x.checkOut = s.departure; });
  if (ui.shiftNext) shiftFollowing(t, s, d);
  commit({ header: true });
  renderDrawer();
};

A['focus-step'] = (el) => {
  const s = T().steps.find((x) => x.id === el.dataset.id);
  if (isMobile()) { ui.drawer = null; $('#drawer-root').classList.remove('open'); $('#drawer-root').innerHTML = ''; go(`#/trip/${ui.tripId}/map`); }
  setTimeout(() => mapView?.focus(s.place, 13), 120);
};

A['clear-transport'] = () => {
  const s = curStep();
  Object.assign(s.transport, { mode: '', depart: '', arrive: '', company: '', ref: '', price: null, status: '', notes: '' });
  commit();
  renderDrawer();
};

A['add-stay'] = () => {
  const s = curStep();
  const st = newStay({ checkIn: s.arrival, checkOut: s.departure });
  s.stays.push(st);
  ui.open.add(st.id);
  commit({ map: false });
  renderDrawer();
  $(`[data-stay="${st.id}"] [data-f="name"]`)?.focus();
};
A['del-stay'] = (el) => {
  const s = curStep();
  const notify = undoable('Hébergement supprimé');
  s.stays = s.stays.filter((x) => x.id !== el.dataset.id);
  commit();
  renderDrawer();
  notify();
};
A['del-sub'] = (el) => {
  const s = curStep();
  const notify = undoable('Sous-étape supprimée');
  s.subs = s.subs.filter((x) => x.id !== el.dataset.id);
  commit();
  renderDrawer();
  notify();
};
A['toggle-open'] = (el) => {
  const id = el.dataset.id;
  ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id);
  el.closest('.sub').querySelector('.sub-body').classList.toggle('hidden');
};
A['del-step'] = () => {
  const t = T(), s = curStep();
  const notify = undoable(`Étape « ${esc(s.name || 'sans nom')} » supprimée`);
  t.steps = t.steps.filter((x) => x.id !== s.id);
  touch(); save();
  closeDrawer();
  notify();
};

const n2 = (s) => (nights(s) ? plural(nights(s), 'nuit') : 'de passage');

// ---------- Géolocalisation
function geoErr(e) {
  if (!navigator.geolocation) return 'Géolocalisation non disponible sur cet appareil';
  if (e?.code === 1) return 'Accès à la position refusé : autorisez-le dans les réglages du navigateur';
  if (e?.code === 3) return 'Position introuvable (délai dépassé)';
  if (!isSecureContext) return 'La géolocalisation nécessite HTTPS';
  return 'Position indisponible';
}

function getPositionOnce(timeout = 12000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('no geo'));
    navigator.geolocation.getCurrentPosition(
      (p) => { onPos(p); res(ui.me); },
      rej,
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

function startWatch() {
  if (ui.watchId != null || !navigator.geolocation) return;
  ui.watchId = navigator.geolocation.watchPosition(onPos, (e) => {
    toast(esc(geoErr(e)));
    if (e.code === 1) stopRecording();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopWatch() {
  if (ui.watchId != null) navigator.geolocation.clearWatch(ui.watchId);
  ui.watchId = null;
}

function onPos(p) {
  const c = p.coords;
  ui.me = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed, t: p.timestamp };
  mapView?.setMe(ui.me, ui.follow);
  if (ui.recording) recordPoint(ui.me);
}

function recordPoint(me) {
  const t = getTrip(state.settings.recordingTripId);
  if (!t || me.acc > 150) return;
  const last = t.track.at(-1);
  const moved = last ? haversine({ lat: last[0], lng: last[1] }, me) : Infinity;
  if (!last || (moved > Math.max(0.025, me.acc / 1000) && me.t - last[2] > 10000) || me.t - last[2] > 15 * 60_000) {
    t.track.push([+me.lat.toFixed(5), +me.lng.toFixed(5), me.t]);
    save();
    if (t.id === ui.tripId) renderMapDebounced();
  }
}
const renderMapDebounced = debounce(renderMap, 1500);

function startRecording(silent = false) {
  if (!navigator.geolocation) return toast(esc(geoErr()));
  ui.recording = true;
  ui.follow = true;
  state.settings.recordingTripId = ui.tripId;
  save();
  startWatch();
  updateRecUI();
  if (!silent) toast('Suivi activé : votre trajet s’enregistre. Gardez l’app ouverte pour un tracé continu.', { ms: 6000 });
}
function stopRecording() {
  ui.recording = false;
  state.settings.recordingTripId = null;
  save();
  releaseWake();
  updateRecUI();
}

function updateRecUI() {
  $('#rec-pill')?.classList.toggle('hidden', !ui.recording);
  $('[data-act="locate"]')?.classList.toggle('on', ui.follow);
}

A['toggle-rec'] = () => {
  ui.recording ? stopRecording() : startRecording();
};

async function requestWake() {
  try {
    ui.wake = await navigator.wakeLock.request('screen');
    ui.wake.addEventListener('release', () => { if (ui.wake?.released) ui.wake = null; });
  } catch {
    toast('Votre navigateur ne permet pas de garder l’écran allumé');
    ui.wake = null;
  }
}
function releaseWake() { ui.wake?.release?.(); ui.wake = null; }
A['toggle-wake'] = async () => {
  ui.wantWake = !ui.wake;
  ui.wake ? releaseWake() : await requestWake();
  renderPanel();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.recording && ui.wantWake && !ui.wake) requestWake();
});

A.locate = async () => {
  ui.follow = true;
  updateRecUI();
  startWatch();
  if (ui.me) mapView?.focus(ui.me, 14);
  else {
    try { const me = await getPositionOnce(); mapView?.focus(me, 14); }
    catch (e) { toast(esc(geoErr(e))); }
  }
};
A.fit = () => { ui.follow = false; updateRecUI(); fitTrip(); };
const fitTrip = () => { const el = $('#map-progress'); mapView?.fit(T(), ui.me, el && !el.classList.contains('hidden') ? el.offsetHeight + 10 : 0); };
A['mp-toggle'] = () => { ui.mpCollapsed = !ui.mpCollapsed; $('#map-progress')?.classList.toggle('collapsed', ui.mpCollapsed); };

A.layers = () => openModal(`
  <h2>Fond de carte</h2>
  <div class="layer-grid">
    ${[['auto', 'Automatique', 'Plan clair ou sombre selon le thème'], ...Object.entries(BASEMAPS).map(([k, v]) => [k, v.label, ''])].map(([k, l, d]) =>
      `<button class="layer ${state.settings.basemap === k ? 'on' : ''}" data-act="set-base" data-k="${k}"><b>${l}</b>${d ? `<small>${d}</small>` : ''}</button>`).join('')}
  </div>
  <div class="sec">
    <label class="check"><input type="checkbox" id="opt-routing" ${state.settings.routing ? 'checked' : ''}> Tracer les vraies routes pour voiture, bus, van et moto</label>
  </div>
  <div class="sec">
    <h4>📴 Carte hors-ligne</h4>
    <p class="hint">Télécharge les zones autour de chaque étape, hébergement et activité de ce voyage. Les zones que vous consultez sont aussi gardées automatiquement.</p>
    <button class="btn" data-act="prefetch">Télécharger la carte de ce voyage</button>
    <div id="prefetch-status" class="hint"></div>
  </div>
  <div class="actions"><button class="btn primary" data-act="close-modal">OK</button></div>`, (m) => {
  $('#opt-routing', m).onchange = (e) => { state.settings.routing = e.target.checked; save(); renderMap(); };
});
A['set-base'] = (el) => {
  state.settings.basemap = el.dataset.k;
  save();
  applyBasemap();
  $$('.layer').forEach((b) => b.classList.toggle('on', b.dataset.k === el.dataset.k));
};
A.prefetch = async (el) => {
  el.disabled = true;
  const status = $('#prefetch-status');
  const n = await mapView.prefetch(T(), (done, total) => { if (status) status.textContent = `${done} / ${total} tuiles…`; });
  if (status) status.textContent = n ? `✓ ${n} tuiles enregistrées pour un usage hors-ligne` : 'Ajoutez des lieux à vos étapes d’abord.';
  el.disabled = false;
};

// =====================================================================
// Onglet Budget
// =====================================================================
function renderBudget(t) {
  const c = tripCosts(t), cur = t.currency;
  // Monnaies des pays visités (avec un taux connu) : le budget y est converti automatiquement
  const localCurs = [...new Set(t.steps.map(stepCurrency))].filter((k) => k && k !== cur && t.rates[k] > 0);
  const pct = t.budget ? Math.min(100, (c.total / t.budget) * 100) : 0;
  const over = t.budget && c.total > t.budget;
  const days = tripStart(t) && tripEnd(t) ? diffDays(tripStart(t), tripEnd(t)) + 1 : null;
  const maxCat = Math.max(1, ...Object.values(c.cats));
  const exps = [...t.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.t - a.t);
  const byDay = {};
  exps.forEach((e) => (byDay[e.date || ''] ||= []).push(e));
  const foreign = [...new Set(t.expenses.map((e) => e.currency).filter((x) => x && x !== cur))];
  return `
  <div class="budget">
    <div class="card budget-hero">
      <div class="bh-top">
        <div><small class="eyebrow">Coût total</small><div class="big">${fmtMoney(c.total, cur)}</div></div>
        <div class="right"><small class="eyebrow">Budget</small><div class="mid">${t.budget ? fmtMoney(t.budget, cur) : `<button class="link" data-act="trip-settings">Définir</button>`}</div></div>
      </div>
      ${t.budget ? `<div class="bar lg ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div><p class="${over ? 'warn-txt' : 'muted'}">${over ? `Dépassement de ${fmtMoney(c.total - t.budget, cur)}` : `Reste ${fmtMoney(t.budget - c.total, cur)}`}</p>` : ''}
      ${localCurs.length ? `<div class="fx">${localCurs.map((k) => `<div class="fx-row"><span class="fx-cur"><b>${k}</b><small>${esc(curName(k))}</small></span>
        ${t.budget ? `<span><small>Budget</small><b>${fmtMoney(t.budget / t.rates[k], k)}</b></span><span><small>${over ? 'Dépassement' : 'Reste'}</small><b class="${over ? 'warn-txt' : ''}">${fmtMoney(Math.abs(t.budget - c.total) / t.rates[k], k)}</b></span>` : `<span><small>Dépensé</small><b>${fmtMoney(c.total / t.rates[k], k)}</b></span>`}
        <span><small>1 ${cur}</small><b>${(1 / t.rates[k]).toLocaleString('fr-FR', { maximumSignificantDigits: 4 })} ${k}</b></span></div>`).join('')}</div>` : ''}
      <div class="stats">
        <div><b>${fmtMoney(c.booked, cur)}</b><span>réservations</span></div>
        <div><b>${fmtMoney(c.spent, cur)}</b><span>dépenses sur place</span></div>
        ${isRoad(t) ? `<div><b>${fmtMoney(c.fuelLeft, cur)}</b><span>⛽ carburant à prévoir</span></div>` : ''}
        ${t.travelers > 1 ? `<div><b>${fmtMoney(c.total / t.travelers, cur)}</b><span>par personne</span></div>` : ''}
        ${days ? `<div><b>${fmtMoney(c.total / days, cur)}</b><span>par jour</span></div>` : ''}
      </div>
    </div>

    <button class="btn primary full lg" data-act="add-expense">＋ Ajouter une dépense</button>

    <div class="card">
      <h4>Par catégorie</h4>
      ${Object.entries(EXP_CATS).filter(([k]) => c.cats[k]).map(([k, v]) => `<div class="cat-row"><span>${v.icon} ${v.label}</span><div class="bar"><i style="width:${(c.cats[k] / maxCat) * 100}%;background:${v.color}"></i></div><b>${fmtMoney(c.cats[k], cur)}</b></div>`).join('') || '<p class="muted">Les prix des hébergements, trajets, activités et vos dépenses apparaîtront ici.</p>'}
    </div>

    <div class="card">
      <h4>Par étape</h4>
      ${t.steps.map((s) => { const v = stepCost(t, s); return v ? `<button class="cost-row" data-act="open-step" data-id="${s.id}"><span>${esc(s.name || 'Étape')}</span><small>${n2(s)}</small><b>${fmtMoney(v, cur)}</b></button>` : ''; }).join('') || '<p class="muted">Aucun coût saisi.</p>'}
    </div>

    <div class="card">
      <h4>Dépenses</h4>
      ${Object.entries(byDay).map(([d, list]) => `<div class="exp-day"><small class="eyebrow">${d ? fmtDayLong(d) : 'Sans date'} · ${fmtMoney(list.reduce((n, e) => n + conv(t, e.amount, e.currency), 0), cur)}</small>
        ${list.map((e) => `<button class="exp" data-act="edit-expense" data-id="${e.id}"><span class="exp-ic">${EXP_CATS[e.category]?.icon || '💼'}</span><span class="exp-l">${esc(e.label || EXP_CATS[e.category]?.label || 'Dépense')}${e.stepId ? `<small>${esc(t.steps.find((s) => s.id === e.stepId)?.name || '')}</small>` : ''}</span><b>${fmtMoney(e.amount, e.currency || cur)}${e.currency && e.currency !== cur ? `<small>${fmtMoney(conv(t, e.amount, e.currency), cur)}</small>` : ''}</b></button>`).join('')}
      </div>`).join('') || '<p class="muted">Notez vos dépenses au fil de l’eau : resto, essence, souvenirs…</p>'}
    </div>

    <div class="card">
      <h4>💱 Taux de change <small>1 unité = x ${cur}</small></h4>
      <div class="rates">
        ${[...new Set([...Object.keys(t.rates), ...foreign])].map((k) => `<label class="rate"><span title="${esc(curName(k))}">1 ${k} =<small>${esc(curName(k))}</small></span><input type="number" step="any" min="0" value="${t.rates[k] ?? ''}" data-rate="${k}" inputmode="decimal"><span>${cur}</span><button class="icon-btn sm" data-act="del-rate" data-k="${k}" aria-label="Retirer">✕</button></label>`).join('')}
      </div>
      <div class="row-btns">
        <select id="new-rate"><option value="">＋ Devise…</option>${CURRENCIES.filter((x) => x !== cur && !(x in t.rates)).map((x) => `<option>${x}</option>`).join('')}</select>
        <button class="btn sm" data-act="update-rates">↻ Taux du jour</button>
      </div>
    </div>
  </div>`;
}

document.addEventListener('change', (e) => {
  const t = T();
  if (!t) return;
  if (e.target.dataset.rate) {
    const v = parseFloat(e.target.value.replace(',', '.'));
    if (v > 0) t.rates[e.target.dataset.rate] = v; else delete t.rates[e.target.dataset.rate];
    commit({ map: false });
  }
  if (e.target.id === 'new-rate' && e.target.value) {
    t.rates[e.target.value] = t.rates[e.target.value] || null;
    commit({ map: false });
    A['update-rates']();
  }
});
A['del-rate'] = (el) => { delete T().rates[el.dataset.k]; commit({ map: false }); };
A['update-rates'] = async () => {
  const t = T();
  const syms = Object.keys(t.rates);
  if (!syms.length) return toast('Ajoutez d’abord une devise');
  try {
    const r = await svc.fetchRates(t.currency, syms);
    Object.assign(t.rates, r);
    commit({ map: false });
    toast('Taux de change mis à jour');
  } catch {
    toast('Impossible de récupérer les taux (hors-ligne ?). Saisissez-les à la main.');
  }
};

function expenseModal(e) {
  const t = T();
  const isNew = !e;
  const curStepObj = t.steps[currentStepIdx(t)];
  e ||= { id: uid(), t: Date.now(), amount: null, currency: stepCurrency(curStepObj) || t.steps.map(stepCurrency).find((c) => c && c !== t.currency) || t.currency, label: '', category: 'food', date: todayStr(), stepId: curStepObj?.id || '' };
  const curs = [...new Set([e.currency, t.currency, ...Object.keys(t.rates)])];
  openModal(`
    <h2>${isNew ? 'Nouvelle dépense' : 'Modifier la dépense'}</h2>
    <form class="form" id="f-exp">
      <div class="amount"><input type="number" name="amount" step="any" min="0" inputmode="decimal" placeholder="0" value="${e.amount ?? ''}" required autofocus><select name="currency" aria-label="Devise">${curs.map((c) => `<option value="${c}" ${c === e.currency ? 'selected' : ''}>${c}</option>`).join('')}<option value="__other">Autre…</option></select></div>
      <div class="pills">${Object.entries(EXP_CATS).map(([k, v]) => `<label class="pill"><input type="radio" name="category" value="${k}" ${k === e.category ? 'checked' : ''}><span>${v.icon} ${v.label}</span></label>`).join('')}</div>
      <label class="fld"><span>Description</span><input name="label" value="${esc(e.label)}" placeholder="ex : Dîner, essence, musée…"></label>
      <div class="grid2">
        <label class="fld"><span>Date</span><input type="date" name="date" value="${e.date || ''}"></label>
        <label class="fld"><span>Étape</span><select name="stepId"><option value="">—</option>${t.steps.map((s) => `<option value="${s.id}" ${s.id === e.stepId ? 'selected' : ''}>${esc(s.name || 'Étape')}</option>`).join('')}</select></label>
      </div>
      <div class="actions">
        ${isNew ? '' : `<button type="button" class="btn danger" data-act="del-expense" data-id="${e.id}">Supprimer</button>`}
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="close-modal">Annuler</button>
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`, (m) => {
    const sel = $('[name=currency]', m);
    // Changer d'étape propose la monnaie de son pays
    $('[name=stepId]', m).onchange = (ev) => {
      const c = stepCurrency(t.steps.find((x) => x.id === ev.target.value));
      if (!c) return;
      if (![...sel.options].some((o) => o.value === c)) sel.insertAdjacentHTML('afterbegin', `<option value="${c}">${c}</option>`);
      sel.value = c;
    };
    sel.onchange = () => {
      if (sel.value !== '__other') return;
      const code = (prompt('Code de la devise (ex : USD, JPY, THB)') || '').trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(code)) { sel.insertAdjacentHTML('afterbegin', `<option>${code}</option>`); sel.value = code; }
      else sel.value = t.currency;
    };
    $('form', m).onsubmit = (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      Object.assign(e, { amount: parseFloat(String(f.amount).replace(',', '.')) || 0, currency: f.currency, label: f.label.trim(), category: f.category || 'other', date: f.date, stepId: f.stepId });
      if (e.currency !== t.currency && !(e.currency in t.rates)) { t.rates[e.currency] = null; svc.fetchRates(t.currency, [e.currency]).then((r) => { Object.assign(t.rates, r); commit({ map: false }); }).catch(() => toast(`Pensez à saisir le taux ${e.currency} dans le budget`)); }
      if (isNew) t.expenses.push(e);
      closeModal();
      commit({ map: false });
      toast(isNew ? 'Dépense ajoutée' : 'Dépense modifiée');
    };
  });
}
A['add-expense'] = () => expenseModal();
A['edit-expense'] = (el) => expenseModal(T().expenses.find((e) => e.id === el.dataset.id));
A['del-expense'] = (el) => {
  const t = T();
  const notify = undoable('Dépense supprimée');
  t.expenses = t.expenses.filter((e) => e.id !== el.dataset.id);
  closeModal();
  commit({ map: false });
  notify();
};

// =====================================================================
// Onglet Listes (bagages, préparatifs…) + note générale
// =====================================================================
const listProgress = (l) => {
  const n = l.items.length, d = l.items.filter((x) => x.done).length;
  return { n, d, pct: n ? (d / n) * 100 : 0 };
};
const fmtDue = (dt) => `${fmtDay(dt.slice(0, 10), { weekday: 'short', day: 'numeric', month: 'short' })}${fmtTime(dt) ? ' ' + fmtTime(dt) : ''}`;

function renderLists(t) {
  const sub = ui.listsTab || 'lists';
  const all = t.checklists.flatMap((l) => l.items);
  const done = all.filter((x) => x.done).length;
  return `<div class="lists">
    <div class="seg" role="tablist">
      <button class="${sub === 'lists' ? 'on' : ''}" data-act="lists-tab" data-k="lists" role="tab">✅ Listes <small>${done}/${all.length}</small></button>
      <button class="${sub === 'notes' ? 'on' : ''}" data-act="lists-tab" data-k="notes" role="tab">📝 Note générale${t.notes ? ' <small>•</small>' : ''}</button>
    </div>
    ${sub === 'notes' ? `
      <div class="card notes-card">
        <textarea id="trip-notes" rows="18" placeholder="Idées, numéros utiles, infos pays, phrases à connaître, codes…">${esc(t.notes)}</textarea>
        <p class="hint">Enregistré automatiquement.</p>
      </div>` : `
      <div class="list-new">
        <button class="btn primary" data-act="new-list">＋ Nouvelle liste</button>
        <select id="tpl-pick" aria-label="Ajouter un modèle de liste"><option value="">Ajouter un modèle…</option>${Object.keys(templates()).map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}<option value="__manage">⚙️ Gérer mes modèles…</option></select>
      </div>
      ${t.checklists.map(listHTML).join('') || '<div class="empty"><div class="empty-ic">✅</div><p>Aucune liste. Créez-en une ou partez d’un modèle.</p></div>'}`}
  </div>`;
}

function listHTML(l) {
  const p = listProgress(l);
  return `<div class="card list ${l.collapsed ? 'collapsed' : ''}" data-list="${l.id}">
    <div class="list-head">
      <button class="icon-btn sm fold" data-act="list-fold" data-id="${l.id}" aria-label="${l.collapsed ? 'Déplier' : 'Replier'}" aria-expanded="${!l.collapsed}">${l.collapsed ? '▸' : '▾'}</button>
      <input class="list-title" value="${esc(l.name)}" data-list-title="${l.id}" aria-label="Nom de la liste">
      <small class="${p.n && p.d === p.n ? 'ok-txt' : ''}">${p.n && p.d === p.n ? '✓ ' : ''}${p.d}/${p.n}</small>
      <button class="icon-btn sm" data-act="list-menu" data-id="${l.id}" aria-label="Options de la liste">⋯</button>
    </div>
    <div class="bar ${p.n && p.d === p.n ? 'full' : ''}"><i style="width:${p.pct}%"></i></div>
    ${l.collapsed ? '' : `
      <div class="items" data-items="${l.id}">${l.items.map((x) => itemHTML(l, x)).join('')}</div>
      <form class="quick-add" data-list-add="${l.id}"><input placeholder="Ajouter un élément…" data-keep="add-${l.id}" enterkeyhint="done" aria-label="Nouvel élément"><button class="btn sm">＋</button></form>`}
  </div>`;
}

function itemHTML(l, x) {
  const open = ui.open.has(x.id);
  const subs = x.subs || [];
  const sd = subs.filter((s) => s.done).length;
  const late = x.due && !x.done && new Date(x.due) < new Date();
  return `<div class="item ${x.done ? 'done' : ''} ${open ? 'open' : ''}" data-item="${x.id}">
    <div class="item-row">
      <span class="drag sm" aria-hidden="true">⋮⋮</span>
      <input type="checkbox" class="chk" data-act="toggle-item" data-list="${l.id}" data-id="${x.id}" ${x.done ? 'checked' : ''} aria-label="Fait">
      <span class="item-main">
      <input class="item-text" value="${esc(x.text)}" data-item-text="${x.id}" data-list="${l.id}" aria-label="Élément">
      <span class="item-badges">
        ${subs.length ? `<span class="chip ${sd === subs.length ? 'ok' : ''}">${sd}/${subs.length}</span>` : ''}
        ${x.note ? '<span class="chip" title="Note">📝</span>' : ''}
        ${x.due ? `<span class="chip ${late ? 'late' : x.done ? '' : 'warn'}" title="Échéance">⏰ ${fmtDue(x.due)}</span>` : ''}
      </span>
      </span>
      <button class="icon-btn sm more" data-act="item-open" data-id="${x.id}" aria-label="Détails" aria-expanded="${open}">${open ? '▴' : '▾'}</button>
    </div>
    ${open ? `<div class="item-body">
      <div class="subitems">
        ${subs.map((s) => `<div class="subitem ${s.done ? 'done' : ''}">
          <input type="checkbox" class="chk" data-act="toggle-subitem" data-list="${l.id}" data-item="${x.id}" data-id="${s.id}" ${s.done ? 'checked' : ''} aria-label="Fait">
          <input class="item-text" value="${esc(s.text)}" data-subitem-text="${s.id}" data-item="${x.id}" data-list="${l.id}" aria-label="Sous-élément">
          <button class="icon-btn sm" data-act="del-subitem" data-list="${l.id}" data-item="${x.id}" data-id="${s.id}" aria-label="Supprimer">✕</button>
        </div>`).join('')}
        <form class="quick-add sm" data-subitem-add="${x.id}" data-list="${l.id}"><input placeholder="＋ Ajouter un sous-élément…" data-keep="sub-${x.id}" enterkeyhint="done" aria-label="Nouveau sous-élément"></form>
      </div>
      <label class="fld"><span>Note</span><textarea rows="2" data-item-note="${x.id}" data-list="${l.id}" placeholder="Détails, lien, taille, quantité…">${esc(x.note || '')}</textarea></label>
      <div class="due-row">
        <label class="fld"><span>⏰ Échéance & rappel</span><input type="datetime-local" data-item-due="${x.id}" data-list="${l.id}" value="${x.due || ''}"></label>
        ${x.due ? `<button class="btn sm" data-act="item-ics" data-list="${l.id}" data-id="${x.id}" title="Rappel fiable même app fermée">📅 Ajouter à l’agenda</button><button class="btn sm ghost" data-act="item-due-clear" data-list="${l.id}" data-id="${x.id}">Retirer</button>` : ''}
      </div>
      <div class="row-btns"><span class="spacer"></span><button class="btn sm danger" data-act="del-item" data-list="${l.id}" data-id="${x.id}">Supprimer l’élément</button></div>
    </div>` : ''}
  </div>`;
}

function mountLists(t, p) {
  const notes = $('#trip-notes', p);
  if (notes) { notes.oninput = debounce(() => { t.notes = notes.value; touch(); save(); }, 300); return; }
  const rerender = (focusSel) => { commit({ map: false, header: false }); if (focusSel) $(focusSel)?.focus(); };
  $$('[data-list-add]', p).forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const text = $('input', f).value.trim();
    if (!text) return;
    findList(f.dataset.listAdd).items.push({ id: uid(), text, done: false, note: '', due: '', subs: [] });
    rerender(`[data-list-add="${f.dataset.listAdd}"] input`);
  }));
  $$('[data-subitem-add]', p).forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const text = $('input', f).value.trim();
    if (!text) return;
    const it = findItem(f.dataset.list, f.dataset.subitemAdd);
    (it.subs ||= []).push({ id: uid(), text, done: false });
    it.done = false;
    rerender(`[data-subitem-add="${it.id}"] input`);
  }));
  $$('[data-list-title]', p).forEach((el) => (el.onchange = () => { findList(el.dataset.listTitle).name = el.value.trim() || 'Liste'; touch(); save(); }));
  $$('[data-item-text]', p).forEach((el) => (el.onchange = () => { const it = findItem(el.dataset.list, el.dataset.itemText); it.text = el.value.trim() || it.text; touch(); save(); }));
  $$('[data-subitem-text]', p).forEach((el) => (el.onchange = () => {
    const s = findItem(el.dataset.list, el.dataset.item).subs.find((x) => x.id === el.dataset.subitemText);
    s.text = el.value.trim() || s.text; touch(); save();
  }));
  $$('[data-item-note]', p).forEach((el) => (el.oninput = debounce(() => { findItem(el.dataset.list, el.dataset.itemNote).note = el.value; touch(); save(); }, 300)));
  $$('[data-item-due]', p).forEach((el) => (el.onchange = () => {
    const it = findItem(el.dataset.list, el.dataset.itemDue);
    it.due = el.value;
    it.notified = false;
    if (it.due) askNotifPermission();
    rerender();
  }));
  $('#tpl-pick', p)?.addEventListener('change', (e) => {
    const k = e.target.value;
    if (!k) return;
    if (k === '__manage') { e.target.value = ''; return manageTemplates(); }
    t.checklists.unshift({ id: uid(), name: k, collapsed: false, items: (templates()[k] || []).map((text) => ({ id: uid(), text, done: false, note: '', due: '', subs: [] })) });
    rerender();
    toast(`Liste « ${esc(k)} » ajoutée`);
  });
  $$('[data-items]', p).forEach((el) => window.Sortable && Sortable.create(el, {
    handle: '.drag', draggable: '.item', animation: 150, ghostClass: 'ghost',
    onEnd: () => {
      const l = findList(el.dataset.items);
      const order = $$(':scope > [data-item]', el).map((x) => x.dataset.item);
      l.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      touch(); save();
    },
  }));
}

// ---------- Modèles de listes (modifiables, partagés entre tous les voyages)
function templates() {
  state.settings.templates ||= clone(LIST_TEMPLATES);
  return state.settings.templates;
}
function manageTemplates() {
  const tp = templates();
  const names = Object.keys(tp);
  openModal(`
    <h2>⚙️ Mes modèles de listes</h2>
    <p class="hint">Vos modèles servent à créer une liste en un geste dans n’importe quel voyage.</p>
    <div class="tpl-list">${names.map((n, i) => `<div class="tpl-row">
      <div><b>${esc(n)}</b><small>${plural(tp[n].length, 'élément')}</small></div>
      <button class="btn sm" data-act="tpl-edit" data-i="${i}">Modifier</button>
      <button class="icon-btn sm" data-act="tpl-del" data-i="${i}" aria-label="Supprimer le modèle">🗑</button>
    </div>`).join('') || '<p class="muted">Aucun modèle.</p>'}</div>
    <div class="actions"><button class="btn" data-act="tpl-new">＋ Nouveau modèle</button><span class="spacer"></span><button class="btn primary" data-act="close-modal">Terminé</button></div>`);
}
function editTemplate(name) {
  const tp = templates();
  openModal(`
    <h2>${name ? 'Modifier le modèle' : 'Nouveau modèle'}</h2>
    <form class="form" id="tpl-form">
      <label class="fld"><span>Nom du modèle</span><input id="tpl-name" value="${esc(name || '')}" placeholder="ex : Ski, Plage, Bébé à bord…" required></label>
      <label class="fld"><span>Éléments (un par ligne)</span><textarea id="tpl-items" rows="10" placeholder="Passeport&#10;Chargeur&#10;Crème solaire">${esc((tp[name] || []).join('\n'))}</textarea></label>
      <div class="actions"><button type="button" class="btn" data-act="tpl-manage">‹ Retour</button><span class="spacer"></span><button class="btn primary">Enregistrer</button></div>
    </form>`, (m) => {
    $('#tpl-form', m).onsubmit = (e) => {
      e.preventDefault();
      const nn = $('#tpl-name', m).value.trim();
      const items = $('#tpl-items', m).value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (!nn) return;
      if (name && name !== nn) delete tp[name];
      tp[nn] = items;
      save();
      toast('Modèle enregistré ✓');
      manageTemplates();
      if (ui.tab === 'lists') renderPanel();
    };
  });
}
A['tpl-manage'] = () => manageTemplates();
A['tpl-new'] = () => editTemplate('');
A['tpl-edit'] = (el) => editTemplate(Object.keys(templates())[+el.dataset.i]);
A['tpl-del'] = (el) => {
  const tp = templates();
  const n = Object.keys(tp)[+el.dataset.i];
  if (!confirm(`Supprimer le modèle « ${n} » ?`)) return;
  delete tp[n];
  save();
  manageTemplates();
  if (ui.tab === 'lists') renderPanel();
};
A['list-save-tpl'] = (el) => {
  const l = findList(el.dataset.id);
  templates()[l.name] = l.items.map((x) => x.text);
  save();
  closeModal();
  toast(`« ${esc(l.name)} » enregistré dans vos modèles ✓`);
};

const findList = (id) => T().checklists.find((l) => l.id === id);
const findItem = (lid, iid) => findList(lid).items.find((x) => x.id === iid);
const listCommit = () => commit({ map: false, header: false });

A['lists-tab'] = (el) => { ui.listsTab = el.dataset.k; renderPanel(); $('#panel').scrollTop = 0; };
A['list-fold'] = (el) => { const l = findList(el.dataset.id); l.collapsed = !l.collapsed; listCommit(); };
A['item-open'] = (el) => { ui.open.has(el.dataset.id) ? ui.open.delete(el.dataset.id) : ui.open.add(el.dataset.id); renderPanel(); };
A['toggle-item'] = (el) => {
  const it = findItem(el.dataset.list, el.dataset.id);
  it.done = el.checked;
  (it.subs || []).forEach((s) => (s.done = el.checked));
  listCommit();
};
A['toggle-subitem'] = (el) => {
  const it = findItem(el.dataset.list, el.dataset.item);
  it.subs.find((s) => s.id === el.dataset.id).done = el.checked;
  it.done = it.subs.every((s) => s.done);
  listCommit();
};
A['del-item'] = (el) => {
  const l = findList(el.dataset.list);
  const notify = undoable('Élément supprimé');
  l.items = l.items.filter((x) => x.id !== el.dataset.id);
  listCommit();
  notify();
};
A['del-subitem'] = (el) => {
  const it = findItem(el.dataset.list, el.dataset.item);
  it.subs = it.subs.filter((s) => s.id !== el.dataset.id);
  listCommit();
};
A['item-due-clear'] = (el) => { const it = findItem(el.dataset.list, el.dataset.id); it.due = ''; it.notified = false; listCommit(); };
A['item-ics'] = (el) => {
  const it = findItem(el.dataset.list, el.dataset.id);
  const dt = (s) => s.replace(/[-:]/g, '').slice(0, 13) + '00';
  const end = new Date(new Date(it.due).getTime() + 30 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const icsEsc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Voyage//FR', 'BEGIN:VEVENT', `UID:${it.id}@voyage`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${dt(it.due)}`, `DTEND:${dt(end)}`, `SUMMARY:${icsEsc('⏰ ' + it.text)}`, it.note ? `DESCRIPTION:${icsEsc(it.note)}` : '',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(it.text)}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  download(`rappel-${slug(it.text)}.ics`, ics, 'text/calendar');
};
A['new-list'] = () => {
  const l = { id: uid(), name: 'Nouvelle liste', collapsed: false, items: [] };
  T().checklists.unshift(l);
  listCommit();
  const input = $(`[data-list-title="${l.id}"]`);
  input?.focus();
  input?.select();
};
A['list-menu'] = (el) => {
  const l = findList(el.dataset.id);
  openModal(`<h2>${esc(l.name)}</h2>
    <div class="menu">
      <button class="menu-i" data-act="list-uncheck" data-id="${l.id}">↺ Tout décocher (réutiliser la liste)</button>
      <button class="menu-i" data-act="list-save-tpl" data-id="${l.id}">💾 Enregistrer comme modèle</button>
      <button class="menu-i" data-act="list-copy" data-id="${l.id}">⧉ Copier vers un autre voyage</button>
      <button class="menu-i danger" data-act="list-del" data-id="${l.id}">🗑 Supprimer la liste</button>
    </div>`);
};
A['list-uncheck'] = (el) => {
  findList(el.dataset.id).items.forEach((x) => { x.done = false; (x.subs || []).forEach((s) => (s.done = false)); });
  closeModal(); listCommit();
};
A['list-del'] = (el) => {
  const t = T();
  const notify = undoable('Liste supprimée');
  t.checklists = t.checklists.filter((l) => l.id !== el.dataset.id);
  closeModal(); listCommit(); notify();
};
A['list-copy'] = (el) => {
  const l = findList(el.dataset.id);
  const others = state.trips.filter((x) => x.id !== ui.tripId);
  if (!others.length) return toast('Aucun autre voyage');
  openModal(`<h2>Copier « ${esc(l.name)} » vers…</h2><div class="menu">${others.map((o) => `<button class="menu-i" data-act="list-copy-to" data-list="${l.id}" data-id="${o.id}">${esc(o.emoji)} ${esc(o.name)}</button>`).join('')}</div>`);
};
A['list-copy-to'] = (el) => {
  const l = clone(findList(el.dataset.list));
  l.id = uid();
  l.items.forEach((x) => { x.id = uid(); x.done = false; x.notified = false; (x.subs || []).forEach((s) => { s.id = uid(); s.done = false; }); });
  getTrip(el.dataset.id).checklists.push(l);
  save(); closeModal(); toast('Liste copiée');
};

// ---------- Rappels (échéances des listes)
function askNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
async function notify(title, body) {
  toast(`⏰ <b>${esc(title)}</b>${body ? ' · ' + esc(body) : ''}`, { ms: 9000 });
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: title });
    else new Notification(title, { body, icon: 'icons/icon-192.png' });
  } catch { /* notification refusée */ }
}
function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const t of state.trips) for (const l of t.checklists) for (const it of l.items) {
    if (it.due && !it.done && !it.notified && new Date(it.due).getTime() <= now) {
      it.notified = true;
      changed = true;
      notify(it.text, `${t.emoji} ${t.name} · ${l.name}`);
    }
  }
  if (changed) { save(); if (ui.tab === 'lists') renderPanel(); }
}

// =====================================================================
// Onglet Documents (scan avec l'appareil photo, fichiers, plusieurs pages)
// =====================================================================
const docFiles = (d) => d.files || [];
const thumbCache = new Map();

function renderDocs(t) {
  const end = tripEnd(t);
  return `<div class="docs">
    <div class="doc-add">
      <label class="doc-btn primary"><span>📷</span><b>Scanner</b><small>avec l’appareil photo</small><input type="file" accept="image/*" capture="environment" data-doc-new="scan" hidden></label>
      <label class="doc-btn"><span>📁</span><b>Fichiers</b><small>PDF, photos…</small><input type="file" accept="image/*,application/pdf" multiple data-doc-new="files" hidden></label>
      <button class="doc-btn" data-act="add-doc"><span>✍️</span><b>Saisir</b><small>n°, date, note</small></button>
    </div>
    ${t.documents.map((d) => { const ty = DOC_TYPES[d.type] || DOC_TYPES.other; const exp = d.expiry && end && d.expiry < addDays(end, d.type === 'passport' ? 180 : 0); const f = docFiles(d);
      return `<button class="card doc" data-act="edit-doc" data-id="${d.id}">
        ${f[0]?.type?.startsWith('image/') ? `<img class="doc-thumb" data-thumb="${f[0].id}" alt="">` : `<span class="doc-ic">${f[0] ? '📄' : ty.icon}</span>`}
        <span class="doc-main">
          <b>${esc(d.name || ty.label)}</b>
          <small>${ty.icon} ${ty.label}${d.number ? ` · <span class="mono">${esc(d.number)}</span>` : ''}</small>
          ${d.stayId ? (() => { const s = t.steps.find((x) => x.stays.some((y) => y.id === d.stayId)); const st = s?.stays.find((y) => y.id === d.stayId); return st ? `<small>🛏️ ${esc(st.name || 'Hébergement')} · ${esc(s.name)}</small>` : ''; })() : ''}
          ${d.expiry ? `<small class="${exp ? 'warn-txt' : ''}">Expire le ${fmtDay(d.expiry, { day: 'numeric', month: 'short', year: 'numeric' })}${exp ? ' ⚠️' : ''}</small>` : ''}
        </span>
        ${f.length ? `<span class="chip">${plural(f.length, 'page')}</span>` : ''}
      </button>`; }).join('') || '<div class="empty"><div class="empty-ic">🗂️</div><p>Scannez vos papiers ou ajoutez vos PDF : ils restent sur votre téléphone, consultables hors-ligne.</p></div>'}
  </div>`;
}

function mountDocs(t, p) {
  $$('[data-doc-new]', p).forEach((input) => (input.onchange = async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const scan = input.dataset.docNew === 'scan';
    const d = { id: uid(), name: scan ? `Scan du ${fmtDay(todayStr(), { day: 'numeric', month: 'short' })}` : files[0].name.replace(/\.[^.]+$/, ''), type: 'other', number: '', expiry: '', notes: '', files: [] };
    await addDocFiles(d, files, scan);
    t.documents.unshift(d);
    commit({ map: false });
    docModal(d, true);
  }));
  loadThumbs(p);
}

async function loadThumbs(root) {
  for (const img of $$('img[data-thumb]', root)) {
    const id = img.dataset.thumb;
    if (!thumbCache.has(id)) {
      const blob = await getFile(id).catch(() => null);
      if (!blob) { img.remove(); continue; }
      thumbCache.set(id, URL.createObjectURL(blob));
    }
    img.src = thumbCache.get(id);
  }
}

// Recadrage des niveaux pour un rendu "document scanné" lisible
async function enhanceScan(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height), px = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 16) hist[(px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0]++;
    const total = px.length / 16;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < total * 0.02) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < total * 0.05) hi--;
    if (hi - lo > 30) {
      const s = 255 / (hi - lo);
      for (let i = 0; i < px.length; i += 4) for (let j = 0; j < 3; j++) px[i + j] = Math.max(0, Math.min(255, (px[i + j] - lo) * s));
      g.putImageData(img, 0, 0);
    }
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85));
  } catch {
    return file;
  }
}

async function addDocFiles(d, files, scan = false) {
  d.files ||= [];
  for (const f of files) {
    try {
      const blob = f.type.startsWith('image/') ? (scan ? await enhanceScan(f) : await compressImage(f, 2400, 0.88)) : f;
      const id = await putFile(blob);
      d.files.push({ id, name: f.name || 'scan.jpg', type: blob.type || f.type });
    } catch (err) {
      toast(esc(err.message || 'Impossible d’enregistrer le fichier'));
    }
  }
}

function docModal(d, isNew = false) {
  const t = T();
  const f = docFiles(d);
  openModal(`
    <h2>${isNew ? 'Nouveau document' : 'Document'}</h2>
    <div class="form" data-scope id="f-doc">
      <div class="doc-pages">
        ${f.map((x, i) => `<div class="doc-page">
          <button class="doc-page-open" data-act="view-doc" data-doc="${d.id}" data-i="${i}" aria-label="Voir la page ${i + 1}">${x.type?.startsWith('image/') ? `<img data-thumb="${x.id}" alt="">` : '<span>📄<small>PDF</small></span>'}</button>
          <button class="icon-btn sm doc-page-del" data-act="del-doc-file" data-doc="${d.id}" data-id="${x.id}" aria-label="Retirer cette page">✕</button>
        </div>`).join('')}
        <label class="doc-page add"><span>📷<small>Scanner</small></span><input type="file" accept="image/*" capture="environment" data-doc-add="scan" hidden></label>
        <label class="doc-page add"><span>📁<small>Fichier</small></span><input type="file" accept="image/*,application/pdf" multiple data-doc-add="files" hidden></label>
      </div>
      <label class="fld"><span>Nom</span><input data-f="name" placeholder="ex : Passeport, Billet aller, Assurance…" ${isNew ? '' : ''}></label>
      <div class="pills">${Object.entries(DOC_TYPES).map(([k, v]) => `<label class="pill"><input type="radio" name="dtype" data-f="type" value="${k}"><span>${v.icon} ${v.label}</span></label>`).join('')}</div>
      <div class="grid2">
        <label class="fld"><span>Numéro / référence</span><input data-f="number"></label>
        <label class="fld"><span>Date d’expiration</span><input type="date" data-f="expiry"></label>
      </div>
      <label class="fld"><span>Notes</span><textarea rows="2" data-f="notes"></textarea></label>
      <label class="check doc-private"><input type="checkbox" data-f="private"> Visible uniquement par moi <small>(jamais envoyé à mes compagnons de voyage)</small></label>
    </div>
    <div class="actions">
      <button type="button" class="btn danger" data-act="del-doc" data-id="${d.id}">Supprimer</button>
      <span class="spacer"></span>
      <button class="btn primary" data-act="doc-done" data-id="${d.id}">Terminé</button>
    </div>`, (m) => {
    bindFields($('#f-doc', m), d, () => refresh({ map: false, header: false }));
    loadThumbs(m);
    $$('[data-doc-add]', m).forEach((input) => (input.onchange = async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      await addDocFiles(d, files, input.dataset.docAdd === 'scan');
      commit({ map: false });
      docModal(d, isNew);
    }));
  });
}

A['add-doc'] = () => {
  const t = T();
  const d = { id: uid(), name: '', type: 'passport', number: '', expiry: '', notes: '', files: [], private: true };
  t.documents.unshift(d);
  commit({ map: false });
  docModal(d, true);
};
A['edit-doc'] = (el) => docModal(T().documents.find((d) => d.id === el.dataset.id));
A['doc-done'] = (el) => {
  const t = T();
  const d = t.documents.find((x) => x.id === el.dataset.id);
  // Un document resté vide est retiré
  if (d && !d.name && !d.number && !d.notes && !docFiles(d).length) t.documents = t.documents.filter((x) => x !== d);
  closeModal();
  commit({ map: false });
};
A['del-doc'] = (el) => {
  const t = T();
  const d = t.documents.find((x) => x.id === el.dataset.id);
  const notify = undoable('Document supprimé');
  t.documents = t.documents.filter((x) => x !== d);
  closeModal();
  commit({ map: false });
  notify();
};
A['del-doc-file'] = (el) => {
  const d = T().documents.find((x) => x.id === el.dataset.doc);
  d.files = docFiles(d).filter((x) => x.id !== el.dataset.id);
  delFile(el.dataset.id);
  commit({ map: false });
  docModal(d);
};
A['del-stay-file'] = (el) => {
  const t = T();
  const d = t.documents.find((x) => x.id === el.dataset.doc);
  d.files = docFiles(d).filter((x) => x.id !== el.dataset.id);
  delFile(el.dataset.id);
  if (!d.files.length && !d.notes) t.documents = t.documents.filter((x) => x !== d);
  commit({ map: false });
  renderDrawer();
};

A['view-doc'] = async (el) => {
  const d = T().documents.find((x) => x.id === el.dataset.doc);
  const f = docFiles(d)[+el.dataset.i];
  const blob = await getFile(f.id).catch(() => null);
  if (!blob) return toast('Fichier introuvable sur cet appareil');
  const url = URL.createObjectURL(blob);
  if (!blob.type.startsWith('image/')) { window.open(url, '_blank'); return; }
  openModal(`<div class="viewer"><img src="${url}" alt="${esc(d.name)}"></div>
    <div class="actions"><button class="btn" data-act="edit-doc" data-id="${d.id}">‹ Retour</button><span class="spacer"></span><button class="btn primary" data-act="close-modal">Fermer</button></div>`, null, 'wide');
};

// =====================================================================
// Souvenirs : photos du voyage (placées automatiquement sur la bonne étape)
// =====================================================================

// Lecture minimale des métadonnées EXIF d'un JPEG : date de prise de vue + GPS
async function readExif(file) {
  try {
    if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name || '')) return {};
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off < v.byteLength - 10) {
      const marker = v.getUint16(off), size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch { /* EXIF illisible */ }
  return {};
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const readIFD = (o) => {
    const tags = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) { const e = o + 2 + i * 12; tags[u16(e)] = { count: u32(e + 4), at: e + 8 }; }
    return tags;
  };
  const ascii = (tag) => {
    const o = tag.count > 4 ? start + u32(tag.at) : tag.at;
    let s = '';
    for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(o + i));
    return s;
  };
  const rat = (o) => u32(o) / (u32(o + 4) || 1);
  const out = {};
  const ifd0 = readIFD(start + u32(start + 4));
  if (ifd0[0x8769]) {
    const ex = readIFD(start + u32(ifd0[0x8769].at));
    if (ex[0x9003]) out.date = ascii(ex[0x9003]);
  }
  if (!out.date && ifd0[0x0132]) out.date = ascii(ifd0[0x0132]);
  if (ifd0[0x8825]) {
    const g = readIFD(start + u32(ifd0[0x8825].at));
    if (g[2] && g[4]) {
      const dms = (tag) => { const o = start + u32(tag.at); return rat(o) + rat(o + 8) / 60 + rat(o + 16) / 3600; };
      let lat = dms(g[2]), lng = dms(g[4]);
      if (g[1] && String.fromCharCode(v.getUint8(g[1].at)) === 'S') lat = -lat;
      if (g[3] && String.fromCharCode(v.getUint8(g[3].at)) === 'W') lng = -lng;
      if (isFinite(lat) && isFinite(lng) && (lat || lng)) { out.lat = lat; out.lng = lng; }
    }
  }
  if (out.date) {
    const m = out.date.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/);
    out.t = m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
  }
  return out;
}

async function makeThumb(file, max = 360) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.min(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return { blob: await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72)), w: bmp.width, h: bmp.height };
}

// Trouve l'étape d'une photo : par sa date, sinon par sa position, sinon l'étape du jour
function stepForPhoto(t, { t: when, lat, lng }) {
  if (when) {
    const i = currentStepIdx(t, toDayStr(when));
    if (i >= 0) return t.steps[i];
  }
  if (lat != null) {
    let best = null, bd = Infinity;
    for (const s of t.steps) if (s.place) { const d = haversine(s.place, { lat, lng }); if (d < bd) { bd = d; best = s; } }
    if (best && bd < 150) return best;
  }
  return t.steps[currentStepIdx(t)] || t.steps.at(-1) || null;
}
const toDayStr = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const stepPhotos = (t, s, leg = false) => t.photos.filter((p) => p.stepId === s.id && !!p.onLeg === leg).sort((a, b) => a.t - b.t);
const isVideo = (p) => p.kind === 'video';

// Vignette d'une vidéo : une image prise au début du film
async function videoThumb(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 5000); });
  try { v.currentTime = Math.min(0.4, (v.duration || 1) / 2); await new Promise((r) => { v.onseeked = r; setTimeout(r, 1500); }); } catch { /* image 0 */ }
  const w = v.videoWidth || 640, h = v.videoHeight || 360;
  const k = Math.min(1, 360 / Math.min(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext('2d');
  g.fillStyle = '#7a2436'; g.fillRect(0, 0, c.width, c.height);
  try { g.drawImage(v, 0, 0, c.width, c.height); } catch { /* format non lisible ici */ }
  URL.revokeObjectURL(url);
  return { blob: await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72)), w, h, duration: isFinite(v.duration) ? v.duration : null };
}
const fmtClip = (sec) => (sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '');

async function addPhotos(files, { stepId = null, onLeg = false, day = null } = {}) {
  const t = T();
  if (!files.length) return [];
  const added = [];
  toast(`Ajout de ${plural(files.length, 'élément')}…`, { ms: 2000 });
  for (const f of files) {
    const video = f.type.startsWith('video/');
    if (!video && !f.type.startsWith('image/')) continue;
    try {
      const ex = video ? {} : await readExif(f);
      let lat = ex.lat ?? null, lng = ex.lng ?? null;
      // Prise de vue à l'instant (fichier tout juste créé) : on utilise la position actuelle
      const fresh = Date.now() - (f.lastModified || 0) < 120_000;
      if (lat == null && fresh) {
        try { const me = ui.me || (await getPositionOnce(6000)); lat = me.lat; lng = me.lng; } catch { /* sans position */ }
      }
      const when = ex.t || f.lastModified || Date.now();
      let p;
      if (video) {
        const th = await videoThumb(f);
        p = { id: uid(), kind: 'video', mime: f.type, fileId: await putFile(f), thumbId: await putFile(th.blob), w: th.w, h: th.h, duration: th.duration, size: f.size, t: when, lat, lng, caption: '', stepId: null, addedAt: Date.now() };
      } else {
        const full = await compressImage(f, 2400, 0.88);
        const th = await makeThumb(f);
        p = { id: uid(), fileId: await putFile(full), thumbId: await putFile(th.blob), w: th.w, h: th.h, t: when, lat, lng, caption: '', stepId: null, addedAt: Date.now() };
      }
      if (onLeg) p.onLeg = true;
      if (day && toDayStr(p.t) !== day) p.day = day; // ajoutée depuis une journée : rangée dans cette journée
      const s = stepId ? t.steps.find((x) => x.id === stepId) : stepForPhoto(t, p);
      p.stepId = s?.id || null;
      if (p.lat == null && s?.place) { p.lat = s.place.lat; p.lng = s.place.lng; p.approx = true; }
      t.photos.push(p);
      added.push(p);
    } catch (e) {
      toast(`${f.type.startsWith('video/') ? 'Vidéo' : 'Photo'} ignorée : ${esc(e.message || 'format non pris en charge')}`);
    }
  }
  commit();
  if (added.length) {
    const names = [...new Set(added.map((p) => t.steps.find((s) => s.id === p.stepId)?.name).filter(Boolean))];
    const nv = added.filter(isVideo).length, np = added.length - nv;
    toast(`📸 ${[np && plural(np, 'photo ajoutée', 'photos ajoutées'), nv && plural(nv, 'vidéo ajoutée', 'vidéos ajoutées')].filter(Boolean).join(' et ')}`, {
      undo: () => { const ids = new Set(added.map((p) => p.id)); t.photos = t.photos.filter((p) => !ids.has(p.id)); added.forEach((p) => { delFile(p.fileId); delFile(p.thumbId); }); commit(); if (ui.drawer) renderDrawer(); },
    });
  }
  if (ui.drawer) renderDrawer();
  return added;
}

// Boutons d'ajout (appareil photo / galerie) partout dans l'app
document.addEventListener('change', async (e) => {
  const input = e.target.closest?.('[data-ph-add]');
  if (!input) return;
  const files = [...input.files];
  input.value = '';
  await addPhotos(files, { stepId: input.dataset.step || null, onLeg: input.dataset.leg === '1', day: input.dataset.day || null });
});

function photoStripHTML(t, s, max = 4) {
  const ph = stepPhotos(t, s);
  if (!ph.length) return '';
  return `<div class="ph-strip">${ph.slice(0, max).map((p, i) => `<button class="ph-mini ${isVideo(p) ? 'vid' : ''}" data-act="view-photo" data-id="${p.id}"><img data-thumb="${p.thumbId}" alt="">${i === max - 1 && ph.length > max ? `<b>+${ph.length - max}</b>` : ''}</button>`).join('')}</div>`;
}

function photosPaneHTML(t, s, leg = false, day = null) {
  const ph = stepPhotos(t, s, leg).filter((p) => !day || photoDay(p) === day);
  return `
    <div class="ph-grid">
      <label class="ph add"><span>＋</span><small>Photo / vidéo</small><input type="file" accept="image/*,video/*" multiple data-ph-add data-step="${s.id}" data-leg="${leg ? 1 : 0}" data-day="${day || ''}" hidden></label>
      ${ph.map((p) => `<button class="ph ${isVideo(p) ? 'vid' : ''}" data-act="view-photo" data-id="${p.id}" aria-label="${isVideo(p) ? 'Voir la vidéo' : 'Voir la photo'}"><img data-thumb="${p.thumbId}" alt="${esc(p.caption)}">${isVideo(p) ? `<em>▶ ${fmtClip(p.duration)}</em>` : ''}${p.caption ? '<i>Aa</i>' : ''}</button>`).join('')}
    </div>
    <p class="hint">Touchez <b>＋</b> : choisissez dans votre photothèque, ou prenez une photo ou une vidéo.</p>
    <label class="fld"><span>${leg ? 'Récit du trajet' : 'Récit de l’étape'}</span><textarea data-f="${leg ? 'transport.story' : 'story'}" rows="6" placeholder="${leg ? 'La route, les paysages, les pauses, les galères…' : 'Racontez ce moment : ce que vous avez vu, mangé, ressenti…'} Vos amis le verront avec les photos."></textarea></label>`;
}

// ---------- Visionneuse plein écran
function viewPhoto(id) {
  const t = T();
  const p = t.photos.find((x) => x.id === id);
  if (!p) return;
  const s = t.steps.find((x) => x.id === p.stepId);
  const list = s ? stepPhotos(t, s, !!p.onLeg) : t.photos;
  const i = list.indexOf(p);
  const when = new Date(p.t).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  openModal(`
    <div class="lb" id="lb">
      <div class="lb-img">${isVideo(p) ? '<video controls playsinline preload="metadata"></video>' : `<img alt="${esc(p.caption)}">`}</div>
      ${i > 0 ? `<button class="lb-nav prev" data-act="view-photo" data-id="${list[i - 1].id}" aria-label="Photo précédente">‹</button>` : ''}
      ${i < list.length - 1 ? `<button class="lb-nav next" data-act="view-photo" data-id="${list[i + 1].id}" aria-label="Photo suivante">›</button>` : ''}
      <button class="lb-close" data-act="close-modal" aria-label="Fermer">✕</button>
      <div class="lb-info" data-scope id="lb-info">
        <div class="lb-meta">${i + 1}/${list.length} · ${when}${s ? ` · ${p.onLeg ? '🛣️ trajet vers' : '📍'} ${esc(s.name)}` : ''}${p.approx ? ' <small>(position approximative)</small>' : ''}</div>
        <input class="lb-caption" data-f="caption" placeholder="Ajouter une légende…" aria-label="Légende">
        <div class="lb-actions">
          <select id="lb-step" aria-label="Étape">${t.steps.map((x) => `<option value="${x.id}" ${x.id === p.stepId ? 'selected' : ''}>${esc(x.name || 'Étape')}</option>`).join('')}</select>
          <button class="btn sm" data-act="photo-cover" data-id="${p.id}">${s?.coverId === p.id ? '★ Couverture' : '☆ Couverture'}</button>
          <button class="btn sm danger" data-act="del-photo" data-id="${p.id}">Supprimer</button>
        </div>
        ${isShared(t) ? `<div id="lb-thread" class="lb-thread" data-id="${p.id}"></div>` : ''}
      </div>
    </div>`, async (m) => {
    m.closest('#modal-root').classList.add('dark');
    renderLbThread();
    bindFields($('#lb-info', m), p, () => refresh({ map: false, header: false }));
    $('#lb-step', m).onchange = (e) => { p.stepId = e.target.value; commit(); viewPhoto(p.id); if (ui.drawer) renderDrawer(); };
    const media = $('.lb-img img, .lb-img video', m);
    const th = await getFile(p.thumbId).catch(() => null);
    if (th) media[isVideo(p) ? 'poster' : 'src'] = URL.createObjectURL(th);
    const full = await getFile(p.fileId).catch(() => null);
    if (full) media.src = URL.createObjectURL(full);
    // Balayage gauche / droite
    let x0 = null;
    const box = $('.lb-img', m);
    box.addEventListener('touchstart', (e) => (x0 = e.touches[0].clientX), { passive: true });
    box.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 50) $(`.lb-nav.${dx < 0 ? 'next' : 'prev'}`, m)?.click();
    });
  }, 'lightbox');
}
A['view-photo'] = (el) => viewPhoto(el.dataset.id);
document.addEventListener('keydown', (e) => {
  if (!$('#lb')) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowRight') $('.lb-nav.next')?.click();
  if (e.key === 'ArrowLeft') $('.lb-nav.prev')?.click();
});
A['photo-cover'] = (el) => {
  const t = T();
  const p = t.photos.find((x) => x.id === el.dataset.id);
  const s = t.steps.find((x) => x.id === p.stepId);
  if (!s) return;
  s.coverId = s.coverId === p.id ? null : p.id;
  commit();
  viewPhoto(p.id);
};
A['del-photo'] = (el) => {
  const t = T();
  const p = t.photos.find((x) => x.id === el.dataset.id);
  const notify = undoable('Photo supprimée');
  t.photos = t.photos.filter((x) => x !== p);
  closeModal();
  commit();
  if (ui.drawer) renderDrawer();
  notify();
};


// =====================================================================
// Partage avec les amis (côté voyageur)
// =====================================================================
const fb = {}; // commentaires et j'aime reçus, par voyage
let syncTimer = null;

const isShared = (t) => !!t?.share?.token;
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
};
function newComments(t) {
  const f = fb[t.id];
  if (!f) return 0;
  const seen = t.share?.seenAt || 0;
  return f.comments.filter((c) => !c.is_owner && new Date(c.created_at).getTime() > seen).length;
}

function scheduleSync(t = T(), delay = 12000) {
  if (!isShared(t) || !cloud.cloudReady()) return;
  t.share.dirty = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(t), delay);
}

async function syncNow(t, { silent = true } = {}) {
  if (ui.syncing || !isShared(t) && silent) return;
  if (!navigator.onLine) { if (!silent) toast('Hors-ligne : l’envoi se fera au retour du réseau'); return; }
  ui.syncing = true;
  renderShareStatus();
  try {
    await cloud.publish(t, {
      getFile, start: tripStart(t), end: tripEnd(t), me: ui.me,
      onProgress: (n, tot) => { ui.syncProgress = `${n}/${tot}`; renderShareStatus(); },
    });
    t.share.error = null;
    save();
    if (!silent) toast('✓ Voyage partagé à jour');
  } catch (e) {
    t.share.error = e.message || 'Erreur réseau';
    save();
    if (!silent) toast(`Envoi impossible : ${esc(t.share.error)}`);
  } finally {
    ui.syncing = false;
    ui.syncProgress = null;
    renderShareStatus();
  }
}
addEventListener('online', () => { const t = T(); if (t?.share?.dirty) syncNow(t); });

async function pullFeedback(t = T()) {
  if (!isShared(t) || !cloud.cloudReady() || !navigator.onLine) return;
  try {
    const d = await cloud.fetchShare(t.share.token);
    if (!d) return;
    fb[t.id] = { comments: d.comments || [], likes: d.likes || [] };
    if (t.id === ui.tripId) {
      renderTripHeader(t);
      if ($('#share-modal')) renderShareModal();
      if ($('#lb-thread')) renderLbThread();
    }
  } catch { /* réessai plus tard */ }
}
setInterval(() => document.visibilityState === 'visible' && pullFeedback(), 60000);

function renderShareStatus() {
  const el = $('#share-status');
  const t = T();
  if (!el || !t) return;
  const waiting = t.photos.filter((p) => !p.remote).length;
  el.innerHTML = ui.syncing
    ? `⏳ Envoi en cours${ui.syncProgress ? ` · photo ${ui.syncProgress}` : ''}…`
    : t.share.error ? `⚠️ Dernier envoi échoué (${esc(t.share.error)}) <button class="link" data-act="sync-now">Réessayer</button>`
      : waiting || t.share.dirty ? `🕓 ${waiting ? plural(waiting, 'photo') + ' en attente' : 'Modifications en attente'} <button class="link" data-act="sync-now">Envoyer maintenant</button>`
        : `✓ À jour${t.share.syncedAt ? ' · ' + ago(new Date(t.share.syncedAt).toISOString()) : ''}`;
}
A['sync-now'] = () => syncNow(T(), { silent: false });

function threadHTML(t, target, { compact = false } = {}) {
  const f = fb[t.id];
  const list = (f?.comments || []).filter((c) => c.target === target);
  const roots = list.filter((c) => !c.parent_id);
  const one = (c) => `<div class="cm ${c.is_owner ? 'own' : ''}">
    <div class="cm-b"><b>${esc(c.author)}${c.is_owner ? ' (vous)' : ''}</b><p>${esc(c.body)}</p></div>
    <small>${ago(c.created_at)} · <button class="link" data-act="cm-reply" data-id="${c.id}" data-who="${esc(c.author)}">Répondre</button>${c.is_owner ? '' : ` · <button class="link muted" data-act="cm-del" data-id="${c.id}">Supprimer</button>`}</small>
  </div>`;
  return `<div class="thread">
    ${roots.map((c) => `<div class="cm-th">${one(c)}${list.filter((r) => r.parent_id === c.id).map((r) => `<div class="cm-rep">${one(r)}</div>`).join('')}</div>`).join('') || (compact ? '' : '<p class="muted">Aucun commentaire pour l’instant.</p>')}
    <form class="cm-form" data-target="${target}"><div class="cm-row"><input data-body placeholder="Écrire un commentaire…" maxlength="2000" aria-label="Commentaire"><button class="btn sm primary">Envoyer</button></div><small class="cm-replying" hidden></small></form>
  </div>`;
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('.cm-form');
  if (!form || !T()) return;
  e.preventDefault();
  const t = T();
  const input = $('[data-body]', form);
  const body = input.value.trim();
  if (!body) return;
  try {
    const c = await cloud.addComment(t.share.token, form.dataset.target, form.dataset.parent || null, t.share.author || 'Moi', body);
    (fb[t.id] ||= { comments: [], likes: [] }).comments.push(c);
    input.value = '';
    if ($('#share-modal')) renderShareModal();
    if ($('#lb-thread')) renderLbThread();
  } catch (err) {
    toast(`Envoi impossible : ${esc(err.message || 'réseau')}`);
  }
});
A['cm-reply'] = (el) => {
  const form = el.closest('.thread').querySelector('.cm-form');
  form.dataset.parent = el.dataset.id;
  const r = $('.cm-replying', form);
  r.hidden = false;
  r.textContent = `Réponse à ${el.dataset.who}`;
  $('[data-body]', form).placeholder = `Répondre à ${el.dataset.who}…`;
  $('[data-body]', form).focus();
};
A['cm-del'] = async (el) => {
  const t = T();
  if (!confirm('Supprimer ce commentaire ?')) return;
  try {
    await cloud.deleteComment(t.share.token, el.dataset.id);
    fb[t.id].comments = fb[t.id].comments.filter((c) => c.id !== el.dataset.id && c.parent_id !== el.dataset.id);
    if ($('#share-modal')) renderShareModal();
    if ($('#lb-thread')) renderLbThread();
  } catch { toast('Suppression impossible'); }
};

// Commentaires sous la photo ouverte dans la visionneuse
function renderLbThread() {
  const box = $('#lb-thread');
  const t = T();
  if (!box || !t) return;
  const target = `photo:${box.dataset.id}`;
  const likes = (fb[t.id]?.likes || []).filter((l) => l.target === target);
  box.innerHTML = `<div class="lb-social">❤️ ${likes.length}${likes.length ? ` <small>${likes.map((l) => esc(l.author || 'Anonyme')).slice(0, 4).join(', ')}</small>` : ''}</div>${threadHTML(t, target, { compact: true })}`;
}

A.share = () => {
  const t = T();
  t.share ||= {};
  t.share.seenAt = Date.now();
  save();
  openModal('<div id="share-modal"></div>', () => { renderShareModal(); renderTripHeader(t); pullFeedback(t); });
};

function renderShareModal() {
  const box = $('#share-modal');
  const t = T();
  if (!box || !t) return;
  const sh = t.share || {};
  const pos = sh.position || 'city';
  const ready = cloud.cloudReady();
  const settings = `
    <label class="fld"><span>Votre prénom (affiché à vos amis)</span><input id="sh-author" value="${esc(sh.author || '')}" placeholder="ex : Fanny" maxlength="40"></label>
    <div class="fld"><span>Votre position</span>
      <div class="pills">${[['off', '🙈 Masquée'], ['city', '🏙️ Ville de l’étape'], ['exact', '📍 Position GPS précise']].map(([k, l]) => `<label class="pill"><input type="radio" name="shpos" value="${k}" ${pos === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <small class="hint">${pos === 'exact' ? 'Vos amis voient votre point bleu et votre tracé. À éviter si le lien circule largement.' : pos === 'city' ? 'Recommandé : vos amis voient la ville où vous êtes, jamais votre adresse exacte.' : 'Vos amis voient les étapes passées, sans savoir où vous êtes maintenant.'}</small>
    </div>`;
  const companions = companionsHTML(t, ready);
  if (!isShared(t)) {
    box.innerHTML = `
      <h2>Partager le voyage</h2>
      ${companions}
      <h3 class="share-sec">Amis et famille <small>regardent et commentent</small></h3>
      <p class="share-pitch">Vos proches suivent votre voyage depuis un simple lien : la carte, vos récits et vos photos. Ils peuvent <b>aimer</b> et <b>commenter</b>, et vous pouvez leur <b>répondre</b>. Ils n’ont <b>rien à installer</b> et aucun compte à créer.</p>
      ${ready ? settings : '<div class="note warn-box">Le service de partage n’est pas encore connecté. Il le sera dès que le projet Supabase sera configuré.</div>'}
      <a class="btn sm" href="share.html?demo=${t.id}" target="_blank" rel="noopener">👁 Voir ce que verront vos amis (aperçu)</a>
      <div class="share-what"><b>Partagé :</b> étapes, dates, récits, photos et légendes.<br><b>Jamais partagé :</b> budget, documents, réservations, listes, notes personnelles.</div>
      <div class="actions"><button class="btn" data-act="close-modal">Fermer</button><button class="btn primary" data-act="share-start" ${ready ? '' : 'disabled'}>Créer le lien pour les amis</button></div>`;
  } else {
    const url = cloud.shareUrl(sh.token);
    const f = fb[t.id] || { comments: [], likes: [] };
    const recent = f.comments.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30);
    const label = (target) => {
      if (target === 'trip') return '💬 Sur le voyage';
      const [k, id] = target.split(':');
      if (k === 'step') return `📍 ${esc(t.steps.find((s) => s.id === id)?.name || 'Étape')}`;
      const p = t.photos.find((x) => x.id === id);
      return p ? `📸 Photo${p.caption ? ' « ' + esc(p.caption.slice(0, 30)) + ' »' : ''}` : '📸 Photo';
    };
    const targets = [...new Set(recent.map((c) => c.target))];
    box.innerHTML = `
      <h2>Partager le voyage</h2>
      ${companions}
      <h3 class="share-sec">Amis et famille <small>regardent et commentent</small></h3>
      <div class="share-link"><input id="share-url" value="${esc(url)}" readonly aria-label="Lien de partage"><button class="btn primary" data-act="share-copy">Copier</button></div>
      <div class="row-btns wrap">
        ${navigator.share ? '<button class="btn sm" data-act="share-native">📲 Envoyer…</button>' : ''}
        <a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">👁 Voir comme un ami</a>
      </div>
      <p class="hint" id="share-status"></p>
      <div class="share-stats"><span>💬 <b>${f.comments.length}</b> commentaires</span><span>❤️ <b>${f.likes.length}</b> j’aime</span></div>
      <h4 class="share-h">Conversations</h4>
      ${targets.length ? targets.map((tg) => `<div class="share-conv"><small class="eyebrow">${label(tg)}</small>${threadHTML(t, tg, { compact: true })}</div>`).join('') : '<p class="muted">Pas encore de commentaires. Envoyez le lien à vos proches !</p>'}
      <details class="share-settings"><summary>Réglages du partage</summary>${settings}
        <button class="btn sm danger" data-act="share-stop">Arrêter le partage et supprimer le lien</button>
      </details>
      <div class="actions"><button class="btn primary" data-act="close-modal">Fermer</button></div>`;
    renderShareStatus();
  }
  $('#sh-author', box)?.addEventListener('change', (e) => { t.share.author = e.target.value.trim(); save(); scheduleSync(t, 2000); });
  $$('[name=shpos]', box).forEach((r) => (r.onchange = () => { t.share.position = r.value; save(); scheduleSync(t, 2000); renderShareModal(); }));
}


// =====================================================================
// Carnet partagé avec les compagnons de voyage (tout le monde modifie)
// =====================================================================
let collabTimer = null;
function scheduleCollab(t = T(), delay = 1500) {
  if (!t?.collab || !cloud.cloudReady()) return;
  clearTimeout(collabTimer);
  collabTimer = setTimeout(() => collabSync(t), delay);
}
async function collabSync(t) {
  if (!t?.collab || !navigator.onLine || !cloud.cloudReady()) return;
  // Pendant une saisie, on attend la fin pour ne pas déranger
  if (document.activeElement?.matches?.('input, textarea, select')) {
    document.addEventListener('focusout', () => setTimeout(() => collabSync(t), 300), { once: true });
    return;
  }
  if (ui.collabBusy) { ui.collabAgain = true; return; }
  ui.collabBusy = true;
  try {
    const res = await collab.syncCollab(t);
    t.collab.error = null;
    save();
    if (res.changed && t.id === ui.tripId) {
      refresh();
      if (ui.drawer) renderDrawer();
      if (res.by && res.by !== t.collab.me) toast(`${esc(res.by)} a modifié le voyage`);
    }
    if ($('#share-modal')) renderShareModal();
  } catch (e) {
    t.collab.error = e.message || 'réseau';
  } finally {
    ui.collabBusy = false;
    if (ui.collabAgain) { ui.collabAgain = false; scheduleCollab(t, 500); }
  }
}
setInterval(() => { const t = T(); if (t?.collab && document.visibilityState === 'visible') collabSync(t); }, 25000);
document.addEventListener('visibilitychange', () => { const t = T(); if (t?.collab && document.visibilityState === 'visible') collabSync(t); });
addEventListener('online', () => { const t = T(); if (t?.collab) collabSync(t); });

function companionsHTML(t, ready) {
  const c = t.collab;
  if (!ready) return '';
  if (!c) return `
    <h3 class="share-sec">Compagnons de voyage <small>modifient le carnet avec vous</small></h3>
    <div class="collab-card">
      <p>Les personnes qui voyagent avec vous ajoutent elles aussi des étapes, des hébergements, des activités, des dépenses et des photos. Tout se met à jour chez chacun.</p>
      <label class="fld"><span>Votre prénom</span><input id="collab-me" value="${esc(state.settings.myName || t.share?.author || '')}" placeholder="ex : Fanny" maxlength="40"></label>
      <button class="btn primary full" data-act="collab-start">Inviter des compagnons de voyage</button>
      <small class="hint">Vos documents marqués « Visible uniquement par moi » (passeport…) ne sont jamais partagés.</small>
    </div>`;
  const members = (c.members || []).map((m) => `<span class="member ${m.me ? 'me' : ''}">${esc(m.name)}${m.me ? ' (vous)' : ''}</span>`).join('');
  return `
    <h3 class="share-sec">Compagnons de voyage <small>modifient le carnet avec vous</small></h3>
    <div class="collab-card on">
      <div class="collab-code"><small>Code d’invitation</small><b>${c.code.slice(0, 3)}-${c.code.slice(3)}</b></div>
      <div class="row-btns wrap">
        <button class="btn primary" data-act="collab-invite">Envoyer l’invitation</button>
        <button class="btn" data-act="collab-copy">Copier</button>
      </div>
      <div class="members">${members || '<span class="muted">Personne n’a encore rejoint le voyage.</span>'}</div>
      <small class="hint">${c.error ? `Synchronisation impossible (${esc(c.error)}). Nouvel essai automatique.` : c.syncedAt ? `Synchronisé ${new Date(c.syncedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'Synchronisation…'}</small>
    </div>`;
}

A['collab-start'] = async (el) => {
  const t = T();
  const name = $('#collab-me')?.value.trim();
  if (!name) { $('#collab-me')?.focus(); return toast('Indiquez votre prénom'); }
  state.settings.myName = name;
  el.disabled = true;
  el.textContent = 'Création du carnet partagé…';
  try {
    await collab.createCollab(t, name);
    save();
    collab.watchCollab(t, () => collabSync(t));
    await collabSync(t);
    renderShareModal();
    renderTripHeader(t);
    toast('Carnet partagé créé : envoyez le code à vos compagnons');
  } catch (e) {
    el.disabled = false;
    el.textContent = 'Inviter des compagnons de voyage';
    toast(`Impossible : ${esc(e.message || 'réseau')}`);
  }
};
const appUrl = () => cloud.shareUrl('x').replace(/share\.html\?t=x$/, '');
A['collab-invite'] = async () => {
  const t = T();
  const text = collab.inviteText(t, appUrl());
  if (navigator.share) { try { await navigator.share({ title: `Voyage ${t.name}`, text }); return; } catch { /* annulé */ } }
  A['collab-copy']();
};
A['collab-copy'] = async () => {
  const t = T();
  try { await navigator.clipboard.writeText(collab.inviteText(t, appUrl())); toast('Invitation copiée'); }
  catch { toast(`Code : ${t.collab.code}`); }
};

function joinModal(code = '') {
  if (!cloud.cloudReady()) return toast('Service en ligne indisponible');
  openModal(`
    <h2>Rejoindre un voyage</h2>
    <p class="hint">Un compagnon de voyage vous a envoyé un code ? Entrez-le ici : le voyage apparaîtra dans « Mes voyages » et vous pourrez le compléter ensemble.</p>
    <form class="form" id="join-form">
      <label class="fld"><span>Code d’invitation</span><input id="join-code" value="${esc(code)}" placeholder="ex : TUN-K7P" autocapitalize="characters" autocomplete="off" required></label>
      <label class="fld"><span>Votre prénom</span><input id="join-name" value="${esc(state.settings.myName || '')}" placeholder="ex : Léa" maxlength="40" required></label>
      <div class="actions"><button type="button" class="btn" data-act="close-modal">Annuler</button><button class="btn primary">Rejoindre</button></div>
    </form>`, (m) => {
    $('#join-form', m).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button.primary', m);
      const name = $('#join-name', m).value.trim();
      btn.disabled = true;
      btn.textContent = 'Connexion…';
      try {
        const trip = await collab.joinCollab($('#join-code', m).value, name);
        state.settings.myName = name;
        const existing = getTrip(trip.id);
        if (existing) Object.assign(existing, normalizeTrip(trip));
        else state.trips.push(normalizeTrip(trip));
        collab.registerFiles(getTrip(trip.id));
        await flush();
        closeModal();
        toast(`Vous avez rejoint « ${esc(trip.name)} »`);
        go(`#/trip/${trip.id}/itin`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Rejoindre';
        toast(/introuvable/i.test(err.message || '') ? 'Code introuvable : vérifiez-le auprès de votre compagnon' : `Impossible : ${esc(err.message || 'réseau')}`);
      }
    };
  });
}
A['join-trip'] = () => joinModal();

A['share-start'] = async (el) => {
  const t = T();
  t.share ||= {};
  t.share.author = $('#sh-author')?.value.trim() || t.share.author || '';
  if (!t.share.author) { $('#sh-author')?.focus(); toast('Indiquez votre prénom'); return; }
  el.disabled = true;
  el.textContent = 'Création du lien…';
  try {
    await cloud.publish(t, { getFile, start: tripStart(t), end: tripEnd(t), me: ui.me, onProgress: (n, tot) => (el.textContent = `Envoi des photos ${n}/${tot}…`) });
    t.share.seenAt = Date.now();
    save();
    renderShareModal();
    renderTripHeader(t);
    toast('🎉 Lien créé : envoyez-le à vos proches');
  } catch (e) {
    el.disabled = false;
    el.textContent = 'Créer le lien de partage';
    toast(`Partage impossible : ${esc(e.message || 'réseau')}`);
  }
};
A['share-copy'] = async () => {
  const input = $('#share-url');
  try { await navigator.clipboard.writeText(input.value); toast('Lien copié ✓'); }
  catch { input.select(); toast('Sélectionné : copiez-le avec ⌘C / appui long'); }
};
A['share-native'] = async () => {
  const t = T();
  try { await navigator.share({ title: `${t.emoji} ${t.name}`, text: `Suivez notre voyage « ${t.name} » !`, url: cloud.shareUrl(t.share.token) }); } catch { /* annulé */ }
};
A['share-stop'] = async () => {
  const t = T();
  if (!confirm('Arrêter le partage ? Le lien ne fonctionnera plus et les commentaires seront supprimés.')) return;
  try { await cloud.stopShare(t); save(); renderShareModal(); renderTripHeader(t); toast('Partage arrêté'); }
  catch (e) { toast(`Impossible : ${esc(e.message || 'réseau')}`); }
};

// =====================================================================
// Options du voyage, export, import, impression, agenda
// =====================================================================
A['trip-settings'] = () => {
  const t = T();
  openModal(`
    <h2>Options du voyage</h2>
    <div class="form" data-scope id="f-trip">
      <div class="row"><input data-f="name" placeholder="Nom du voyage"></div>
      <div class="grid2">
        <label class="fld"><span>Début (sinon : 1ʳᵉ étape)</span><input type="date" data-f="start"></label>
        <label class="fld"><span>Fin (sinon : dernière étape)</span><input type="date" data-f="end"></label>
      </div>
      <div class="grid3">
        <label class="fld"><span>Devise</span><select data-f="currency">${CURRENCIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label class="fld"><span>Budget (${t.currency})</span><input type="number" step="any" min="0" inputmode="decimal" data-f="budget"></label>
        <label class="fld"><span>Voyageurs</span><input type="number" min="1" inputmode="numeric" data-f="travelers"></label>
      </div>
      <div class="colors">${COLORS.map((c) => `<label class="color"><input type="radio" name="tcolor" data-f="color" value="${c}"><span style="background:${c}"></span></label>`).join('')}</div>
      <div class="kind-pick">
        <label class="kind"><input type="radio" name="tkind" data-f="kind" value="roadtrip"><span><b>🚗 Road trip</b><small>Avec mon véhicule</small></span></label>
        <label class="kind"><input type="radio" name="tkind" data-f="kind" value="mixed"><span><b>✈️ Multi-transports</b><small>Avion, train, bus…</small></span></label>
      </div>
      <div class="road-opts ${isRoad(t) ? '' : 'hidden'}">
        <div class="pills">${Object.entries(VEHICLES).map(([k, v]) => `<label class="pill"><input type="radio" name="tveh" data-f="vehicle" value="${k}"><span>${v.icon} ${v.label}</span></label>`).join('')}</div>
        <div class="grid2">
          <label class="fld"><span>Consommation (L/100 km)</span><input type="number" step="0.1" min="0" inputmode="decimal" data-f="conso" placeholder="${VEHICLES[t.vehicle].conso}"></label>
          <label class="fld"><span>Prix du carburant (${t.currency}/L)</span><input type="number" step="0.01" min="0" inputmode="decimal" data-f="fuelPrice" placeholder="1.85"></label>
        </div>
      </div>
    </div>
    <div class="menu">
      <button class="menu-i" data-act="export-trip">💾 Sauvegarder / partager (.json)</button>
      <button class="menu-i" data-act="export-ics">📅 Ajouter à mon agenda (.ics)</button>
      <button class="menu-i" data-act="print">🖨️ Imprimer / PDF de l’itinéraire</button>
      <button class="menu-i" data-act="dup-trip">⧉ Dupliquer le voyage (modèle)</button>
      ${t.track.length ? '<button class="menu-i" data-act="clear-track">🧹 Effacer le tracé GPS</button>' : ''}
      <button class="menu-i danger" data-act="del-trip">🗑 Supprimer le voyage</button>
    </div>
    <div class="actions"><button class="btn primary" data-act="close-modal">Terminé</button></div>`, (m) => {
    bindFields($('#f-trip', m), t, (path, val, prev) => {
      if (path === 'travelers' && !(t.travelers >= 1)) t.travelers = 1;
      if (path === 'kind' && val === 'roadtrip') {
        // Passage en road trip : les trajets sans mode (ou en voiture/van/moto) passent sur le véhicule
        t.steps.forEach((s, i) => { if (i && (!s.transport.mode || MODES[s.transport.mode]?.road)) s.transport.mode = t.vehicle; });
      }
      if (path === 'vehicle' && prev) t.steps.forEach((s) => { if (s.transport.mode === prev) s.transport.mode = val; });
      if (path === 'kind' || path === 'vehicle') { $('.road-opts', m).classList.toggle('hidden', !isRoad(t)); $('[data-f=conso]', m).placeholder = VEHICLES[t.vehicle].conso; }
      refresh();
    });
  });
};

async function tripExport(t) {
  const files = {};
  for (const id of [...t.documents.flatMap((d) => docFiles(d).map((f) => f.id)), ...t.photos.flatMap((p) => [p.fileId, p.thumbId])].filter(Boolean)) {
    const b = await getFile(id).catch(() => null);
    if (b) files[id] = await blobToDataURL(b);
  }
  return { app: 'voyage', version: 1, exportedAt: new Date().toISOString(), trip: t, files };
}

A['export-trip'] = async () => {
  const t = T();
  const data = JSON.stringify(await tripExport(t));
  const name = `${slug(t.name)}.voyage.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && isMobile()) {
    try { await navigator.share({ files: [file], title: t.name }); return; } catch { /* annulé */ }
  }
  download(name, data);
};

A['export-all'] = async () => {
  const all = [];
  for (const t of state.trips) all.push(await tripExport(t));
  download(`voyages-sauvegarde-${todayStr()}.json`, JSON.stringify({ app: 'voyage', version: 1, backup: all }));
};

A.import = () => $('#import-input').click();
$('#import-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const packs = data.backup || (data.trip ? [data] : data.steps ? [{ trip: data, files: {} }] : data.trips ? data.trips.map((trip) => ({ trip, files: {} })) : []);
    if (!packs.length) throw new Error('format');
    let last;
    for (const p of packs) {
      const t = normalizeTrip(p.trip);
      for (const [oldId, url] of Object.entries(p.files || {})) {
        const nid = await putFile(await dataURLToBlob(url));
        t.documents.forEach((d) => docFiles(d).forEach((f) => f.id === oldId && (f.id = nid)));
        t.photos.forEach((ph) => { if (ph.fileId === oldId) ph.fileId = nid; if (ph.thumbId === oldId) ph.thumbId = nid; });
      }
      if (getTrip(t.id)) { t.id = uid(); t.name += ' (importé)'; }
      state.trips.push(t);
      last = t;
    }
    await flush();
    toast(`${plural(packs.length, 'voyage importé', 'voyages importés')}`);
    if (packs.length === 1) go(`#/trip/${last.id}/itin`); else route();
  } catch {
    toast('Fichier non reconnu');
  }
});

A['dup-trip'] = () => {
  const c = clone(T());
  c.id = uid();
  c.name += ' (copie)';
  c.track = []; c.photos = []; c.expenses = [];
  c.documents = c.documents.map((d) => ({ ...d, files: [] }));
  c.steps.forEach((s) => { s.id = uid(); s.stays.forEach((x) => (x.id = uid())); s.subs.forEach((x) => { x.id = uid(); x.done = false; }); });
  c.checklists.forEach((l) => { l.id = uid(); l.items.forEach((x) => { x.id = uid(); x.done = false; }); });
  state.trips.push(c);
  save(); closeModal();
  go(`#/trip/${c.id}/itin`);
  toast('Voyage dupliqué');
};
A['clear-track'] = () => {
  if (!confirm('Effacer tout le tracé GPS enregistré pour ce voyage ?')) return;
  T().track = [];
  closeModal(); commit();
};
A['del-trip'] = async () => {
  const t = T();
  if (!confirm(t.collab ? `Retirer « ${t.name} » de ce téléphone ? Vous quitterez le voyage partagé ; vos compagnons le gardent.` : `Supprimer définitivement « ${t.name} » ? Pensez à le sauvegarder avant.`)) return;
  if (t.collab) { try { await collab.leaveCollab(t); } catch { /* hors-ligne : on retire quand même localement */ } }
  [...t.documents.flatMap((d) => docFiles(d).map((f) => f.id)), ...t.photos.flatMap((p) => [p.fileId, p.thumbId])].forEach((id) => delFile(id));
  state.trips = state.trips.filter((x) => x !== t);
  if (state.settings.recordingTripId === t.id) stopRecording();
  await flush();
  closeModal();
  go('#/');
};

A['export-ics'] = () => {
  const t = T();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dt = (s) => s.replace(/[-:]/g, '').slice(0, 13) + '00';
  const icsEsc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const ev = [];
  const push = (id, summary, start, end, allDay, desc = '', loc = '') => ev.push([
    'BEGIN:VEVENT', `UID:${id}@voyage`, `DTSTAMP:${stamp}`,
    allDay ? `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}` : `DTSTART:${dt(start)}`,
    allDay ? `DTEND;VALUE=DATE:${end.replace(/-/g, '')}` : `DTEND:${dt(end)}`,
    `SUMMARY:${icsEsc(summary)}`, desc && `DESCRIPTION:${icsEsc(desc)}`, loc && `LOCATION:${icsEsc(loc)}`, 'END:VEVENT',
  ].filter(Boolean).join('\r\n'));
  t.steps.forEach((s, i) => {
    if (s.arrival) push(s.id, `${t.emoji} ${s.name}`, s.arrival, addDays(s.departure && s.departure > s.arrival ? s.departure : s.arrival, s.departure > s.arrival ? 0 : 1), true, s.notes, s.place?.label);
    const tr = s.transport;
    if (tr.mode && tr.depart) {
      const end = tr.arrive || new Date(new Date(tr.depart).getTime() + 3600_000).toISOString().slice(0, 16);
      push(s.id + '-tr', `${MODES[tr.mode].icon} ${t.steps[i - 1]?.name || ''} → ${s.name}`, tr.depart, end, false, [tr.company, tr.ref && 'Réf. ' + tr.ref, tr.notes].filter(Boolean).join('\n'));
    }
    s.stays.forEach((st) => {
      if (st.checkIn && st.checkOut) push(st.id, `🛏️ ${st.name || 'Hébergement'}`, st.checkIn, st.checkOut, true, [st.confirmation && 'Confirmation : ' + st.confirmation, st.phone, st.notes].filter(Boolean).join('\n'), st.place?.label);
    });
    s.subs.forEach((x) => {
      if (x.date && x.time) push(x.id, `${SUB_TYPES[x.type]?.icon || ''} ${x.name}`, `${x.date}T${x.time}`, new Date(new Date(`${x.date}T${x.time}`).getTime() + 5400_000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), false, x.notes, x.place?.label);
      else if (x.date) push(x.id, `${SUB_TYPES[x.type]?.icon || ''} ${x.name}`, x.date, addDays(x.date, 1), true, x.notes, x.place?.label);
    });
  });
  download(`${slug(t.name)}.ics`, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Voyage//FR', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n'), 'text/calendar');
};

A.print = () => {
  const t = T();
  const c = tripCosts(t);
  $('#print-root').innerHTML = `
    <h1>${esc(t.emoji)} ${esc(t.name)}</h1>
    <p>${fmtRange(tripStart(t), tripEnd(t))} · ${plural(t.steps.length, 'étape')} · ${plural(totalNights(t), 'nuit')} · ${fmtMoney(c.total, t.currency)}</p>
    ${t.steps.map((s, i) => { const tr = s.transport; return `<section>
      ${tr.mode ? `<p class="p-tr">${MODES[tr.mode].icon} ${MODES[tr.mode].label}${tr.depart ? ' · ' + fmtDateTime(tr.depart) : ''}${tr.arrive ? ' → ' + fmtTime(tr.arrive) : ''}${tr.company ? ' · ' + esc(tr.company) : ''}${tr.ref ? ' · Réf. ' + esc(tr.ref) : ''}</p>` : ''}
      <h2>${i + 1}. ${esc(s.name)} <small>${s.arrival ? fmtRange(s.arrival, s.departure) + ' · ' + n2(s) : ''}</small></h2>
      ${s.place ? `<p class="muted">${esc(s.place.label)}</p>` : ''}
      ${s.stays.map((st) => `<p>🛏️ <b>${esc(st.name)}</b>${st.place ? ' — ' + esc(shortLabel(st.place.label)) : ''}${st.confirmation ? ' · Conf. ' + esc(st.confirmation) : ''}${st.phone ? ' · ' + esc(st.phone) : ''}${st.checkInTime ? ' · check-in ' + st.checkInTime : ''}</p>`).join('')}
      ${s.subs.length ? `<ul>${s.subs.map((x) => `<li>${x.date ? fmtDay(x.date) + ' ' : ''}${x.time || ''} ${SUB_TYPES[x.type]?.icon || ''} ${esc(x.name)}${x.notes ? ' — ' + esc(x.notes) : ''}</li>`).join('')}</ul>` : ''}
      ${s.notes ? `<p class="p-notes">${esc(s.notes)}</p>` : ''}
    </section>`; }).join('')}
    ${t.notes ? `<h2>Notes</h2><p class="p-notes">${esc(t.notes)}</p>` : ''}`;
  closeModal();
  setTimeout(() => window.print(), 100);
};

// =====================================================================
// Réglages généraux
// =====================================================================
const isDark = () => state.settings.theme === 'dark' || (state.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() {
  const th = state.settings.theme;
  if (th === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = th;
  $('meta[name=theme-color]').content = isDark() ? '#0a1312' : '#7a2436';
  applyBasemap();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

A.settings = async () => {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  openModal(`
    <h2>Réglages</h2>
    <div class="sec">
      <h4>Thème</h4>
      <div class="pills">${[['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<label class="pill"><input type="radio" name="theme" value="${k}" ${state.settings.theme === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div class="sec">
      <h4>Sauvegarde</h4>
      <p class="hint">Vos données restent sur cet appareil${est ? ` (${(est.usage / 1e6).toFixed(1)} Mo utilisés)` : ''}. Exportez régulièrement pour les retrouver sur un autre appareil.</p>
      <div class="row-btns wrap"><button class="btn" data-act="export-all">💾 Tout exporter</button><button class="btn" data-act="import">⤓ Importer</button></div>
    </div>
    <div class="sec">
      <h4>Installer sur le téléphone</h4>
      <p class="hint">iPhone : Safari → Partager → « Sur l’écran d’accueil ». Android : menu ⋮ → « Installer l’application ».</p>
    </div>
    <div class="actions"><button class="btn primary" data-act="close-modal">OK</button></div>`, (m) => {
    $$('[name=theme]', m).forEach((r) => (r.onchange = () => { state.settings.theme = r.value; save(); applyTheme(); }));
  });
};

// =====================================================================
// Voyage d'exemple
// =====================================================================
A.demo = () => {
  const d0 = addDays(todayStr(), -2);
  const P = (lat, lng, label) => ({ lat, lng, label });
  const t = newTrip({ name: 'Road trip au Portugal', emoji: '', color: '#7a2436', budget: 2200, travelers: 2, notes: 'Bonjour : Olá · Merci : Obrigado/a · L’addition : A conta, por favor' });
  const steps = [
    { name: 'Paris', type: 'home', place: P(48.8566, 2.3522, 'Paris, Île-de-France, France'), arrival: d0, departure: d0 },
    { name: 'Lisbonne', type: 'city', place: P(38.7223, -9.1393, 'Lisbonne, Portugal'), arrival: d0, departure: addDays(d0, 3),
      transport: { mode: 'plane', depart: `${d0}T07:05`, arrive: `${d0}T08:40`, company: 'TP 433', ref: 'XK7P2L', price: 236, status: 'paid', notes: 'Terminal 1 · Bagage cabine uniquement' },
      stays: [newStay({ name: 'Casa do Alfama', place: P(38.7115, -9.1302, 'Rua de São Miguel, Alfama, Lisbonne, Portugal'), checkIn: d0, checkOut: addDays(d0, 3), checkInTime: '15:00', checkOutTime: '11:00', status: 'paid', confirmation: 'BK-48213', price: 342, notes: 'Boîte à clés, code 4821' })],
      subs: [
        newSub({ name: 'Tram 28 jusqu’à Graça', type: 'activity', date: d0, time: '14:00', place: P(38.7166, -9.1310, 'Largo da Graça, Lisbonne'), done: true }),
        newSub({ name: 'Miradouro da Senhora do Monte', type: 'view', date: d0, time: '19:30', place: P(38.7192, -9.1328, 'Miradouro da Senhora do Monte, Lisbonne'), done: true }),
        newSub({ name: 'Monastère des Hiéronymites', type: 'visit', date: addDays(d0, 1), time: '10:00', place: P(38.6979, -9.2068, 'Mosteiro dos Jerónimos, Belém'), cost: 36, done: true }),
        newSub({ name: 'Pastéis de Belém', type: 'cafe', date: addDays(d0, 1), time: '12:00', place: P(38.6975, -9.2032, 'Pastéis de Belém, Lisbonne') }),
        newSub({ name: 'LX Factory', type: 'shop', date: addDays(d0, 2), time: '11:00', place: P(38.7036, -9.1784, 'LX Factory, Lisbonne') }),
        newSub({ name: 'Dîner fado à Alfama', type: 'food', date: addDays(d0, 2), time: '20:30', place: P(38.7110, -9.1290, 'Alfama, Lisbonne'), cost: 70, notes: 'Réserver la veille' }),
        newSub({ name: 'Time Out Market', type: 'food', place: P(38.7069, -9.1459, 'Mercado da Ribeira, Lisbonne') }),
      ] },
    { name: 'Sintra', type: 'culture', place: P(38.8029, -9.3817, 'Sintra, Portugal'), arrival: addDays(d0, 3), departure: addDays(d0, 4),
      transport: { mode: 'train', depart: `${addDays(d0, 3)}T09:11`, arrive: `${addDays(d0, 3)}T09:51`, company: 'CP Linha de Sintra', price: 9.2, status: 'paid' },
      stays: [newStay({ name: 'Quinta da Serra', place: P(38.7975, -9.3900, 'Sintra, Portugal'), checkIn: addDays(d0, 3), checkOut: addDays(d0, 4), status: 'booked', price: 128, confirmation: 'QS-1190' })],
      subs: [newSub({ name: 'Palais de Pena', type: 'visit', date: addDays(d0, 3), time: '10:30', place: P(38.7876, -9.3906, 'Palácio da Pena, Sintra'), cost: 40 }), newSub({ name: 'Quinta da Regaleira', type: 'visit', date: addDays(d0, 3), time: '15:00', place: P(38.7963, -9.3960, 'Quinta da Regaleira, Sintra'), cost: 30 }), newSub({ name: 'Cabo da Roca au coucher du soleil', type: 'view', place: P(38.7804, -9.4989, 'Cabo da Roca') })] },
    { name: 'Coimbra', type: 'city', place: P(40.2033, -8.4103, 'Coimbra, Portugal'), arrival: addDays(d0, 4), departure: addDays(d0, 5),
      transport: { mode: 'car', depart: `${addDays(d0, 4)}T10:00`, company: 'Location Europcar', ref: 'EU-77812', price: 186, status: 'paid', notes: 'Récupération à Sintra centre' },
      stays: [newStay({ name: 'À réserver', status: 'todo', checkIn: addDays(d0, 4), checkOut: addDays(d0, 5) })],
      subs: [newSub({ name: 'Bibliothèque Joanina', type: 'visit', place: P(40.2079, -8.4255, 'Biblioteca Joanina, Coimbra'), cost: 26 })] },
    { name: 'Porto', type: 'city', place: P(41.1579, -8.6291, 'Porto, Portugal'), arrival: addDays(d0, 5), departure: addDays(d0, 8),
      transport: { mode: 'car' },
      subs: [newSub({ name: 'Livraria Lello', type: 'visit', place: P(41.1469, -8.6149, 'Livraria Lello, Porto') }), newSub({ name: 'Caves de porto à Gaia', type: 'activity', place: P(41.1373, -8.6131, 'Vila Nova de Gaia') }), newSub({ name: 'Francesinha au Café Santiago', type: 'food', place: P(41.1468, -8.6056, 'Café Santiago, Porto') })] },
    { name: 'Paris', type: 'home', place: P(48.8566, 2.3522, 'Paris, Île-de-France, France'), arrival: addDays(d0, 8), departure: addDays(d0, 8),
      transport: { mode: 'plane', depart: `${addDays(d0, 8)}T18:30`, arrive: `${addDays(d0, 8)}T21:50`, status: 'todo' } },
  ];
  t.steps = steps.map((s) => newStep({ ...s, transport: { mode: '', depart: '', arrive: '', company: '', ref: '', price: null, status: '', notes: '', ...(s.transport || {}) } }));
  t.expenses = [
    { id: uid(), t: Date.now(), amount: 18.5, currency: 'EUR', label: 'Pastéis & cafés', category: 'food', date: d0, stepId: t.steps[1].id },
    { id: uid(), t: Date.now(), amount: 64, currency: 'EUR', label: 'Dîner Alfama', category: 'food', date: addDays(d0, 1), stepId: t.steps[1].id },
    { id: uid(), t: Date.now(), amount: 12, currency: 'EUR', label: 'Carte Viva Viagem', category: 'transport', date: d0, stepId: t.steps[1].id },
  ];
  t.documents = [
    { id: uid(), name: 'Carte d’identité', type: 'passport', number: '', expiry: '2031-05-12', notes: '', files: [] },
    { id: uid(), name: 'Assurance voyage', type: 'insurance', number: 'AV-552-019', expiry: '', notes: 'Assistance 24h/24 : +33 1 00 00 00 00', files: [] },
  ];
  t.track = [[38.7139, -9.1335, Date.now() - 86400_000 * 2], [38.7160, -9.1300, Date.now() - 86400_000 * 2 + 600_000], [38.7192, -9.1328, Date.now() - 86400_000 * 2 + 1500_000]];
  t.checklists[0].items.slice(0, 6).forEach((x) => (x.done = true));
  t.checklists[1].items.slice(0, 7).forEach((x) => (x.done = true));
  state.trips.push(t);
  save();
  go(`#/trip/${t.id}/itin`);
};

// =====================================================================
// Démarrage
// =====================================================================
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installEvt = e; if (!ui.tripId) renderHome(); });
matchMedia('(max-width: 899px)').addEventListener('change', () => mapView?.invalidate());

// Clavier du téléphone : on mesure la partie visible de l'écran pour garder les champs visibles
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    // Le clavier ne compte que s'il prend vraiment de la place et qu'un champ est actif
    const typing = document.activeElement?.matches?.('input, textarea, select');
    const raw = innerHeight - vv.height - vv.offsetTop;
    const kb = typing && raw > 120 ? raw : 0;
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    document.documentElement.style.setProperty('--vvh', kb ? `${vv.height}px` : '100dvh');
  };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
  document.addEventListener('focusin', () => setTimeout(onVV, 350));
  document.addEventListener('focusout', () => setTimeout(onVV, 100));
  onVV();
}
document.addEventListener('focusin', (e) => {
  if (!e.target.matches?.('input, textarea, select') || !matchMedia('(pointer: coarse)').matches) return;
  setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

(async function init() {
  startPicto();
  await load();
  applyTheme();
  route();
  checkReminders();
  setInterval(checkReminders, 30000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      reg.update();
      // Vérifie régulièrement s'il existe une nouvelle version, et à chaque retour dans l'app
      setInterval(() => reg.update().catch(() => {}), 60_000);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {}));
    }).catch(() => {});
    // Nouvelle version installée : l'app se recharge seule (après la saisie en cours)
    let hadController = !!navigator.serviceWorker.controller, reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if (reloading) return;
      reloading = true;
      const go = () => { flush().finally(() => { try { sessionStorage.setItem('capnord-updated', '1'); } catch {} location.reload(); }); };
      const typing = () => document.activeElement?.matches?.('input, textarea, select');
      if (!typing()) go();
      else document.addEventListener('focusout', function wait() { setTimeout(() => { if (!typing()) { document.removeEventListener('focusout', wait); go(); } }, 400); });
    });
  }
  try { if (sessionStorage.getItem('capnord-updated')) { sessionStorage.removeItem('capnord-updated'); setTimeout(() => toast('✓ Cap Nord est à jour'), 600); } } catch {}
})();
