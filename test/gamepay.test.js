// One game, one payment chain: console -> Moneypenny -> IT Services -> Razorpay, with the credits bought and the game paid automatically.
// IT Services and Razorpay are a stand-in (fakeIts) that follows the credit-order / credit-verify contract. No live call, no real money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, buy, MIN, HOUR, T0 } from './helpers.js';
import { refreshRates, utcDayStart } from '../src/fx.js';
import { verifyBalances } from '../src/ledger.js';
import { drain, webhookSecret } from '../src/outbox.js';
import { hmacHex } from '../src/util.js';
import { itServicesRail } from '../src/itservices-rail.js';

const DAY0 = utcDayStart(T0);
const src = (r) => ({ name: 't', async fetch() { return { rates: { INR: r } }; } });
const ORG = 'org@example.com';
const PAYEE = 'host@example.org';

/** A stand-in for IT Services + Razorpay. createOrder is idempotent by order_id. */
function fakeIts() {
  const orders = new Map(); // razorpay order id -> {mp, amount, currency, payer, game}
  const byMp = new Map();
  const paid = new Map(); // razorpay payment id -> razorpay order id
  const f = {
    name: 'fake_its', down: false, verifyDown: false, calls: { createOrder: 0, verify: 0 },
    async createOrder(o) {
      f.calls.createOrder++;
      if (f.down) throw new Error('its_down');
      if (byMp.has(o.order_id)) return byMp.get(o.order_id);
      const id = `order_${orders.size + 1}`;
      orders.set(id, { mp: o.order_id, amount: o.amount_minor, currency: o.currency, payer: o.payer_email, game: o.game_ref });
      const out = { rail_order_id: id, pay_url: null, payframe: { key: 'rzp_test_key', order_id: id, amount: o.amount_minor, currency: o.currency } };
      byMp.set(o.order_id, out);
      return out;
    },
    async verify(v) {
      f.calls.verify++;
      if (f.verifyDown) throw new Error('its_down');
      const oid = paid.get(v.razorpay_payment_id);
      const o = orders.get(v.razorpay_order_id);
      if (!oid || oid !== v.razorpay_order_id || !o) return { paid: false };
      return { paid: true, rail_order_id: oid, payment_ref: v.razorpay_payment_id, amount_minor: o.amount, currency: o.currency, payer_email: o.payer, mp_order_id: o.mp };
    },
    async health() { return { ok: true }; },
    async instruct() { throw new Error('no'); },
    /** the customer pays in the payment window: returns what the window hands back */
    customerPays(railOrderId, payId) { paid.set(payId, railOrderId); return { razorpay_order_id: railOrderId, razorpay_payment_id: payId, razorpay_signature: 'sig' }; },
    orders,
  };
  return f;
}

