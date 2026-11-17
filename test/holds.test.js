import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, MIN, note } from './helpers.js';
import { verifyBalances } from '../src/ledger.js';

const reserve = (api, o = {}) => api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 3400, currency: 'USD', ...o });

test('reserve, capture: credit pays part, cash pays the rest', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await reserve(s.api);
  assert.equal(r.body.credit_applied, 1000);
  assert.equal(r.body.cash_due_minor, 2400);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0); // held credits are not spendable twice
  const noPay = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal(noPay.status, 400);
  await note(s.api, 'rzp1', 2400);
  const under = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rzp1', cash_paid_minor: 100 });
  assert.equal(under.body.error.code, 'underpaid');
  const ok = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rzp1', cash_paid_minor: 2400 });
  assert.equal(ok.body.status, 'captured');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('credit that covers the whole order needs no payment reference', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 5000, 'p1');
  const r = await reserve(s.api);
  assert.equal(r.body.cash_due_minor, 0);
  const c = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal(c.status, 200);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1600);
});

test('release gives every credit back', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await reserve(s.api);
  await s.api.post('/v1/spend/release', { hold_id: r.body.hold_id });
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  const again = await s.api.post('/v1/spend/release', { hold_id: r.body.hold_id });
  assert.equal(again.body.status, 'released'); // safe to repeat
  await note(s.api, 'x', 9999);
  const cap = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'x', cash_paid_minor: 9999 });
  assert.equal(cap.body.error.code, 'hold_closed');
});

test('a hold nobody captures is released after ~15 min plus grace, by sweep or next reserve', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await reserve(s.api);
  s.clock.t += 14 * MIN;
  assert.equal((await reserve(s.api, { order_ref: 'o2' })).body.reason, 'nothing_spendable'); // still held
  s.clock.t += 7 * MIN; // past 15 + 5 grace
  const r2 = await reserve(s.api, { order_ref: 'o3' }); // reserve sweeps first
  assert.equal(r2.body.credit_applied, 1000);
  await note(s.api, 'x', 5000);
  const late = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'x', cash_paid_minor: 5000 });
  assert.equal(late.body.error.code, 'hold_closed');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('a slightly late payment can still capture inside the grace window', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await reserve(s.api);
  s.clock.t += 17 * MIN;
  await note(s.api, 'rzp', 2400);
  const c = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rzp', cash_paid_minor: 2400 });
  assert.equal(c.status, 200);
  s.clock.t += 10 * MIN;
});

test('capture after the grace window is refused', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await reserve(s.api);
  s.clock.t += 21 * MIN;
  await note(s.api, 'rzp', 2400);
  const c = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rzp', cash_paid_minor: 2400 });
  assert.equal(c.status, 410);
});

test('double capture: second try (new key) is refused; same key replays', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await reserve(s.api);
  await note(s.api, 'rzp1', 2400);
  const body = { hold_id: r.body.hold_id, payment_ref: 'rzp1', cash_paid_minor: 2400 };
  const a = await s.api.post('/v1/spend/capture', body, { idem: 'cap-1' });
  const same = await s.api.post('/v1/spend/capture', body, { idem: 'cap-1' });
  assert.equal(same.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(same.body, a.body);
  const other = await s.api.post('/v1/spend/capture', body, { idem: 'cap-2' });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'hold_already_captured');
  const ev = await s.db.all("SELECT * FROM outbox WHERE type = 'spend.captured'");
  assert.equal(ev.length, 1);
});

test('one payment cannot pay two orders', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r1 = await reserve(s.api, { order_ref: 'o1', amount_minor: 1500 });
  await note(s.api, 'rzpX', 500);
  await s.api.post('/v1/spend/capture', { hold_id: r1.body.hold_id, payment_ref: 'rzpX', cash_paid_minor: 500 });
  await buy(s.api, 'a@x.com', 1000, 'p2');
  const r2 = await reserve(s.api, { order_ref: 'o2', amount_minor: 1500 });
  await note(s.api, 'rzpX', 500);
  const c2 = await s.api.post('/v1/spend/capture', { hold_id: r2.body.hold_id, payment_ref: 'rzpX', cash_paid_minor: 500 });
  assert.equal(c2.body.error.code, 'payment_already_used');
});

test('an order cannot hold twice, or be paid twice with credits', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 9000, 'p1');
  const r = await reserve(s.api);
  assert.equal((await reserve(s.api)).body.error.code, 'order_has_open_hold');
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal((await reserve(s.api)).body.error.code, 'order_already_paid_with_credits');
});

test('unknown person or unknown hold is handled', async () => {
  const s = await setup();
  const r = await reserve(s.api, { email: 'nobody@x.com' });
  assert.equal(r.body.credit_applied, 0);
  assert.equal(r.body.cash_due_minor, 3400);
  assert.equal((await s.api.post('/v1/spend/capture', { hold_id: 'hold_nope' })).status, 404);
});

test('gateway minimum: INR cash left is never below the minimum', async () => {
  const s = await setup();
  await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 3427, paid_minor: 239900, currency: 'INR', payment_ref: 'pi' });
  // order Rs 2,400 = 240000 paise. Credits could cover all but Rs 0.10-ish; remainder must be 0 or >= 100 paise
  const r = await reserve(s.api, { amount_minor: 240100, currency: 'INR' });
  assert.ok(r.body.cash_due_minor === 0 || r.body.cash_due_minor >= 100, `cash_due ${r.body.cash_due_minor}`);
  assert.equal(r.body.credit_value_minor + r.body.cash_due_minor, 240100);
});

test('full coverage waives a sub-credit rounding remainder in the person\'s favour', async () => {
  const s = await setup();
  await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 3428, paid_minor: 240000, currency: 'INR', payment_ref: 'pi' });
  const r = await reserve(s.api, { amount_minor: 239900, currency: 'INR' }); // 3427 credits cover 239890; 10 paise left
  assert.equal(r.body.cash_due_minor, 0);
});
