// The gate: price list, spend by item, buying credits through the payment rail, outbox, health, degraded cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, MIN, DAY } from './helpers.js';
import { verifyBalances } from '../src/ledger.js';
import { stubRail } from '../src/rail.js';

const setItem = (s, credits = 500, item = 'thing', product = 'prod') => s.admin.put('/v1/admin/catalogue', { product, item, credits });
const spendItem = (api, o = {}) => api.post('/v1/spend/reserve_item', { email: 'a@x.com', product: 'prod', item: 'thing', order_ref: `o${Math.random()}`, ...o });
const buyOrder = (api, o = {}) => api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'USD', order_ref: 'ord-1', ...o });

test('price list: admin sets prices in credits, products read them, others cannot change them', async () => {
  const s = await setup();
  assert.equal((await setItem(s, 500)).status, 200);
  assert.equal((await s.api.put('/v1/admin/catalogue', { product: 'prod', item: 'x', credits: 5 })).status, 403);
  const l = await s.api.get('/v1/catalogue?product=prod');
  assert.deepEqual(l.body.items, [{ product: 'prod', item: 'thing', credits: 500, active: 1 }]);
  assert.equal((await s.admin.put('/v1/admin/catalogue', { product: 'prod', item: 'bad item', credits: 5 })).status, 400);
  assert.equal((await s.admin.put('/v1/admin/catalogue', { product: 'prod', item: 'z', credits: 0 })).status, 400);
  await s.admin.put('/v1/admin/catalogue', { product: 'prod', item: 'thing', credits: 500, active: 0 });
  assert.equal((await s.api.get('/v1/catalogue?product=prod')).body.items.length, 0);
  assert.ok((await s.admin.get('/v1/admin/audit')).body.entries.some((e) => e.action === 'catalogue.set'));
});

test('spend by item: all or nothing in credits, price must match, then capture or release', async () => {
  const s = await setup();
  await setItem(s, 500);
  await buy(s.api, 'a@x.com', 300, 'p1');
  const short = await spendItem(s.api);
  assert.equal(short.status, 402);
  assert.equal(short.body.error.code, 'insufficient_credits');
  assert.equal(short.body.error.short_by, 200);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 300); // nothing was taken
  await buy(s.api, 'a@x.com', 700, 'p2');
  assert.equal((await spendItem(s.api, { credits: 400 })).body.error.code, 'price_changed');
  assert.equal((await spendItem(s.api, { item: 'nope' })).status, 404);
  const ok = await spendItem(s.api, { credits: 500, order_ref: 'o-a' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.credits, 500);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500);
  assert.equal((await s.api.post('/v1/spend/release', { hold_id: ok.body.hold_id })).body.status, 'released');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  const again = await spendItem(s.api, { order_ref: 'o-b' });
  assert.equal((await s.api.post('/v1/spend/capture', { hold_id: again.body.hold_id })).body.status, 'captured');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('spend by item: bonus still obeys its rules and a stranger has nothing', async () => {
  const s = await setup();
  await setItem(s, 500);
  assert.equal((await spendItem(s.api, { email: 'nobody@x.com' })).status, 402);
  await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 400, ref: 'b1' });
  assert.equal((await spendItem(s.api)).body.error.code, 'insufficient_credits'); // bonus locked until a first purchase
});

test('another tenant cannot see or use this tenant price list', async () => {
  const s = await setup({ other: true });
  await setItem(s, 500);
  const b = s.mkT(s.other);
  assert.equal((await b.get('/v1/catalogue?product=prod')).body.items.length, 0);
  assert.equal((await spendItem(b)).status, 404);
});

