// Console wallet, test mode. Design: capture first, then grant; a definite refusal refunds; unclear failures repeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, MIN, T0 } from './helpers.js';
import { refreshRates, utcDayStart } from '../src/fx.js';
import { verifyBalances } from '../src/ledger.js';
import { createWallet, createPaymentSide, memoryStore, storeContract } from '../packages/console-wallet/index.js';

const DAY0 = utcDayStart(T0);
const src = (r) => ({ name: 't', async fetch() { return { rates: { INR: r } }; } });
const refuse = () => Object.assign(new Error('refused'), { definite: true });

/** A game that is idempotent by order id, like the contract says. `behave(call#, args)` may throw. */
async function world(behave = () => {}, wrap = (c) => c, opts = {}) {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 239900 } });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 1000 });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_big', credits: 1700 });
  await refreshRates(s.db, src(88), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  const granted = new Set();
  let calls = 0;
  const game = { entitle: async (a) => { calls += 1; await behave(calls, a, s); granted.add(a.orderRef); } };
  const alerts = [];
  const store = opts.store ?? memoryStore();
  const w = createWallet({ mnp: wrap(s.api), now: () => s.clock.t, alert: (r) => alerts.push(r.reason), games: { tambola: game }, ...opts, store });
  w.store = store; // the test keeps its own handle; the wallet does not expose the store
  const side = createPaymentSide({ pay: s.pay });
  return { s, w, side, granted, alerts, calls: () => calls };
}
const fund = async (w, side, email = 'o@x.com', buyId = 'b1', ref = 'pay_1') => {
  const b = await w.startBuy({ email, credits: 3400, currency: 'INR', buyId });
  assert.equal(b.ok, true, JSON.stringify(b));
  return { b, c: await side.paymentVerified({ orderId: b.orderId, paymentRef: ref, paidMinor: b.amountMinor, currency: 'INR' }) };
};
let clickNo = 0;
const spend = (w, extra = {}) => w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: `auto${++clickNo}`, ...extra });
const held = async (s) => (await s.db.first("SELECT COUNT(*) AS n FROM hold WHERE status = 'held'")).n;
const ok = async (s) => assert.deepEqual(await verifyBalances(s.ctx()), []); // ledger invariant after every money flow
const onlyRow = (w) => w.store.all()[0];

// ---- buying ----
test('B1: the pack costs exactly Rs 2,399 and credits 3,400, also after the daily rate moves', async () => {
  const { s, w, side } = await world();
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal(b.amountMinor, 239900);
  await refreshRates(s.db, src(95), s.clock.t + 1);
  const c = await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' });
  assert.equal(c.credited, 3400);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  assert.equal((await w.startBuy({ email: 'p@x.com', credits: 3400, currency: 'INR', buyId: 'b2' })).amountMinor, 239900);
  await ok(s);
});

test('B2: underpay and wrong currency give nothing; overpay credits the order only', async () => {
  const { s, w, side } = await world();
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal((await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_x', paidMinor: 100, currency: 'INR' })).code, 'payment_mismatch');
  assert.equal((await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_y', paidMinor: 239900, currency: 'USD' })).ok, false);
  assert.equal((await w.balance('o@x.com')).balance, 0);
  assert.equal((await side.paymentVerified({ orderId: b.orderId, paymentRef: 'pay_z', paidMinor: 500000, currency: 'INR' })).credited, 3400);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  await ok(s);
});

test('B3: same buy id, same order; same payment id credits once; a second payment id on a paid order is refused', async () => {
  const { s, w, side } = await world();
  const a = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  const b = await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'INR', buyId: 'b1' });
  assert.equal(a.orderId, b.orderId);
  assert.equal((await side.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' })).ok, true);
  assert.equal((await side.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_1', paidMinor: 239900, currency: 'INR' })).ok, true);
  assert.equal((await side.paymentVerified({ orderId: a.orderId, paymentRef: 'pay_2', paidMinor: 239900, currency: 'INR' })).code, 'order_already_paid');
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  await ok(s);
});

test('B4: only listed packs, only in rupees, ids are per person, and an order not at the pack price is refused', async () => {
  const { w } = await world();
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 1234, buyId: 'b9' })).code, 'not_a_pack');
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, currency: 'USD', buyId: 'b9' })).code, 'currency_not_offered');
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'a b/../c' })).code, 'bad_request');
  assert.equal((await w.quote(NaN)).code, 'bad_request');
  const a = await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'same' });
  const b = await w.startBuy({ email: 'p@x.com', credits: 3400, buyId: 'same' });
  assert.notEqual(a.orderId, b.orderId);
  const bad = await world(() => {}, (c) => ({ get: (p) => c.get(p), post: async (p, x) => { const r = await c.post(p, x); if (p === '/v1/buy_credits' && r.status === 200) r.body.fixed_price = false; return r; } }));
  assert.equal((await bad.w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'b1' })).code, 'price_mismatch');
});

