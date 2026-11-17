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
 * A jump bigger than jumpPct versus the last good rate is held as 'pending_approval' until a person approves it.
 * A failed fetch keeps the last good rate and raises an alert.
 */
export async function refreshRates(db, source, now, { jumpPct = 5 } = {}) {
  return db.tx(async (t) => {
    let fetched;
    try {
      fetched = await source.fetch();
      if (!fetched || typeof fetched.rates !== 'object') throw new Error('bad rate source answer');
    } catch (e) {
      await alertAll(t, now, 'fx.fetch_failed', { source: source.name, error: String(e.message).slice(0, 120) });
      return { ok: false, error: 'fetch_failed', results: {} };
    }
    const day = utcDayStart(now);
    const results = {};
    for (const [cur, v] of Object.entries(fetched.rates)) {
      if (!/^[A-Z]{3}$/.test(cur) || !Number.isFinite(v) || v <= 0) {
        results[cur] = 'invalid';
        continue;
      }
      const x = toX10000(v);
      if (x < 1) {
        results[cur] = 'invalid';
        continue;
      }
      const same = await t.first('SELECT id FROM fx_rate WHERE currency = ? AND valid_from = ?', cur, day); // any row: the day is already decided
      if (same) {
        results[cur] = 'already_fixed';
        continue;
      }
      const prev = await t.first("SELECT rate_x10000 FROM fx_rate WHERE currency = ? AND status = 'active' ORDER BY valid_from DESC, id DESC LIMIT 1", cur);
      const jump = prev ? (Math.abs(x - prev.rate_x10000) * 100) / prev.rate_x10000 : 0;
      const status = jump > jumpPct ? 'pending_approval' : 'active';
      await t.run(
        'INSERT INTO fx_rate (currency, rate_x10000, source, fetched_at, valid_from, valid_to, margin_bps, status, note) VALUES (?,?,?,?,?,?,0,?,?)',
        cur, x, source.name, now, day, day + DAY, status, status === 'pending_approval' ? `jump ${jump.toFixed(2)}% over ${jumpPct}%` : null,
      );
      results[cur] = status;
      if (status === 'pending_approval') await alertAll(t, now, 'fx.jump_held', { currency: cur, jump_pct: Number(jump.toFixed(2)) });
    }
    return { ok: true, results };
  });
}

/** A person approves a held rate: a new active row is appended (history is never edited). */
export async function approveRate(db, id, now, approve = true) {
  return db.tx(async (t) => {
    const r = await t.first("SELECT * FROM fx_rate p WHERE id = ? AND status = 'pending_approval' AND NOT EXISTS (SELECT 1 FROM fx_rate q WHERE q.resolves = p.id)", id);
    if (!r) return { ok: false, error: 'not_pending' };
    await t.run(
      'INSERT INTO fx_rate (currency, rate_x10000, source, fetched_at, valid_from, valid_to, margin_bps, status, note, resolves) VALUES (?,?,?,?,?,?,?,?,?,?)',
      r.currency, r.rate_x10000, r.source, r.fetched_at, r.valid_from, r.valid_to, r.margin_bps, approve ? 'active' : 'rejected', `${approve ? 'approved' : 'rejected'} row ${id} at ${now}`, id,
    );
    return { ok: true };
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
