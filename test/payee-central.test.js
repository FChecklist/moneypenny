// F10 to F13: the central IT Services pay service as a payee gateway. DARK behind MNP_PAYEE_ACCOUNTS and MNP_CENTRAL_PAY.
// No real network and no real money: a fake central service (test/fake-central.js) that copies the real files' checks and status codes.
//   F10 the gateway adapter     F11 the payee-aware rail (routing of an order)
//   F12 confirmation of a payment from the central service's facts     F13 health of the central payee
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setup, bal } from './helpers.js';
import * as P from '../src/payees.js';
import * as R from '../src/routes.js';
import { buyCredits, railConfirm, processRail } from '../src/gate.js';
import { stubRail, unconfiguredRail, railContract } from '../src/rail.js';
import { gatewayFor } from '../src/gateways/index.js';
import { makeSecretReader } from '../src/secrets.js';
import { verifyChain } from '../src/ledger.js';
import { fakeCentral, MNP_HOST } from './fake-central.js';
import { GATEWAY_NAME, checkBaseUrl, CALL_MS } from '../src/gateways/itservices-central.js';
import { payeeRail, selectRail, centralPayEnabled } from '../src/payee-rail.js';
import { confirmCentralPayment } from '../src/central-confirm.js';
import { centralHealth } from '../src/central-health.js';

const hex = (n) => randomBytes(n).toString('hex');
const nm = (x) => ({ key_id: `MNP_${x}_KEY_ID`, key_secret: `MNP_${x}_KEY_SECRET`, webhook_secret: `MNP_${x}_WEBHOOK_SECRET` });
const BASE = 'https://pay.example.com';
const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };
const caught = async (p) => { try { await p; } catch (e) { return e; } return null; };
const noLeak = (e, ...secrets) => {
  const text = JSON.stringify({ code: e.code, message: e.message, extra: e.extra });
  for (const s of [...secrets, 'ECONNREFUSED', 'pay.example.com', 'x-site-key']) assert.ok(!text.includes(s), `an error carries ${s.slice(0, 6)}...`);
};

// ---------- the adapter on its own (F10) ----------
function adapterWorld() {
  const central = fakeCentral();
  const env = { MNP_CENTRAL_BASE_URL: BASE, MNP_CENT_KEY_ID: MNP_HOST, MNP_CENT_KEY_SECRET: central.siteKey, MNP_CENT_WEBHOOK_SECRET: `v${hex(10)}` };
  const payee = { gateway: GATEWAY_NAME, secret_names: nm('CENT') };
  return { central, env, gw: () => gatewayFor(payee, { reader: makeSecretReader(env), fetch: central.fetch }) };
}
const ORDER = { order_id: 'ord_aaa111', order_ref: 'REF1', amount_minor: 500, currency: 'USD', credits: 500, payer_email: 'p1@example.com' };

test('F10: the registry knows the central gateway, and no adapter exists without an HTTP client', () => {
  const a = adapterWorld();
  assert.equal(a.gw().name, GATEWAY_NAME);
  assert.throws(() => gatewayFor({ gateway: GATEWAY_NAME, secret_names: nm('CENT') }, { reader: makeSecretReader(a.env) }), (e) => e.code === 'gateway_not_configured');
});

test('F10: createOrder sends exactly the documented call, repeats safely, and keeps the price', async () => {
  const a = adapterWorld();
  const out = await a.gw().createOrder(ORDER);
  assert.match(out.gateway_order_id, /^order_/);
  assert.equal(out.amount_minor, 500);
  assert.equal(out.currency, 'USD');
  assert.equal(out.repeat, false);
  const [c] = a.central.calls;
  assert.equal(c.method, 'POST');
  assert.equal(c.origin, BASE);
  assert.equal(c.path, '/api/pay/credit-order');
  assert.equal(c.headers['x-site-key'], a.central.siteKey);
  assert.deepEqual(c.body, { site: MNP_HOST, payment_ref: 'ord_aaa111', credits: 500, amount_minor: 500, currency: 'USD', payer_email: 'p1@example.com' });
  assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted, 'every call has a deadline');
  assert.ok(CALL_MS < 4000, 'the deadline is shorter than the 4000 ms the order step allows');
  // the same Moneypenny order id gives the same central order, never a second one
  const again = await a.gw().createOrder(ORDER);
  assert.equal(again.gateway_order_id, out.gateway_order_id);
  assert.equal(again.repeat, true);
  assert.equal(a.central.orders.size, 1);
  // the same id with another amount is refused (the other side says 409)
  assert.equal(await code(a.gw().createOrder({ ...ORDER, amount_minor: 600 })), 'central_conflict');
});

