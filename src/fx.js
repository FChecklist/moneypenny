// Daily exchange rates. Fetched behind a pluggable source (stub by default; no network here),
// FIXED for the UTC day they are valid for, append-only, with a sanity band and a stale fallback.
import { DAY, newId } from './util.js';
import { emit } from './outbox.js';

export const utcDayStart = (t) => t - (t % DAY);
export const toX10000 = (v) => Math.round(v * 10000);

/** Default source: fixed sample numbers, no network. A real source implements fetch() the same way. */
export const stubSource = {
  name: 'stub',
  async fetch() {
    return { rates: { INR: 70, EUR: 0.92, GBP: 0.79, AED: 3.6725 } };
  },
};

async function alertAll(db, now, type, payload) {
  for (const t of await db.all('SELECT id FROM tenant')) await emit({ db, tenantId: t.id, now: () => now }, type, payload);
}

/**
 * Run once a day at 00:00 UTC. A day's rate is fixed: a second run on the same UTC day changes nothing.
 * There is NO approval gate: a big but valid move is accepted. Only a rate that is missing, zero, negative or not
 * a number is rejected: the last good rate is kept and an alert is raised. A failed fetch does the same.
 */
export async function refreshRates(db, source, now) {
  return db.tx(async (t) => {
    let fetched;
    try {
      fetched = await source.fetch();
      if (!fetched || typeof fetched.rates !== 'object' || fetched.rates === null) throw new Error('bad rate source answer');
    } catch (e) {
      await alertAll(t, now, 'fx.fetch_failed', { source: source.name, error: String(e.message).slice(0, 120) });
      return { ok: false, error: 'fetch_failed', results: {} };
    }
    const day = utcDayStart(now);
    const results = {};
    const bad = [];
    if (!('INR' in fetched.rates)) bad.push('INR');
    for (const [cur, v] of Object.entries(fetched.rates)) {
      if (!/^[A-Z]{3}$/.test(cur) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || toX10000(v) < 1) {
        results[cur] = 'invalid';
        bad.push(cur);
        continue;
      }
      const x = toX10000(v);
      const same = await t.first('SELECT id FROM fx_rate WHERE currency = ? AND valid_from = ?', cur, day);
      if (same) {
        results[cur] = 'already_fixed';
        continue;
      }
      const prev = await t.first("SELECT rate_x10000 FROM fx_rate WHERE currency = ? AND status = 'active' ORDER BY valid_from DESC, id DESC LIMIT 1", cur);
      const move = prev ? ((x - prev.rate_x10000) * 100) / prev.rate_x10000 : 0;
      await t.run(
        "INSERT INTO fx_rate (currency, rate_x10000, source, fetched_at, valid_from, valid_to, margin_bps, status, note) VALUES (?,?,?,?,?,?,0,'active',?)",
        cur, x, source.name, now, day, day + DAY, prev ? `moved ${move.toFixed(2)}% (recorded only, never blocks)` : null,
      );
      results[cur] = 'active';
    }
    if (bad.length) await alertAll(t, now, 'fx.rate_rejected', { source: source.name, currencies: bad.map((c) => String(c).slice(0, 8)) });
    return { ok: bad.length === 0, results };
  });
}

/**
 * The rate in force now.  state: fresh (inside its UTC day), fallback (last good rate, older than a day
 * but inside the maximum age), stale (older than the maximum age: no new INR money orders), or none.
 */
export async function currentRate(ctx, currency, maxAgeHours) {
  const now = ctx.now();
  const row = await ctx.db.first(
    "SELECT * FROM fx_rate WHERE currency = ? AND status = 'active' AND valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1",
    currency, now,
  );
  if (!row) return { state: 'none' };
  const ageH = (now - row.fetched_at) / 3600000;
  const state = now < row.valid_to ? 'fresh' : ageH <= maxAgeHours ? 'fallback' : 'stale';
  return { state, row, units_per_usd: row.rate_x10000 / 10000, as_of: row.fetched_at, valid_to: row.valid_to };
}

/** Latest rate for display-only currencies (never used to take payment). */
export async function displayRate(ctx, currency) {
  const row = await ctx.db.first("SELECT * FROM fx_rate WHERE currency = ? AND status = 'active' AND valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1", currency, ctx.now());
  return row ? { units_per_usd: row.rate_x10000 / 10000, as_of: row.fetched_at } : null;
}

export { newId };
