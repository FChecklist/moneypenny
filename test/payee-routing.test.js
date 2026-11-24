// F3 (routing and order snapshot) and F4 (gateway adapters). Dark behind the payee flag. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, DAY } from './helpers.js';
import * as P from '../src/payees.js';
import * as R from '../src/routes.js';
import { buyCredits, railConfirm } from '../src/gate.js';
import { paymentNotice } from '../src/wallet.js';
import { stubRail } from '../src/rail.js';
import { gatewayFor } from '../src/gateways/index.js';
import { fakeGateway } from '../src/gateways/fake.js';
import { makeSecretReader } from '../src/secrets.js';
import { hmacHex } from '../src/util.js';
import { verifyChain } from '../src/ledger.js';

const nm = (x) => ({ key_id: `MNP_${x}_KEY_ID`, key_secret: `MNP_${x}_KEY_SECRET`, webhook_secret: `MNP_${x}_WEBHOOK_SECRET` });
const env = {};
for (const x of ['LEGACY', 'PB']) for (const [k, n] of Object.entries(nm(x))) env[n] = `value-${x}-${k}-0123456789abcdefXYZ`;
const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

async function world() {
  const s = await setup();
  await s.db.run("UPDATE payee_account SET secret_names = ? WHERE payee_id = 'pay_legacy_itservices'", JSON.stringify(nm('LEGACY')));
  const ctx = { ...s.ctx(), payees: true, actor: 'owner', callerType: 'owner', env, rail: stubRail };
  return { s, ctx };
}
async function two() {
  const { s, ctx } = await world();
  const b = await P.createPayee(ctx, { legal_name: 'Payee B Legal', gateway: 'stripe', mode: 'live', secret_names: nm('PB'), currencies: ['INR', 'USD'] });
  await P.activatePayee(ctx, b.payee_id);
  // a tenant made after the migration has no '*' route yet: the owner sets one
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: '*', payee_id: 'pay_legacy_itservices', effective_from: 0, reason: 'default route for tests' });
  return { s, ctx, bId: b.payee_id, A: 'pay_legacy_itservices' };
}
const buy = (ctx, o = {}) => buyCredits(ctx, { email: 'p1@example.com', credits: 500, order_ref: `r${Math.random()}`, currency: 'USD', ...o });
const row = (s, id) => s.db.first('SELECT * FROM purchase_order WHERE id = ?', id);

test('F3: flag off is dark: no payee written, no refusal', async () => {
  const s = await setup();
  const o = await buyCredits({ ...s.ctx(), rail: stubRail }, { email: 'p1@example.com', credits: 500, order_ref: 'x1', currency: 'USD' });
  assert.equal((await row(s, o.order_id)).payee_id, null);
  assert.equal(await code(R.resolvePayee(s.ctx(), { currency: 'USD' })), 'payees_disabled');
});

test('F3: product route, default route, snapshot on the order', async () => {
  const { s, ctx, bId, A } = await two();
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: bId, effective_from: 0, reason: 'bingo goes to B' });
  const o1 = await buy(ctx, { product: 'bingo' });
  const r1 = await row(s, o1.order_id);
  assert.equal(r1.payee_id, bId);
  assert.equal(r1.product, 'bingo');
  assert.equal(r1.mode, 'live');
  assert.equal(r1.payee_version, 2);
  assert.ok(r1.route_id);
  assert.equal(JSON.parse(r1.payee_snapshot).display_name, 'Payee B Legal');
  assert.equal(JSON.parse(r1.payee_snapshot).secret_names, undefined);
  const o2 = await buy(ctx, { product: 'other' });
  assert.equal((await row(s, o2.order_id)).payee_id, A); // '*' route from the migration
  const o3 = await buy(ctx);
  assert.equal((await row(s, o3.order_id)).product, '*');
});

test('F3: re-map never changes an old order; same order_ref returns the first payee', async () => {
  const { s, ctx, bId, A } = await two();
  const o = await buy(ctx, { order_ref: 'same1', product: 'bingo' });
  assert.equal((await row(s, o.order_id)).payee_id, A);
  const snap = (await row(s, o.order_id)).payee_snapshot;
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: bId, effective_from: ctx.now() - 1, reason: 'move bingo to B' });
  await P.editPayee(ctx, A, { display_name: 'Renamed Legacy' });
  const again = await buy(ctx, { order_ref: 'same1', product: 'bingo' });
  assert.equal(again.order_id, o.order_id);
  const r = await row(s, o.order_id);
  assert.equal(r.payee_id, A);
  assert.equal(r.payee_snapshot, snap);
  assert.equal((await row(s, (await buy(ctx, { product: 'bingo' })).order_id)).payee_id, bId);
});