test('F10: an answer that changes the amount, the currency or the order id is refused', async () => {
  for (const [i, change] of [{ amount_minor: 501 }, { currency: 'INR' }, { orderId: '' }, { ok: false }].entries()) {
    const a = adapterWorld();
    a.central.state.tweak = (path, j) => ({ ...j, ...change });
    assert.equal(await code(a.gw().createOrder({ ...ORDER, order_id: `ord_t${i}` })), 'central_bad_answer');
  }
});

test('F10: every failure of the other side has its own plain code and never carries a secret, the key or the address', async () => {
  const cases = [
    [(c) => { c.state.down = 503; }, 'central_not_ready'],
    [(c) => { c.state.configured = false; }, 'central_not_ready'],
    [(c) => { c.state.down = 500; }, 'central_unreachable'],
    [(c) => { c.state.down = 429; }, 'central_unreachable'],
    [(c) => { c.state.offline = true; }, 'central_unreachable'],
    [(c) => { c.state.down = 401; }, 'central_key_refused'],
    [(c) => { c.state.down = 403; }, 'central_key_refused'],
    [(c) => { c.state.down = 409; }, 'central_conflict'],
    [(c) => { c.state.down = 404; }, 'central_refused'],
  ];
  for (const [set, want] of cases) {
    const a = adapterWorld();
    set(a.central);
    const e = await caught(a.gw().createOrder(ORDER));
    assert.equal(e.code, want);
    noLeak(e, a.central.siteKey, a.env.MNP_CENT_WEBHOOK_SECRET);
  }
  // a wrong site key in our store is refused by the other side
  const a = adapterWorld();
  a.env.MNP_CENT_KEY_SECRET = `wrong${hex(8)}`;
  assert.equal(await code(a.gw().createOrder(ORDER)), 'central_key_refused');
});

test('F10: a bad setup is refused before any call: no address, a bad site name, a missing secret', async () => {
  const noAddr = adapterWorld();
  delete noAddr.env.MNP_CENTRAL_BASE_URL;
  assert.equal(await code(noAddr.gw().createOrder(ORDER)), 'central_not_configured');
  const badSite = adapterWorld();
  badSite.env.MNP_CENT_KEY_ID = 'Bad Site!';
  assert.equal(await code(badSite.gw().createOrder(ORDER)), 'central_not_configured');
  const noKey = adapterWorld();
  delete noKey.env.MNP_CENT_KEY_SECRET;
  assert.equal(await code(noKey.gw().createOrder(ORDER)), 'payee_secret_missing');
  for (const w of [noAddr, badSite, noKey]) assert.equal(w.central.calls.length, 0);
});

test('F10: the address must be the plain https origin of a public host', () => {
  for (const ok of [BASE, `${BASE}/`, 'https://itservices-rajat-agarwal.pages.dev']) assert.equal(checkBaseUrl(ok), new URL(ok).origin);
  for (const bad of [undefined, '', 'not a url', 'http://pay.example.com', 'ftp://pay.example.com', 'https://localhost', 'https://pay.localhost', 'https://10.0.0.5', 'https://127.0.0.1', 'https://[::1]',
    'https://pay.example.com:8443', 'https://user:pw@pay.example.com', 'https://pay.example.com/x', 'https://pay.example.com/?a=1', 'https://pay.example.com/#f',
    'https://metadata.google.internal', 'https://a.nip.io', 'https://intranet', 'https://x.internal']) {
    assert.throws(() => checkBaseUrl(bad), (e) => e.code === 'central_not_configured', String(bad));
  }
});

