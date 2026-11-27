// Real rate sources (fake fetch only, no network), the chain, the stub refusal, the 24 h limit, and the quote fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, MIN, HOUR, T0 } from './helpers.js';
import { refreshRates, currentRate, utcDayStart, stubSource } from '../src/fx.js';
import { erApiSource, fawazSource, chainSource, productionSource, RATE_ATTRIBUTION, ER_API_URL, FAWAZ_URL } from '../src/fx-sources.js';
import { getSettings, DEFAULTS } from '../src/settings.js';

const DAY0 = utcDayStart(T0);
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const ER_GOOD = { result: 'success', rates: { INR: 83.5, EUR: 0.92, GBP: 0.79, AED: 3.6725, JPY: 150 } };
const FZ_GOOD = { date: '2026-11-17', usd: { inr: 84.25, eur: 0.93, gbp: 0.8, aed: 3.67 } };
/** A fake fetch: one answer (or throw) per URL; records the calls. */
const fakeFetch = (map) => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const v = map[url];
    if (v instanceof Error) throw v;
    return v;
  };
  f.calls = calls;
  return f;
};
const down = () => new Error('network down');
const buyInr = (s, ref, credits = 1000, email = 'a@x.com') => s.api.post('/v1/buy_credits', { email, credits, currency: 'INR', order_ref: ref });

test('chain falls back to the second source when the first fails', async () => {
  const f = fakeFetch({ [ER_API_URL]: down(), [FAWAZ_URL]: ok(FZ_GOOD) });
  const out = await productionSource(f).fetch();
  assert.equal(out.source, 'fawaz');
  assert.equal(out.rates.INR, 84.25);
  assert.deepEqual(f.calls, [ER_API_URL, FAWAZ_URL]);
  // an HTTP error counts as a failure too
  const f2 = fakeFetch({ [ER_API_URL]: { ok: false, status: 500, json: async () => ({}) }, [FAWAZ_URL]: ok(FZ_GOOD) });
  assert.equal((await productionSource(f2).fetch()).source, 'fawaz');
  // and the first source alone is used when it works (the fallback is not even called)
  const f3 = fakeFetch({ [ER_API_URL]: ok(ER_GOOD), [FAWAZ_URL]: ok(FZ_GOOD) });
  assert.equal((await productionSource(f3).fetch()).source, 'er-api');
  assert.deepEqual(f3.calls, [ER_API_URL]);
});

test('a bad answer is rejected (and falls back); two bad answers store nothing and raise an alert', async () => {
  const bads = [
    { result: 'error', 'error-type': 'quota-reached' },
    { result: 'success', rates: { EUR: 0.9 } }, // no INR
    { result: 'success', rates: { INR: 'abc' } },
    { result: 'success', rates: { INR: -3 } },
    { result: 'success', rates: { INR: 5000 } }, // outside the technical band
    { result: 'success', rates: { INR: 83.5, EUR: 0 } },
    null,
    { rates: { INR: 83.5 } }, // not marked success
  ];
  for (const bad of bads) {
    await assert.rejects(() => erApiSource(fakeFetch({ [ER_API_URL]: ok(bad) })).fetch(), undefined, JSON.stringify(bad));
    const f = fakeFetch({ [ER_API_URL]: ok(bad), [FAWAZ_URL]: ok(FZ_GOOD) });
    assert.equal((await productionSource(f).fetch()).source, 'fawaz', JSON.stringify(bad));
  }
  await assert.rejects(() => fawazSource(fakeFetch({ [FAWAZ_URL]: ok({ usd: { inr: 'x' } }) })).fetch());
  await assert.rejects(() => fawazSource(fakeFetch({ [FAWAZ_URL]: ok({ usd: { inr: 5 } }) })).fetch());
  // both bad: nothing stored, alert raised
  const s = await setup();
  const both = fakeFetch({ [ER_API_URL]: ok(bads[0]), [FAWAZ_URL]: ok({ usd: {} }) });
  const r = await refreshRates(s.db, productionSource(both), DAY0);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fetch_failed');
  assert.equal((await s.db.all('SELECT * FROM fx_rate')).length, 0);
  assert.ok(await s.db.first("SELECT 1 x FROM outbox WHERE type = 'fx.fetch_failed'"));
});

test('the real source name is stored in fx_rate.source (er-api, fawaz); the 50% move guard still applies', async () => {
  const s = await setup();
  await refreshRates(s.db, productionSource(fakeFetch({ [ER_API_URL]: ok(ER_GOOD) })), DAY0);
  const a = await s.db.first("SELECT * FROM fx_rate WHERE currency = 'INR'");
  assert.equal(a.source, 'er-api');
  assert.equal(a.rate_x10000, 835000);
  assert.equal((await s.db.first("SELECT source FROM fx_rate WHERE currency = 'EUR'")).source, 'er-api');
  assert.equal(await s.db.first("SELECT 1 x FROM fx_rate WHERE currency = 'JPY'"), null); // only the currencies we use are kept
  // next day the first source is down: the fallback's name is stored
  await refreshRates(s.db, productionSource(fakeFetch({ [ER_API_URL]: down(), [FAWAZ_URL]: ok(FZ_GOOD) })), DAY0 + 24 * HOUR);
  const b = await s.db.first("SELECT source FROM fx_rate WHERE currency = 'INR' ORDER BY valid_from DESC, id DESC");
  assert.equal(b.source, 'fawaz');
  // a 60% jump is still refused by the move guard
  const c = await refreshRates(s.db, chainSource(erApiSource(fakeFetch({ [ER_API_URL]: ok({ result: 'success', rates: { INR: 135 } }) }))), DAY0 + 48 * HOUR);
  assert.equal(c.results.INR, 'invalid');
  assert.equal((await s.db.first("SELECT source FROM fx_rate WHERE currency = 'INR' ORDER BY valid_from DESC, id DESC")).source, 'fawaz');
});