async function world(opts = {}) {
  const its = fakeIts();
  const s = await setup({ rail: its });
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 239900, 5100: 349900 } });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 3400 });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_small', credits: 1000 });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_huge', credits: 99999 });
  await refreshRates(s.db, src(88), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  return { s, its, ...opts };
}
const start = (s, o = {}) => s.api.post('/v1/game_pay/start', { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard', ...o });
const status = (s, ref = 'G1') => s.read.get(`/v1/game_pay/status?order_ref=${ref}`);
const held = async (s) => (await s.db.first("SELECT COUNT(*) n FROM hold WHERE status = 'held'")).n;
const captured = async (s, ref = 'game:G1') => (await s.db.first("SELECT COUNT(*) n FROM hold WHERE status = 'captured' AND order_ref = ?", ref)).n;
const events = async (s, type = 'game.paid') => (await s.db.all('SELECT * FROM outbox WHERE type = ? ORDER BY created_at', type)).map((e) => ({ ...e, data: JSON.parse(e.payload) }));
const lots = async (s) => (await s.db.first("SELECT COUNT(*) n FROM lot WHERE source = 'purchase'")).n;
const ledgerOk = async (s) => assert.deepEqual(await verifyBalances(s.ctx()), []);
const balance = async (s, email = ORG) => (await s.read.get(`/v1/balance?email=${encodeURIComponent(email)}`)).body.balance;
const confirmBody = (b, paidWith, extra = {}) => ({ order_ref: 'G1', order_id: b.order.order_id, ...paidWith, ...extra });

// ---- quote ----
test('GQ1: the quote gives cost, balance, what is still to buy and the covering pack, and writes nothing', async () => {
  const { s } = await world();
  const q = await s.read.get(`/v1/game_pay/quote?order_ref=G1&email=${ORG}&product=tambola&item=game_standard`);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.cost_credits, 3400);
  assert.equal(q.body.balance, 0);
  assert.equal(q.body.short_by, 3400);
  assert.equal(q.body.to_buy.credits, 3400);
  assert.equal(q.body.to_buy.amount_minor, 239900); // the listed pack price, exactly
  assert.equal(q.body.cost_usd, '34.00');
  assert.equal(q.body.can_pay_now, false);
  assert.equal(q.body.status, 'unknown');
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM game_pay')).n, 0);
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM hold')).n, 0);
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM purchase_order')).n, 0);
});

test('GQ2: a part-funded organizer is asked for the smallest pack that covers the gap', async () => {
  const { s } = await world();
  await buy(s.api, ORG, 3000, 'pay_pre1');
  const q = (await s.read.get(`/v1/game_pay/quote?order_ref=G1&email=${ORG}&product=tambola&item=game_standard`)).body;
  assert.equal(q.balance, 3000);
  assert.equal(q.short_by, 400);
  assert.equal(q.to_buy.credits, 3400); // smallest listed pack that is at least the gap
  const huge = await s.read.get(`/v1/game_pay/quote?order_ref=G9&email=${ORG}&product=tambola&item=game_huge`);
  assert.equal(huge.body.to_buy, null); // nothing covers it: no invented size
});

// ---- paying from credits ----
test('GP1: enough credits: ONE call pays the game, nothing is left in a hold, the game is told once', async () => {
  const { s } = await world();
  await buy(s.api, ORG, 5000, 'pay_pre1');
  const r = await start(s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paid, true);
  assert.equal(r.body.status, 'paid');
  assert.equal(await balance(s), 1600);
  assert.equal(await held(s), 0);
  assert.equal(await captured(s), 1);
  const ev = await events(s);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.game_ref, 'G1');
  assert.equal(ev[0].data.credits, 3400);
  assert.ok(!ev[0].payload.includes('@'), 'the event carries no e-mail');
  assert.equal((await status(s)).body.paid, true);
  assert.equal((await status(s)).body.event.id, ev[0].id);
  await ledgerOk(s);
});

test('GP2: asking again (same game, other idempotency key) never charges twice; another person cannot take the game id', async () => {
  const { s } = await world();
  await buy(s.api, ORG, 9000, 'pay_pre1');
  await start(s);
  const again = await start(s);
  assert.equal(again.body.paid, true);
  assert.equal(await balance(s), 5600);
  assert.equal(await captured(s), 1);
  assert.equal((await events(s)).length, 1);
  assert.equal((await start(s, { email: 'other@example.com' })).body.error.code, 'game_ref_used');
  assert.equal((await start(s, { item: 'game_small' })).body.error.code, 'game_ref_used');
  await ledgerOk(s);
});

test('GP3: the price shown must be the price charged', async () => {
  const { s } = await world();
  await buy(s.api, ORG, 5000, 'pay_pre1');
  const r = await start(s, { credits: 3300 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'price_changed');
  assert.equal(r.body.error.price_credits, 3400);
  assert.equal(await balance(s), 5000);
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM game_pay')).n, 0);
});

// ---- short of credits: buy first, then the game is paid automatically ----
test('GB1: short of credits: a purchase for THIS game id opens, the window details come back, nothing is charged yet', async () => {
  const { s, its } = await world();
  const r = await start(s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paid, false);
  assert.equal(r.body.status, 'awaiting_payment');
  assert.equal(r.body.order.amount_minor, 239900);
  assert.equal(r.body.order.credits, 3400);
  assert.equal(r.body.order.payframe.key, 'rzp_test_key');
  assert.equal(r.body.order.payframe.order_id, 'order_1');
  assert.equal([...its.orders.values()][0].game, 'G1');
  assert.equal([...its.orders.values()][0].payer, ORG);
  assert.equal(await held(s), 0);
  assert.equal(await balance(s), 0);
  const again = await start(s); // a second click: the same order, not a second one
  assert.equal(again.body.order.order_id, r.body.order.order_id);
  assert.equal(its.orders.size, 1);
});

test('GB2: payment done: credits are added and the game is paid in the same step; the game is told; nothing stuck', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  const win = its.customerPays('order_1', 'pay_100');
  const r = await s.api.post('/v1/game_pay/confirm', confirmBody(b, win));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paid, true);
  assert.equal(r.body.credited, 3400);
  assert.equal(await balance(s), 0); // bought 3400, the game took 3400
  assert.equal(await held(s), 0);
  assert.equal(await captured(s), 1);
  assert.equal(await lots(s), 1);
  assert.equal((await events(s)).length, 1);
  assert.equal((await status(s)).body.status, 'paid');
  const hist = (await s.api.get(`/v1/history?email=${ORG}`)).body.entries.map((e) => e.kind);
  assert.ok(hist.includes('purchase') && hist.includes('capture'));
  await ledgerOk(s);
});

