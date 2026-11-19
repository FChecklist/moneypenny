// Console wallet flow, test mode: buy a fixed-price pack, spend on a game item, failures give credits back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, MIN, T0 } from './helpers.js';
import { refreshRates, utcDayStart } from '../src/fx.js';
import { createWallet, createPaymentSide } from '../packages/console-wallet/index.js';

const DAY0 = utcDayStart(T0);
const src = (r) => ({ name: 't', async fetch() { return { rates: { INR: r } }; } });

async function world(entitle = async () => {}, mnpWrap = (c) => c) {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 239900 } });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 1000 });
  await refreshRates(s.db, src(88), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  const calls = [];
  const w = createWallet({ mnp: mnpWrap(s.api), now: () => s.clock.t, games: { tambola: { entitle: async (a) => { calls.push(a); return entitle(a, s); } } } });
  const side = createPaymentSide({ pay: s.pay });
  return { s, w, side, calls };
}
const fund = async (w, side, email = 'o@x.com', buyId = 'b1', ref = 'pay_1') => {
  const b = await w.startBuy({ email, credits: 3400, currency: 'INR', buyId });
  assert.equal(b.ok, true, JSON.stringify(b));
  return { b, c: await side.paymentVerified({ orderId: b.orderId, paymentRef: ref, paidMinor: b.amountMinor, currency: 'INR' }) };
};
const spend = (w, extra = {}) => w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard', ...extra });
const refuse = () => Object.assign(new Error('refused'), { definite: true });
const holdsOpen = async (s) => (await s.db.first("SELECT COUNT(*) AS n FROM hold WHERE status = 'held'")).n;

test('W1: the pack costs exactly Rs 2,399 and credits 3,400, also after the daily rate moves', async () => {
  const { s, w, side } = await world();
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal(b.amountMinor, 239900);
  await refreshRates(s.db, src(95), s.clock.t + 1); // rate moves after the order
  const c = await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' });
  assert.equal(c.credited, 3400);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  const later = await w.startBuy({ email: 'p@x.com', credits: 3400, currency: 'INR', buyId: 'b2' });
  assert.equal(later.amountMinor, 239900);
});

test('W2: underpay, wrong currency and overpay: no extra credits, exact codes', async () => {
  const { w, side } = await world();
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  const low = await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_x', paidMinor: 100, currency: 'INR' });
  assert.equal(low.ok, false);
  assert.equal(low.code, 'payment_mismatch');
  const usd = await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_y', paidMinor: 239900, currency: 'USD' });
  assert.equal(usd.ok, false);
  assert.equal((await w.balance('o@x.com')).balance, 0);
  const over = await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_z', paidMinor: 500000, currency: 'INR' });
  assert.equal(over.credited, 3400);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W3: same buy id gives the same order; same payment id credits once; another payment id on a paid order is refused', async () => {
  const { w, side } = await world();
  const a = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal(a.orderId, b.orderId);
  const one = await side.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' });
  const two = await side.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true); // repeat of the same payment id is harmless
  const other = await side.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_2', paidMinor: 239900, currency: 'INR' });
  assert.equal(other.ok, false);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W4: spend reserves, calls the game once, then captures; a repeat click is not a second order', async () => {
  const { w, side, calls } = await world();
  await fund(w, side);
  const r = await spend(w, { spendKey: 'click-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const r2 = await spend(w, { spendKey: 'click-1' });
  assert.equal(r2.ok, true);
  assert.equal(r2.repeat, true);
  assert.equal(calls.length, 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  assert.equal(w.store.all().length, 1);
});

test('W5: not enough credits: exact code, no game step, no hold left', async () => {
  const { s, w, calls } = await world();
  const r = await spend(w);
  assert.equal(r.code, 'insufficient_credits');
  assert.equal(calls.length, 0);
  assert.equal(await holdsOpen(s), 0);
});

test('W6: if the game step fails the credits come back and no hold is left', async () => {
  const { s, w, side } = await world(async () => { throw refuse(); });
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'game_step_failed');
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  assert.equal(w.store.all()[0].status, 'released');
  assert.equal(await holdsOpen(s), 0);
});

test('W7: unknown product, prototype names and unlisted item are refused; balance untouched', async () => {
  const { w, side } = await world();
  await fund(w, side);
  for (const p of ['nope', '__proto__', 'constructor', 'toString']) assert.equal((await w.spend({ email: 'o@x.com', product: p, item: 'x' })).code, 'unknown_product');
  const bad = await spend(w, { item: 'nope' });
  assert.equal(bad.code, 'no_item');
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W8: hold lapsed before capture: owner gets a dead letter at once, no second capture, credits not lost silently', async () => {
  const { w, side } = await world(async (a, s) => { s.clock.t += 30 * MIN; });
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'capture_pending');
  const row = w.store.all()[0];
  assert.equal(row.status, 'dead_letter');
  assert.equal(row.reason, 'hold_expired');
  assert.equal((await w.retryStuck()).dead, 1);
});