test('F10: verifyCheckout asks the central service and gives back its facts, never the browser\'s', async () => {
  const a = adapterWorld();
  const o = await a.gw().createOrder(ORDER);
  const proof = a.central.pay(o.gateway_order_id);
  const f = await a.gw().verifyCheckout(proof);
  assert.deepEqual(f, { paid: true, status: 'captured', razorpay_order_id: o.gateway_order_id, razorpay_payment_id: proof.razorpay_payment_id, amount_minor: 500, currency: 'USD', payment_ref: 'ord_aaa111', order_payer_email: 'p1@example.com' });
  const call = a.central.of('/api/pay/credit-verify')[0];
  assert.deepEqual(call.body, { site: MNP_HOST, ...proof });
  assert.equal(call.headers['x-site-key'], a.central.siteKey);
  // safe to ask again
  assert.equal((await a.gw().verifyCheckout(proof)).paid, true);
  // not paid (the gateway says failed): no facts to credit from
  const o2 = await a.gw().createOrder({ ...ORDER, order_id: 'ord_bbb222' });
  assert.deepEqual(await a.gw().verifyCheckout(a.central.pay(o2.gateway_order_id, { status: 'failed' })), { paid: false, status: 'failed' });
  // refusals
  assert.equal(await code(a.gw().verifyCheckout({ ...proof, razorpay_signature: 'f'.repeat(64) })), 'central_proof_refused');
  assert.equal(await code(a.gw().verifyCheckout({ razorpay_order_id: 'order_nobody1', razorpay_payment_id: 'pay_nobody1', razorpay_signature: a.central.sign('order_nobody1', 'pay_nobody1') })), 'central_order_unknown');
  for (const bad of [{ ok: true, paid: true }, { ok: true, paid: 'yes' }, { ok: true, paid: true, amount_minor: 0, currency: 'USD' }]) {
    a.central.state.tweak = () => bad;
    assert.equal(await code(a.gw().verifyCheckout(proof)), 'central_bad_answer');
  }
});

test('F10: health never throws; a central payee has no local webhook proof and no refund call', async () => {
  const a = adapterWorld();
  assert.deepEqual(await a.gw().health(), { ok: true });
  const ping = a.central.of('/api/pay/ping')[0];
  assert.equal(ping.method, 'GET');
  assert.equal(ping.headers['x-site-key'], undefined, 'the liveness call carries no key');
  a.central.state.down = 500;
  assert.deepEqual(await a.gw().health(), { ok: false });
  a.central.state.down = null;
  a.central.state.offline = true;
  assert.deepEqual(await a.gw().health(), { ok: false });
  delete a.env.MNP_CENTRAL_BASE_URL;
  assert.deepEqual(await a.gw().health(), { ok: false });
  assert.deepEqual(await a.gw().verifyWebhook('{}', new Headers()), { ok: false });
  assert.equal(await code(Promise.resolve().then(() => a.gw().verifySignature())), 'central_no_local_proof');
  assert.equal(await code(a.gw().refund()), 'refund_by_central_service');
});

// ---------- the world with a central payee (F11 to F13) ----------
async function world({ baseRail = stubRail } = {}) {
  const s = await setup();
  const central = fakeCentral();
  const env = { MNP_CENTRAL_BASE_URL: BASE, MNP_CENT_KEY_ID: MNP_HOST, MNP_CENT_KEY_SECRET: central.siteKey, MNP_CENT_WEBHOOK_SECRET: `v${hex(10)}` };
  for (const n of Object.values(nm('LEGACY'))) env[n] = `v${hex(10)}`;
  await s.db.run("UPDATE payee_account SET secret_names = ? WHERE payee_id = 'pay_legacy_itservices'", JSON.stringify(nm('LEGACY')));
  const rail = payeeRail(baseRail, { fetch: central.fetch, store: env });
  const ctx = { ...s.ctx(), payees: true, central: true, actor: 'owner', callerType: 'owner', env, rail, fetch: central.fetch };
  const c = await P.createPayee(ctx, { legal_name: 'Central Test Payee', gateway: GATEWAY_NAME, mode: 'test', secret_names: nm('CENT'), currencies: ['INR', 'USD'] });
  await P.activatePayee(ctx, c.payee_id);
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: '*', payee_id: 'pay_legacy_itservices', effective_from: 0, reason: 'default route for tests' });
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: c.payee_id, effective_from: 0, reason: 'bingo goes to the central service' });
  return { s, central, env, ctx, rail, cId: c.payee_id, A: 'pay_legacy_itservices' };
}
const buyAt = (w, product, extra = {}) => buyCredits(w.ctx, { email: 'p1@example.com', credits: 500, order_ref: `r${hex(5)}`, currency: 'USD', product, ...extra });
const orow = (w, id) => w.s.db.first('SELECT * FROM purchase_order WHERE id = ?', id);
const orders = async (w) => (await w.s.db.first('SELECT count(*) n FROM purchase_order')).n;
const confirm = (w, o, proof, extra = {}) => confirmCentralPayment(w.ctx, { order_id: o.order_id, ...proof, ...extra });
const down = (w) => { w.central.state.down = 503; };
const up = (w) => { w.central.state.down = null; };