test('GB3: a payment not yet taken changes nothing', async () => {
  const { s } = await world();
  const b = (await start(s)).body;
  const r = await s.api.post('/v1/game_pay/confirm', confirmBody(b, { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_none', razorpay_signature: 'x' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.paid, false);
  assert.equal((await status(s)).body.status, 'awaiting_payment');
  assert.equal(await balance(s), 0);
});

test('GB4: tab closed: the push from IT Services pays the game; the console poll sees it; a later confirm changes nothing', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  const win = its.customerPays('order_1', 'pay_200');
  const push = { order_id: b.order.order_id, payment_ref: 'pay_200', paid_minor: 239900, currency: 'INR', payer_email: ORG };
  const r = await s.pay.post('/v1/game_pay/payment_confirmed', push);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paid, true);
  assert.equal((await status(s)).body.paid, true); // the poll: the game is paid although nobody confirmed
  const late = await s.api.post('/v1/game_pay/confirm', confirmBody(b, win));
  assert.equal(late.body.paid, true);
  assert.equal(late.body.payment.already, true);
  assert.equal(await lots(s), 1);
  assert.equal(await captured(s), 1);
  assert.equal((await events(s)).length, 1);
  assert.equal(await balance(s), 0);
  await ledgerOk(s);
});

test('GB5: the same payment sent again and again (own keys, other keys, the console too): credits once, game charged once', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  const win = its.customerPays('order_1', 'pay_300');
  const push = { order_id: b.order.order_id, payment_ref: 'pay_300', paid_minor: 239900, currency: 'INR', payer_email: ORG };
  const first = await s.pay.post('/v1/game_pay/payment_confirmed', push, { idem: 'same-key' });
  const replay = await s.pay.post('/v1/game_pay/payment_confirmed', push, { idem: 'same-key' }); // same key: the first answer comes back
  const other = await s.pay.post('/v1/game_pay/payment_confirmed', push, { idem: 'a-different-key' }); // a fresh request for the same payment
  const viaConsole = await s.api.post('/v1/game_pay/confirm', confirmBody(b, win));
  assert.equal(first.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(other.body.payment.already, true);
  assert.equal(viaConsole.body.paid, true);
  assert.equal(await lots(s), 1);
  assert.equal(await captured(s), 1);
  assert.equal((await events(s)).length, 1);
  assert.equal(await balance(s), 0);
  await ledgerOk(s);
});

test('GB6: wrong e-mail: a payment by someone else adds nothing and notes nothing; the right one still works', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  its.customerPays('order_1', 'pay_400');
  const bad = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: 'pay_400', paid_minor: 239900, currency: 'INR', payer_email: 'stranger@example.net' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.code, 'payer_mismatch');
  assert.equal(await balance(s), 0);
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM verified_payment')).n, 0);
  assert.equal((await status(s)).body.status, 'awaiting_payment');
  // even a payment noted for the wrong person cannot be pushed through the plain confirm route
  await s.pay.post('/v1/payment_notice', { payment_ref: 'pay_401', paid_minor: 239900, currency: 'INR', payer_email: 'stranger@example.net' });
  const direct = await s.pay.post('/v1/rail/confirm', { order_id: b.order.order_id, payment_ref: 'pay_401', paid_minor: 239900, currency: 'INR' });
  assert.equal(direct.body.error.code, 'payer_mismatch');
  assert.equal(await lots(s), 0);
  const ok = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: 'pay_400', paid_minor: 239900, currency: 'INR', payer_email: ORG });
  assert.equal(ok.body.paid, true);
});

