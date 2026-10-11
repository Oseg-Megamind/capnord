// Carte Leaflet : étapes numérotées, trajets par mode de transport, sous-étapes,
// tracé GPS réel, carnet de bord et position en direct.
import { MODES, SUB_TYPES } from './constants.js';
import { esc, fmtRange } from './utils.js';
import * as svc from './services.js';

export const BASEMAPS = {
  osm: { label: 'Plan', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
  dark: { label: 'Nuit', cls: 'tiles-dark', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
  street: { label: 'Routier', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, attribution: 'Tuiles © Esri' } },
  topo: { label: 'Relief', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opts: { subdomains: 'abc', maxZoom: 17, attribution: '© OpenStreetMap · SRTM · © OpenTopoMap' } },
  sat: { label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, attribution: 'Imagerie © Esri' } },
};

const ll = (p) => [p.lat, p.lng];

function arc(a, b, n = 40) {
  let bl = b.lng;
  if (bl - a.lng > 180) bl -= 360;
  if (a.lng - bl > 180) bl += 360;
  const dx = bl - a.lng, dy = b.lat - a.lat;
  const mx = (a.lng + bl) / 2 - dy * 0.18, my = (a.lat + b.lat) / 2 + dx * 0.18;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * a.lat + 2 * u * t * my + t * t * b.lat, u * u * a.lng + 2 * u * t * mx + t * t * bl]);
  }
  return pts;
}