test('B5: an old open order at an old pack price is not handed out after the price changes', async () => {
  const { s, w } = await world();
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'b1' })).amountMinor, 239900);
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 249900 } });
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'b1' })).code, 'price_changed'); // the id still points at the old order
  assert.equal((await w.startBuy({ email: 'o@x.com', credits: 3400, buyId: 'b2' })).amountMinor, 249900);
});

// ---- spending: capture first, then grant ----
test('S1: spend captures, then grants once; the ledger balances', async () => {
  const { s, w, side, granted, calls } = await world();
  await fund(w, side);
  const r = await spend(w, { spendKey: 'click-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls(), 1);
  assert.equal(granted.size, 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  assert.equal(onlyRow(w).status, 'granted');
  assert.equal(await held(s), 0);
  await ok(s);
});

test('S2: a repeated click is the same order, never a second grant or charge', async () => {
  const { s, w, side, calls } = await world();
  await fund(w, side);
  await spend(w, { spendKey: 'k1' });
  const again = await spend(w, { spendKey: 'k1' });
  assert.equal(again.ok, true);
  assert.equal(again.repeat, true);
  assert.equal(calls(), 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  assert.equal(w.store.all().length, 1);
  await ok(s);
});

test('S3: not enough credits: exact code, no game step, no hold; after buying, the same click works', async () => {
  const { s, w, side, calls } = await world();
  const a = await spend(w, { spendKey: 'k1' });
  assert.equal(a.code, 'insufficient_credits');
  assert.equal((await spend(w, { spendKey: 'k1' })).code, 'insufficient_credits');
  assert.equal(calls(), 0);
  assert.equal(await held(s), 0);
  await fund(w, side);
  assert.equal((await spend(w, { spendKey: 'k1' })).ok, true);
  assert.equal(calls(), 1);
  await ok(s);
});

test('S4: the game definitely refuses: the order is refunded and the credits are back', async () => {
  const { s, w, side } = await world(() => { throw refuse(); });
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'game_step_refused');
  assert.equal(onlyRow(w).status, 'refunded');
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  assert.equal(await held(s), 0);
  await ok(s);
});

test('S5: an unclear game failure never frees the credits; the job repeats the step and it is granted once', async () => {
  const { s, w, side, granted } = await world((n) => { if (n === 1) throw new Error('timeout'); });
  await fund(w, side);
  const r = await spend(w);
  assert.equal(r.code, 'order_in_progress');
  assert.equal(onlyRow(w).status, 'captured'); // credits already spent
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  assert.equal(onlyRow(w).status, 'granted');
  assert.equal(granted.size, 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  await ok(s);
});

test('S6: still unclear after an hour: the owner is alerted at once, credits stay spent, nothing is lost', async () => {
  const { s, w, side, alerts, calls } = await world(() => { throw new Error('timeout'); });
  await fund(w, side);
  await spend(w);
  for (let i = 0; i < 31; i++) { s.clock.t += 2 * MIN; await w.retryStuck(); }
  assert.equal(onlyRow(w).status, 'needs_review');
  assert.deepEqual(alerts, ['game_step_unknown_too_long']);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  assert.equal((await spend(w, { spendKey: onlyRow(w).spendKey.split(':')[1] })).code, 'with_owner');
  const n = calls();
  await w.retryStuck();
  assert.equal(calls(), n); // no more calls to the game once it is with the owner
  await ok(s);
});

test('S7: a capture that fails on the network is retried by the job; the game is only called after the capture', async () => {
  let fail = 2;
  const order = [];
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (p === '/v1/spend/capture') { if (fail-- > 0) throw new Error('net'); order.push('capture'); } return c.post(p, b); } });
  const { s, w, side } = await world(() => { order.push('grant'); }, wrap);
  await fund(w, side);
  assert.equal((await spend(w)).code, 'order_in_progress');
  assert.equal(onlyRow(w).status, 'reserved');
  for (let i = 0; i < 3; i++) { s.clock.t += 3 * MIN; await w.retryStuck(); }
  assert.equal(onlyRow(w).status, 'granted');
  assert.deepEqual(order, ['capture', 'grant']);
  await ok(s);
});

test('S8: a reserve whose answer is lost is recovered: the same hold comes back, credits held once', async () => {
  let lose = true;
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { const r = await c.post(p, b); if (lose && p === '/v1/spend/reserve_item') { lose = false; throw new Error('lost answer'); } return r; } });
  const { s, w, side, calls } = await world(() => {}, wrap);
  await fund(w, side);
  assert.equal((await spend(w)).code, 'order_in_progress');
  assert.equal(await held(s), 1); // the hold exists, the console did not hear
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  assert.equal(onlyRow(w).status, 'granted');
  assert.equal(calls(), 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  assert.equal(await held(s), 0);
  await ok(s);
});

