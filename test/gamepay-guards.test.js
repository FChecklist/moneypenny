// One named test per guard in the game pay chain (audit follow-up, 20 Nov 2026). Each test fails when its guard alone is removed.
// Test-only: production code is unchanged. Direct calls (trySettle) reach a guard that the route layer would otherwise hide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, buy, MIN, T0 } from './helpers.js';
import { refreshRates, utcDayStart } from '../src/fx.js';
import { trySettle } from '../src/gamepay.js';

const DAY0 = utcDayStart(T0);
const ORG = 'org@example.com';
const src = (r) => ({ name: 't', async fetch() { return { rates: { INR: r } }; } });

function fakeIts() {
  const orders = new Map(), byMp = new Map(), paid = new Map();
  const f = {
    name: 'fake_its', verifyDown: false, calls: { verify: 0 },
    async createOrder(o) {
      if (byMp.has(o.order_id)) return byMp.get(o.order_id);
      const id = `order_${orders.size + 1}`;
      orders.set(id, { mp: o.order_id, amount: o.amount_minor, currency: o.currency, payer: o.payer_email });
      const out = { rail_order_id: id, payframe: { key: 'k', order_id: id, amount: o.amount_minor, currency: o.currency } };
      byMp.set(o.order_id, out);
      return out;
    },
    async verify(v) {
      f.calls.verify++;
      if (f.verifyDown) throw new Error('down');
      const oid = paid.get(v.razorpay_payment_id), o = orders.get(v.razorpay_order_id);
      if (!oid || oid !== v.razorpay_order_id || !o) return { paid: false };
      return { paid: true, rail_order_id: oid, payment_ref: v.razorpay_payment_id, amount_minor: o.amount, currency: o.currency, payer_email: o.payer, mp_order_id: o.mp };
    },
    async health() { return { ok: true }; },
    async instruct() { throw new Error('no'); },
    customerPays(orderId, payId) { paid.set(payId, orderId); return { razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: 'sig' }; },
  };
  return f;
}
async function world() {
  const its = fakeIts();
  const s = await setup({ rail: its });
  await s.admin.put('/v1/admin/settings', { inr_packs: { 3400: 239900, 5100: 349900 } });
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 3400 });
  await refreshRates(s.db, src(88), DAY0);
  s.clock.t = DAY0 + 3 * MIN;
  return { s, its };
}
const start = (s, o = {}) => s.api.post('/v1/game_pay/start', { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard', ...o });
const gp = (s, ref = 'G1') => s.db.first('SELECT * FROM game_pay WHERE game_ref = ?', ref);
const count = async (s, sql, ...a) => (await s.db.first(sql, ...a)).n;
const held = (s) => count(s, "SELECT COUNT(*) n FROM hold WHERE status = 'held'");
const paidEvents = (s) => count(s, "SELECT COUNT(*) n FROM outbox WHERE type = 'game.paid'");
const balance = async (s) => (await s.read.get(`/v1/balance?email=${ORG}`)).body.balance;
const push = (s, b, payRef, extra = {}) => s.pay.post('/v1/game_pay/payment_confirmed', { order_id: b.order.order_id, payment_ref: payRef, paid_minor: 239900, currency: 'INR', payer_email: ORG, ...extra });
async function paidGame(s) { await buy(s.api, ORG, 5000, 'pay_pre1'); const r = await start(s); assert.equal(r.body.paid, true); }
const direct = (s, fn) => s.db.tx((t) => fn({ ...s.ctx(), db: t }));

test('GG1 (gamepay.js:92): settling a game that is already paid answers "already" and touches nothing', async () => {
  const { s } = await world(); await paidGame(s);
  const before = { bal: await balance(s), ev: await paidEvents(s) };
  const r = await direct(s, (ctx) => trySettle(ctx, { game_ref: 'G1' }));
  assert.equal(r.paid, true); assert.equal(r.already, true);
  assert.equal(await balance(s), before.bal); assert.equal(await paidEvents(s), before.ev); assert.equal(await held(s), 0);
});

test('GG2 (gamepay.js:106): a hold of this game already captured another way marks the game paid once, without a second charge', async () => {
  const { s } = await world();
  await buy(s.api, ORG, 3000, 'pay_pre1');
  assert.equal((await start(s)).body.paid, false); // short: game row exists, still open
  await buy(s.api, ORG, 400, 'pay_pre2');
  const h = await s.api.post('/v1/spend/reserve_item', { email: ORG, product: 'tambola', item: 'game_standard', order_ref: 'game:G1' });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const c = await s.api.post('/v1/spend/capture', { hold_id: h.body.hold_id });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const r = await direct(s, (ctx) => trySettle(ctx, { game_ref: 'G1' }));
  assert.equal(r.paid, true, JSON.stringify(r));
  assert.equal((await gp(s)).status, 'paid');
  assert.equal(await paidEvents(s), 1);
  assert.equal(await balance(s), 0); // 3400 bought, 3400 spent once
});

test('GG3 (gamepay.js:82): if the game turns paid under the step (a race), the whole step is undone: no second event, credits not taken', async () => {
  const { s } = await world(); await buy(s.api, ORG, 5000, 'pay_pre1');
  await s.db.run("CREATE TRIGGER racer AFTER UPDATE OF status ON hold WHEN NEW.status = 'captured' BEGIN UPDATE game_pay SET status = 'paid' WHERE game_ref = 'G1'; END");
  const r = await start(s);
  await s.db.run('DROP TRIGGER racer');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(await paidEvents(s), 0);
  assert.equal(await count(s, "SELECT COUNT(*) n FROM hold WHERE status = 'captured'"), 0);
  assert.equal(await balance(s), 5000);
});

test('GG4 (gamepay.js:215): asking to pay a paid game again does not rewrite it, even if the price has moved since', async () => {
  const { s } = await world(); await paidGame(s);
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 2000 });
  const again = await start(s, { credits: 2000 });
  assert.equal(again.body.paid, true);
  assert.equal((await gp(s)).credits, 3400); // the paid record keeps what was charged
  assert.equal(await paidEvents(s), 1);
});

