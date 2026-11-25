// F5 (owner scope, owner audit view), F6 (owner API routes) and F7 (webhook intake per payee). Dark behind the payee flag. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/api.js';
import * as P from '../src/payees.js';
import * as R from '../src/routes.js';
import { buyCredits } from '../src/gate.js';
import { receivePayeeWebhook } from '../src/webhooks-in.js';
import { stubRail } from '../src/rail.js';
import { hmacHex } from '../src/util.js';

const nm = (x) => ({ key_id: `MNP_${x}_KEY_ID`, key_secret: `MNP_${x}_KEY_SECRET`, webhook_secret: `MNP_${x}_WEBHOOK_SECRET` });
const env = { MNP_PAYEE_ACCOUNTS: '1' };
for (const x of ['LEGACY', 'PB']) for (const [k, n] of Object.entries(nm(x))) env[n] = `value-${x}-${k}-0123456789abcdefXYZ`;
const WH = (x) => env[`MNP_${x}_WEBHOOK_SECRET`];
const A = 'pay_legacy_itservices';
const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

async function world() {
  const s = await setup();
  await s.db.run("UPDATE payee_account SET secret_names = ? WHERE payee_id = ?", JSON.stringify(nm('LEGACY')), A);
  const app = createApp({ db: s.db, master: s.master, now: s.now, env, aiWithoutStatus: true });
  const owner = { ...s.ctx(), payees: true, env, actor: 'owner', callerType: 'owner', rail: stubRail };
  await R.setRoute(owner, { tenant_id: 'demo', product_id: '*', payee_id: A, effective_from: 0, reason: 'default route for tests' });
  return { s, app, owner };
}
// signed owner call, as the HTTP layer expects it
let nn = 0;
async function oc(w, method, path, body, { ts, sign = true } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const t = ts ?? w.s.now();
  const nonce = `n${++nn}`;
  const sig = sign ? await hmacHex(w.s.master, `mnp-owner\n${t}\n${nonce}\n${method}\n${path}\n${raw}`) : 'bad';
  const r = await w.app.fetch(new Request(`http://t.local${path}`, { method, body: method === 'GET' ? undefined : raw, headers: { 'x-owner-ts': String(t), 'x-owner-nonce': nonce, 'x-owner-sig': sig } }));
  return { status: r.status, body: await r.json() };
}
const payeeBody = (x = 'PB', extra = {}) => ({ legal_name: `Payee ${x} Legal`, gateway: 'razorpay', mode: 'test', secret_names: nm(x), currencies: ['INR', 'USD'], ...extra });

// ---------------- F5 ----------------
test('F5: only the owner role may call any payee mutator or the audit view (one check)', async () => {
  const { owner } = await world();
  const b = await P.createPayee(owner, payeeBody());
  const calls = (c) => [
    P.createPayee(c, payeeBody('PC')), P.editPayee(c, b.payee_id, { note: 'x' }), P.activatePayee(c, b.payee_id), P.pausePayee(c, b.payee_id), P.retirePayee(c, b.payee_id),
    R.setRoute(c, { tenant_id: 'demo', product_id: 'p1', payee_id: A, effective_from: 5, reason: 'r' }), P.listPayeeAudit(c), P.verifyPayeeAudit(c),
  ];
  for (const who of [{ callerType: 'human', actor: 'k1' }, { callerType: 'ai', actor: 'k2' }, { callerType: 'product', actor: 'k3' }, { callerType: undefined, actor: 'k4' }, { callerType: 'owner', actor: 'system' }, { callerType: 'owner', actor: '' }]) {
    for (const p of calls({ ...owner, ...who })) assert.equal(await code(p), 'payee_forbidden', JSON.stringify(who));
  }
  assert.equal((await P.listPayees(owner)).find((x) => x.payee_id === b.payee_id).status, 'draft'); // nothing changed
});