test('F11: dark: selectRail gives back the very same rail unless BOTH flags are exactly 1 and an HTTP client is given', () => {
  const base = { name: 'old', async createOrder() {}, async health() { return { ok: true }; } };
  const f = async () => {};
  for (const [env, opts] of [[{}, { fetch: f }], [{ MNP_PAYEE_ACCOUNTS: '1' }, { fetch: f }], [{ MNP_CENTRAL_PAY: '1' }, { fetch: f }], [{ MNP_PAYEE_ACCOUNTS: '1', MNP_CENTRAL_PAY: '1' }, {}], [{ MNP_PAYEE_ACCOUNTS: 'true', MNP_CENTRAL_PAY: 'true' }, { fetch: f }]]) {
    assert.equal(selectRail(env, base, opts), base);
  }
  assert.equal(selectRail(undefined, base, { fetch: f }), base);
  const on = selectRail({ MNP_PAYEE_ACCOUNTS: '1', MNP_CENTRAL_PAY: '1' }, base, { fetch: f });
  assert.notEqual(on, base);
  assert.equal(on.name, 'payee_rail');
  assert.equal(on.base, base);
});

test('F11: dark: the central side needs the registry flag AND its own flag', () => {
  assert.equal(centralPayEnabled({}), false);
  assert.equal(centralPayEnabled({ payees: true }), false);
  assert.equal(centralPayEnabled({ central: true }), false);
  assert.equal(centralPayEnabled({ payees: true, central: true }), true);
  assert.equal(centralPayEnabled({ env: { MNP_PAYEE_ACCOUNTS: '1' } }), false);
  assert.equal(centralPayEnabled({ env: { MNP_CENTRAL_PAY: '1' } }), false);
  assert.equal(centralPayEnabled({ env: { MNP_PAYEE_ACCOUNTS: '1', MNP_CENTRAL_PAY: '1' } }), true);
});

test('F12 and F13: dark: with either flag off, confirm and health refuse and make no call', async () => {
  const w = await world();
  const proof = { order_id: 'ord_x', razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'a'.repeat(64) };
  assert.equal(await code(confirmCentralPayment({ ...w.ctx, central: false }, proof)), 'central_disabled');
  assert.equal(await code(confirmCentralPayment({ ...w.ctx, payees: false }, proof)), 'payees_disabled');
  assert.equal(await code(centralHealth({ ...w.ctx, central: false }, w.cId)), 'central_disabled');
  assert.equal(await code(centralHealth({ ...w.ctx, payees: false }, w.cId)), 'payees_disabled');
  assert.equal(w.central.calls.length, 0);
});

test('F11: dark: the wrapper rail keeps the rail contract, and with the flags off nothing is built', async () => {
  assert.deepEqual(await railContract(payeeRail(stubRail, { fetch: async () => { throw new Error('no network'); }, store: {} })), []);
  const w = await world();
  const off = { ...w.ctx, payees: false, central: false, rail: stubRail };
  const o = await buyCredits(off, { email: 'p1@example.com', credits: 500, order_ref: 'plain1', currency: 'USD', product: 'bingo' });
  assert.equal((await orow(w, o.order_id)).payee_id, null);
  assert.ok(o.rail_order_id.startsWith('STUB-ORD-'));
  assert.equal(w.central.calls.length, 0);
});

test('F11: an order of the central payee is opened at the central service; every other order goes to the old rail', async () => {
  const w = await world();
  const o = await buyAt(w, 'bingo', { order_ref: 'central1' });
  const row = await orow(w, o.order_id);
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(row.payee_id, w.cId);
  assert.equal(JSON.parse(row.payee_snapshot).gateway, GATEWAY_NAME);
  assert.equal(JSON.parse(row.payee_snapshot).secret_names, undefined);
  assert.match(row.rail_order_id, /^order_/);
  assert.equal(row.pay_url, null);
  const calls = w.central.of('/api/pay/credit-order');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.payment_ref, o.order_id);
  assert.equal(calls[0].body.amount_minor, row.amount_minor);
  assert.equal(calls[0].body.currency, 'USD');
  assert.equal(calls[0].body.credits, 500);
  assert.equal(calls[0].body.payer_email, 'p1@example.com');
  // a product with the legacy payee never touches the central service
  const other = await buyAt(w, 'other', { order_ref: 'legacy1' });
  assert.ok(other.rail_order_id.startsWith('STUB-ORD-'));
  assert.equal((await orow(w, other.order_id)).payee_id, w.A);
  assert.equal(w.central.of('/api/pay/credit-order').length, 1);
  // the same order reference is the same order, and no second central order is made
  assert.equal((await buyAt(w, 'bingo', { order_ref: 'central1' })).order_id, o.order_id);
  assert.equal(w.central.orders.size, 1);
});