test('buy credits: rail order made, credits only after confirmation, amount checked, repeat is safe', async () => {
  const s = await setup();
  const o = await buyOrder(s.api);
  assert.equal(o.status, 200);
  assert.equal(o.body.status, 'awaiting_payment');
  assert.equal(o.body.amount_minor, 1000);
  assert.match(o.body.pay_url, /^https:\/\//);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0); // nothing yet
  const again = await buyOrder(s.api, { }, {});
  assert.equal(again.body.order_id, o.body.order_id);
  assert.equal((await buyOrder(s.api, { credits: 2000 })).body.error.code, 'order_ref_used');
  assert.equal((await s.api.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_1', paid_minor: 1000, currency: 'USD' })).status, 403); // product key cannot confirm
  assert.equal((await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_1', paid_minor: 900, currency: 'USD' })).body.error.code, 'payment_mismatch');
  assert.equal((await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_1', paid_minor: 1000, currency: 'INR' })).body.error.code, 'payment_mismatch');
  const c = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_1', paid_minor: 1000, currency: 'USD' }, { idem: null });
  assert.equal(c.body.credited, 1000);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  const dup = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_1', paid_minor: 1000, currency: 'USD' }, { idem: null });
  assert.equal(dup.headers.get('idempotent-replay'), 'true');
  const dup2 = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_1', paid_minor: 1000, currency: 'USD' }, { idem: 'other-key' });
  assert.equal(dup2.body.already, true);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  assert.equal((await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_2', paid_minor: 1000, currency: 'USD' })).body.error.code, 'order_already_paid');
  const h = (await s.api.get('/v1/history?email=a@x.com')).body.entries.find((e) => e.kind === 'purchase');
  assert.equal(h.ext_ref, 'pay_1');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('buy credits: limits, currencies, and one payment cannot pay two orders', async () => {
  const s = await setup();
  assert.equal((await buyOrder(s.api, { credits: 10 })).status, 400); // below the minimum
  assert.equal((await buyOrder(s.api, { credits: 9999999 })).status, 400);
  assert.equal((await buyOrder(s.api, { currency: 'EUR' })).body.error.code, 'bad_currency');
  const a = await buyOrder(s.api, { order_ref: 'o1' });
  const b = await buyOrder(s.api, { order_ref: 'o2' });
  await s.pay.post('/v1/rail/confirm', { order_id: a.body.order_id, payment_ref: 'same', paid_minor: 1000, currency: 'USD' });
  const second = await s.pay.post('/v1/rail/confirm', { order_id: b.body.order_id, payment_ref: 'same', paid_minor: 1000, currency: 'USD' });
  assert.equal(second.status, 409);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
});

test('rail down: orders wait, retry with back-off, become dead letters, and can be requeued', async () => {
  const s = await setup();
  let down = true;
  const calls = [];
  s.app.rail = { name: 'flaky', async createOrder(o) { calls.push(o.order_id); if (down) throw new Error('rail unreachable'); return stubRail.createOrder(o); }, async health() { return { ok: !down }; } };
  const o = await buyOrder(s.api);
  assert.equal(o.body.status, 'pending_rail'); // accepted, waiting
  assert.equal((await s.admin.post('/v1/admin/rail/process', {})).body.sent, 0); // not due yet (back-off)
  for (let i = 0; i < 7; i++) {
    s.clock.t += 61 * MIN;
    await s.admin.post('/v1/admin/rail/process', {});
  }
  const dl = await s.admin.get('/v1/admin/dead_letters');
  assert.equal(dl.body.dead_letters.length, 1);
  assert.equal(dl.body.dead_letters[0].attempts, 8);
  assert.equal(calls.length, 8);
  assert.equal((await s.admin.get('/v1/admin/health')).body.dead_letters, 1);
  const state = await s.db.first('SELECT status FROM purchase_order WHERE id = ?', o.body.order_id);
  assert.equal(state.status, 'failed');
  down = false;
  assert.equal((await s.admin.post('/v1/admin/dead_letters/requeue', { id: dl.body.dead_letters[0].id })).status, 200);
  assert.equal((await s.admin.post('/v1/admin/rail/process', {})).body.sent, 1);
  assert.equal((await s.db.first('SELECT status FROM purchase_order WHERE id = ?', o.body.order_id)).status, 'awaiting_payment');
  assert.equal((await s.admin.post('/v1/admin/dead_letters/requeue', { id: dl.body.dead_letters[0].id })).status, 404);
});

test('the rate lock lasts 120 minutes; after that an unpaid order is marked failed but a payment is still credited, re-priced', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { fx_margin_bps: 0 });
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.rate_lock_minutes, 120);
  const { refreshRates } = await import('../src/fx.js');
  const day = s.clock.t - (s.clock.t % DAY);
  await refreshRates(s.db, { name: 't', async fetch() { return { rates: { INR: 70 } }; } }, day);
  const o = await buyOrder(s.api, { currency: 'INR', credits: 2000, order_ref: 'lk' });
  assert.equal(o.body.amount_minor, 140000);
  s.clock.t += 119 * MIN;
  await s.admin.post('/v1/admin/sweep', {});
  assert.equal((await s.db.first('SELECT status FROM purchase_order WHERE id = ?', o.body.order_id)).status, 'awaiting_payment');
  const o2 = await buyOrder(s.api, { currency: 'INR', credits: 2000, order_ref: 'lk2' });
  s.clock.t += 2 * 60 * MIN; // both orders are now past the lock
  await s.admin.post('/v1/admin/sweep', {});
  assert.equal((await s.db.first('SELECT status FROM purchase_order WHERE id = ?', o.body.order_id)).status, 'failed');
  await refreshRates(s.db, { name: 't', async fetch() { return { rates: { INR: 80 } }; } }, day + DAY);
  s.clock.t = day + DAY + 60000;
  const c = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'late1', paid_minor: 140000, currency: 'INR' });
  assert.equal(c.body.repriced, true);
  assert.equal(c.body.credited, 1750); // Rs 1,400 at Rs 80 (flat) is 1,750 credits, never more than the money is worth now
  void o2;
});

test('a late USD payment is credited in full (no rate involved)', async () => {
  const s = await setup();
  const o = await buyOrder(s.api);
  s.clock.t += 3 * 60 * MIN;
  await s.admin.post('/v1/admin/sweep', {});
  const c = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'late2', paid_minor: 1000, currency: 'USD' });
  assert.equal(c.body.credited, 1000);
});

test('health: shows whether parts work, never tenant data', async () => {
  const s = await setup();
  const r = await s.app.fetch(new Request('http://t.local/health'));
  const h = await r.json();
  assert.equal(r.status, 200);
  assert.equal(h.db, true);
  assert.equal(h.rail.name, undefined); // the open page does not say which rail
  assert.equal(h.outbox, undefined); // and gives no counts
  assert.equal(h.rail.ok, true);
  assert.ok(!JSON.stringify(h).includes('demo'));
  s.app.rail = { name: 'down', async createOrder() { throw new Error('x'); }, async health() { return { ok: false }; } };
  const h2 = await (await s.app.fetch(new Request('http://t.local/health'))).json();
  assert.equal(h2.ok, false);
  assert.equal(h2.rail.ok, false);
});

test('degraded mode: a recent balance is still shown (marked) if the database cannot read lots', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 700, 'p1');
  await buy(s.api, 'b@x.com', 100, 'p2'); // has credits but was never read, so nothing is cached for them
  const good = await bal(s.read, 'a@x.com', false);
  assert.equal(good.balance, 700);
  assert.equal(good.degraded, undefined);
  await s.db.run('ALTER TABLE lot RENAME TO lot_away');
  try {
    const d = await bal(s.read, 'a@x.com', false);
    assert.equal(d.degraded, true);
    assert.equal(d.balance, 700);
    assert.equal((await s.read.get('/v1/balance?email=b@x.com')).status, 500); // nothing cached for this person
    s.clock.t += 10 * MIN; // older than the cache window (5 minutes)
    assert.equal((await s.read.get('/v1/balance?email=a@x.com')).status, 500);
  } finally {
    await s.db.run('ALTER TABLE lot_away RENAME TO lot');
  }
  assert.equal((await bal(s.read, 'a@x.com', false)).balance, 700);
});

test('white label: renamed currency, and no response forces the Moneypenny name', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { currency_name: 'Acme Coins', unit_label: 'coins', unit_symbol: 'AC' });
  await setItem(s, 100);
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const outs = [];
  outs.push(await s.read.get('/v1/balance?email=a@x.com'));
  outs.push(await s.api.get('/v1/balance?email=a@x.com&details=1'));
  outs.push(await s.read.get('/v1/quote?credits=2000&currency=EUR'));
  outs.push(await s.api.get('/v1/catalogue?product=prod'));
  const r = await spendItem(s.api, { order_ref: 'w1' });
  outs.push(r);
  outs.push(await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id }));
  outs.push(await spendItem(s.api, { order_ref: 'w2', email: 'broke@x.com' }));
  outs.push(await buyOrder(s.api, { order_ref: 'w3' }));
  outs.push(await s.api.get('/v1/history?email=a@x.com'));
  for (const o of outs) assert.ok(!/moneypenny/i.test(JSON.stringify(o.body)), JSON.stringify(o.body));
  const d = (await s.read.get('/v1/balance?email=a@x.com')).body.display;
  assert.equal(d.label, 'Acme Coins');
  assert.equal(d.symbol, 'AC');
  assert.ok(!/\$/.test(d.symbol));
  assert.equal(d.amount, '900');
});

test('default currency name and unit', async () => {
  const s = await setup();
  const d = (await s.read.get('/v1/balance?email=a@x.com')).body.display;
  assert.equal(d.label, 'Moneypenny Credits');
  assert.equal(d.unit, 'credits');
});