test('F5: owner audit view lists newest first, verifies, and detects tampering; flag off is 503', async () => {
  const { s, owner } = await world();
  const t0 = s.now();
  s.clock.t = t0 + 1000;
  const b = await P.createPayee(owner, payeeBody());
  s.clock.t = t0 + 2000;
  await P.editPayee(owner, b.payee_id, { note: 'a note' });
  await P.editPayee(owner, b.payee_id, { note: 'a longer note' }); // same second as the edit before: seq breaks the tie
  const EXPECT_AUDIT = [[4, t0 + 2000, 'payee.edit'], [3, t0 + 2000, 'payee.edit'], [2, t0 + 1000, 'payee.create'], [1, t0, 'route.set']];
  const v = await P.listPayeeAudit(owner, { limit: 10 });
  assert.deepEqual(v.entries.map((e) => [e.seq, e.ts, e.action]), EXPECT_AUDIT); // explicit newest-first list; fails if reversed
  assert.ok(v.entries[0].seq > v.entries[1].seq);
  assert.equal((await P.listPayeeAudit(owner, { limit: 1, before_seq: v.entries[0].seq })).entries.length, 1);
  assert.equal(await code(P.listPayeeAudit(owner, { limit: 0 })), 'bad_field');
  assert.equal(await code(P.listPayeeAudit(owner, { limit: 201 })), 'bad_field');
  assert.equal((await P.verifyPayeeAudit(owner)).ok, true);
  await s.db.run("UPDATE payee_audit SET actor = 'someone-else' WHERE seq = 1");
  assert.deepEqual(await P.verifyPayeeAudit(owner), { ok: false, broken_at: 1 });
  assert.equal(await code(P.listPayeeAudit({ ...owner, payees: false, env: {} })), 'payees_disabled');
});

// ---------------- F6 ----------------
test('F6: owner routes need the master-signed headers; keys of every other class are refused', async () => {
  const w = await world();
  assert.equal((await oc(w, 'GET', '/v1/owner/payees', undefined, { sign: false })).status, 403);
  assert.equal((await oc(w, 'GET', '/v1/owner/payees', undefined, { ts: w.s.now() - 6 * 60000 })).status, 403);
  const ok = await oc(w, 'GET', '/v1/owner/payees');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.payees[0].payee_id, A);
  // a replayed signature is refused
  const raw = '';
  const sig = await hmacHex(w.s.master, `mnp-owner\n${w.s.now()}\nrep1\nGET\n/v1/owner/payees\n${raw}`);
  const h = { 'x-owner-ts': String(w.s.now()), 'x-owner-nonce': 'rep1', 'x-owner-sig': sig };
  assert.equal((await w.app.fetch(new Request('http://t.local/v1/owner/payees', { headers: h }))).status, 200);
  const again = await w.app.fetch(new Request('http://t.local/v1/owner/payees', { headers: h }));
  assert.equal(again.status, 403);
  // tenant keys (admin, ai, spend) cannot reach it
  for (const c of [w.s.admin, w.s.ai, w.s.api]) assert.equal((await c.get('/v1/owner/payees')).status, 403);
  assert.equal((await oc(w, 'GET', '/v1/owner/nothing')).status, 404);
});

test('F6: list, read, create, edit, activate, pause, retire, set route, check secrets, audit: thin handlers, no secret value anywhere', async () => {
  const w = await world();
  const made = await oc(w, 'POST', '/v1/owner/payees', payeeBody());
  assert.equal(made.status, 200);
  const id = made.body.payee.payee_id;
  assert.equal(made.body.payee.status, 'draft');
  assert.equal((await oc(w, 'GET', `/v1/owner/payees/${id}`)).body.payee.legal_name, 'Payee PB Legal');
  assert.equal((await oc(w, 'PUT', `/v1/owner/payees/${id}`, { note: 'fine' })).body.payee.version, 2);
  assert.equal((await oc(w, 'GET', `/v1/owner/payees/${id}/secrets`)).body.ok, true);
  assert.equal((await oc(w, 'POST', `/v1/owner/payees/${id}/activate`, {})).body.payee.status, 'active');
  assert.equal((await oc(w, 'POST', '/v1/owner/routes', { tenant_id: 'demo', product_id: 'p1', payee_id: id, effective_from: 10, reason: 'move p1' })).status, 200);
  assert.equal((await oc(w, 'POST', `/v1/owner/payees/${id}/pause`, {})).body.payee.status, 'paused');
  assert.equal((await oc(w, 'POST', `/v1/owner/payees/${id}/retire`, {})).body.payee.status, 'retired');
  const au = await oc(w, 'GET', '/v1/owner/payee_audit?limit=50');
  assert.ok(['payee.create', 'payee.edit', 'payee.activate', 'route.set', 'payee.pause', 'payee.retire'].every((a) => au.body.entries.some((e) => e.action === a)));
  assert.equal((await oc(w, 'GET', '/v1/owner/payee_audit/verify')).body.ok, true);
  // refusals come as stable codes
  assert.equal((await oc(w, 'POST', '/v1/owner/payees', payeeBody('PB'))).body.error.code, 'payee_exists');
  assert.equal((await oc(w, 'GET', '/v1/owner/payees/pay_nope')).body.error.code, 'payee_not_found');
  assert.equal((await oc(w, 'POST', '/v1/owner/payees', payeeBody('PD', { gateway: 'nope' }))).body.error.code, 'bad_gateway');
  assert.equal((await oc(w, 'GET', '/v1/owner/payee_audit?limit=abc')).body.error.code, 'bad_field');
  // a pasted secret value is refused and never echoed
  const bad = await oc(w, 'POST', '/v1/owner/payees', payeeBody('PE', { secret_names: { ...nm('PE'), key_secret: ['rzp', 'live', 'ABCDEFGHIJKLMNOPQRSTUV'].join('_') } }));
  assert.equal(bad.body.error.code, 'secret_value_refused');
  assert.ok(!JSON.stringify(bad.body).includes('rzp_live_'));
  // nothing anywhere carries a secret value
  const dump = JSON.stringify([await oc(w, 'GET', '/v1/owner/payees'), au, await w.s.db.all('SELECT * FROM payee_audit')]);
  for (const k of Object.keys(env)) if (k !== 'MNP_PAYEE_ACCOUNTS' && k.includes('SECRET') || k.includes('KEY_ID')) assert.ok(!dump.includes(env[k]), k);
});

