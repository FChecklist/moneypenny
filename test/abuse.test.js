import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, DAY } from './helpers.js';
import { verifyBalances } from '../src/ledger.js';

test('self referral is refused, including gmail dot and plus tricks', async () => {
  const s = await setup();
  const pay = { cash_minor: 10000, currency: 'USD' };
  assert.equal((await event(s.api, 'a@x.com', 'referral_sale_paid', { ...pay, payer_email: 'A@x.com' })).body.reason, 'self_referral');
  assert.equal((await event(s.api, 'john.smith@gmail.com', 'referral_sale_paid', { ...pay, payer_email: 'johnsmith+shop@googlemail.com' })).body.reason, 'self_referral');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
});

test('commission only on cash received', async () => {
  const s = await setup();
  const none = await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 0, currency: 'USD' });
  assert.equal(none.body.reason, 'no_cash_no_commission');
  const missing = await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com' });
  assert.equal(missing.body.reason, 'no_cash_no_commission');
  const ok = await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 2700, currency: 'USD' });
  assert.equal(ok.body.granted, 270); // 10% of $27 cash, not of a $34 list price
});

test('duplicate accounts (gmail dots and plus tags) share one welcome bonus', async () => {
  const s = await setup();
  assert.equal((await event(s.api, 'john.smith@gmail.com', 'account_created')).body.granted, 100);
  assert.equal((await event(s.api, 'johnsmith+2@gmail.com', 'account_created')).body.reason, 'already_earned');
  assert.equal((await event(s.api, 'j.o.h.n.smith@googlemail.com', 'account_created')).body.reason, 'already_earned');
  assert.equal((await event(s.api, 'john.smith+x@gmail.com', 'first_game_created')).body.granted, 200);
  // lifetime bonus cap is shared across the aliases too
  const g = await s.api.post('/v1/credit', { email: 'johnsmith+9@gmail.com', bucket: 'bonus', amount: 500, ref: 'g' });
  assert.equal(g.body.granted, 500);
  const g2 = await s.api.post('/v1/credit', { email: 'john.smith+7@gmail.com', bucket: 'bonus', amount: 100, ref: 'g2' });
  assert.equal(g2.status, 422);
});

test('throw-away e-mail domains earn nothing', async () => {
  const s = await setup();
  assert.equal((await event(s.api, 'a@mailinator.com', 'account_created')).body.reason, 'blocked_domain');
  assert.equal((await s.api.post('/v1/credit', { email: 'a@mailinator.com', bucket: 'bonus', amount: 10, ref: 'x' })).status, 422);
});

test('velocity: new people per hour and events per person per day', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { new_accounts_per_hour: 3, account_events_per_day: 2 });
  for (const e of ['a@x.com', 'b@x.com', 'c@x.com']) assert.equal((await event(s.api, e, 'account_created')).body.granted, 100);
  const r = await event(s.api, 'd@x.com', 'account_created');
  assert.equal(r.status, 429);
  s.clock.t += 61 * 60000;
  assert.equal((await event(s.api, 'd@x.com', 'account_created')).body.granted, 100);
  // per-person daily limit: counts every event, even refused ones
  await event(s.api, 'e@x.com', 'nothing_a');
  await event(s.api, 'e@x.com', 'nothing_b');
  assert.equal((await event(s.api, 'e@x.com', 'account_created')).body.reason, 'too_many_events');
});

test('refund after spend: only unspent credits can go back as money', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'pay1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 800, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  const full = await s.api.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'pay1' });
  assert.equal(full.status, 200); // default = whatever is unspent
  assert.equal(full.body.returned_credits, 200);
  assert.equal(full.body.money_due_minor, 200);
  const more = await s.api.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'pay1', credits: 1 });
  assert.equal(more.status, 409);
  assert.equal(more.body.error.code, 'credits_already_used');
  const explicit = await buy(s.api, 'b@x.com', 1000, 'pay2');
  assert.equal(explicit.status, 200);
  await s.api.post('/v1/spend/capture', { hold_id: (await s.api.post('/v1/spend/reserve', { email: 'b@x.com', order_ref: 'o2', amount_minor: 800, currency: 'USD' })).body.hold_id });
  const tooMuch = await s.api.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'pay2', credits: 1000 });
  assert.equal(tooMuch.body.error.code, 'credits_already_used');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('bonus and commission credits can never come back as money', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created');
  const r = await s.api.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'ev-anything' });
  assert.equal(r.status, 404);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
});

test('money refund amount follows what was paid, in parts, never above what was paid', async () => {
  const s = await setup();
  await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 3, paid_minor: 100, currency: 'USD', payment_ref: 'odd' });
  let total = 0;
  for (let i = 0; i < 3; i++) total += (await s.api.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'odd', credits: 1 })).body.money_due_minor;
  assert.ok(total <= 100);
  assert.ok(total >= 99);
});

test('cancelled paid order returns credits to the buckets they came from; no more than was spent', async () => {
  const s = await setup();
  for (const t of ['account_created', 'first_game_created']) await event(s.api, 'a@x.com', t); // 300 bonus
  await buy(s.api, 'a@x.com', 5000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 1000, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal((await bal(s.api, 'a@x.com')).buckets.bonus, 0);
  const back = await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id });
  assert.equal(back.body.returned_credits, 1000);
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.buckets.bonus, 300);
  assert.equal(b.buckets.bought, 5000);
  const again = await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id, credits: 1 });
  assert.equal(again.body.error.code, 'nothing_to_return');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('an order that was only reserved cannot be refunded', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 800, currency: 'USD' });
  assert.equal((await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id })).body.error.code, 'hold_not_captured');
});

test('returned credits keep their old end date, or at least the minimum days', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 1000, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  s.clock.t += 360 * DAY; // 5 days left on the original lot
  await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id });
  const b = await bal(s.api, 'a@x.com');
  assert.ok(b.next_expiry >= s.clock.t + 30 * DAY);
});

test('chargeback removes what is left of that purchase and pauses the account', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 300, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  const c = await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'p1' });
  assert.equal(c.body.removed_credits, 700);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  const again = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o2', amount_minor: 300, currency: 'USD' });
  assert.equal(again.body.reason, 'account_frozen');
  assert.equal((await buy(s.api, 'a@x.com', 100, 'p9')).status, 200); // money already taken: credited even though the account is paused
  assert.equal((await event(s.api, 'a@x.com', 'account_created')).body.reason, 'account_frozen');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('admin can pause and release an account', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  await s.admin.post('/v1/admin/freeze', { email: 'a@x.com' });
  assert.equal((await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 300, currency: 'USD' })).body.reason, 'account_frozen');
  await s.admin.post('/v1/admin/freeze', { email: 'a@x.com', frozen: false });
  assert.equal((await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o2', amount_minor: 300, currency: 'USD' })).body.credit_applied, 300);
});

test('the same payment cannot be credited twice', async () => {
  const s = await setup();
  assert.equal((await buy(s.api, 'a@x.com', 100, 'dup')).status, 200);
  const r = await buy(s.api, 'a@x.com', 100, 'dup');
  assert.equal(r.status, 409);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
});

test('bad inputs are refused cleanly', async () => {
  const s = await setup();
  assert.equal((await buy(s.api, 'not-an-email', 100, 'p')).status, 400);
  assert.equal((await buy(s.api, 'a@x.com', -5, 'p')).status, 400);
  assert.equal((await buy(s.api, 'a@x.com', 1.5, 'p')).status, 400);
  assert.equal((await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'commission', amount: 10 })).status, 400);
  assert.equal((await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o', amount_minor: 100, currency: 'EUR' })).status, 400);
});
