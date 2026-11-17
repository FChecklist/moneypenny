// One test (or more) for every finding of independent audit 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, buy, event, note, DAY, MIN } from './helpers.js';
import { refreshRates, overrideRate, currentRate, utcDayStart } from '../src/fx.js';
import { migrate } from '../src/db.js';
import { findPayment } from '../src/wallet.js';

const sale = (api, o = {}) => event(api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 2000, currency: 'USD', ...o });
const src = (rates) => ({ name: 'test', async fetch() { return { rates }; } });

test('commission needs a real, noted payment of at least that size and currency', async () => {
  const s = await setup();
  assert.equal((await sale(s.api, { sale_ref: 'inv_1', noNotice: true })).body.reason, 'payment_not_verified'); // never noted
  await note(s.api, 'inv_2', 1000);
  assert.equal((await sale(s.api, { sale_ref: 'inv_2', noNotice: true, cash_minor: 2000 })).body.reason, 'cash_exceeds_payment'); // bigger than the payment
  await note(s.api, 'inv_3', 2000, 'INR');
  assert.equal((await sale(s.api, { sale_ref: 'inv_3', noNotice: true })).body.reason, 'cash_exceeds_payment'); // other currency
  assert.equal((await sale(s.api, { sale_ref: 'inv_4' })).body.granted, 200); // noted by the helper, as in life
});

test('a sale id is the same sale whatever its letter case', async () => {
  const s = await setup();
  assert.equal((await sale(s.api, { sale_ref: 'Pay_AbC' })).body.granted, 200);
  const again = await sale(s.api, { sale_ref: 'pay_abc', noNotice: true });
  assert.equal(again.body.granted, 0);
  assert.equal(again.body.reason, 'sale_already_used');
});

test('a taken-back sale cannot earn commission afterwards, in any letter case', async () => {
  const s = await setup();
  await note(s.api, 'Inv_9', 2000);
  assert.equal((await s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'INV_9' })).status, 200); // a sale nobody earned on yet: unknown, so it is noted as reversed below

  const r = await sale(s.api, { sale_ref: 'inv_9', noNotice: true });
  assert.equal(r.body.granted, 0);
});

test('a payment notice is idempotent, and a changed figure is refused', async () => {
  const s = await setup();
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'n1', paid_minor: 500, currency: 'USD' })).body.noted, true);
  const dup = await s.pay.post('/v1/payment_notice', { payment_ref: 'N1', paid_minor: 500, currency: 'USD' }, { idem: 'pay:N1' });
  assert.equal(dup.body.duplicate, true);
  const bad = await s.pay.post('/v1/payment_notice', { payment_ref: 'n1', paid_minor: 900, currency: 'USD' }, { idem: 'pay:n1' });
  assert.equal(bad.body.error.code, 'payment_conflict');
  assert.equal((await s.api.post('/v1/payment_notice', { payment_ref: 'n2', paid_minor: 5, currency: 'USD' })).status, 403); // product keys cannot note payments
  assert.equal((await s.ai.post('/v1/payment_notice', { payment_ref: 'n3', paid_minor: 5, currency: 'USD' })).status, 403);
});

test('cash on an order is captured only against a noted payment that covers it', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  await s.admin.put('/v1/admin/catalogue', { product: 'demo_product', item: 'big', price_credits: 3400 }).catch(() => null);
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 3400, currency: 'USD' });
  const cap = (extra) => s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rz1', cash_paid_minor: r.body.cash_due_minor, ...extra });
  assert.equal((await cap()).body.error.code, 'payment_not_verified'); // never noted
  await note(s.api, 'rz1', r.body.cash_due_minor - 1);
  assert.equal((await cap()).body.error.code, 'payment_not_verified'); // does not cover it
});