test('W9: a capture that failed on the network is retried by the job and then completes once', async () => {
  let n = 3;
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (n > 0 && p === '/v1/spend/capture') { n--; throw new Error('net'); } return c.post(p, b); } });
  const { w, side, calls } = await world(async () => {}, wrap);
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'capture_pending');
  assert.equal(w.store.all()[0].status, 'capture_retry');
  await w.retryStuck();
  await w.retryStuck(); // a second run changes nothing
  assert.equal(w.store.all()[0].status, 'captured');
  assert.equal(calls.length, 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
});

test('W10: crash after the game step: the job repeats the idempotent step and captures; a row stuck too long goes to the owner', async () => {
  const granted = new Set();
  const { s, w, side, calls } = await world(async (a) => { granted.add(a.orderRef); });
  await fund(w, side);
  const hold = await s.api.post('/v1/spend/reserve_item', { email: 'o@x.com', product: 'tambola', item: 'game_standard', order_ref: 'tambola-crash' });
  w.store.plant('c1', { id: 'c1', orderRef: 'tambola-crash', email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: 'k', status: 'entitled', tries: 0, holdId: hold.body.hold_id, credits: 1000, at: s.clock.t });
  const hold2 = await s.api.post('/v1/spend/reserve_item', { email: 'o@x.com', product: 'tambola', item: 'game_standard', order_ref: 'tambola-crash2' });
  w.store.plant('c3', { id: 'c3', orderRef: 'tambola-crash2', email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: 'k3', status: 'entitling', tries: 0, holdId: hold2.body.hold_id, credits: 1000, at: s.clock.t });
  w.store.plant('c2', { id: 'c2', orderRef: 'tambola-x', email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: 'k2', status: 'entitling', tries: 0, holdId: 'h', credits: 1000, at: s.clock.t - 30 * MIN });
  s.clock.t += 3 * MIN;
  const out = await w.retryStuck();
  assert.equal(w.store.get('c1').status, 'captured');
  assert.equal(w.store.get('c3').status, 'captured');
  assert.equal(calls.length, 1); // c3 only: the step is repeated once, by orderRef
  assert.ok(granted.has('tambola-crash2'));
  assert.equal(w.store.get('c2').status, 'needs_review');
  assert.equal(out.review, 1);
  assert.equal((await w.balance('o@x.com')).balance, 3400 - 2000);
});

test('W11: a network failure on reserve is never guessed: the order goes to review', async () => {
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (p === '/v1/spend/reserve_item') throw new Error('net'); return c.post(p, b); } });
  const { w, side, calls } = await world(async () => {}, wrap);
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'reserve_unknown');
  assert.equal(calls.length, 0);
  assert.equal(w.store.all()[0].status, 'needs_review');
});

test('W12: a failed release is kept and retried by the job', async () => {
  let failRelease = true;
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (failRelease && p === '/v1/spend/release') return { status: 503, body: {} }; return c.post(p, b); } });
  const { w, side } = await world(async () => { throw refuse(); }, wrap);
  await fund(w, side);
  await spend(w);
  assert.equal(w.store.all()[0].status, 'release_failed');
  failRelease = false;
  await w.retryStuck();
  assert.equal(w.store.all()[0].status, 'released');
  assert.equal((await w.balance('o@x.com')).balance, 3400);
});

test('W13: concurrent clicks cannot spend the same credits twice (3,400 credits, 1,700 each: exactly 2 succeed)', async () => {
  const { s, w, side, calls } = await world();
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_big', credits: 1700 });
  await fund(w, side);
  const res = await Promise.all([1, 2, 3, 4].map((n) => spend(w, { item: 'game_big', spendKey: `k${n}` })));
  assert.equal(res.filter((x) => x.ok).length, 2);
  assert.equal(calls.length, 2);
  assert.equal((await w.balance('o@x.com')).balance, 0);
  assert.equal(await holdsOpen(s), 0);
});

test('W13b: the same key at once gives one order; a key used by someone else or for another item is refused', async () => {
  const { w, side, calls } = await world();
  await fund(w, side);
  await fund(w, side, 'p@x.com', 'b2', 'pay_2');
  const [a, b] = await Promise.all([spend(w, { spendKey: 'same' }), spend(w, { spendKey: 'same' })]);
  assert.equal([a, b].filter((x) => x.ok && !x.repeat).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(w.store.all().length, 1);
  const other = await w.spend({ email: 'p@x.com', product: 'tambola', item: 'game_standard', spendKey: 'same' }); // keys are per person: no squatting
  assert.equal(other.ok, true);
  assert.equal(other.repeat, undefined);
  assert.equal((await spend(w, { item: 'game_big', spendKey: 'same' })).code, 'key_conflict');
  assert.equal((await w.balance('p@x.com')).balance, 2400);
});

test('W13e: two job runs at once: the crashed game step is repeated once and captured once; nothing is overwritten', async () => {
  const { s, w, side, calls } = await world();
  await fund(w, side);
  const hold = await s.api.post('/v1/spend/reserve_item', { email: 'o@x.com', product: 'tambola', item: 'game_standard', order_ref: 'tambola-dup' });
  w.store.plant('d1', { id: 'd1', orderRef: 'tambola-dup', email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: 'x', status: 'entitling', tries: 0, holdId: hold.body.hold_id, credits: 1000, at: s.clock.t });
  s.clock.t += 3 * MIN;
  await Promise.all([w.retryStuck(), w.retryStuck(), w.retryStuck()]);
  assert.equal(calls.length, 1);
  assert.equal(w.store.get('d1').status, 'captured');
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  await w.retryStuck();
  assert.equal(w.store.get('d1').status, 'captured');
});

test('W13f: a late release cannot overwrite an order that was captured meanwhile', async () => {
  const { s, w, side } = await world();
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.ok, true);
  const id = w.store.all()[0].id;
  const late = await w.retryStuck();
  assert.equal(late.dead, 0);
  assert.equal(w.store.get(id).status, 'captured');
});

