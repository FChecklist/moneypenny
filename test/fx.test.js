// The daily exchange-rate table, rate locking, margin, rounding, stale and failed fetches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, DAY, MIN, T0 } from './helpers.js';
import { refreshRates, approveRate, currentRate, utcDayStart, stubSource } from '../src/fx.js';
import { getSettings } from '../src/settings.js';

const src = (rates, name = 'test') => ({ name, async fetch() { return { rates }; } });
const failing = { name: 'broken', async fetch() { throw new Error('network down'); } };
const DAY0 = utcDayStart(T0); // 00:00 UTC of the test day
const inr = (s) => currentRate(s.ctx(), 'INR', 72);

test('rate is fixed for the UTC day: a second fetch changes nothing', async () => {
  const s = await setup();
  const a = await refreshRates(s.db, src({ INR: 70 }), DAY0);
  assert.equal(a.results.INR, 'active');
  const b = await refreshRates(s.db, src({ INR: 70.9 }), DAY0 + 5 * 60 * MIN);
  assert.equal(b.results.INR, 'already_fixed');
  assert.equal((await s.db.all("SELECT * FROM fx_rate WHERE currency = 'INR'")).length, 1);
  const r = await inr(s);
  assert.equal(r.units_per_usd, 70);
  assert.equal(r.row.valid_to - r.row.valid_from, DAY);
});

test('00:00 UTC boundary: yesterday rate is "fresh" until midnight, then a fallback until the new one lands', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  s.clock.t = DAY0 + DAY - 1; // 23:59:59.999
  assert.equal((await inr(s)).state, 'fresh');
  s.clock.t = DAY0 + DAY; // 00:00:00.000 next day
  const mid = await inr(s);
  assert.equal(mid.state, 'fallback');
  assert.equal(mid.units_per_usd, 70);
  await refreshRates(s.db, src({ INR: 71 }), DAY0 + DAY);
  const next = await inr(s);
  assert.equal(next.state, 'fresh');
  assert.equal(next.units_per_usd, 71);
  // history is kept
  assert.equal((await s.db.all("SELECT * FROM fx_rate WHERE currency = 'INR' ORDER BY id")).length, 2);
});

test('rate history cannot be edited or deleted', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  await assert.rejects(() => s.db.run('UPDATE fx_rate SET rate_x10000 = 1'));
  await assert.rejects(() => s.db.run('DELETE FROM fx_rate'));
});

test('the table rate replaces the hand-typed one, and entries lock it', async () => {
  const s = await setup();
  s.clock.t = DAY0 + 3600000;
  await refreshRates(s.db, src({ INR: 80 }), DAY0);
  assert.equal((await getSettings(s.ctx())).inr_paise_per_usd, 8000);
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const e = (await s.api.get('/v1/history?email=a@x.com')).body.entries[0];
  assert.equal(e.rate_inr, 8000);
  assert.equal(e.rate_cpu, 100);
  // an INR order is priced with the table rate
  const q = (await s.read.get('/v1/quote?credits=1000')).body;
  assert.equal(q.inr_minor, 80000);
  assert.equal(q.rate_state, 'fresh');
});

test('margin per tenant, and the rupee rounding setting', async () => {
  const s = await setup();
  s.clock.t = DAY0 + 3600000;
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  await s.admin.put('/v1/admin/settings', { fx_margin_bps: 200 });
  assert.equal((await getSettings(s.ctx())).inr_paise_per_usd, 7140);
  let q = (await s.read.get('/v1/quote?credits=333')).body; // 3.33 USD * 71.40 = Rs 237.762 -> Rs 238
  assert.equal(q.inr_minor, 23800);
  await s.admin.put('/v1/admin/settings', { inr_round_to_rupee: false });
  q = (await s.read.get('/v1/quote?credits=333')).body;
  assert.equal(q.inr_minor, 23777); // ceil(333 * 7140 / 100) = 23776.2 -> 23777 paise
  assert.equal(q.usd, '3.33');
  assert.equal(q.usd_minor, 333);
});

test('a jump over the sanity band is held for a person; approving appends, never edits', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  const next = DAY0 + DAY + 3600000;
  const r = await refreshRates(s.db, src({ INR: 80 }), next); // +14%
  assert.equal(r.results.INR, 'pending_approval');
  s.clock.t = next;
  assert.equal((await inr(s)).units_per_usd, 70); // still the last good one
  const alert = await s.db.first("SELECT * FROM outbox WHERE type = 'fx.jump_held'");
  assert.ok(alert);
  const held = await s.db.first("SELECT id FROM fx_rate WHERE status = 'pending_approval'");
  assert.equal((await approveRate(s.db, held.id, next, true)).ok, true);
  assert.equal((await inr(s)).units_per_usd, 80);
  assert.equal((await approveRate(s.db, held.id, next, true)).ok, false); // nothing left to approve
  assert.equal((await s.db.all("SELECT * FROM fx_rate WHERE currency = 'INR'")).length, 3);
});

test('a rejected jump never becomes the rate', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  const next = DAY0 + DAY;
  await refreshRates(s.db, src({ INR: 140 }), next);
  const held = await s.db.first("SELECT id FROM fx_rate WHERE status = 'pending_approval'");
  await approveRate(s.db, held.id, next, false);
  s.clock.t = next + 1000;
  assert.equal((await inr(s)).units_per_usd, 70);
});