test('S9: a hold that lapsed before capture is reserved again; nothing was given in between', async () => {
  let slow = true;
  const holder = {};
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (slow && p === '/v1/spend/capture') { slow = false; holder.s.clock.t += 40 * MIN; } return c.post(p, b); } });
  const { s, w, side, calls } = await world(() => {}, wrap);
  holder.s = s;
  await fund(w, side);
  assert.equal((await spend(w)).code, 'order_in_progress');
  assert.equal(calls(), 0);
  assert.equal(onlyRow(w).status, 'new');
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  assert.equal(onlyRow(w).status, 'granted');
  assert.equal(calls(), 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  await ok(s);
});

test('S10: a worker that died in the middle of a step is put back by the job and finishes once', async () => {
  const { s, w, side, granted } = await world();
  await fund(w, side);
  const h = await s.api.post('/v1/spend/reserve_item', { email: 'o@x.com', product: 'tambola', item: 'game_standard', order_ref: 'tambola-dead' });
  await s.api.post('/v1/spend/capture', { hold_id: h.body.hold_id });
  w.store.plant('d1', { id: 'd1', orderRef: 'tambola-dead', email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: 'x', status: 'granting', tries: 0, holdId: h.body.hold_id, credits: 1000, at: s.clock.t });
  s.clock.t += 3 * MIN;
  await Promise.all([w.retryStuck(), w.retryStuck(), w.retryStuck()]);
  assert.equal(w.store.get('d1').status, 'granted');
  assert.equal(granted.size, 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  await ok(s);
});

test('S11: four clicks at once on 1,700-credit items with 3,400 credits: exactly two are granted', async () => {
  const { s, w, side, calls } = await world();
  await fund(w, side);
  const res = await Promise.all([1, 2, 3, 4].map((n) => spend(w, { item: 'game_big', spendKey: `k${n}` })));
  assert.equal(res.filter((x) => x.ok).length, 2);
  assert.equal(res.filter((x) => x.code === 'insufficient_credits').length, 2);
  assert.equal(calls(), 2);
  assert.equal((await w.balance('o@x.com')).balance, 0);
  assert.equal(await held(s), 0);
  await ok(s);
});

test('S12: the same key at once is one order; keys are per person and per item', async () => {
  const { s, w, side, calls } = await world();
  await fund(w, side);
  await fund(w, side, 'p@x.com', 'b2', 'pay_2');
  const [a, b] = await Promise.all([spend(w, { spendKey: 'same' }), spend(w, { spendKey: 'same' })]);
  assert.equal([a, b].filter((x) => x.ok && !x.repeat).length, 1);
  assert.equal(calls(), 1);
  assert.equal((await spend(w, { item: 'game_big', spendKey: 'same' })).code, 'key_conflict');
  const other = await w.spend({ email: 'p@x.com', product: 'tambola', item: 'game_standard', spendKey: 'same' });
  assert.equal(other.ok, true);
  assert.equal((await w.balance('p@x.com')).balance, 2400);
  await ok(s);
});

test('S13: unknown or prototype product names and an unlisted item are refused; credits untouched', async () => {
  const { s, w, side } = await world();
  await fund(w, side);
  for (const p of ['nope', '__proto__', 'constructor', 'toString']) assert.equal((await w.spend({ email: 'o@x.com', product: p, item: 'x' })).code, 'unknown_product');
  assert.equal((await spend(w, { item: 'nope' })).code, 'no_item');
  assert.equal(await held(s), 0);
  assert.equal((await w.balance('o@x.com')).balance, 3400);
  assert.equal(w.paymentVerified, undefined);
});

test('S14: the owner is alerted the moment an order needs a person', async () => {
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (p === '/v1/refund') return { status: 503, body: {} }; return c.post(p, b); } });
  const { s, w, side, alerts } = await world(() => { throw refuse(); }, wrap);
  await fund(w, side);
  await spend(w);
  for (let i = 0; i < 8; i++) { s.clock.t += 3 * MIN; await w.retryStuck(); }
  assert.equal(onlyRow(w).status, 'needs_review');
  assert.deepEqual(alerts, ['refund_failed']);
});

