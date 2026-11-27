// Real exchange-rate sources. Each answers fetch() with { rates: { INR, EUR, GBP, AED }, source: name }.
// A source rejects a bad answer itself (it throws), so the chain can fall back to the next one.
// The sanity band and the 50% move guard stay in refreshRates (fx.js); the band is checked here too so a
// wild answer from the first source falls back instead of being stored as-is.
import { BAND } from './fx.js';

export const RATE_ATTRIBUTION = 'Rates by Exchange Rate API, https://www.exchangerate-api.com';
export const ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
export const FAWAZ_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
const WANTED = ['INR', 'EUR', 'GBP', 'AED'];
const TIMEOUT_MS = 8000;

function pick(get, name) {
  const rates = {};
  for (const c of WANTED) {
    const v = get(c);
    if (v === undefined && c !== 'INR') continue; // only INR is required
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${name}: bad ${c}`);
    rates[c] = v;
  }
  if (!('INR' in rates)) throw new Error(`${name}: no INR`);
  if (rates.INR < BAND.INR[0] || rates.INR > BAND.INR[1]) throw new Error(`${name}: INR outside band`);
  return { rates, source: name };
}

async function getJson(fetchFn, url, name) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(`${name}: http ${res ? res.status : 'none'}`);
  return res.json();
}

export function erApiSource(fetchFn = globalThis.fetch) {
  return {
    name: 'er-api',
    async fetch() {
      const j = await getJson(fetchFn, ER_API_URL, 'er-api');
      if (!j || j.result !== 'success' || typeof j.rates !== 'object' || j.rates === null) throw new Error('er-api: not a success answer');
      return pick((c) => j.rates[c], 'er-api');
    },
  };
}

export function fawazSource(fetchFn = globalThis.fetch) {
  return {
    name: 'fawaz',
    async fetch() {
      const j = await getJson(fetchFn, FAWAZ_URL, 'fawaz');
      if (!j || typeof j.usd !== 'object' || j.usd === null) throw new Error('fawaz: no usd table');
      return pick((c) => j.usd[c.toLowerCase()], 'fawaz');
    },
  };
}

/** Tries each source in order; the first good answer wins and carries its own name (stored in fx_rate.source). */
export function chainSource(...sources) {
  return {
    name: sources.map((s) => s.name).join('>'),
    async fetch() {
      let last;
      for (const s of sources) {
        try {
          const out = await s.fetch();
          return { ...out, source: out.source ?? s.name };
        } catch (e) {
          last = e;
        }
      }
      throw last ?? new Error('no rate source');
    },
  };
}

/** Production default: er-api first, fawaz as the fallback. */
export const productionSource = (fetchFn = globalThis.fetch) => chainSource(erApiSource(fetchFn), fawazSource(fetchFn));
