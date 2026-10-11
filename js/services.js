// Services en ligne gratuits et sans clé : OpenStreetMap Nominatim (recherche de lieux),
// OSRM (itinéraires routiers), Open-Meteo (météo), Frankfurter (taux de change).
import { state, save } from './store.js';

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const NOMI = 'https://nominatim.openstreetmap.org';

export async function geocode(q) {
  const data = await getJSON(`${NOMI}/search?format=jsonv2&addressdetails=1&limit=6&accept-language=fr&q=${encodeURIComponent(q)}`);
  return data.map((r) => {
    const a = r.address || {};
    const name = r.name || a.city || a.town || a.village || r.display_name.split(',')[0];
    return { lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6), label: r.display_name, name, country: a.country || '', cc: (a.country_code || '').toUpperCase(), kind: r.type };
  });
}

export async function reverse(lat, lng) {
  try {
    const r = await getJSON(`${NOMI}/reverse?format=jsonv2&zoom=16&accept-language=fr&lat=${lat}&lon=${lng}`);
    const a = r.address || {};
    return {
      lat: +lat.toFixed(6), lng: +lng.toFixed(6), label: r.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`, cc: (a.country_code || '').toUpperCase(),
      name: a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county || r.name || 'Point sur la carte',
    };
  } catch {
    return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, name: 'Point sur la carte' };
  }
}

// ---------- Itinéraires routiers (mis en cache durablement)
const routeKey = (a, b) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
const pending = new Map();

export const cachedRoute = (a, b) => state.routeCache[routeKey(a, b)];

export function route(a, b) {
  const key = routeKey(a, b);
  if (state.routeCache[key]) return Promise.resolve(state.routeCache[key]);
  if (pending.has(key)) return pending.get(key);
  const p = getJSON(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`)
    .then((r) => {
      const rt = r.routes?.[0];
      if (!rt) throw new Error('Pas de route');
      let coords = rt.geometry.coordinates.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]);
      if (coords.length > 400) {
        const step = Math.ceil(coords.length / 400);
        coords = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
      }
      const res = { c: coords, km: rt.distance / 1000, min: rt.duration / 60 };
      state.routeCache[key] = res;
      save();
      return res;
    })
    .catch(() => {
      // Échec mémorisé pour la session : on garde la ligne droite
      const res = { c: null, failed: true };
      return res;
    })
    .finally(() => setTimeout(() => pending.delete(key), 60_000));
  pending.set(key, p);
  return p;
}

// ---------- Météo
const wxCache = new Map();
export async function weather(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = wxCache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60_000) return hit.data;
  const r = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&current=temperature_2m,weather_code&timezone=auto&forecast_days=16`);
  const days = (r.daily?.time || []).map((d, i) => ({
    date: d, code: r.daily.weather_code[i], max: r.daily.temperature_2m_max[i], min: r.daily.temperature_2m_min[i],
    rain: r.daily.precipitation_probability_max?.[i],
  }));
  const data = { days, current: r.current ? { temp: r.current.temperature_2m, code: r.current.weather_code } : null };
  wxCache.set(key, { t: Date.now(), data });
  return data;
}

// ---------- Taux de change : renvoie la valeur d'1 unité de chaque devise dans la devise de base
// open.er-api.com couvre toutes les monnaies (dirham, dong, sol…) ; Frankfurter en secours.
export async function fetchRates(base, symbols) {
  let rates;
  try {
    rates = (await getJSON(`https://open.er-api.com/v6/latest/${base}`)).rates;
  } catch {
    const q = `?base=${base}&symbols=${symbols.join(',')}`;
    try { rates = (await getJSON(`https://api.frankfurter.dev/v1/latest${q}`)).rates; }
    catch { rates = (await getJSON(`https://api.frankfurter.app/latest${q}`)).rates; }
  }
  const out = {};
  for (const cur of symbols) if (rates?.[cur]) out[cur] = +(1 / rates[cur]).toPrecision(6);
  return out;
}


// ---------- Normales de saison : la météo réelle des mêmes dates l'an dernier
export async function climate(lat, lng, from, to) {
  const shift = (d) => `${+d.slice(0, 4) - 1}${d.slice(4)}`;
  const r = await getJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${shift(from)}&end_date=${shift(to)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`);
  const d = r.daily || {};
  const n = (d.time || []).length;
  if (!n) return null;
  const avg = (a) => a.filter((x) => x != null).reduce((x, y) => x + y, 0) / Math.max(1, a.filter((x) => x != null).length);
  return { max: avg(d.temperature_2m_max), min: avg(d.temperature_2m_min), rainy: d.precipitation_sum.filter((x) => x > 1).length, days: n };
}

// ---------- Actualité locale (GDELT, gratuit, 1 requête / 5 s par appareil)
const newsCache = new Map();
let lastNews = 0;
export async function news(query) {
  const hit = newsCache.get(query);
  if (hit && Date.now() - hit.t < 3600_000) return hit.items;
  const wait = lastNews + 5500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNews = Date.now();
  const r = await getJSON(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${query}" sourcelang:french`)}&mode=artlist&maxrecords=6&format=json&sort=datedesc&timespan=14d`);
  const items = (r.articles || []).map((a) => ({ title: a.title, url: a.url, domain: a.domain, date: a.seendate, image: a.socialimage }));
  newsCache.set(query, { t: Date.now(), items });
  return items;
}