test('F11: the order snapshot decides, not today\'s route: a re-route after the order does not move it', async () => {
  const w = await world();
  down(w);
  const o = await buyAt(w, 'bingo', { order_ref: 'late1' });
  assert.equal(o.status, 'pending_rail'); // the central service was down: the order waits in the outbox
  assert.equal(w.central.of('/api/pay/credit-order').length, 1);
  await R.setRoute(w.ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: w.A, effective_from: w.ctx.now() - 1, reason: 'bingo goes back to the legacy payee' });
  up(w);
  assert.deepEqual(await processRail(w.ctx, w.rail, { orderId: o.order_id }), { sent: 1, failed: 0, dead: 0 });
  const row = await orow(w, o.order_id);
  assert.equal(row.payee_id, w.cId);
  assert.match(row.rail_order_id, /^order_/); // opened at the central service, not at the old rail
  assert.equal(w.central.of('/api/pay/credit-order').length, 2);
  // a new order for the same product now goes to the legacy payee
  assert.equal((await orow(w, (await buyAt(w, 'bingo')).order_id)).payee_id, w.A);
});

test('F11: a central payee\'s order is never opened by a plain rail (the old rail would be the wrong payee)', async () => {
  const w = await world();
  const before = await orders(w);
  // flags off for the rail: a plain rail refuses before anything is written
  assert.equal(await code(buyCredits({ ...w.ctx, rail: stubRail }, { email: 'p1@example.com', credits: 500, order_ref: 'plain2', currency: 'USD', product: 'bingo' })), 'rail_not_configured');
  assert.equal(await orders(w), before);
  // an order that was already made, retried by a plain rail: it waits, it is not sent there
  down(w);
  const o = await buyAt(w, 'bingo', { order_ref: 'wait1' });
  up(w);
  const spy = { ...stubRail, calls: 0, async createOrder() { this.calls++; return { rail_order_id: 'SPY', pay_url: null }; } };
  assert.deepEqual(await processRail(w.ctx, spy, { orderId: o.order_id }), { sent: 0, failed: 1, dead: 0 });
  assert.equal(spy.calls, 0);
  assert.equal((await w.s.db.first('SELECT last_error FROM rail_outbox WHERE order_id = ?', o.order_id)).last_error, 'central_rail_off');
  assert.equal((await orow(w, o.order_id)).status, 'pending_rail');
});

test('F11: with no old rail connected, central orders still work and other orders are refused before anything is written', async () => {
  const w = await world({ baseRail: unconfiguredRail });
  assert.equal((await buyAt(w, 'bingo')).status, 'awaiting_payment');
  const before = await orders(w);
  assert.equal(await code(buyAt(w, 'other')), 'rail_not_configured');
  assert.equal(await orders(w), before);
});

test('F11: a retired payee opens no new order; a paused one still finishes the order it was given', async () => {
  const w = await world();
  down(w);
  const o1 = await buyAt(w, 'bingo', { order_ref: 'p1' });
  const o2 = await buyAt(w, 'bingo', { order_ref: 'p2' });
  up(w);
  await P.pausePayee(w.ctx, w.cId);
  assert.equal((await processRail(w.ctx, w.rail, { orderId: o1.order_id })).sent, 1);
  await P.retirePayee(w.ctx, w.cId);
  const n = w.central.of('/api/pay/credit-order').length;
  assert.deepEqual(await processRail(w.ctx, w.rail, { orderId: o2.order_id }), { sent: 0, failed: 1, dead: 0 });
  assert.equal((await w.s.db.first('SELECT last_error FROM rail_outbox WHERE order_id = ?', o2.order_id)).last_error, 'central_payee_retired');
  assert.equal(w.central.of('/api/pay/credit-order').length, n);
});