test('GB7: the payment side names another payer than the order: the console path refuses too', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  const win = its.customerPays('order_1', 'pay_500');
  const real = [...its.orders.values()][0];
  real.payer = 'someone.else@example.net'; // IT Services says a different person's order
  const r = await s.api.post('/v1/game_pay/confirm', confirmBody(b, win));
  assert.equal(r.body.error.code, 'payer_mismatch');
  assert.equal(await lots(s), 0);
});

test('GB8: a payment for too little or in the wrong currency gives nothing; the game stays unpaid', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  its.customerPays('order_1', 'pay_600');
  const low = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: 'pay_600', paid_minor: 1000, currency: 'INR', payer_email: ORG });
  assert.equal(low.body.error.code, 'payment_mismatch');
  const usd = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: 'pay_600', paid_minor: 239900, currency: 'USD', payer_email: ORG });
  assert.equal(usd.status >= 400, true);
  assert.equal(await balance(s), 0);
  assert.equal((await status(s)).body.paid, false);
});

// ---- failures after money is in ----
test('GF1: the credit step crashes: the whole step is undone (nothing noted, nothing credited, nothing held); sending it again completes', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  its.customerPays('order_1', 'pay_700');
  const push = { order_id: b.order.order_id, payment_ref: 'pay_700', paid_minor: 239900, currency: 'INR', payer_email: ORG };
  await s.db.run("CREATE TRIGGER boom BEFORE INSERT ON lot BEGIN SELECT RAISE(ABORT, 'disk full'); END"); // the credit step fails, after the payment was noted
  const crashed = await s.pay.post('/v1/game_pay/payment_confirmed', push);
  await s.db.run('DROP TRIGGER boom');
  assert.equal(crashed.status, 500);
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM verified_payment')).n, 0);
  assert.equal(await lots(s), 0);
  assert.equal(await held(s), 0);
  assert.equal((await s.db.first("SELECT status FROM purchase_order")).status, 'awaiting_payment');
  assert.equal((await status(s)).body.paid, false);
  const again = await s.pay.post('/v1/game_pay/payment_confirmed', push, { idem: 'retry-1' });
  assert.equal(again.body.paid, true);
  assert.equal(await lots(s), 1);
  assert.equal(await captured(s), 1);
  assert.equal((await events(s)).length, 1);
  await ledgerOk(s);
});

test('GF2: the credits arrive but the game cannot be paid (account paused): the credits stay, no hold is left, review is flagged; the sweep pays it once fixed', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  its.customerPays('order_1', 'pay_800');
  await s.admin.post('/v1/admin/freeze', { email: ORG, frozen: true });
  const r = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: 'pay_800', paid_minor: 239900, currency: 'INR', payer_email: ORG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.credited, 3400);
  assert.equal(r.body.paid, false);
  assert.equal(r.body.status, 'review');
  assert.equal(r.body.reason, 'account_frozen');
  assert.equal(await held(s), 0);
  assert.equal((await events(s, 'game_pay.needs_review')).length, 1);
  assert.equal((await events(s)).length, 0);
  await s.admin.post('/v1/admin/freeze', { email: ORG, frozen: false });
  const sw = await s.admin.post('/v1/admin/sweep', {});
  assert.equal(sw.body.game_pay.paid, 1);
  assert.equal((await status(s)).body.paid, true);
  assert.equal(await balance(s), 0);
  assert.equal((await events(s)).length, 1);
  await ledgerOk(s);
});

test('GF3: the price moved while the buyer was paying: the credits wait, the game is NOT charged the new price unseen', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  its.customerPays('order_1', 'pay_900');
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 3000 });
  const r = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: 'pay_900', paid_minor: 239900, currency: 'INR', payer_email: ORG });
  assert.equal(r.body.paid, false);
  assert.equal(r.body.reason, 'price_changed');
  assert.equal(await balance(s), 3400);
  assert.equal(await held(s), 0);
  const q = (await s.read.get('/v1/game_pay/quote?order_ref=G1')).body;
  assert.equal(q.cost_credits, 3000);
  assert.equal((await start(s, { credits: 3000 })).body.paid, true); // the person confirms the new price
  assert.equal(await balance(s), 400);
  assert.equal(await captured(s), 1);
  await ledgerOk(s);
});