test('failed fetch: last good rate stays, an alert is raised, old rate becomes stale and pauses new INR orders (USD still works)', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  const f = await refreshRates(s.db, failing, DAY0 + DAY);
  assert.equal(f.ok, false);
  assert.ok(await s.db.first("SELECT 1 x FROM outbox WHERE type = 'fx.fetch_failed'"));
  s.clock.t = DAY0 + DAY + 2 * 3600000;
  assert.equal((await inr(s)).state, 'fallback');
  assert.equal((await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'INR', order_ref: 'f1' })).status, 200);
  s.clock.t = DAY0 + 4 * DAY; // far past the 72 hour limit
  assert.equal((await inr(s)).state, 'stale');
  const blocked = await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'INR', order_ref: 'f2' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.code, 'rate_stale');
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const cash = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'c1', amount_minor: 500000, currency: 'INR' });
  assert.equal(cash.body.error.code, 'rate_stale');
  assert.equal((await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'c2', amount_minor: 500, currency: 'USD' })).status, 200);
  assert.equal((await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'USD', order_ref: 'f3' })).status, 200);
  assert.equal((await bal(s.read, 'a@x.com', false)).fx_stale, true);
  const h = await (await s.app.fetch(new Request('http://t.local/health'))).json();
  assert.equal(h.fx.state, 'stale');
  assert.equal(h.ok, false);
});

test('an order keeps the rate it was made at, even when the rate changes before payment', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  s.clock.t = DAY0 + 3600000;
  const o = await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 2000, currency: 'INR', order_ref: 'lk1' });
  assert.equal(o.body.amount_minor, 140000); // Rs 1,400
  // next day the rate moves 3% (inside the band)
  await refreshRates(s.db, src({ INR: 72.1 }), DAY0 + DAY);
  s.clock.t = DAY0 + DAY + 3600000;
  assert.equal((await getSettings(s.ctx())).inr_paise_per_usd, 7210);
  const c = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'rzp_1', paid_minor: 140000, currency: 'INR' });
  assert.equal(c.body.credited, 2000);
  const e = (await s.api.get('/v1/history?email=a@x.com')).body.entries.find((x) => x.kind === 'purchase');
  assert.equal(e.rate_inr, 7000); // the locked rate, not today's
  assert.equal(e.money_minor, 140000);
  // a new order today is priced at today's rate
  const o2 = await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 2000, currency: 'INR', order_ref: 'lk2' });
  assert.equal(o2.body.amount_minor, 144200);
});

test('a hold keeps its rate; the cash it collects is booked at that rate', async () => {
  const s = await setup();
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  s.clock.t = DAY0 + 3600000;
  await buy(s.api, 'a@x.com', 100, 'p1');
  s.clock.t = DAY0 + DAY - 10 * MIN; // ten minutes before midnight UTC
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'h1', amount_minor: 210000, currency: 'INR' }); // Rs 2100 = 3000 credits
  assert.ok(r.body.cash_due_minor > 0);
  await refreshRates(s.db, src({ INR: 72 }), DAY0 + DAY);
  s.clock.t = DAY0 + DAY + 2 * MIN; // after the new rate, still inside the hold
  assert.equal((await getSettings(s.ctx())).inr_paise_per_usd, 7200);
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rz9', cash_paid_minor: r.body.cash_due_minor });
  const col = (await s.api.get('/v1/history?email=a@x.com')).body.entries.find((x) => x.kind === 'collection');
  assert.equal(col.rate_inr, 7000);
});

test('display helper: credits, US$, INR, and a display-only local figure with a "rate as of" stamp', async () => {
  const s = await setup();
  s.clock.t = DAY0 + 3600000;
  await refreshRates(s.db, stubSource, DAY0);
  const q = (await s.read.get('/v1/quote?credits=2000&currency=EUR')).body;
  assert.equal(q.credits, 2000);
  assert.equal(q.usd, '20.00');
  assert.equal(q.inr_minor, 140000);
  assert.deepEqual(q.pay_in, ['INR', 'USD']);
  assert.equal(q.local.currency, 'EUR');
  assert.equal(q.local.amount, '18.40');
  assert.equal(q.local.display_only, true);
  assert.equal(q.rate_as_of, new Date(DAY0).toISOString());
  // a tenant can name its display currency; it is never a payment currency
  await s.admin.put('/v1/admin/settings', { display_currency: 'GBP' });
  assert.equal((await s.read.get('/v1/quote?credits=2000')).body.local.currency, 'GBP');
  assert.equal((await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'GBP', order_ref: 'e1' })).body.error.code, 'bad_currency');
  assert.equal((await s.admin.put('/v1/admin/settings', { base_currency: 'EUR' })).status, 400);
});

test('bad rates from a source are ignored', async () => {
  const s = await setup();
  const r = await refreshRates(s.db, src({ INR: -5, XX: 3, EUR: 'a', GBP: 0 }), DAY0);
  assert.ok(Object.values(r.results).every((v) => v === 'invalid'));
  assert.equal((await s.db.all('SELECT * FROM fx_rate')).length, 0);
  assert.equal((await inr(s)).state, 'none');
});