test('F11: a central failure at order time is an ordinary rail failure: the order waits, then is opened, and no secret leaks', async () => {
  const w = await world();
  w.central.state.offline = true;
  const o = await buyAt(w, 'bingo', { order_ref: 'net1' });
  assert.equal(o.status, 'pending_rail');
  const job = await w.s.db.first('SELECT * FROM rail_outbox WHERE order_id = ?', o.order_id);
  assert.equal(job.last_error, 'central_unreachable');
  assert.ok(!JSON.stringify(job).includes(w.central.siteKey));
  w.central.state.offline = false;
  assert.equal((await processRail(w.ctx, w.rail, { orderId: o.order_id })).sent, 1);
  assert.equal((await orow(w, o.order_id)).status, 'awaiting_payment');
  assert.equal(w.central.orders.size, 1);
});

test('F12: a verified payment credits once, from the central service\'s facts, to the order\'s own payee', async () => {
  const w = await world();
  const o = await buyAt(w, 'bingo', { order_ref: 'pay1' });
  const row = await orow(w, o.order_id);
  const proof = w.central.pay(row.rail_order_id, { payment_id: 'pay_AbC123XyZ789' });
  // the browser can say anything else it likes: only the proof is read
  const out = await confirm(w, o, proof, { paid_minor: 1, amount: 999999, currency: 'INR', credits: 5 });
  assert.deepEqual(out, { order_id: o.order_id, status: 'paid', credited: 500, paid: true });
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
  const paid = await orow(w, o.order_id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payment_ref, 'pay_abc123xyz789'); // payment ids are kept in lower case
  assert.equal(paid.payee_id, w.cId); // the order's own payee carries the payment: it was never read from today's route
  assert.ok(await w.s.db.first("SELECT 1 x FROM payee_audit WHERE action = 'central.confirmed'"));
  assert.equal((await P.verifyPayeeAudit(w.ctx)).ok, true);
  assert.equal((await verifyChain(w.ctx)).ok, true);
  // the same proof again: nothing more is credited and the central service is not asked again
  const asked = w.central.of('/api/pay/credit-verify').length;
  assert.deepEqual(await confirm(w, o, proof), { order_id: o.order_id, status: 'paid', credited: 500, already: true, paid: true });
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
  assert.equal(w.central.of('/api/pay/credit-verify').length, asked);
  // another payment for the same, already paid order is refused
  const second = w.central.pay(row.rail_order_id, { payment_id: 'pay_second0001' });
  assert.equal(await code(confirm(w, o, second)), 'order_already_paid');
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
});

test('F12: an authorized payment is captured by the central service and then credited; a failed one credits nothing', async () => {
  const w = await world();
  const a = await buyAt(w, 'bingo', { order_ref: 'auth1' });
  const ra = await orow(w, a.order_id);
  assert.equal((await confirm(w, a, w.central.pay(ra.rail_order_id, { status: 'authorized' }))).paid, true);
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
  const f = await buyAt(w, 'bingo', { order_ref: 'fail1' });
  const rf = await orow(w, f.order_id);
  assert.deepEqual(await confirm(w, f, w.central.pay(rf.rail_order_id, { status: 'failed' })), { order_id: f.order_id, status: 'awaiting_payment', paid: false });
  assert.equal((await orow(w, f.order_id)).status, 'awaiting_payment');
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
});

test('F12: refusals: wrong order, not a central order, bad proof, unknown order. Nothing is credited', async () => {
  const w = await world();
  const o1 = await buyAt(w, 'bingo', { order_ref: 'ref1' });
  const o2 = await buyAt(w, 'bingo', { order_ref: 'ref2' });
  const r1 = await orow(w, o1.order_id);
  const r2 = await orow(w, o2.order_id);
  const proof2 = w.central.pay(r2.rail_order_id);
  const asked = () => w.central.of('/api/pay/credit-verify').length;
  // the proof of order 2 offered for order 1
  assert.equal(await code(confirm(w, o1, proof2)), 'order_mismatch');
  assert.equal(asked(), 0, 'refused before any call');
  // not a central order
  const legacy = await buyAt(w, 'other', { order_ref: 'leg1' });
  assert.equal(await code(confirm(w, legacy, proof2)), 'not_central_order');
  // unknown order, and proof that is not even shaped like a signature
  assert.equal(await code(confirmCentralPayment(w.ctx, { order_id: 'ord_nope', ...proof2 })), 'no_order');
  assert.equal(await code(confirm(w, o1, { ...w.central.pay(r1.rail_order_id), razorpay_signature: 'zz' })), 'bad_request');
  assert.equal(await code(confirmCentralPayment(w.ctx, null)), 'bad_request');
  assert.equal(asked(), 0);
  // a signature the central service does not accept
  assert.equal(await code(confirm(w, o1, { ...w.central.pay(r1.rail_order_id), razorpay_signature: 'f'.repeat(64) })), 'central_proof_refused');
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 0);
  assert.equal((await orow(w, o1.order_id)).status, 'awaiting_payment');
});

