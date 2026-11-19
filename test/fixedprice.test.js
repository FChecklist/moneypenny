// F1: a listed INR pack costs exactly its list price, whatever the daily rate does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, DAY, MIN, T0 } from './helpers.js';
import { refreshRates, utcDayStart } from '../src/fx.js';

const DAY0 = utcDayStart(T0);
const src = (r) => ({ name: 't', async fetch() { return { rates: { INR: r } }; } });
const PACK = { 3400: 239900 };
const order = (s, ref, credits = 3400) => s.api.post('/v1/buy_credits', { email: 'a@x.com', credits, currency: 'INR', order_ref: ref });

test('F1-1: the 3,400 pack costs Rs 2,399 at any rate, with the margin on', async () => {
  for (const rate of [70, 78, 88, 95]) {
    const s = await setup();
    await s.admin.put('/v1/admin/settings', { inr_packs: PACK }); // margin stays at its default 5%
    await refreshRates(s.db, src(rate), DAY0);
    const q = await s.read.get('/v1/quote?credits=3400');
    assert.equal(q.body.inr_minor, 239900, `quote at Rs ${rate}`);
    assert.equal(q.body.inr_fixed, true);
    s.clock.t = DAY0 + 3 * MIN;
    const o = await order(s, `p${rate}`);
    assert.equal(o.status, 200);
    assert.equal(o.body.amount_minor, 239900, `order at Rs ${rate}`);
  }
});

test('F1-2: an order for a pack stores the fixed price; other sizes still use the rate', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { inr_packs: PACK });
  await refreshRates(s.db, src(88), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  await order(s, 'f1');
  const row = await s.db.first("SELECT amount_minor, fixed_price FROM purchase_order WHERE order_ref = 'f1'");
  assert.equal(row.amount_minor, 239900);
  assert.equal(row.fixed_price, 1);
  await order(s, 'f2', 1000);
  const odd = await s.db.first("SELECT amount_minor, fixed_price FROM purchase_order WHERE order_ref = 'f2'");
  assert.equal(odd.fixed_price, 0);
  assert.notEqual(odd.amount_minor, Math.round(239900 * 1000 / 3400));
});

test('F1-3: a pack keeps its price when the rate is stale, and a late payment is not re-priced', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { inr_packs: PACK });
  await refreshRates(s.db, src(70), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  await order(s, 'late');
  const o = await s.db.first("SELECT id FROM purchase_order WHERE order_ref = 'late'");
  s.clock.t = DAY0 + 2 * DAY; // past the 120-minute lock, rate moved
  await refreshRates(s.db, src(95), s.clock.t);
  const c = await s.pay.post('/v1/rail/confirm', { order_id: o.id, payment_ref: 'pay_late', paid_minor: 239900, currency: 'INR' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.credited, 3400);
  assert.ok(!c.body.repriced);
  s.clock.t = DAY0 + 10 * DAY; // rate now stale
  const q = await s.read.get('/v1/quote?credits=3400');
  assert.equal(q.body.inr_minor, 239900);
  assert.equal((await s.read.get('/v1/quote?credits=1000')).body.inr_minor, null);
});

test('F1-4: bad pack tables are refused', async () => {
  const s = await setup();
  for (const bad of [[1], { abc: 100 }, { 3400: 5 }, { 3400: 1.5 }, { 0: 500 }, null]) {
    assert.equal((await s.admin.put('/v1/admin/settings', { inr_packs: bad })).status, 400);
  }
});

test('F1-5: a pack price far from a normal price is refused (typing slip)', async () => {
  const s = await setup();
  for (const bad of [{ 3400: 239 }, { 3400: 23990 }, { 3400: 2399000 }]) assert.equal((await s.admin.put('/v1/admin/settings', { inr_packs: bad })).status, 400);
  assert.equal((await s.admin.put('/v1/admin/settings', { inr_packs: PACK })).status, 200);
});

test('F1-6: an underpaid fixed order is refused; a pack changed after the order keeps the price quoted', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { inr_packs: PACK });
  await refreshRates(s.db, src(70), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  await order(s, 'chg');
  const o = await s.db.first("SELECT id FROM purchase_order WHERE order_ref = 'chg'");
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 259900 } }); // list price changed after the order
  const low = await s.pay.post('/v1/rail/confirm', { order_id: o.id, payment_ref: 'pay_low', paid_minor: 200000, currency: 'INR' });
  assert.equal(low.status, 422);
  const ok = await s.pay.post('/v1/rail/confirm', { order_id: o.id, payment_ref: 'pay_ok', paid_minor: 239900, currency: 'INR' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.credited, 3400);
  assert.equal((await order(s, 'chg2')).body.amount_minor, 259900); // new orders use the new price
});