// ---- the store promise ----
test('T1: the in-memory store keeps every promise; a broken store is caught by the contract', async () => {
  assert.deepEqual(await storeContract(() => memoryStore()), []);
  const broken = () => ({ ...memoryStore(), cas: () => true });
  assert.ok((await storeContract(broken)).length > 0);
  const noUnique = () => { const m = memoryStore(); return { ...m, putNew: (id, row) => { m.plant(id, row); return null; } }; };
  assert.ok((await storeContract(noUnique)).length > 0);
});

test('T2: the wallet works with a store that answers later (async), like a real database', async () => {
  const m = memoryStore();
  const lag = () => new Promise((r) => setTimeout(r, 1));
  const asyncStore = { get: async (i) => { await lag(); return m.get(i); }, all: async () => { await lag(); return m.all(); }, putNew: async (i, r) => { await lag(); return m.putNew(i, r); }, cas: async (i, f, p) => { await lag(); return m.cas(i, f, p); }, plant: m.plant };
  assert.deepEqual(await storeContract(() => asyncStore), []);
  const { s, w, side, calls } = await world(() => {}, (c) => c, { store: asyncStore });
  await fund(w, side);
  const res = await Promise.all([1, 2, 3, 4].map((n) => spend(w, { item: 'game_big', spendKey: `k${n}` })));
  assert.equal(res.filter((x) => x.ok).length, 2);
  assert.equal(calls(), 2);
  assert.equal((await w.balance('o@x.com')).balance, 0);
  await ok(s);
});

test('T3: a capture that was done on the server but looked failed is not lost: the order carries on to the grant', async () => {
  let first = true;
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { const r = await c.post(p, b); if (first && p === '/v1/spend/capture') { first = false; return { status: 409, body: { error: { code: 'hold_closed' } } }; } return r; } });
  const { s, w, side, calls } = await world(() => {}, wrap);
  await fund(w, side);
  await spend(w);
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  s.clock.t += 3 * MIN;
  await w.retryStuck();
  assert.equal(onlyRow(w).status, 'granted');
  assert.equal(calls(), 1);
  assert.equal((await w.balance('o@x.com')).balance, 2400);
  await ok(s);
});

test('P1: a pack order made at an old price is not handed out again after a price change (Moneypenny side), and a spend needs a click key', async () => {
  const { s, w } = await world();
  const ref = { email: 'o@x.com', credits: 3400, currency: 'INR', order_ref: 'raw-1' };
  assert.equal((await s.api.post('/v1/buy_credits', ref)).status, 200);
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 249900 } });
  const again = await s.api.post('/v1/buy_credits', ref);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'price_changed');
  assert.equal((await w.spend({ email: 'o@x.com', product: 'tambola', item: 'game_standard' })).code, 'bad_request');
});

test('P2: the console key cannot confirm a payment (only the payment side can)', async () => {
  const { s } = await world();
  assert.equal((await s.api.post('/v1/rail/confirm', { order_id: 'x', payment_ref: 'p', paid_minor: 1, currency: 'INR' })).status, 403);
});

test('S15: capture keeps failing: after 5 tries the order goes to the owner with the reason; no game call', async () => {
  const wrap = (c) => ({ get: (p) => c.get(p), post: async (p, b) => { if (p === '/v1/spend/capture') throw new Error('net'); return c.post(p, b); } });
  const { s, w, side, alerts, calls } = await world(() => {}, wrap);
  await fund(w, side);
  await spend(w);
  for (let i = 0; i < 8; i++) { s.clock.t += 3 * MIN; await w.retryStuck(); }
  assert.equal(onlyRow(w).status, 'needs_review');
  assert.deepEqual(alerts, ['capture_failed']);
  assert.equal(calls(), 0);
});

test('S16: the wallet does not hand out its store', async () => {
  const { w } = await world();
  const fresh = createWallet({ mnp: {}, games: {} });
  assert.equal(fresh.store, undefined);
  assert.equal(Object.keys(fresh).includes('plant'), false);
});

test('S17: a row whose workers keep dying still reaches the owner: the hour counts from capture, not from the last attempt', async () => {
  const { s, w, side, alerts, calls } = await world();
  await fund(w, side);
  const t0 = s.clock.t;
  s.clock.t += 61 * MIN;
  w.store.plant('l1', { id: 'l1', orderRef: 'tambola-loop', email: 'o@x.com', product: 'tambola', item: 'game_standard', spendKey: 'l', status: 'granting', tries: 9, holdId: 'h', credits: 1000, at: s.clock.t, capturedAt: t0 });
  await w.retryStuck();
  assert.equal(w.store.get('l1').status, 'needs_review');
  assert.deepEqual(alerts, ['game_step_unknown_too_long']);
  assert.equal(calls(), 0);
});