test('F12: facts that do not name this order, this payment and this person are not believed', async () => {
  const cases = [
    ['another order reference', { payment_ref: 'ord_other' }, 'central_facts_mismatch'],
    ['another person', { order_payer_email: 'someone@else.com' }, 'central_facts_mismatch'],
    ['another gateway order', { razorpay_order_id: 'order_zzz999' }, 'central_facts_mismatch'],
    ['another payment', { razorpay_payment_id: 'pay_other0001' }, 'central_facts_mismatch'],
    ['a short amount', { amount_minor: 499 }, 'payment_mismatch'],
    ['another currency', { currency: 'INR' }, 'payment_mismatch'],
  ];
  for (const [what, change, want] of cases) {
    const w = await world();
    const o = await buyAt(w, 'bingo', { order_ref: 'f1' });
    const proof = w.central.pay((await orow(w, o.order_id)).rail_order_id);
    w.central.state.tweak = (path, j) => (path === '/api/pay/credit-verify' ? { ...j, ...change } : j);
    assert.equal(await code(confirm(w, o, proof)), want, what);
    assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 0, what);
    const row = await orow(w, o.order_id);
    assert.equal(row.status, 'awaiting_payment', what);
    assert.equal(row.payment_ref, null, what);
    assert.ok(!(await w.s.db.first("SELECT 1 x FROM payee_audit WHERE action = 'central.confirmed'")), what);
  }
});

test('F12: more money than the order asked for credits the order only; the extra is flagged', async () => {
  const w = await world();
  const o = await buyAt(w, 'bingo', { order_ref: 'over1' });
  const row = await orow(w, o.order_id);
  w.central.state.tweak = (path, j) => (path === '/api/pay/credit-verify' ? { ...j, amount_minor: row.amount_minor + 250 } : j);
  const out = await confirm(w, o, w.central.pay(row.rail_order_id));
  assert.equal(out.credited, 500);
  assert.equal(out.overpaid_minor, 250);
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
});