test('F3: refusals: no route, paused with and without fallback, currency, unknown product, overlap, not active', async () => {
  const { s, ctx, bId, A } = await two();
  await s.db.run("DELETE FROM payee_route WHERE tenant_id = 'demo'");
  assert.equal(await code(buy(ctx)), 'no_route');
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: bId, effective_from: 0, reason: 'bingo goes to B', fallback_payee_id: A });
  await P.pausePayee(ctx, bId);
  const o = await buy(ctx, { product: 'bingo' });
  assert.equal((await row(s, o.order_id)).payee_id, A); // fallback
  assert.ok(await s.db.first("SELECT 1 x FROM payee_audit WHERE action = 'route.fallback_used'"));
  assert.ok(await s.db.first("SELECT 1 x FROM outbox WHERE type = 'payee.fallback_used'"));
  await P.pausePayee(ctx, A);
  assert.equal(await code(buy(ctx, { product: 'bingo' })), 'payee_unavailable');
  assert.equal(await code(buy(ctx, { product: 'Bad Product' })), 'bad_product');
  await P.activatePayee(ctx, A);
  assert.equal(await code(R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: A, effective_from: 0, reason: 'overlap try one' })), 'route_overlap');
  assert.equal(await code(R.setRoute(ctx, { tenant_id: 'demo', product_id: 'xx', payee_id: bId, effective_from: 5, reason: 'paused payee try' })), 'payee_not_active');
  assert.equal(await code(R.setRoute({ ...ctx, callerType: 'admin' }, { tenant_id: 'demo', product_id: 'x', payee_id: A, effective_from: 5, reason: 'not the owner' })), 'payee_forbidden');
});

test('F3: currency the payee does not take is refused', async () => {
  const { s, ctx } = await two();
  await s.db.run("UPDATE payee_account SET currencies = '[\"USD\"]' WHERE payee_id = 'pay_legacy_itservices'");
  assert.equal(await code(buy(ctx, { currency: 'INR' })), 'currency_unsupported');
});

test('F3: route changes and payee confirm write audit rows; verified payment gets the order payee', async () => {
  const { s, ctx, bId } = await two();
  await R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: bId, effective_from: 0, reason: 'bingo goes to B' });
  assert.ok(await s.db.first("SELECT 1 x FROM payee_audit WHERE action = 'route.set'"));
  const o = await buy(ctx, { product: 'bingo' });
  await paymentNotice(ctx, { payment_ref: 'pay_abc123', paid_minor: (await row(s, o.order_id)).amount_minor, currency: 'USD', payer_email: 'p1@example.com' });
  await railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_abc123', paid_minor: (await row(s, o.order_id)).amount_minor, currency: 'USD' });
  assert.equal((await s.db.first("SELECT payee_id FROM verified_payment WHERE ref = 'pay_abc123'")).payee_id, bId);
});

test('B.1 proof: credits, balances, lots and the chain are identical under payee A and payee B', async () => {
  const run = async (product) => {
    const { s, ctx, bId } = await two();
    await R.setRoute(ctx, { tenant_id: 'demo', product_id: 'bingo', payee_id: bId, effective_from: 0, reason: 'bingo goes to B' });
    const o = await buy(ctx, { order_ref: 'fixed1', product });
    const r = await row(s, o.order_id);
    await railConfirm(ctx, { order_id: o.order_id, payment_ref: 'pay_same1', paid_minor: r.amount_minor, currency: 'USD' });
    const strip = (rows) => JSON.stringify(rows.map((x) => { const { id, account_id, created_at, ...rest } = x; return rest; }));
    const lots = strip(await s.db.all('SELECT * FROM lot ORDER BY rowid'));
    const entries = (await s.db.all('SELECT * FROM entry ORDER BY rowid')).map((e) => [e.kind ?? e.type, e.amount, e.credits].join());
    assert.equal((await verifyChain(ctx)).ok, true);
    return { payee: r.payee_id, lots, entries };
  };
  const a = await run('other');
  const b = await run('bingo');
  assert.notEqual(a.payee, b.payee);
  assert.equal(a.lots, b.lots);
  assert.deepEqual(a.entries, b.entries);
});

test('F4: registry refuses an unknown gateway; no fetch means no adapter', () => {
  const reader = makeSecretReader(env);
  assert.throws(() => gatewayFor({ gateway: 'stripe' }, { reader, fetch: async () => {} }), (e) => e.code === 'gateway_unsupported');
  assert.throws(() => gatewayFor({ gateway: 'razorpay', secret_names: nm('PB') }, { reader }), (e) => e.code === 'gateway_not_configured');
});

