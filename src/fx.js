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
 * There is NO approval gate: a big but valid move is accepted. A rate that is missing, zero, negative, not a number,
 * outside a wide technical band (INR 10 to 500 per US$), or more than 50% away from the last good rate (a bad feed,
 * not a market move) is rejected: the last good rate is kept and an alert is raised. A failed fetch does the same.
 * A person can fix a bad day with overrideRate().
 */
export const BAND = { INR: [10, 500] }; // units per US$: a technical sanity range, far wider than any real move
export const MAX_MOVE_PCT = 50; // one day's move beyond this is a bad feed (an inverted or mis-scaled number), not a market move

export async function refreshRates(db, source, now) {
  return db.tx(async (t) => {
    let fetched;
    try {
      fetched = await source.fetch();
      if (!fetched || typeof fetched.rates !== 'object' || fetched.rates === null) throw new Error('bad rate source answer');
    } catch (e) {
      await alertAll(t, now, 'fx.fetch_failed', { source: source.name, error: String((e && e.code) || (e && e.message) || 'error').replace(/[^A-Za-z0-9 _.:-]/g, '?').slice(0, 80) });
      return { ok: false, error: 'fetch_failed', results: {} };
    }
    const day = utcDayStart(now);
    const results = {};
    const bad = [];
    if (!('INR' in fetched.rates)) bad.push('INR');
    for (const [cur, v] of Object.entries(fetched.rates)) {
      if (!/^[A-Z]{3}$/.test(cur) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || toX10000(v) < 1 || (BAND[cur] && (v < BAND[cur][0] || v > BAND[cur][1]))) {
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
      if (prev && Math.abs(move) > MAX_MOVE_PCT) {
        results[cur] = 'invalid';
        bad.push(cur);
        continue;
      }
      await t.run(
        "INSERT INTO fx_rate (currency, rate_x10000, source, fetched_at, valid_from, valid_to, margin_bps, status, note) VALUES (?,?,?,?,?,?,0,'active',?)",
        cur, x, fetched.source || source.name, now, day, day + DAY, prev ? `moved ${move.toFixed(2)}% (recorded only, never blocks)` : null,
      );
      results[cur] = 'active';
    }
    if (bad.length) await alertAll(t, now, 'fx.rate_rejected', { source: fetched.source || source.name, currencies: bad.map((c) => String(c).slice(0, 8)) });
    return { ok: bad.length === 0, results };
  });
}

/** A person fixes a bad day: a new active row for the rest of today. History is kept (the bad row stays, marked by the newer one). */
export async function overrideRate(db, currency, value, now, reason) {
  return db.tx((t) => overrideRateIn(t, currency, value, now, reason));
}
export async function overrideRateIn(t, currency, value, now, reason) {
  if (!/^[A-Z]{3}$/.test(currency) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (BAND[currency] && (value < BAND[currency][0] || value > BAND[currency][1]))) return { ok: false, error: 'invalid_rate' };
  const note = `override: ${String(reason || 'no reason given').replace(/[^A-Za-z0-9 _.:,-]/g, '?').slice(0, 100)}`;
  await t.run(
    "INSERT INTO fx_rate (currency, rate_x10000, source, fetched_at, valid_from, valid_to, margin_bps, status, note) VALUES (?,?,?,?,?,?,0,'active',?)",
    currency, toX10000(value), 'manual', now, now, utcDayStart(now) + DAY, note,
  );
  await alertAll(t, now, 'fx.rate_overridden', { currency });
  return { ok: true };
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
