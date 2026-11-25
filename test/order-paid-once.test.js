// Watches the guard `order-paid-once` (scripts/guard-check.js), which no test noticed once round 6 added the guarded UPDATE
// to railConfirm: for an order that is already paid, the common cases (same payment again, other payment) give the same answer
// through the UPDATE alone. They differ when the repeat carries figures a fresh order would refuse. A paid order must answer from
// its own state first: the same payment is "already", another payment is order_already_paid, whatever amount or currency it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal } from './helpers.js';
import { buyCredits, railConfirm } from '../src/gate.js';
import { stubRail } from '../src/rail.js';

const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

test('railConfirm: a paid order answers from its own state before the amount and currency are judged', async () => {
  const s = await setup();
  const ctx = { ...s.ctx(), rail: stubRail };
  const o = await buyCredits(ctx, { email: 'a@example.com', credits: 500, order_ref: 'paid-once-1', currency: 'USD' });
  const { amount_minor } = await s.db.first('SELECT amount_minor FROM purchase_order WHERE id = ?', o.order_id);
  assert.equal((await railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_one', paid_minor: amount_minor, currency: 'USD' })).credited, 500);
  // the same payment again: "already paid", even with a short amount or another currency (a fresh order would refuse both)
  const already = { order_id: o.order_id, status: 'paid', credited: 500, already: true };
  assert.deepEqual(await railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_one', paid_minor: 1, currency: 'USD' }), already);
  assert.deepEqual(await railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_one', paid_minor: amount_minor, currency: 'INR' }), already);
  // another payment for the paid order: refused as already paid, whatever it carries
  assert.equal(await code(railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_two', paid_minor: 1, currency: 'USD' })), 'order_already_paid');
  assert.equal(await code(railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_two', paid_minor: amount_minor, currency: 'USD' })), 'order_already_paid');
  assert.equal((await bal(s.api, 'a@example.com')).balance, 500);
});