const rzp = (calls, res = { ok: true, status: 200, json: { id: 'order_X1', amount: 500, currency: 'INR' } }) =>
  gatewayFor({ gateway: 'razorpay', secret_names: nm('PB') }, { reader: makeSecretReader(env), fetch: async (url, o) => { calls.push({ url, o }); return { ok: res.ok, status: res.status, json: async () => res.json }; } });

test('F4: razorpay create order, refund, signature (right and wrong); secrets read by name', async () => {
  const calls = [];
  const g = rzp(calls);
  const o = await g.createOrder({ order_id: 'ord_1', amount_minor: 500, currency: 'INR' });
  assert.equal(o.gateway_order_id, 'order_X1');
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/orders');
  assert.equal(calls[0].o.headers.authorization, `Basic ${btoa(`${env.MNP_PB_KEY_ID}:${env.MNP_PB_KEY_SECRET}`)}`);
  assert.equal(JSON.parse(calls[0].o.body).receipt, 'ord_1');
  const good = await hmacHex(env.MNP_PB_KEY_SECRET, 'order_X1|pay_9');
  assert.equal(await g.verifySignature({ order_id: 'order_X1', payment_id: 'pay_9', signature: good }), true);
  assert.equal(await g.verifySignature({ order_id: 'order_X1', payment_id: 'pay_9', signature: good.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }), false);
  assert.equal(await g.verifySignature({ order_id: 'order_X1', payment_id: 'pay_9' }), false);
  const calls2 = [];
  const rf = await rzp(calls2, { ok: true, status: 200, json: { id: 'rfnd_1', amount: 200 } }).refund({ payment_id: 'pay_9', amount_minor: 200, idem: 'k1' });
  assert.equal(rf.refund_id, 'rfnd_1');
  assert.equal(calls2[0].url, 'https://api.razorpay.com/v1/payments/pay_9/refund');
});

test('F4: errors never carry a secret value; missing secret names the NAME only', async () => {
  const g = rzp([], { ok: false, status: 401, json: { error: { description: `bad key ${env.MNP_PB_KEY_SECRET}` } } });
  const e = await g.createOrder({ order_id: 'o', amount_minor: 1, currency: 'INR' }).catch((x) => x);
  assert.equal(e.code, 'gateway_error');
  for (const v of Object.values(env)) assert.ok(!JSON.stringify({ m: e.message, c: e.code, d: e.details }).includes(v));
  const none = gatewayFor({ gateway: 'razorpay', secret_names: nm('PB') }, { reader: makeSecretReader({}), fetch: async () => { throw new Error(`boom ${env.MNP_PB_KEY_SECRET}`); } });
  const m = await none.createOrder({ order_id: 'o', amount_minor: 1, currency: 'INR' }).catch((x) => x);
  assert.equal(m.code, 'payee_secret_missing');
  assert.ok(m.message.includes('MNP_PB_KEY_ID'));
  const net = await gatewayFor({ gateway: 'razorpay', secret_names: nm('PB') }, { reader: makeSecretReader(env), fetch: async () => { throw new Error(`boom ${env.MNP_PB_KEY_SECRET}`); } }).createOrder({ order_id: 'o', amount_minor: 1, currency: 'INR' }).catch((x) => x);
  assert.equal(net.code, 'gateway_error');
  assert.ok(!net.message.includes(env.MNP_PB_KEY_SECRET));
  assert.equal(makeSecretReader(env).get('lowercase'), undefined);
});

test('F4: fake gateway repeats are safe and signature check works', async () => {
  const f = fakeGateway({ secrets: { key_id: 'k', key_secret: 's' } });
  const a = await f.createOrder({ order_id: 'o1', amount_minor: 5, currency: 'INR' });
  assert.equal((await f.createOrder({ order_id: 'o1', amount_minor: 5, currency: 'INR' })).gateway_order_id, a.gateway_order_id);
  assert.equal(await f.verifySignature({ order_id: 'a', payment_id: 'b', signature: await hmacHex('s', 'a|b') }), true);
  assert.equal(await f.verifySignature({ order_id: 'a', payment_id: 'b', signature: 'x' }), false);
  assert.deepEqual(await f.refund({ payment_id: 'p', amount_minor: 1, idem: 'i' }), await f.refund({ payment_id: 'p', amount_minor: 1, idem: 'i' }));
});