test('W13c: a release the hold refuses (already closed) is not retried forever', async () => {
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => (p === '/v1/spend/release' ? { status: 409, body: { error: { code: 'hold_already_captured' } } } : c.post(p, b)) });
  const { w, side } = await world(async () => { throw refuse(); }, wrap);
  await fund(w, side);
  await spend(w);
  assert.equal(w.store.all()[0].status, 'needs_review');
});

test('W13d: only listed packs, only in rupees, and an order id nobody else can take', async () => {
  const { w } = await world();
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'USD', buyId: 'b9' })).code, 'currency_not_offered');
  const a = await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'same' });
  const b = await w.startBuy({ email: 'p@x.com', credits: 3400, buyId: 'same' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.orderId, b.orderId);
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 1234, currency: 'INR', buyId: 'b9' })).code, 'not_a_pack');
});

test('W14: bad ids and amounts are refused before any call; the wallet has no payment method', async () => {
  const { w } = await world();
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'a b/../c' })).code, 'bad_request');
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: -5, buyId: 'x' })).code, 'bad_request');
  assert.equal((await w.quote(NaN)).code, 'bad_request');
  assert.equal(w.paymentVerified, undefined);
});

test('W15: capture is tried again at once (short back-off) so a blip does not lose the window', async () => {
  let fails = 2;
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (p === '/v1/spend/capture' && fails-- > 0) throw new Error('net'); return c.post(p, b); } });
  const { s, w, side } = await world(async () => {}, wrap);
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.store.all()[0].status, 'captured');
  assert.equal(await holdsOpen(s), 0);
});

test('W16: a repeated key after a refused or released order gives its final state, and a new key can be used', async () => {
  const { w } = await world();
  const a = await spend(w, { spendKey: 'k1' });
  assert.equal(a.code, 'insufficient_credits');
  const b = await spend(w, { spendKey: 'k1' });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'insufficient_credits'); // same final answer, not a stuck "in progress"
});

test('W17: the price asked at the order must equal the quoted pack price', async () => {
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { const r = await c.post(p, b); if (p === '/v1/buy_credits' && r.status === 200) r.body.amount_minor += 1; return r; } });
  const { w } = await world(async () => {}, wrap);
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'b1' })).code, 'price_mismatch');
});

test('W18: an unclear game failure (timeout) never releases the credits: the job repeats the step and captures', async () => {
  let n = 0;
  const { s, w, side } = await world(async () => { if (n++ === 0) throw new Error('timeout'); });
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'game_step_unknown');
  assert.equal(w.store.all()[0].status, 'entitling');
  assert.equal((await w.balance('o@x.com')).balance, 2400); // still held
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  assert.equal(w.store.all()[0].status, 'captured');
  assert.equal((await w.balance('o@x.com')).balance, 2400);
});

test('W19: an unclear failure that stays unclear goes to the owner, hold untouched by the job', async () => {
  const { s, w, side } = await world(async () => { throw new Error('timeout'); });
  await fund(w, side);
  await spend(w);
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  assert.equal(w.store.all()[0].status, 'entitling');
  s.clock.t += 10 * MIN;
  const out = await w.retryStuck();
  assert.equal(w.store.all()[0].status, 'needs_review');
  assert.equal(out.review, 1);
});

test('W20: the owner is alerted at once when an order goes to dead letter or review', async () => {
  const seen = [];
  const s0 = await world(async () => { throw new Error('timeout'); });
  const w = createWallet({ mnp: { get: (p) => s0.s.api.get(p), post: (p, b) => s0.s.api.post(p, b) }, now: () => s0.s.clock.t, alert: (row) => seen.push(row.status), games: { tambola: { entitle: async () => { throw new Error('timeout'); } } } });
  await fund(w, createPaymentSide({ pay: s0.s.pay }));
  await spend(w);
  s0.s.clock.t += 13 * MIN;
  await w.retryStuck();
  assert.deepEqual(seen, ['needs_review']);
});