test('F12: the payment side\'s own push (/v1/rail/confirm with the purchase key) credits a central order the same way', async () => {
  const w = await world();
  const o = await buyAt(w, 'bingo', { order_ref: 'push1' });
  const row = await orow(w, o.order_id);
  const res = await w.s.pay.post('/v1/rail/confirm', { order_id: o.order_id, payment_ref: 'pay_Push0001', paid_minor: row.amount_minor, currency: 'USD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.credited, 500);
  const paid = await orow(w, o.order_id);
  assert.deepEqual([paid.status, paid.payee_id, paid.payment_ref], ['paid', w.cId, 'pay_push0001']);
  // the browser report for the same payment now finds the order paid with that very payment
  assert.equal((await confirm(w, o, w.central.pay(row.rail_order_id, { payment_id: 'pay_Push0001' }))).already, true);
  assert.equal((await bal(w.s.api, 'p1@example.com')).balance, 500);
});

test('B.1 proof: credits, lots, entries and the chain are identical for a central payment and a legacy payment', async () => {
  const run = async (central) => {
    const w = await world();
    const o = await buyAt(w, central ? 'bingo' : 'other', { order_ref: 'fixed1' });
    const row = await orow(w, o.order_id);
    if (central) await confirm(w, o, w.central.pay(row.rail_order_id, { payment_id: 'pay_same1' }));
    else await railConfirm(w.ctx, { order_id: o.order_id, payment_ref: 'pay_same1', paid_minor: row.amount_minor, currency: 'USD' });
    const strip = (rows) => JSON.stringify(rows.map((x) => { const { id, account_id, created_at, ...rest } = x; return rest; }));
    const lots = strip(await w.s.db.all('SELECT * FROM lot ORDER BY rowid'));
    const entries = (await w.s.db.all('SELECT * FROM entry ORDER BY rowid')).map((e) => [e.kind ?? e.type, e.amount, e.credits].join());
    assert.equal((await verifyChain(w.ctx)).ok, true);
    return { payee: (await orow(w, o.order_id)).payee_id, lots, entries, balance: (await bal(w.s.api, 'p1@example.com')).balance };
  };
  const a = await run(false);
  const b = await run(true);
  assert.notEqual(a.payee, b.payee);
  assert.equal(a.lots, b.lots);
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.balance, b.balance);
});

test('F13: health says present or missing for each secret name and whether the service answers, and never a value', async () => {
  const w = await world();
  const h = await centralHealth(w.ctx, w.cId);
  assert.deepEqual(h, { payee_id: w.cId, gateway: GATEWAY_NAME, status: 'active', mode: 'test', secrets: { key_id: true, key_secret: true, webhook_secret: true }, base_url_ok: true, configured: true, reachable: true });
  const text = JSON.stringify(h);
  for (const v of [w.central.siteKey, w.env.MNP_CENT_WEBHOOK_SECRET, BASE, 'pay.example.com', MNP_HOST]) assert.ok(!text.includes(v));
  assert.equal(w.central.of('/api/pay/ping').length, 1);
  // the service does not answer
  w.central.state.down = 500;
  assert.equal((await centralHealth(w.ctx, w.cId)).reachable, false);
  w.central.state.down = null;
  // a missing secret: no call is made at all
  delete w.env.MNP_CENT_KEY_SECRET;
  const n = w.central.calls.length;
  const miss = await centralHealth(w.ctx, w.cId);
  assert.deepEqual([miss.secrets.key_secret, miss.configured, miss.reachable], [false, false, false]);
  assert.equal(w.central.calls.length, n);
  // a missing or bad address
  w.env.MNP_CENT_KEY_SECRET = w.central.siteKey;
  for (const v of [undefined, 'http://pay.example.com']) {
    if (v === undefined) delete w.env.MNP_CENTRAL_BASE_URL; else w.env.MNP_CENTRAL_BASE_URL = v;
    const r = await centralHealth(w.ctx, w.cId);
    assert.deepEqual([r.base_url_ok, r.configured, r.reachable], [false, false, false]);
  }
  assert.equal(w.central.calls.length, n);
});

test('F13: health is for the owner only and only for a central payee', async () => {
  const w = await world();
  assert.equal(await code(centralHealth({ ...w.ctx, callerType: 'admin' }, w.cId)), 'payee_forbidden');
  assert.equal(await code(centralHealth({ ...w.ctx, actor: 'system' }, w.cId)), 'payee_forbidden');
  assert.equal(await code(centralHealth(w.ctx, w.A)), 'not_central_payee');
  assert.equal(await code(centralHealth(w.ctx, 'pay_nobody')), 'payee_not_found');
  assert.equal(w.central.calls.length, 0);
});

test('F10 to F13: no step of the whole flow leaks the site key, a secret value or the address into an error, an order, an audit row or the outbox', async () => {
  const w = await world();
  const o = await buyAt(w, 'bingo', { order_ref: 'leak1' });
  const row = await orow(w, o.order_id);
  await confirm(w, o, w.central.pay(row.rail_order_id));
  w.central.state.offline = true;
  const e = await caught(confirm(w, await buyAt(w, 'bingo', { order_ref: 'leak2' }), w.central.pay(row.rail_order_id)));
  assert.ok(e);
  noLeak(e, w.central.siteKey, w.env.MNP_CENT_WEBHOOK_SECRET);
  const dump = JSON.stringify({
    orders: await w.s.db.all('SELECT * FROM purchase_order'),
    audit: await w.s.db.all('SELECT * FROM payee_audit'),
    outbox: await w.s.db.all('SELECT * FROM rail_outbox'),
    events: await w.s.db.all('SELECT * FROM outbox'),
    payees: await P.listPayees(w.ctx),
  });
  for (const v of [w.central.siteKey, w.env.MNP_CENT_WEBHOOK_SECRET, ...Object.values(w.env).filter((x) => x !== BASE && x !== MNP_HOST && x.length > 12)]) assert.ok(!dump.includes(v));
});