test('GF4: a hold left behind by an old attempt that ran out is given back, then the game is paid once; a fresh one is reused', async () => {
  const { s } = await world();
  await buy(s.api, ORG, 9000, 'pay_pre1');
  const old = await s.api.post('/v1/spend/reserve_item', { email: ORG, product: 'tambola', item: 'game_standard', order_ref: 'game:G1' });
  assert.equal(old.status, 200);
  assert.equal(await balance(s), 5600); // 3400 sits in the old hold
  s.clock.t += 40 * MIN; // past the hold and its grace
  const r = await start(s);
  assert.equal(r.body.paid, true, JSON.stringify(r.body));
  assert.equal(await held(s), 0);
  assert.equal(await captured(s), 1);
  assert.equal(await balance(s), 5600); // 9000 - one game, the old hold's credits came back first
  await ledgerOk(s);
  // a hold that is still fresh is the SAME hold: no double hold, no double charge
  const w = await world();
  await buy(w.s.api, ORG, 9000, 'pay_pre2');
  const fresh = await w.s.api.post('/v1/spend/reserve_item', { email: ORG, product: 'tambola', item: 'game_standard', order_ref: 'game:G1' });
  const go = await start(w.s);
  assert.equal(go.body.hold_id, fresh.body.hold_id);
  assert.equal(await balance(w.s), 5600);
  await ledgerOk(w.s);
});

test('GF5: a second payment for a game that is already paid keeps its credits on the account and never charges the game again', async () => {
  const { s, its } = await world();
  const b1 = (await start(s)).body;
  its.customerPays('order_1', 'pay_a1');
  // the organizer clicks buy again before the first window closes: a second order (another pack size is not needed; same pack, new try)
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 249900, 5100: 349900 } });
  const b2 = (await start(s)).body;
  assert.notEqual(b2.order.order_id, b1.order.order_id);
  its.customerPays('order_2', 'pay_a2');
  const first = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b1.order.order_id, payment_ref: 'pay_a1', paid_minor: 239900, currency: 'INR', payer_email: ORG });
  assert.equal(first.body.paid, true);
  const second = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b2.order.order_id, payment_ref: 'pay_a2', paid_minor: 249900, currency: 'INR', payer_email: ORG });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.paid, true);
  assert.equal(await balance(s), 3400); // the second pack stays as credits
  assert.equal(await captured(s), 1);
  assert.equal((await events(s)).length, 1);
  await ledgerOk(s);
});

test('GF6: IT Services is slow or down: no charge and a clear retry; the push still completes the game later', async () => {
  const { s, its } = await world();
  its.down = true;
  const r = await start(s);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'awaiting_payment');
  assert.equal(r.body.order.status, 'pending_rail');
  assert.equal(r.body.order.payframe, undefined);
  its.down = false;
  s.clock.t += 5 * MIN; // the retry waits a moment (back-off)
  await s.admin.post('/v1/admin/sweep', {});
  const ready = (await status(s)).body;
  assert.equal(ready.order.status, 'awaiting_payment');
  assert.equal(ready.order.payframe.order_id, 'order_1');
  its.customerPays('order_1', 'pay_b1');
  its.verifyDown = true;
  const down = await s.api.post('/v1/game_pay/confirm', { order_ref: 'G1', razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_b1', razorpay_signature: 's' });
  assert.equal(down.status, 502);
  assert.equal(down.body.error.code, 'rail_unavailable');
  assert.equal(await balance(s), 0);
  const push = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: ready.order.order_id, payment_ref: 'pay_b1', paid_minor: 239900, currency: 'INR', payer_email: ORG });
  assert.equal(push.body.paid, true);
});