test('the migration list is remembered: running it again changes nothing', async () => {
  const s = await setup();
  const before = (await s.db.all('SELECT file FROM schema_migrations ORDER BY file')).map((r) => r.file);
  assert.deepEqual(before, ['0001_init.sql', '0002_gate_fx.sql', '0003_ai_safety.sql']);
  migrate(s.db);
  migrate(s.db);
  assert.deepEqual((await s.db.all('SELECT file FROM schema_migrations ORDER BY file')).map((r) => r.file), before);
});

test('a rate outside the technical band, or a huge jump, is refused; a person can fix a bad day', async () => {
  const s = await setup();
  const DAY0 = utcDayStart(Date.UTC(2026, 10, 17, 9));
  await refreshRates(s.db, src({ INR: 70 }), DAY0);
  const r1 = await refreshRates(s.db, src({ INR: 0.83 }), DAY0 + DAY); // inverted feed
  assert.equal(r1.results.INR, 'invalid');
  const r2 = await refreshRates(s.db, src({ INR: 150 }), DAY0 + DAY); // more than 50% in a day
  assert.equal(r2.results.INR, 'invalid');
  const cur = await currentRate({ db: s.db, now: () => DAY0 + DAY + 60000 }, 'INR', 72);
  assert.equal(cur.row.rate_x10000, 700000); // still the last good rate
  assert.equal((await overrideRate(s.db, 'INR', 0.5, DAY0 + DAY + 1000, 'x')).ok, false);
  assert.equal((await overrideRate(s.db, 'INR', 75, DAY0 + DAY + 1000, 'fix')).ok, true);
  const now = await currentRate({ db: s.db, now: () => DAY0 + DAY + 2000 }, 'INR', 72);
  assert.equal(now.row.rate_x10000, 750000);
});

test('an order keeps its lock window even if the setting changes; overpayment is flagged, not credited', async () => {
  const s = await setup();
  const o = await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'USD', order_ref: 'lk' });
  await s.admin.put('/v1/admin/settings', { rate_lock_minutes: 1 }); // shortening it later must not re-price this order
  s.clock.t += 30 * MIN;
  const c = await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'big1', paid_minor: 1500, currency: 'USD' });
  assert.equal(c.body.credited, 1000);
  assert.equal(c.body.overpaid_minor, 500);
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM outbox WHERE type = 'payment.overpaid'")).n, 1); // the payment side is told, so the extra can be refunded
  assert.equal((await s.db.first("SELECT paid_minor p FROM purchase_order WHERE id = ?", o.body.order_id)).p, 1500);
});

test('a paused account cannot buy credits; health shows no tenant detail', async () => {
  const s = await setup();
  await buy(s.api, 'f@x.com', 100, 'pf');
  await s.admin.post('/v1/admin/freeze', { email: 'f@x.com' }).catch(() => null);
  const r = await s.api.post('/v1/buy_credits', { email: 'f@x.com', credits: 500, currency: 'USD', order_ref: 'fz' });
  assert.equal(r.body.error.code, 'account_frozen');
  const h = await (await s.app.fetch(new Request('http://t.local/health'))).json();
  assert.deepEqual(Object.keys(h).sort(), ['db', 'fx', 'ok', 'rail']);
  assert.deepEqual(Object.keys(h.rail), ['ok']);
});

test('the same signed body under another key class does not replay the first answer', async () => {
  const s = await setup();
  const a = await s.pay.post('/v1/payment_notice', { payment_ref: 'z1', paid_minor: 5, currency: 'USD' }, { idem: 'pay:z1' });
  assert.equal(a.status, 200);
  const b = await s.api.post('/v1/payment_notice', { payment_ref: 'z1', paid_minor: 5, currency: 'USD' }, { idem: 'pay:z1' });
  assert.notEqual(b.headers.get('idempotent-replay'), 'true');
});

test('findPayment sees a purchase that bought credits', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 500, 'Buy_1');
  const p = await findPayment(s.ctx(), 'buy_1');
  assert.deepEqual(p, { paid_minor: 500, currency: 'USD' });
});