export class MapView {
  constructor(el, handlers) {
    this.h = handlers;
    this.map = L.map(el, { zoomControl: false, worldCopyJump: true, tap: true }).setView([35, 5], 3);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);
    this.g = {};
    for (const k of ['route', 'track', 'photos', 'steps', 'subs', 'me']) this.g[k] = L.layerGroup().addTo(this.map);
    this.map.on('click', (e) => this.h.onMapClick?.(e.latlng));
    this.map.on('zoomend', () => this.updateDetailVisibility());
    this.map.on('dragstart', () => this.h.onUserPan?.());
    this.base = null;
    this.baseKey = null;
    this.trip = null;
    this.rerender = null;
  }

  setBase(key) {
    if (key === this.baseKey) return;
    if (this.base) this.map.removeLayer(this.base);
    const b = BASEMAPS[key] || BASEMAPS.osm;
    this.base = L.tileLayer(b.url, { ...b.opts, className: b.cls || '', crossOrigin: 'anonymous' }).addTo(this.map);
    this.base.bringToBack();
    this.baseKey = key;
  }

  invalidate() {
    setTimeout(() => { if (!this.dead) this.map.invalidateSize(); }, 50);
  }

  render(trip, { selectedId = null, selectedLegId = null, states = [], routing = true } = {}) {
    this.trip = trip;
    this.opts = { selectedId, selectedLegId, states, routing };
    const { route, steps, subs, track, photos } = this.g;
    route.clearLayers(); steps.clearLayers(); subs.clearLayers(); track.clearLayers(); photos.clearLayers();

    // Trajets entre étapes
    let prev = null;
    trip.steps.forEach((s, i) => {
      if (!s.place) return;
      if (prev) {
        const mode = MODES[s.transport?.mode];
        const color = mode?.color || '#94a3b8';
        let coords = [ll(prev.place), ll(s.place)];
        if (mode?.arc) coords = arc(prev.place, s.place);
        else if (mode?.road && routing) {
          const r = svc.cachedRoute(prev.place, s.place);
          if (r?.c) coords = r.c;
          else svc.route(prev.place, s.place).then((res) => res?.c && this.scheduleRerender());
        }
        // Trajet effectué = on est arrivé à l'étape (faite ou en cours)
        const done = states[i] === 'done' || states[i] === 'now';
        const sel = s.id === selectedLegId;
        L.polyline(coords, { color: '#fff', weight: sel ? 13 : done ? 9 : 7, opacity: sel ? 0.9 : done ? 0.75 : 0.45, interactive: false }).addTo(route);
        L.polyline(coords, { color: done ? color : '#94a3b8', weight: sel ? 7 : done ? 5 : 3.5, opacity: sel ? 0.95 : done ? 0.95 : 0.8, dashArray: done ? mode?.dash || null : '2 8', lineCap: 'round', interactive: false }).addTo(route);
        // Ligne invisible plus large : facile à toucher au doigt
        const from = prev;
        L.polyline(coords, { color: '#000', weight: 22, opacity: 0, className: 'leg-hit' })
          .bindTooltip(`${mode ? mode.icon + ' ' + mode.label : '➡️ Trajet'} · ${esc(from.name)} → ${esc(s.name)}`, { sticky: true })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); this.h.onLegClick?.(s.id); })
          .addTo(route);
      }
      prev = s;
    });

    // Étapes
    trip.steps.forEach((s, i) => {
      if (!s.place) return;
      const sel = s.id === selectedId;
      const status = states[i] === 'done' ? 'past' : states[i] === 'now' ? 'now' : '';
      const icon = L.divIcon({
        className: 'mk-wrap',
        html: `<div class="mk ${sel ? 'sel' : ''} ${status}" style="--c:${trip.color}"><span>${status === 'past' ? '✓' : i + 1}</span>${(trip.photos || []).some((p) => p.stepId === s.id) ? `<i class="mk-ph">${trip.photos.filter((p) => p.stepId === s.id).length}</i>` : ''}${status === 'now' ? '<b class="mk-here">Vous êtes ici</b>' : ''}</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16],
      });
      L.marker(ll(s.place), { icon, zIndexOffset: sel ? 1000 : status === 'now' ? 500 : 0, keyboard: true, title: s.name })
        .bindTooltip(`<b>${i + 1}. ${esc(s.name || 'Étape')}</b>${s.arrival ? `<br>${fmtRange(s.arrival, s.departure)}` : ''}`, { direction: 'top', offset: [0, -16] })
        .on('click', () => this.h.onStepClick?.(s.id))
        .addTo(steps);

      // Détails : hébergements + sous-étapes
      for (const st of s.stays) {
        if (!st.place) continue;
        this.mini(st.place, '🛏️', `<b>${esc(st.name || 'Hébergement')}</b><br>${esc(s.name)}`, () => this.h.onStepClick?.(s.id, 'stay:' + st.id), 'stay');
      }
      for (const x of s.subs) {
        if (!x.place) continue;
        this.mini(x.place, SUB_TYPES[x.type]?.icon || '📌', `<b>${esc(x.name)}</b><br>${esc(s.name)}${x.time ? ' · ' + x.time : ''}`, () => this.h.onStepClick?.(s.id, 'sub:' + x.id), x.done ? 'done' : '');
      }
    });

    // Tracé GPS réel (coupé en cas de longue interruption)
    const segs = [];
    let cur = [];
    trip.track.forEach((p, i) => {
      if (i && p[2] - trip.track[i - 1][2] > 3 * 3600_000) { segs.push(cur); cur = []; }
      cur.push([p[0], p[1]]);
    });
    if (cur.length) segs.push(cur);
    for (const sg of segs) {
      if (sg.length < 2) continue;
      L.polyline(sg, { color: '#fff', weight: 7, opacity: 0.7, interactive: false }).addTo(track);
      L.polyline(sg, { color: '#e11d48', weight: 3.5, opacity: 0.95, interactive: false }).addTo(track);
    }

    // Photos : regroupées par lieu, vignette + nombre
    const groups = new Map();
    for (const p of trip.photos || []) {
      if (p.lat == null || p.approx) continue;
      const k = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.t - b.t);
      const p = list[0];
      const src = this.h.thumbUrl?.(p.thumbId, () => this.scheduleRerender()) || '';
      const icon = L.divIcon({
        className: 'mk-wrap',
        html: `<div class="mk-photo" ${src ? `style="background-image:url('${src}')"` : ''}>${src ? '' : '📷'}${list.length > 1 ? `<b>${list.length}</b>` : ''}</div>`,
        iconSize: [44, 44], iconAnchor: [22, 22],
      });
      L.marker([p.lat, p.lng], { icon, zIndexOffset: -100 })
        .bindTooltip(esc(p.caption || `${list.length} photo${list.length > 1 ? 's' : ''}`), { direction: 'top', offset: [0, -22] })
        .on('click', () => this.h.onPhotoClick?.(p.id))
        .addTo(photos);
    }
    this.updateDetailVisibility();
  }

  mini(p, emoji, tip, onClick, cls = '', layer = this.g.subs) {
    const icon = L.divIcon({ className: 'mk-wrap', html: `<div class="mk-mini ${cls}">${emoji}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker(ll(p), { icon }).bindTooltip(tip, { direction: 'top', offset: [0, -12] }).on('click', onClick).addTo(layer);
  }

  scheduleRerender() {
    clearTimeout(this.rerender);
    this.rerender = setTimeout(() => this.trip && this.render(this.trip, this.opts), 150);
  }

  updateDetailVisibility() {
    const z = this.map.getZoom();
    for (const [k, min] of [['subs', 10], ['photos', 8]]) {
      const show = z >= min, has = this.map.hasLayer(this.g[k]);
      if (show && !has) this.g[k].addTo(this.map);
      if (!show && has) this.map.removeLayer(this.g[k]);
    }
  }

  fit(trip = this.trip, me = null, padBottom = 0) {
    const pts = [];
    trip?.steps.forEach((s) => s.place && pts.push(ll(s.place)));
    trip?.track.forEach((p) => pts.push([p[0], p[1]]));
    if (!pts.length && me) pts.push(ll(me));
    if (!pts.length) return;
    const opts = { paddingTopLeft: [40, 40], paddingBottomRight: [70, 40 + padBottom], maxZoom: 13 };
    if (pts.length === 1) this.map.setView(pts[0], 11);
    else this.map.fitBounds(L.latLngBounds(pts), opts);
  }

  focus(p, zoom = 13) {
    this.map.flyTo(ll(p), Math.max(zoom, this.map.getZoom()), { duration: 0.8 });
  }

  fitLeg(a, b) {
    this.map.flyToBounds(L.latLngBounds([ll(a), ll(b)]), { padding: [60, 60], maxZoom: 12, duration: 0.8 });
  }

  setMe(me, follow = false) {
    this.g.me.clearLayers();
    if (!me) return;
    if (me.acc && me.acc < 2000) L.circle(ll(me), { radius: me.acc, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(this.g.me);
    const icon = L.divIcon({ className: 'mk-wrap', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    L.marker(ll(me), { icon, zIndexOffset: 2000, interactive: false }).addTo(this.g.me);
    if (follow) this.map.panTo(ll(me), { animate: true });
  }

  // Pré-charge les tuiles autour de chaque étape pour un usage hors-ligne
  async prefetch(trip, onProgress) {
    const b = BASEMAPS[this.baseKey] || BASEMAPS.osm;
    const subs = b.opts.subdomains || 'abc';
    const urls = new Set();
    const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
    const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
    const add = (minLat, minLng, maxLat, maxLng, z) => {
      const x0 = lon2x(minLng, z), x1 = lon2x(maxLng, z), y0 = lat2y(maxLat, z), y1 = lat2y(minLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        urls.add(L.Util.template(b.url, { s: subs[Math.abs(x + y) % subs.length], x, y, z, r: '' }));
      }
    };
    const pts = trip.steps.filter((s) => s.place).map((s) => s.place);
    for (const s of trip.steps) for (const x of [...s.subs, ...s.stays]) if (x.place) pts.push(x.place);
    if (!pts.length) return 0;
    const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
    for (let z = 3; z <= 8; z++) add(Math.min(...lats) - 0.5, Math.min(...lngs) - 0.5, Math.max(...lats) + 0.5, Math.max(...lngs) + 0.5, z);
    for (const p of pts) for (let z = 10; z <= 14; z++) {
      const r = z <= 12 ? 0.08 : 0.025;
      add(p.lat - r, p.lng - r * 1.4, p.lat + r, p.lng + r * 1.4, z);
    }
    const list = [...urls].slice(0, 1500);
    let done = 0;
    const worker = async () => {
      while (list.length) {
        const u = list.pop();
        try { await fetch(u, { mode: 'cors' }); } catch { /* hors-ligne */ }
        onProgress?.(++done, urls.size);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return done;
  }

  destroy() {
    this.dead = true;
    this.map.remove();
  }
}