test('GF7: more credits to buy than any pack covers: refused clearly, nothing opened', async () => {
  const { s, its } = await world();
  const r = await start(s, { order_ref: 'G9', item: 'game_huge' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'no_pack_covers');
  assert.equal(its.orders.size, 0);
});

// ---- the game is told: signed, idempotent ----
test('GE1: the game receives a signed game.paid event whose id never changes, however often it is delivered', async () => {
  const { s } = await world();
  const hook = await s.admin.post('/v1/admin/webhooks', { url: 'https://game.example.com/hook' });
  await buy(s.api, ORG, 5000, 'pay_pre1');
  await start(s);
  const sent = [];
  const ctx = { ...s.ctx(), master: s.master };
  const flaky = async (url, init) => { sent.push({ url, ...init }); return { status: JSON.parse(init.body).type === 'game.paid' && sent.filter((x) => JSON.parse(x.body).type === 'game.paid').length === 1 ? 500 : 200 }; }; // the first try of game.paid fails: it is sent again
  await drain(ctx, flaky);
  s.clock.t += 10 * MIN;
  await drain(ctx, flaky);
  const gamePaid = sent.filter((x) => JSON.parse(x.body).type === 'game.paid');
  assert.ok(gamePaid.length >= 2);
  const ids = new Set(gamePaid.map((x) => x.headers['x-mnp-event-id']));
  assert.equal(ids.size, 1);
  const last = gamePaid.at(-1);
  const expect = await hmacHex(await webhookSecret(s.master, hook.body.id), `${last.headers['x-mnp-timestamp']}.${last.body}`);
  assert.equal(last.headers['x-mnp-signature'], expect);
  const body = JSON.parse(last.body);
  assert.equal(body.data.game_ref, 'G1');
  assert.equal(body.id, [...ids][0]);
  const st = (await status(s)).body;
  assert.equal(st.event.id, body.id);
  assert.equal(st.event.state, 'sent');
});

// ---- the pay link ----
async function link(s, extra = {}) {
  return s.api.post('/v1/game_pay/link', { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard', ...extra });
}
test('GL1: the payee sees only an amount; pays into the ORGANIZER account; the game is paid; the payee gets no account or credits', async () => {
  const { s, its } = await world();
  const l = await link(s);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const token = l.body.token;
  assert.ok(token.length >= 40);
  const info = await s.api.get(`/v1/game_pay/link?token=${token}`);
  assert.equal(info.body.status, 'open');
  assert.equal(info.body.amount_minor, 239900);
  assert.equal(info.body.currency, 'INR');
  for (const k of ['balance', 'credits', 'email', 'account_id', 'cost_credits', 'short_by', 'to_buy']) assert.ok(!(k in info.body), `the payee must not see ${k}`);
  assert.ok(!JSON.stringify(info.body).includes(ORG));
  const go = await s.api.post('/v1/game_pay/link/start', { token, payer_email: PAYEE });
  assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.equal(go.body.order.payframe.order_id, 'order_1');
  for (const k of ['credits', 'balance']) assert.ok(!(k in go.body.order));
  assert.equal([...its.orders.values()][0].payer, PAYEE);
  const win = its.customerPays('order_1', 'pay_l1');
  const done = await s.api.post('/v1/game_pay/confirm', { order_ref: 'G1', ...win });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.paid, true);
  assert.equal(done.body.source, 'paylink');
  assert.equal(await balance(s), 0); // credited to the organizer, spent on the game
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM account WHERE email_norm = ?', PAYEE)).n, 0);
  assert.equal(await captured(s), 1);
  assert.equal((await events(s)).length, 1);
  assert.equal((await s.api.get(`/v1/game_pay/link?token=${token}`)).body.status, 'paid');
  assert.equal((await s.api.post('/v1/game_pay/link/start', { token, payer_email: PAYEE })).body.error.code, 'already_paid');
  await ledgerOk(s);
});

test('GL2: a pay link payment made by anyone but the payee named on the order is refused', async () => {
  const { s, its } = await world();
  const { token } = (await link(s)).body;
  const go = (await s.api.post('/v1/game_pay/link/start', { token, payer_email: PAYEE })).body;
  its.customerPays('order_1', 'pay_l2');
  const bad = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: go.order.order_id, payment_ref: 'pay_l2', paid_minor: 239900, currency: 'INR', payer_email: ORG });
  assert.equal(bad.body.error.code, 'payer_mismatch');
  assert.equal(await lots(s), 0);
  const ok = await s.pay.post('/v1/game_pay/payment_confirmed', { order_id: go.order.order_id, payment_ref: 'pay_l2', paid_minor: 239900, currency: 'INR', payer_email: PAYEE });
  assert.equal(ok.body.paid, true);
});