test('F6: flag off answers payees_disabled; read calls work even while setup is incomplete, changes do not', async () => {
  const w = await world();
  const off = createApp({ db: w.s.db, master: w.s.master, now: w.s.now, aiWithoutStatus: true, env: {} });
  const sig = await hmacHex(w.s.master, `mnp-owner\n${w.s.now()}\noff1\nGET\n/v1/owner/payees\n`);
  const r = await off.fetch(new Request('http://t.local/v1/owner/payees', { headers: { 'x-owner-ts': String(w.s.now()), 'x-owner-nonce': 'off1', 'x-owner-sig': sig } }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'payees_disabled');
  await w.s.db.run("UPDATE payee_account SET secret_names = '{}' WHERE payee_id = ?", A);
  assert.equal((await oc(w, 'GET', '/v1/owner/payees')).status, 200);
  assert.equal((await oc(w, 'GET', `/v1/owner/payees/${A}/secrets`)).status, 200);
  assert.equal((await oc(w, 'GET', '/v1/owner/payee_audit')).status, 200);
  assert.equal((await oc(w, 'POST', '/v1/owner/payees', payeeBody())).body.error.code, 'payee_setup_incomplete');
});

// ---------------- F7 ----------------
const evBody = (type, { order, pay = 'pay_W1', amount, currency = 'USD' }) => JSON.stringify({ event: type, payload: { payment: { entity: { id: pay, order_id: order, amount, currency } } } });
async function hook(w, payeeId, x, raw, eventId, { sign = true } = {}) {
  const sig = sign ? await hmacHex(WH(x), raw) : 'bad';
  const r = await w.app.fetch(new Request(`http://t.local/v1/webhooks/payee/${payeeId}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } }));
  return { status: r.status, body: await r.json() };
}
async function order(w, o = {}) {
  const r = await buyCredits({ ...w.owner }, { email: 'wh@example.com', credits: 500, order_ref: `r${Math.random()}`, currency: 'USD', ...o });
  const row = await w.s.db.first('SELECT * FROM purchase_order WHERE id = ?', r.order_id);
  return row;
}
const status = (w, id) => w.s.db.first('SELECT status, payee_id FROM purchase_order WHERE id = ?', id);
const evs = (w) => w.s.db.all('SELECT payee_id, event_id, outcome, order_id FROM payee_event ORDER BY received_at, event_id');

test('F7: bad signature is 401, unknown payee is 404 with no detail, nothing is credited', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const bad = await hook(w, A, 'LEGACY', raw, 'ev1', { sign: false });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'webhook_bad_signature');
  assert.equal((await status(w, o.id)).status, 'awaiting_payment');
  assert.equal((await evs(w)).length, 0);
  assert.ok((await P.listPayeeAudit(w.owner)).entries.some((e) => e.action === 'webhook.bad_signature'));
  // a signature made with ANOTHER payee's secret is refused too
  const other = await hook(w, A, 'PB', raw, 'ev1');
  assert.equal(other.status, 401);
  const nope = await hook(w, 'pay_unknown', 'LEGACY', raw, 'ev1');
  assert.equal(nope.status, 404);
  assert.deepEqual(Object.keys(nope.body.error).sort(), ['code', 'message']);
});

test('F7: a good event is recorded once; a repeat is a duplicate; a second event for the same payment credits nothing more', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const one = await hook(w, A, 'LEGACY', raw, 'ev1');
  assert.deepEqual([one.status, one.body.result], [200, 'recorded']);
  assert.equal((await status(w, o.id)).status, 'paid');
  assert.equal((await status(w, o.id)).payee_id, A); // the order's own payee, from its snapshot
  assert.equal((await hook(w, A, 'LEGACY', raw, 'ev1')).body.result, 'duplicate');
  const paidAgain = await hook(w, A, 'LEGACY', evBody('order.paid', { order: o.rail_order_id, amount: o.amount_minor }), 'ev2');
  assert.equal(paidAgain.body.result, 'recorded');
  assert.equal((await w.s.db.first("SELECT COUNT(*) n FROM purchase_order WHERE status = 'paid'")).n, 1);
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1); // one credit, not two
  assert.equal((await w.s.db.all('SELECT * FROM payee_event')).length, 2);
});

test('F7: the order snapshot decides: a late payment to the old payee after a switch is credited; the new payee cannot confirm it', async () => {
  const w = await world();
  const b = await P.createPayee(w.owner, payeeBody());
  await P.activatePayee(w.owner, b.payee_id);
  const o = await order(w); // made at A
  assert.equal(o.payee_id, A);
  // the route moves to B and A is paused: new orders go to B
  await P.pausePayee(w.owner, A);
  await R.setRoute(w.owner, { tenant_id: 'demo', product_id: '*', payee_id: b.payee_id, effective_from: w.s.now() + 1000, reason: 'switch to B' });
  w.s.clock.t += 5000;
  assert.equal((await order(w)).payee_id, b.payee_id);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  // B's address, signed by B: the order is A's, so it is ignored and not applied
  const wrong = await hook(w, b.payee_id, 'PB', raw, 'evB');
  assert.deepEqual([wrong.status, wrong.body.result], [200, 'wrong_payee']);
  assert.equal((await status(w, o.id)).status, 'awaiting_payment');
  assert.ok((await w.s.db.all("SELECT 1 FROM outbox WHERE type = 'payee.webhook_wrong_payee'")).length === 1);
  // A's address (A is paused): still accepted, credited
  const right = await hook(w, A, 'LEGACY', raw, 'evA');
  assert.equal(right.body.result, 'recorded');
  assert.equal((await status(w, o.id)).status, 'paid');
  assert.deepEqual((await evs(w)).map((e) => [e.payee_id, e.outcome]).sort(), [[A, 'recorded'], [b.payee_id, 'ignored']].sort());
  // a retired payee still accepts it too
  const o2 = await order(w);
  await P.retirePayee(w.owner, b.payee_id);
  const late = await hook(w, b.payee_id, 'PB', evBody('payment.captured', { order: o2.rail_order_id, pay: 'pay_W9', amount: o2.amount_minor }), 'evR');
  assert.equal(late.body.result, 'recorded');
});

test('F7: unknown order, other event types and bad amounts are stored as ignored and credit nothing', async () => {
  const w = await world();
  const o = await order(w);
  const none = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: 'order_nobody', amount: 5 }), 'e1');
  assert.deepEqual([none.status, none.body.result], [409, 'unmatched_retry']); // inside the grace window: retryable, not final
  w.s.clock.t += 11 * 60000;
  assert.equal((await hook(w, A, 'LEGACY', evBody('payment.captured', { order: 'order_nobody', amount: 5 }), 'e1')).body.result, 'unmatched'); // after it: final
  const refund = await hook(w, A, 'LEGACY', JSON.stringify({ event: 'refund.processed', payload: {} }), 'e2');
  assert.equal(refund.body.result, 'not_applicable');
  const junk = await hook(w, A, 'LEGACY', 'not json', 'e3');
  assert.equal(junk.body.result, 'not_applicable');
  const cur = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor, currency: 'INR' }), 'e5');
  assert.equal(cur.body.result, 'currency_mismatch');
  assert.equal((await status(w, o.id)).status, 'awaiting_payment');
  assert.equal((await w.s.db.first("SELECT COUNT(*) n FROM purchase_order WHERE status = 'paid'")).n, 0);
  assert.deepEqual((await evs(w)).map((e) => e.outcome), ['ignored', 'ignored', 'ignored', 'ignored']);
  assert.equal((await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor }), 'e5')).body.result, 'duplicate'); // a stored permanent refusal is stored once
  // a missing event id is refused
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const r = await w.app.fetch(new Request(`http://t.local/v1/webhooks/payee/${A}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': await hmacHex(WH('LEGACY'), raw) } }));
  assert.equal((await r.json()).error.code, 'webhook_no_event_id');
});

test('F7: a draft payee accepts only test orders; a missing secret is 500 and credits nothing; flag off is 503', async () => {
  const w = await world();
  const d = await P.createPayee(w.owner, payeeBody());
  const o = await order(w);
  const ids = [d.payee_id];
  await w.s.db.run('UPDATE purchase_order SET payee_id = ?, mode = ? WHERE id = ?', d.payee_id, 'live', o.id);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  assert.equal((await hook(w, ids[0], 'PB', raw, 'd1')).body.result, 'draft_payee');
  assert.equal((await status(w, o.id)).status, 'awaiting_payment');
  await w.s.db.run("UPDATE purchase_order SET mode = 'test' WHERE id = ?", o.id);
  assert.equal((await hook(w, ids[0], 'PB', raw, 'd2')).body.result, 'recorded');
  // missing secret
  const o2 = await order(w);
  const gone = createApp({ db: w.s.db, master: w.s.master, now: w.s.now, env: { MNP_PAYEE_ACCOUNTS: '1' }, aiWithoutStatus: true });
  const raw2 = evBody('payment.captured', { order: o2.rail_order_id, pay: 'pay_W2', amount: o2.amount_minor });
  const r = await gone.fetch(new Request(`http://t.local/v1/webhooks/payee/${A}`, { method: 'POST', body: raw2, headers: { 'x-razorpay-signature': await hmacHex(WH('LEGACY'), raw2), 'x-razorpay-event-id': 'm1' } }));
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error.code, 'payee_secret_missing');
  assert.equal((await status(w, o2.id)).status, 'awaiting_payment');
  // flag off
  const off = await receivePayeeWebhook({ db: w.s.db, now: w.s.now, env: {} }, A, raw2, new Headers()).catch((e) => e);
  assert.equal(off.code, 'payees_disabled');
});

// ---------------- round 5 ----------------
test('R5-1: a transient refusal is 409 and not stored; the retry succeeds. A permanent refusal is stored once', async () => {
  const w = await world();
  const o = await order(w);
  const short = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor - 1 }), 't1');
  assert.deepEqual([short.status, short.body.result, short.body.ok], [409, 'payment_mismatch', false]);
  assert.equal((await evs(w)).length, 0);
  const retry = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor }), 't1');
  assert.deepEqual([retry.status, retry.body.result], [200, 'recorded']);
  // order not yet awaiting_payment
  const o2 = await order(w);
  await w.s.db.run("UPDATE purchase_order SET status = 'pending_rail' WHERE id = ?", o2.id);
  const raw2 = evBody('payment.captured', { order: o2.rail_order_id, pay: 'pay_W7', amount: o2.amount_minor });
  assert.equal((await hook(w, A, 'LEGACY', raw2, 't2')).status, 409);
  await w.s.db.run("UPDATE purchase_order SET status = 'awaiting_payment' WHERE id = ?", o2.id);
  assert.equal((await hook(w, A, 'LEGACY', raw2, 't2')).body.result, 'recorded');
  // permanent: currency, stored once
  const o3 = await order(w);
  const bad = evBody('payment.captured', { order: o3.rail_order_id, pay: 'pay_W8', amount: o3.amount_minor, currency: 'INR' });
  assert.equal((await hook(w, A, 'LEGACY', bad, 't3')).status, 200);
  assert.equal((await hook(w, A, 'LEGACY', bad, 't3')).body.result, 'duplicate');
  assert.equal((await w.s.db.all("SELECT 1 FROM payee_event WHERE event_id = 't3'")).length, 1);
});

