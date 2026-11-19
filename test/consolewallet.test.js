// Console wallet flow, test mode: buy a fixed-price pack, spend on a game item, failures give credits back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, MIN, T0 } from './helpers.js';
import { refreshRates, utcDayStart } from '../src/fx.js';
import { createWallet } from '../packages/console-wallet/index.js';

const DAY0 = utcDayStart(T0);
const rate = { name: 't', async fetch() { return { rates: { INR: 88 } }; } };

async function world(entitle = async () => {}) {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 239900 } });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 1000 });
  await refreshRates(s.db, rate, DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  const calls = [];
  const w = createWallet({ mnp: { api: s.api, pay: s.pay }, games: { tambola: { entitle: async (a) => { calls.push(a); return entitle(a, s); } } } });
  return { s, w, calls };
}
const fund = async (w, email = 'o@x.com') => {
  const b = await w.startBuy({ email, credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal(b.ok, true, JSON.stringify(b));
  return { b, c: await w.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_1', paidMinor: b.amountMinor, currency: 'INR' }) };
};

test('W1: buying the pack costs exactly Rs 2,399 and credits 3,400', async () => {
  const { w } = await world();
  const { b, c } = await fund(w);
  assert.equal(b.amountMinor, 239900);
  assert.equal(c.credited, 3400);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W2: a payment that is too small gives no credits', async () => {
  const { w } = await world();
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal((await w.balance('o@x.com')).balance, 0);
  const low = await w.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_x', paidMinor: 100, currency: 'INR' });
  assert.equal(low.ok, false);
  assert.equal((await w.balance('o@x.com')).balance, 0);
});

test('W3: same buy id gives the same order; same payment id credits once', async () => {
  const { w } = await world();
  const a = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal(a.orderId, b.orderId);
  await w.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' });
  await w.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' });
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W4: spend reserves, calls the game once, then captures', async () => {
  const { w, calls } = await world();
  await fund(w);
  const r = await w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  assert.equal(w.store.all()[0].status, 'captured');
});

test('W5: not enough credits means no game step', async () => {
  const { w, calls } = await world();
  const r = await w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard' });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('W6: if the game step fails the credits come back', async () => {
  const { w } = await world(async () => { throw new Error('down'); });
  await fund(w);
  const r = await w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard' });
  assert.equal(r.code, 'game_step_failed');
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  assert.equal(w.store.all()[0].status, 'released');
});

test('W7: unknown product and unlisted item are refused, balance untouched', async () => {
  const { w } = await world();
  await fund(w);
  assert.equal((await w.spend({ email: 'o@x.com', product: 'nope', item: 'x' })).code, 'unknown_product');
  assert.equal((await w.spend({ email: 'o@x.com', product: 'tambola', item: 'nope' })).ok, false);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W8: a hold that lapsed before capture is kept for retry, not lost', async () => {
  const { w } = await world(async (a, s) => { s.clock.t += 30 * MIN; });
  await fund(w);
  const r = await w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard' });
  assert.equal(r.code, 'capture_pending');
  assert.ok(['capture_retry', 'dead_letter'].includes(w.store.all()[0].status));
});