test('GL3: the token is shown once and never stored; one live link per game; expired, unknown and covered links answer plainly', async () => {
  const { s } = await world();
  const body = { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard' };
  const l = await s.api.post('/v1/game_pay/link', body, { idem: 'link-key' });
  const again = await s.api.post('/v1/game_pay/link', body, { idem: 'link-key' });
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal(again.body.token, undefined); // a replay never hands the token out again
  assert.ok(!JSON.stringify(await s.db.all('SELECT * FROM game_pay_link')).includes(l.body.token));
  assert.ok(!JSON.stringify(await s.db.all('SELECT response FROM idempotency')).includes(l.body.token), 'the token is not kept for replay');
  const second = await link(s);
  assert.equal((await s.api.get(`/v1/game_pay/link?token=${l.body.token}`)).status, 404); // the old one was cancelled
  assert.equal((await s.api.get('/v1/game_pay/link?token=nonsense')).body.error.code, 'no_link');
  s.clock.t += 73 * HOUR; // paylink_hours is 72
  assert.equal((await s.api.get(`/v1/game_pay/link?token=${second.body.token}`)).status, 410);
  const fresh = await link(s);
  await buy(s.api, ORG, 9000, 'pay_pre1');
  assert.equal((await s.api.get(`/v1/game_pay/link?token=${fresh.body.token}`)).body.status, 'nothing_due');
  assert.equal((await s.api.post('/v1/game_pay/link/start', { token: fresh.body.token, payer_email: PAYEE })).body.error.code, 'nothing_due');
});

// ---- keys ----
test('GK1: only the right key classes reach each route; IT Services (purchase key) cannot start or confirm for the console', async () => {
  const { s } = await world();
  assert.equal((await s.read.post('/v1/game_pay/start', { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard' })).status, 403);
  assert.equal((await s.pay.post('/v1/game_pay/start', { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard' })).status, 403);
  assert.equal((await s.api.post('/v1/game_pay/payment_confirmed', { order_id: 'x', payment_ref: 'pay_1', paid_minor: 1, currency: 'INR', payer_email: ORG })).status, 403);
  assert.equal((await s.read.get('/v1/game_pay/link?token=abc')).status, 403);
  assert.equal((await s.read.get('/v1/game_pay/status?order_ref=G1')).status, 200);
  assert.equal((await status(s, 'nope')).body.status, 'unknown');
});

// ---- the IT Services adapter ----
test('GA1: the IT Services adapter sends only the site key, maps the answers, and turns a refusal into a short code', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith('/credit-order')) return new Response(JSON.stringify({ ok: true, keyId: 'rzp_test_k', orderId: 'order_X', amount_minor: 239900, currency: 'INR' }), { status: 200 });
    if (url.endsWith('/credit-verify')) return new Response(JSON.stringify({ ok: true, paid: true, razorpay_order_id: 'order_X', razorpay_payment_id: 'pay_X', amount_minor: 239900, currency: 'INR', order_payer_email: ORG, payment_ref: 'ord_1' }), { status: 200 });
    return new Response(JSON.stringify({ error: 'unknown site or wrong key' }), { status: 401 });
  };
  const rail = itServicesRail({ baseUrl: 'https://its.example/', site: 'moneypenny.example', siteKey: 'sk', fetchImpl });
  const o = await rail.createOrder({ order_id: 'ord_1', order_ref: 'gp:G1:1', amount_minor: 239900, currency: 'INR', credits: 3400, payer_email: ORG, game_ref: 'G1' });
  assert.equal(o.rail_order_id, 'order_X');
  assert.equal(o.payframe.key, 'rzp_test_k');
  assert.equal(seen[0].url, 'https://its.example/api/pay/credit-order');
  assert.equal(seen[0].init.headers['x-site-key'], 'sk');
  assert.equal(seen[0].body.payment_ref, 'ord_1');
  assert.equal(seen[0].body.game_id, 'G1');
  const v = await rail.verify({ razorpay_order_id: 'order_X', razorpay_payment_id: 'pay_X', razorpay_signature: 's' });
  assert.deepEqual([v.paid, v.payer_email, v.payment_ref], [true, ORG, 'pay_X']);
  const bad = itServicesRail({ baseUrl: 'https://its.example', site: 's', siteKey: 'wrong', fetchImpl: async () => new Response(JSON.stringify({ error: 'unknown site or wrong key' }), { status: 401 }) });
  await assert.rejects(bad.createOrder({ order_id: 'o', amount_minor: 1, currency: 'INR', credits: 1 }), (e) => e.code === 'its_401');
  assert.throws(() => itServicesRail({ baseUrl: '', site: 's', siteKey: 'k' }));
});