test('GG5 (gamepay.js:262): confirming an order that is already paid answers from our own record, without asking the payment side', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body;
  const win = its.customerPays('order_1', 'pay_a1');
  assert.equal((await s.api.post('/v1/game_pay/confirm', { order_ref: 'G1', order_id: b.order.order_id, ...win })).body.paid, true);
  its.verifyDown = true; const calls = its.calls.verify;
  const r = await s.api.post('/v1/game_pay/confirm', { order_ref: 'G1', order_id: b.order.order_id, ...win }, { idem: 'second' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paid, true); assert.equal(its.calls.verify, calls);
});

test('GG6 (gamepay.js:305): a pay link cannot be made for a game that is already paid', async () => {
  const { s } = await world(); await paidGame(s);
  const r = await s.api.post('/v1/game_pay/link', { order_ref: 'G1', email: ORG, product: 'tambola', item: 'game_standard' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'already_paid');
  assert.equal(await count(s, 'SELECT COUNT(*) n FROM game_pay_link'), 0);
});

test('GG7 (gamepay.js:99): credits that arrive when the price has moved leave the game OPEN (re-quote), not flagged for review', async () => {
  const { s, its } = await world();
  const b = (await start(s)).body; its.customerPays('order_1', 'pay_p1');
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_standard', credits: 3000 });
  const r = await push(s, b, 'pay_p1');
  assert.equal(r.body.reason, 'price_changed');
  assert.equal((await gp(s)).status, 'open');
  assert.equal(await count(s, "SELECT COUNT(*) n FROM outbox WHERE type = 'game_pay.needs_review'"), 0);
});

test('GG8 (gamepay.js:271): a payment made for another order cannot be applied to this game', async () => {
  const { s, its } = await world();
  const a = (await start(s)).body;                       // G1 -> order_1
  const b2 = (await start(s, { order_ref: 'G2' })).body; // G2 -> order_2
  const win2 = its.customerPays('order_2', 'pay_g2');
  const r = await s.api.post('/v1/game_pay/confirm', { order_ref: 'G1', order_id: a.order.order_id, ...win2 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'order_mismatch');
  assert.equal(await balance(s), 0); assert.equal((await gp(s)).status, 'open');
  assert.ok(b2.order.order_id);
});

test('GG9 (gate.js:215): a game order is never credited by the payment side without a noted payment', async () => {
  const { s } = await world();
  const b = (await start(s)).body;
  const r = await s.pay.post('/v1/rail/confirm', { order_id: b.order.order_id, payment_ref: 'pay_nonote', paid_minor: 239900, currency: 'INR' });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'payment_not_verified');
  assert.equal(await balance(s), 0);
});

test('GG10 (wallet.js:169): credits are never given for more money than the payment side noted', async () => {
  const { s } = await world();
  const b = (await start(s)).body;
  await s.pay.post('/v1/payment_notice', { payment_ref: 'pay_small', paid_minor: 100000, currency: 'INR', payer_email: ORG });
  const r = await s.pay.post('/v1/rail/confirm', { order_id: b.order.order_id, payment_ref: 'pay_small', paid_minor: 239900, currency: 'INR' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'payment_conflict');
  assert.equal(await balance(s), 0);
});

test('GG11 (gamepay.js:94): a paused account is left completely alone: nothing is swept or changed on it', async () => {
  const { s, its } = await world();
  await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'game_small', credits: 100 });
  await buy(s.api, ORG, 100, 'pay_pre1');
  const hh = await s.api.post('/v1/spend/reserve_item', { email: ORG, product: 'tambola', item: 'game_small', order_ref: 'other-1' });
  assert.equal(hh.status, 200, JSON.stringify(hh.body));
  const b = (await start(s)).body; its.customerPays('order_1', 'pay_f1');
  await s.admin.post('/v1/admin/freeze', { email: ORG, frozen: true });
  s.clock.t += 60 * MIN; // that hold is now long past its time
  const r = await push(s, b, 'pay_f1');
  assert.equal(r.body.reason, 'account_frozen');
  assert.equal((await s.db.first("SELECT status FROM hold WHERE order_ref = 'other-1'")).status, 'held');
});

test('GG12 (gamepay.js:116): if the capture is refused, the hold is given back at once, never left open', async () => {
  const { s } = await world(); await buy(s.api, ORG, 5000, 'pay_pre1');
  await s.db.run("CREATE TRIGGER ageing AFTER INSERT ON hold BEGIN UPDATE hold SET expires_at = 1 WHERE id = NEW.id; END"); // the hold is stale by the time it is captured
  const r = await start(s);
  await s.db.run('DROP TRIGGER ageing');
  assert.equal(r.body.paid, false, JSON.stringify(r.body));
  assert.equal(r.body.reason, 'hold_expired');
  assert.equal(await held(s), 0);
  assert.equal(await balance(s), 5000);
});