test('R5-2: order lookup is filtered by payee in the SQL: two tenants sharing a rail order id', async () => {
  const w = await world();
  const o = await order(w);
  await w.s.db.run("INSERT INTO tenant (id, name, status, created_at) SELECT 'other', 'other', status, created_at FROM tenant WHERE id = 'demo'").catch(() => {});
  const t2 = await w.s.db.first("SELECT id FROM tenant WHERE id != 'demo' LIMIT 1");
  assert.ok(t2, 'second tenant exists');
  // a second order of another tenant and another payee shares the same gateway order id
  const b = await P.createPayee(w.owner, payeeBody());
  const acc = await w.s.db.first('SELECT account_id FROM purchase_order WHERE id = ?', o.id);
  const cols = Object.keys(o);
  const copy = { ...o, id: 'ord_other', tenant_id: t2.id, order_ref: 'x-other', payee_id: b.payee_id, account_id: acc.account_id };
  await w.s.db.run(`INSERT INTO purchase_order (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => copy[c]));
  const r = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor }), 'x1');
  assert.equal(r.body.result, 'recorded');
  assert.equal((await status(w, o.id)).status, 'paid');
  assert.equal((await w.s.db.first("SELECT status FROM purchase_order WHERE id = 'ord_other'")).status, 'awaiting_payment'); // the other tenant's order is untouched
  // the same payee and the same gateway order id in two tenants: nothing is applied, the owner must look
  const o4 = await order(w);
  const c4 = { ...o4, id: 'ord_dup', tenant_id: t2.id, order_ref: 'x-dup', account_id: acc.account_id };
  await w.s.db.run(`INSERT INTO purchase_order (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => c4[c]));
  const amb = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o4.rail_order_id, pay: 'pay_W5', amount: o4.amount_minor }), 'x2');
  assert.equal(amb.body.result, 'ambiguous_order');
  assert.equal((await status(w, o4.id)).status, 'awaiting_payment');
});