test('INR orders are refused on a stub rate (503 rate_source_not_configured); USD is fine; the test flag allows the stub', async () => {
  const s = await setup();
  await refreshRates(s.db, stubSource, DAY0);
  assert.equal((await s.db.first("SELECT source FROM fx_rate WHERE currency = 'INR'")).source, 'stub');
  s.clock.t = DAY0 + HOUR;
  const r = await buyInr(s, 'st1');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'rate_source_not_configured');
  assert.equal((await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'USD', order_ref: 'st2' })).status, 200);
  assert.equal(await s.db.first("SELECT 1 x FROM purchase_order WHERE order_ref = 'st1'"), null);
  // a real rate that lands later lifts the refusal
  await refreshRates(s.db, productionSource(fakeFetch({ [ER_API_URL]: ok({ result: 'success', rates: { INR: 71 } }) })), DAY0 + 24 * HOUR);
  s.clock.t = DAY0 + 25 * HOUR;
  assert.equal((await buyInr(s, 'st3')).status, 200);
  // the explicit flag keeps the stub usable in tests
  const t = await setup({ allowStubRate: true });
  await refreshRates(t.db, stubSource, DAY0);
  t.clock.t = DAY0 + HOUR;
  assert.equal((await buyInr(t, 'st4')).status, 200);
});

test('max age is 24 h: a rate 23 h old still prices INR, one 25 h old is stale ("try again shortly")', async () => {
  const s = await setup();
  assert.equal(DEFAULTS.fx_max_age_hours, 24);
  assert.equal((await getSettings(s.ctx())).fx_max_age_hours, 24);
  await refreshRates(s.db, productionSource(fakeFetch({ [ER_API_URL]: ok(ER_GOOD) })), DAY0);
  s.clock.t = DAY0 + 23 * HOUR;
  assert.equal((await buyInr(s, 'm1')).status, 200);
  s.clock.t = DAY0 + 24 * HOUR + 30 * MIN; // past midnight, rate 24.5 h old
  assert.equal((await currentRate(s.ctx(), 'INR', 24)).state, 'stale');
  s.clock.t = DAY0 + 25 * HOUR;
  const r = await buyInr(s, 'm2');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'rate_stale');
  assert.match(r.body.error.message, /try again shortly/i);
  assert.equal((await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'USD', order_ref: 'm3' })).status, 200);
  // an order keeps its rate for 120 minutes
  const o = await s.db.first("SELECT lock_until, created_at FROM purchase_order WHERE order_ref = 'm1'");
  assert.equal(o.lock_until - o.created_at, 120 * MIN);
});

test('the stored old default (72) is moved to 24 by the migration; any other stored value is kept', async () => {
  const s = await setup({ other: true });
  const sql = readFileSync(new URL('../migrations/0005_fx_max_age_24h.sql', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
  await s.db.run("UPDATE tenant_setting SET value = '72' WHERE tenant_id = 'demo' AND key = 'fx_max_age_hours'");
  await s.db.run("UPDATE tenant_setting SET value = '48' WHERE tenant_id = 'tenb' AND key = 'fx_max_age_hours'");
  await s.db.run(sql);
  assert.equal((await s.db.first("SELECT value FROM tenant_setting WHERE tenant_id = 'demo' AND key = 'fx_max_age_hours'")).value, '24');
  assert.equal((await s.db.first("SELECT value FROM tenant_setting WHERE tenant_id = 'tenb' AND key = 'fx_max_age_hours'")).value, '48');
});

test('quote total equals the order amount; the new price fields are present, attribution only for a real source', async () => {
  const s = await setup();
  await refreshRates(s.db, productionSource(fakeFetch({ [ER_API_URL]: ok(ER_GOOD) })), DAY0);
  s.clock.t = DAY0 + HOUR;
  for (const credits of [1000, 2345, 99999]) {
    const q = (await s.read.get(`/v1/quote?credits=${credits}`)).body;
    const o = (await buyInr(s, `q${credits}`, credits, 'q@x.com')).body;
    assert.equal(o.amount_minor, q.inr_minor, `quote == order for ${credits}`);
    assert.ok(q.inr_minor > 0);
    for (const x of [q, o]) {
      assert.equal(x.rate_source, 'er-api');
      assert.equal(x.rate_as_of, new Date(DAY0).toISOString());
      assert.equal(x.rate_attribution, RATE_ATTRIBUTION);
      assert.equal(x.rate_lock_minutes, 120);
      assert.equal(x.price_note_en, 'Price held for 2 hours. After that, credits may differ.');
    }
  }
  assert.equal(RATE_ATTRIBUTION, 'Rates by Exchange Rate API, https://www.exchangerate-api.com');
  // existing field names are unchanged
  const q = (await s.read.get('/v1/quote?credits=1000')).body;
  for (const k of ['credits', 'usd', 'usd_minor', 'inr_minor', 'pay_in', 'rate_state', 'rate_as_of', 'inr_paise_per_usd', 'display_text']) assert.ok(k in q, k);
  // a stub rate: source shown, no attribution
  const t = await setup();
  await refreshRates(t.db, stubSource, DAY0);
  t.clock.t = DAY0 + HOUR;
  const qs = (await t.read.get('/v1/quote?credits=1000')).body;
  assert.equal(qs.rate_source, 'stub');
  assert.equal('rate_attribution' in qs, false);
  assert.equal(qs.rate_lock_minutes, 120);
});