test('R5-3: a draft payee with an order that has no snapshot (mode null) refuses for good', async () => {
  const w = await world();
  const d = await P.createPayee(w.owner, payeeBody());
  const o = await order(w);
  await w.s.db.run('UPDATE purchase_order SET payee_id = ?, mode = NULL WHERE id = ?', d.payee_id, o.id);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const r = await hook(w, d.payee_id, 'PB', raw, 'n1');
  assert.deepEqual([r.status, r.body.result], [200, 'draft_payee']);
  assert.equal((await status(w, o.id)).status, 'awaiting_payment');
  assert.equal((await hook(w, d.payee_id, 'PB', raw, 'n1')).body.result, 'duplicate');
});

test('R5-4: 100 bad signatures write one audit row per minute and are rate limited', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const codes = [];
  for (let i = 0; i < 100; i++) codes.push((await hook(w, A, 'LEGACY', raw, `b${i}`, { sign: false })).status);
  assert.equal(codes.filter((c) => c === 401).length, 20);
  assert.equal(codes.filter((c) => c === 429).length, 80);
  const rows = () => w.s.db.all("SELECT detail FROM payee_audit WHERE action = 'webhook.bad_signature'");
  assert.equal((await rows()).length, 1);
  // a good call still works during the flood
  assert.equal((await hook(w, A, 'LEGACY', raw, 'good')).body.result, 'recorded');
  // next minute: one more row, and it carries the count of the minute before
  w.s.clock.t += 60000;
  assert.equal((await hook(w, A, 'LEGACY', raw, 'b-next', { sign: false })).status, 401);
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(JSON.parse(all[1].detail).previous_minute_count, 100);
});

test('R5-5: owner nonces older than the window are pruned and the owner key is rate limited per minute', async () => {
  const w = await world();
  await w.s.db.run("INSERT INTO nonce (key_id, nonce, ts) VALUES ('owner', 'ancient', ?)", w.s.now() - 6 * 60000);
  await w.s.db.run("INSERT INTO nonce (key_id, nonce, ts) VALUES ('owner', 'recent', ?)", w.s.now() - 60000);
  assert.equal((await oc(w, 'GET', '/v1/owner/payees')).status, 200);
  const left = (await w.s.db.all("SELECT nonce FROM nonce WHERE key_id = 'owner'")).map((r) => r.nonce);
  assert.ok(!left.includes('ancient') && left.includes('recent'));
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await oc(w, 'GET', '/v1/owner/payees')).status === 429) limited++;
  assert.ok(limited >= 10);
  w.s.clock.t += 60000; // next minute: allowed again
  assert.equal((await oc(w, 'GET', '/v1/owner/payees')).status, 200);
});
