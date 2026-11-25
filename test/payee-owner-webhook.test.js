// F5 (owner scope, owner audit view), F6 (owner API routes) and F7 (webhook intake per payee). Dark behind the payee flag. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/api.js';
import * as P from '../src/payees.js';
import * as R from '../src/routes.js';
import { buyCredits, expireOrders } from '../src/gate.js';
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
async function oc(w, method, path, body, { ts, sign = true, nonce: given } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const t = ts ?? w.s.now();
  const nonce = given ?? `n${++nn}`;
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
async function hook(w, payeeId, x, raw, eventId, { sign = true, source } = {}) {
  const sig = sign ? await hmacHex(WH(x), raw) : '0'.repeat(64); // wrong but well formed
  const r = await w.app.fetch(new Request(`http://t.local/v1/webhooks/payee/${payeeId}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId, ...(source ? { 'cf-connecting-ip': source } : {}) } }));
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
  assert.equal(paidAgain.body.result, 'duplicate'); // round 7: the same payment again is a duplicate, not a second recording
  assert.equal((await w.s.db.first("SELECT COUNT(*) n FROM purchase_order WHERE status = 'paid'")).n, 1);
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1); // one credit, not two
  assert.equal((await w.s.db.all('SELECT * FROM payee_event')).length, 1); // and nothing new is stored
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

test('R5-5: owner nonces older than the keep time are pruned and the owner key is rate limited per minute', async () => {
  const w = await world();
  const { OWNER_NONCE_KEEP_MS } = await import('../src/api.js'); // no default: a missing export must fail here, not pass on a made-up value
  assert.ok(Number.isFinite(OWNER_NONCE_KEEP_MS) && OWNER_NONCE_KEEP_MS > 0, 'OWNER_NONCE_KEEP_MS is not exported by src/api.js');
  await w.s.db.run("INSERT INTO nonce (key_id, nonce, ts) VALUES ('owner', 'ancient', ?)", w.s.now() - OWNER_NONCE_KEEP_MS - 1000);
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

// ---------------- round 6 ----------------
test('R6-1: nested transactions join the outer one; a failure in the outer rolls back the audit row too', async () => {
  const w = await world();
  const n0 = (await w.s.db.first('SELECT COUNT(*) n FROM payee_audit')).n;
  const err = await w.s.db.tx(async (db) => {
    await P.chainRow({ ...w.owner, db }, db, 'test.nested', () => ({ x: 1 }));
    assert.equal((await db.first('SELECT COUNT(*) n FROM payee_audit')).n, n0 + 1); // visible inside the outer transaction
    throw new Error('outer fails');
  }).catch((e) => e);
  assert.equal(err.message, 'outer fails');
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM payee_audit')).n, n0); // the inner audit row was undone with it
  await w.s.db.tx((db) => P.chainRow({ ...w.owner, db }, db, 'test.nested', () => ({ x: 2 })));
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM payee_audit')).n, n0 + 1); // and it commits with the outer one
  assert.equal((await P.verifyPayeeAudit(w.owner)).ok, true);
});

test('R6-3: currency mismatch and an already paid order are final (200, stored once); underpay and not-yet-awaiting are 409 and not stored', async () => {
  const w = await world();
  const o = await order(w);
  const cur = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor, currency: 'INR' }), 'c1');
  assert.deepEqual([cur.status, cur.body.result], [200, 'currency_mismatch']);
  assert.equal((await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor, currency: 'INR' }), 'c1')).body.result, 'duplicate');
  const under = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor - 1 }), 'u1');
  assert.deepEqual([under.status, under.body.result], [409, 'payment_mismatch']);
  assert.equal((await w.s.db.all("SELECT 1 FROM payee_event WHERE event_id = 'u1'")).length, 0);
  const o2 = await order(w);
  await w.s.db.run("UPDATE purchase_order SET status = 'pending_rail' WHERE id = ?", o2.id);
  assert.equal((await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o2.rail_order_id, pay: 'pay_N', amount: o2.amount_minor }), 'n1')).status, 409);
  assert.equal((await w.s.db.all("SELECT 1 FROM payee_event WHERE event_id = 'n1'")).length, 0);
  // paid first, then another payment id for the same order: final
  assert.equal((await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor }), 'p1')).body.result, 'recorded');
  const again = evBody('payment.captured', { order: o.rail_order_id, pay: 'pay_OTHER', amount: o.amount_minor });
  const paid = await hook(w, A, 'LEGACY', again, 'p2');
  assert.deepEqual([paid.status, paid.body.result], [200, 'order_already_paid']);
  assert.equal((await hook(w, A, 'LEGACY', again, 'p2')).body.result, 'duplicate');
  assert.equal((await w.s.db.all("SELECT 1 FROM payee_event WHERE event_id = 'p2'")).length, 1);
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1);
});

test('R6-4: two confirms for one order with different payment ids: the guarded update lets only one credit', async () => {
  const w = await world();
  const o = await order(w);
  const stale = { ...o }; // what a concurrent reader saw before the other confirm committed
  const { railConfirm } = await import('../src/gate.js');
  const c = { ...w.owner, tenantId: o.tenant_id };
  await railConfirm(c, { order_id: o.id, payment_ref: 'pay_one', paid_minor: o.amount_minor, currency: o.currency });
  const db2 = new Proxy(w.s.db, { get: (t, k) => (k === 'first' ? async (sql, ...p) => (/FROM purchase_order WHERE tenant_id = \? AND id = \?/.test(sql) ? stale : t.first(sql, ...p)) : t[k]) });
  assert.equal(await code(railConfirm({ ...c, db: db2 }, { order_id: o.id, payment_ref: 'pay_two', paid_minor: o.amount_minor, currency: o.currency })), 'order_already_paid');
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1);
  assert.equal((await w.s.db.first('SELECT payment_ref FROM purchase_order WHERE id = ?', o.id)).payment_ref, 'pay_one');
});

test('R6-5: missing or malformed signature is 401 before any HMAC or write; unknown payee writes nothing', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const count = async () => JSON.stringify([(await w.s.db.first('SELECT COUNT(*) n FROM payee_audit')).n, (await w.s.db.first("SELECT COUNT(*) n FROM rate_limit WHERE key_id LIKE 'whbad:%'")).n, (await w.s.db.first('SELECT COUNT(*) n FROM payee_event')).n]);
  const before = await count();
  for (const hdr of [{}, { 'x-razorpay-signature': '' }, { 'x-razorpay-signature': 'zz' }, { 'x-razorpay-signature': 'a'.repeat(63) }]) {
    const r = await w.app.fetch(new Request(`http://t.local/v1/webhooks/payee/${A}`, { method: 'POST', body: raw, headers: { ...hdr, 'x-razorpay-event-id': 'q1' } }));
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'webhook_bad_signature');
  }
  assert.equal(await count(), before);
  assert.equal((await hook(w, 'pay_unknown', 'LEGACY', raw, 'q2')).status, 404);
  assert.equal(await count(), before);
});

test('R6-6: owner ops list the refusal codes and the webhook entry documents 409 retry and 429', async () => {
  const { OWNER_OPS, OPS } = await import('../src/contract.js');
  for (const op of OWNER_OPS.filter((o) => o.level === 'owner')) for (const c of ['rate_limited', 'bad_json', 'replayed', 'forbidden']) assert.ok(op.errors.includes(c), `${op.id} lacks ${c}`);
  assert.ok(OWNER_OPS.find((o) => o.id === 'ownerPayeeStep').errors.includes('bad_transition'));
  assert.ok(OWNER_OPS.find((o) => o.id === 'ownerPayeeStep').errors.includes('payee_gateway_taken'));
  assert.ok(OWNER_OPS.find((o) => o.id === 'ownerGetPayee').errors.includes('not_found'));
  const wh = OWNER_OPS.find((o) => o.id === 'payeeWebhook') || OPS.find((o) => o.id === 'payeeWebhook');
  assert.ok(wh.errors.includes('rate_limited'));
  assert.match(wh.plain, /409/);
  assert.match(wh.plain, /not stored/);
  const { buildContract } = await import('../scripts/gen-contract.js');
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(new URL('../contract/v1/openapi.json', import.meta.url), 'utf8')), JSON.parse(JSON.stringify(buildContract())));
});

test('R6-2: a refused owner call has used its nonce; the same signed call again is replayed, a fresh nonce works', async () => {
  const w = await world();
  const path = '/v1/owner/payees/pay_nope';
  const t = w.s.now(), nonce = 'refused-once';
  const sig = await hmacHex(w.s.master, `mnp-owner\n${t}\n${nonce}\nGET\n${path}\n`);
  const call = () => w.app.fetch(new Request(`http://t.local${path}`, { headers: { 'x-owner-ts': String(t), 'x-owner-nonce': nonce, 'x-owner-sig': sig } }));
  assert.equal((await (await call()).json()).error.code, 'payee_not_found'); // refused after the nonce was taken
  const again = await call();
  assert.equal(again.status, 403);
  assert.equal((await again.json()).error.code, 'replayed');
});

// ---------------- round 7 ----------------
// A database fault that fires only AFTER the guarded paid update: the trigger needs the order to be 'paid' already, so a fault that
// fires proves the order of work (paid update first, credit second) and that the throw came from the credit step.
const arm = (w, orderId) => w.s.db.exec(`CREATE TRIGGER fault_after_paid BEFORE INSERT ON lot WHEN (SELECT status FROM purchase_order WHERE id = '${orderId}') = 'paid' BEGIN SELECT RAISE(ABORT, 'injected fault after the paid update'); END`);
const disarm = (w) => w.s.db.exec('DROP TRIGGER IF EXISTS fault_after_paid');
const quiet = async (fn) => { const keep = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = keep; } };
const COUNTED = ['lot', 'entry', 'payment_ref', 'verified_payment', 'idempotency', 'outbox', 'audit_log', 'payee_event', 'payee_audit'];
const counts = async (w) => JSON.stringify(await Promise.all(COUNTED.map(async (t) => (await w.s.db.first(`SELECT COUNT(*) n FROM ${t}`)).n)));

test('R7-1: when creditPurchase throws AFTER the guarded paid update, the order is not left paid and no credit exists (confirm route and webhook)', async () => {
  const w = await world();
  const { s } = w;
  const mk = async (ref) => (await s.api.post('/v1/buy_credits', { email: 'rb@example.com', credits: 500, currency: 'USD', order_ref: ref })).body;
  const row = async (id) => ({ ...(await s.db.first('SELECT status, payment_ref, paid_minor FROM purchase_order WHERE id = ?', id)) });
  const lots = async (ref) => (await s.db.first('SELECT COUNT(*) n FROM lot WHERE source_ref = ?', ref)).n;
  const confirm = (o, ref) => s.pay.post('/v1/rail/confirm', { order_id: o.order_id, payment_ref: ref, paid_minor: o.amount_minor, currency: 'USD' }, { idem: `key-${ref}` });
  const { railConfirm } = await import('../src/gate.js');

  // A. The control. The same fault WITHOUT the route's transaction leaves the order paid and no credit: the state the route must never leave behind.
  const c = await mk('rb-control');
  arm(w, c.order_id);
  const hurt = await railConfirm({ ...s.ctx(), callerType: 'payment' }, { order_id: c.order_id, payment_ref: 'pay_rb_control', paid_minor: c.amount_minor, currency: 'USD' }).catch((e) => e);
  assert.match(String(hurt.message), /injected fault/);
  assert.equal((await row(c.order_id)).status, 'paid');
  assert.equal(await lots('pay_rb_control'), 0);
  disarm(w);

  // B. The confirm route: the throw comes after the paid update, and the route's transaction undoes everything.
  const o = await mk('rb-route');
  arm(w, o.order_id);
  const before = await counts(w);
  const r = await quiet(() => confirm(o, 'pay_rb_route'));
  assert.deepEqual([r.status, r.body.error.code], [500, 'internal']);
  assert.deepEqual(await row(o.order_id), { status: 'awaiting_payment', payment_ref: null, paid_minor: null });
  assert.equal(await lots('pay_rb_route'), 0);
  assert.equal(await counts(w), before); // no credit, no payment claim, no event, no idempotency record: nothing at all
  assert.equal((await s.api.get('/v1/balance?email=rb%40example.com')).body.balance, 0);
  disarm(w);
  const ok = await confirm(o, 'pay_rb_route'); // same key again: the failed call left no trace, so the retry is judged fresh
  assert.deepEqual([ok.status, ok.body.credited], [200, 500]);
  assert.equal((await row(o.order_id)).status, 'paid');
  assert.equal(await lots('pay_rb_route'), 1);

  // C. The webhook: same fault, same proof. The gateway gets a 500 and will retry; the retry credits once.
  const h = await order(w);
  arm(w, h.id);
  const raw = evBody('payment.captured', { order: h.rail_order_id, pay: 'pay_rb_hook', amount: h.amount_minor });
  const before2 = await counts(w);
  const hit = await quiet(() => hook(w, A, 'LEGACY', raw, 'rb-ev'));
  assert.deepEqual([hit.status, hit.body.error.code], [500, 'internal']);
  assert.equal((await status(w, h.id)).status, 'awaiting_payment');
  assert.equal(await counts(w), before2); // no event row and no audit row either
  disarm(w);
  assert.equal((await hook(w, A, 'LEGACY', raw, 'rb-ev')).body.result, 'recorded');
  assert.equal((await status(w, h.id)).status, 'paid');
  assert.equal(await lots('pay_rb_hook'), 1);
});

test('R7-2: the same payment id again for a paid order answers duplicate and writes nothing (new event id, other event type, paid first by the confirm route)', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const one = await hook(w, A, 'LEGACY', raw, 'ev1');
  assert.deepEqual([one.status, one.body.result], [200, 'recorded']);
  const state = async () => JSON.stringify([await w.s.db.all('SELECT * FROM payee_event ORDER BY event_id'), await w.s.db.all('SELECT seq, action FROM payee_audit ORDER BY seq'), (await w.s.db.first('SELECT COUNT(*) n FROM lot')).n, (await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, await w.s.db.first('SELECT status, payment_ref, paid_minor FROM purchase_order WHERE id = ?', o.id)]);
  const first = await state();
  // the gateway's own second event for the same payment, then the same signed body again with fresh event ids (the event id header is not signed)
  const second = await hook(w, A, 'LEGACY', evBody('order.paid', { order: o.rail_order_id, amount: o.amount_minor }), 'ev2');
  assert.deepEqual([second.status, second.body], [200, { ok: true, result: 'duplicate' }]);
  for (let i = 0; i < 5; i++) assert.deepEqual((await hook(w, A, 'LEGACY', raw, `replay${i}`)).body, { ok: true, result: 'duplicate' });
  assert.equal(await state(), first); // not one new row anywhere
  assert.deepEqual((await hook(w, A, 'LEGACY', raw, 'ev1')).body, { ok: true, result: 'duplicate' }); // the very same event id gives the very same answer
  // paid first by the confirm route with this payment id, then the gateway tells us about it
  const o2 = await order(w);
  const via = await w.s.pay.post('/v1/rail/confirm', { order_id: o2.id, payment_ref: 'pay_W2', paid_minor: o2.amount_minor, currency: 'USD' });
  assert.equal(via.status, 200);
  const before = await state();
  const late = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o2.rail_order_id, pay: 'pay_W2', amount: o2.amount_minor }), 'ev3');
  assert.deepEqual([late.status, late.body.result], [200, 'duplicate']);
  assert.equal(await state(), before);
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 2); // one credit per order, never more
});

test('R7-3: the bad-signature limit is per source and payee: one source cannot use up the budget of another, a good signature is never counted, tables stay small', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const flood = [];
  for (let i = 0; i < 25; i++) flood.push((await hook(w, A, 'LEGACY', raw, `fa${i}`, { sign: false, source: '203.0.113.9' })).status);
  assert.deepEqual([flood.filter((x) => x === 401).length, flood.filter((x) => x === 429).length], [20, 5]);
  // another source has its own budget (before round 7 every source shared one budget per payee and got 429 here)
  const other = await hook(w, A, 'LEGACY', raw, 'fb0', { sign: false, source: '198.51.100.7' });
  assert.deepEqual([other.status, other.body.error.code], [401, 'webhook_bad_signature']);
  // a good signature is never refused or counted, from the flooding source or from any other
  assert.equal((await hook(w, A, 'LEGACY', raw, 'good', { source: '203.0.113.9' })).body.result, 'recorded');
  assert.equal((await hook(w, A, 'LEGACY', raw, 'good2', { source: '198.51.100.7' })).body.result, 'duplicate');
  // 300 more bad calls, each from a different source: still one audit row for the minute, and the counters stay few
  for (let i = 0; i < 300; i++) await hook(w, A, 'LEGACY', raw, `fm${i}`, { sign: false, source: `10.0.${Math.floor(i / 250)}.${i % 250}` });
  const rows = () => w.s.db.all("SELECT detail FROM payee_audit WHERE action = 'webhook.bad_signature'");
  assert.equal((await rows()).length, 1);
  assert.ok((await w.s.db.first("SELECT COUNT(*) n FROM rate_limit WHERE key_id LIKE 'whbad:%'")).n <= 70);
  // the audit row still carries the number of bad calls of the minute before, across all sources
  w.s.clock.t += 60000;
  assert.equal((await hook(w, A, 'LEGACY', raw, 'next', { sign: false, source: '203.0.113.9' })).status, 401);
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(JSON.parse(all[1].detail).previous_minute_count, 25 + 1 + 300);
  // cheap checks come first and write nothing: a malformed signature header and an unknown payee never touch the counters
  const n0 = (await w.s.db.first("SELECT COUNT(*) n FROM rate_limit WHERE key_id LIKE 'whbad:%'")).n;
  const malformed = await w.app.fetch(new Request(`http://t.local/v1/webhooks/payee/${A}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': 'zz', 'x-razorpay-event-id': 'm', 'cf-connecting-ip': '192.0.2.77' } }));
  assert.equal(malformed.status, 401);
  assert.equal((await hook(w, 'pay_unknown', 'LEGACY', raw, 'u', { sign: false, source: '192.0.2.78' })).status, 404);
  assert.equal((await w.s.db.first("SELECT COUNT(*) n FROM rate_limit WHERE key_id LIKE 'whbad:%'")).n, n0);
});

test('R7-4: an owner nonce outlives the accepted time window plus a clock-skew margin (oldest accepted time, newest accepted time, and the keep boundary)', async () => {
  const w = await world();
  const { OWNER_WINDOW_MS, OWNER_NONCE_KEEP_MS } = await import('../src/api.js'); // no defaults: a missing export must fail here
  assert.ok(Number.isFinite(OWNER_WINDOW_MS) && Number.isFinite(OWNER_NONCE_KEEP_MS), 'OWNER_WINDOW_MS and OWNER_NONCE_KEEP_MS must both be exported by src/api.js');
  assert.ok(OWNER_NONCE_KEEP_MS >= OWNER_WINDOW_MS + 60000, 'a nonce must be kept for the window plus at least a minute of clock skew');
  const t0 = w.s.now();
  const call = (ts, nonce) => oc(w, 'GET', '/v1/owner/payees', undefined, { ts, nonce });
  const replayed = (r) => [r.status, r.body.error?.code ?? null];
  // (a) a request 59 seconds short of the oldest accepted age is taken; its window ends one second after t0
  const tsA = t0 - OWNER_WINDOW_MS + 1000;
  assert.equal((await call(tsA, 'old-edge')).status, 200);
  w.s.clock.t = t0 + 1500; // its window has ended; another owner call runs and cleans up
  assert.equal((await oc(w, 'GET', '/v1/owner/payees')).status, 200);
  w.s.clock.t = t0 + 500; // the clock is read half a second behind the cleaner (another machine, or a step back): inside the window again
  assert.deepEqual(replayed(await call(tsA, 'old-edge')), [403, 'replayed']);
  // (b) a request dated 59 seconds short of the newest accepted time (ahead of the clock)
  w.s.clock.t = t0;
  const tsB = t0 + OWNER_WINDOW_MS - 1000;
  assert.equal((await call(tsB, 'new-edge')).status, 200);
  w.s.clock.t = t0 + 2 * OWNER_WINDOW_MS; // its window (ending at tsB + window) has ended; cleanup runs
  assert.equal((await oc(w, 'GET', '/v1/owner/payees')).status, 200);
  w.s.clock.t = t0 + 2 * OWNER_WINDOW_MS - 1500; // stepped back: inside the window again
  assert.deepEqual(replayed(await call(tsB, 'new-edge')), [403, 'replayed']);
  // (c) the keep boundary itself: kept exactly KEEP after its time, gone one millisecond later
  w.s.clock.t = t0 + 3 * OWNER_NONCE_KEEP_MS;
  const now = w.s.now();
  await w.s.db.run("INSERT INTO nonce (key_id, nonce, ts) VALUES ('owner', 'kept', ?), ('owner', 'gone', ?)", now - OWNER_NONCE_KEEP_MS, now - OWNER_NONCE_KEEP_MS - 1);
  assert.equal((await oc(w, 'GET', '/v1/owner/payees')).status, 200);
  const left = (await w.s.db.all("SELECT nonce FROM nonce WHERE key_id = 'owner'")).map((x) => x.nonce);
  assert.ok(left.includes('kept') && !left.includes('gone') && !left.includes('old-edge') && !left.includes('new-edge'));
  // (d) the other cleaner: every signed call by a tenant key also deletes old nonces of all key ids. It must never delete one the owner path still keeps.
  // 'inside-keep' is older than the time window but younger than the keep time: the owner path keeps it, so a tenant cleanup that is only as long as
  // the window (or any length under the keep time) would delete it, and this test would fail.
  const t1 = w.s.now();
  await w.s.db.run("INSERT INTO nonce (key_id, nonce, ts) VALUES ('owner', 'inside-keep', ?)", t1 - OWNER_WINDOW_MS - 1000);
  assert.equal((await w.s.read.get('/v1/balance?email=nobody%40example.com')).status, 200);
  const after = (await w.s.db.all("SELECT nonce FROM nonce WHERE key_id = 'owner'")).map((x) => x.nonce);
  assert.ok(after.includes('kept'), 'a tenant call deleted an owner nonce that is exactly at the keep boundary');
  assert.ok(after.includes('inside-keep'), 'a tenant call deleted an owner nonce that is older than the window but younger than the keep time');
});

test('R7-5: a paid order answers a repeat confirm before its figures are judged: the same payment id gets the first answer, another payment id gets order_already_paid', async () => {
  const w = await world();
  const { s } = w;
  const o = (await s.api.post('/v1/buy_credits', { email: 'rp@example.com', credits: 500, currency: 'USD', order_ref: 'rp-1' })).body;
  const send = (ref, extra) => s.pay.post('/v1/rail/confirm', { order_id: o.order_id, payment_ref: ref, ...extra });
  const first = await send('pay_rp1', { paid_minor: o.amount_minor, currency: 'USD' });
  assert.deepEqual([first.status, first.body.credited], [200, 500]);
  // the repeat carries figures an open order would refuse (wrong currency, then nothing at all); a paid order does not judge them
  for (const extra of [{ paid_minor: 1, currency: 'INR' }, {}]) {
    const again = await send('pay_rp1', extra);
    assert.deepEqual([again.status, again.body.already, again.body.credited], [200, true, 500]);
    const other = await send('pay_rp2', extra);
    assert.deepEqual([other.status, other.body.error.code], [409, 'order_already_paid']);
  }
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM lot WHERE source_ref = 'pay_rp1'")).n, 1);
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM lot WHERE source_ref = 'pay_rp2'")).n, 0);
});

// ---------------- round 8 ----------------
test('R8-4: a payee whose webhook secret is missing: a flood of well-formed calls is counted per source, audit rows stay bounded, money state does not change', async () => {
  const w = await world();
  const o = await order(w);
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const sig = await hmacHex(WH('LEGACY'), raw); // well formed, and a correct signature: it fails only because the payee's secret has no value in the store
  const gone = createApp({ db: w.s.db, master: w.s.master, now: w.s.now, env: { MNP_PAYEE_ACCOUNTS: '1' }, aiWithoutStatus: true });
  const call = async (eventId, source) => {
    const r = await gone.fetch(new Request(`http://t.local/v1/webhooks/payee/${A}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId, ...(source ? { 'cf-connecting-ip': source } : {}) } }));
    return { status: r.status, body: await r.json() };
  };
  const money = async () => ({
    orders: await w.s.db.all('SELECT id, status FROM purchase_order ORDER BY id'),
    entries: (await w.s.db.first('SELECT COUNT(*) n FROM entry')).n,
    lots: (await w.s.db.first('SELECT COUNT(*) n FROM lot')).n,
    claims: (await w.s.db.first('SELECT COUNT(*) n FROM payment_ref')).n,
    events: (await w.s.db.first('SELECT COUNT(*) n FROM payee_event')).n,
  });
  const rows = () => w.s.db.all("SELECT detail FROM payee_audit WHERE action = 'webhook.secret_missing'");
  const before = await money();
  assert.equal(before.orders.find((x) => x.id === o.id).status, 'awaiting_payment');
  // one source: 20 calls get the 500, the rest of its minute gets 429 (before this round every call got a 500 and a chained audit row)
  const one = [];
  for (let i = 0; i < 25; i++) one.push(await call(`ma${i}`, '203.0.113.9'));
  assert.deepEqual([one.filter((x) => x.status === 500).length, one.filter((x) => x.status === 429).length], [20, 5]);
  assert.ok(one.filter((x) => x.status === 500).every((x) => x.body.error.code === 'payee_secret_missing'));
  assert.ok(one.filter((x) => x.status === 429).every((x) => x.body.error.code === 'rate_limited'));
  // another source has its own budget
  assert.equal((await call('mb0', '198.51.100.7')).status, 500);
  // 300 more calls, each from a different source, in the same minute: still one audit row, and the counters stay few
  for (let i = 0; i < 300; i++) await call(`mc${i}`, `10.0.${Math.floor(i / 250)}.${i % 250}`);
  assert.equal((await rows()).length, 1);
  assert.ok((await w.s.db.first("SELECT COUNT(*) n FROM rate_limit WHERE key_id LIKE 'whbad:%'")).n <= 70);
  assert.equal((await w.s.db.first("SELECT COUNT(*) n FROM payee_audit WHERE action IN ('webhook.secret_missing', 'webhook.bad_signature')")).n, 1);
  // no money state moved, and no event row was stored for any of the 326 calls
  assert.deepEqual(await money(), before);
  // next minute: one more row, with the count of the minute before; still no money state
  w.s.clock.t += 60000;
  assert.equal((await call('md0', '203.0.113.9')).status, 500);
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(JSON.parse(all[1].detail).previous_minute_count, 25 + 1 + 300);
  assert.deepEqual(await money(), before);
  // the flood left nothing behind that blocks the real payment: with the secret in the store again, the same event is applied once
  const good = await hook(w, A, 'LEGACY', raw, 'ma0');
  assert.equal(good.body.result, 'recorded');
  assert.equal((await status(w, o.id)).status, 'paid');
});

test('R9-1: an event stored as pending (order unknown) is finished when the same event id is retried after the order exists: one credit, then duplicate', async () => {
  const w = await world();
  const o = await order(w);
  const unknown = 'order_late_known';
  const first = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: unknown, amount: o.amount_minor }), 'pe1');
  assert.deepEqual([first.status, first.body.result], [409, 'unmatched_retry']);
  assert.deepEqual((await evs(w)).map((e) => e.outcome), ['pending_unmatched']);
  await w.s.db.run('UPDATE purchase_order SET rail_order_id = ? WHERE id = ?', unknown, o.id); // the order now exists under that gateway order id
  const raw = evBody('payment.captured', { order: unknown, amount: o.amount_minor });
  const second = await hook(w, A, 'LEGACY', raw, 'pe1');
  assert.deepEqual([second.status, second.body.result], [200, 'recorded']);
  assert.equal((await status(w, o.id)).status, 'paid');
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1);
  assert.deepEqual((await evs(w)).map((e) => [e.event_id, e.outcome, e.order_id]), [['pe1', 'recorded', o.id]]);
  assert.equal((await hook(w, A, 'LEGACY', raw, 'pe1')).body.result, 'duplicate');
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1);
  assert.equal((await evs(w)).length, 1);
  // refused path: pending first, then the order exists but the amount is wrong for good (currency): the pending row becomes ignored, no credit
  const o2 = await order(w);
  const u2 = 'order_late_known2';
  assert.equal((await hook(w, A, 'LEGACY', evBody('payment.captured', { order: u2, pay: 'pay_W2', amount: o2.amount_minor, currency: 'INR' }), 'pe2')).status, 409);
  await w.s.db.run('UPDATE purchase_order SET rail_order_id = ? WHERE id = ?', u2, o2.id);
  const ref = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: u2, pay: 'pay_W2', amount: o2.amount_minor, currency: 'INR' }), 'pe2');
  assert.deepEqual([ref.status, ref.body.result], [200, 'currency_mismatch']);
  assert.equal((await status(w, o2.id)).status, 'awaiting_payment');
  assert.deepEqual({ ...(await w.s.db.first("SELECT outcome, order_id FROM payee_event WHERE event_id = 'pe2'")) }, { outcome: 'ignored', order_id: o2.id });
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM entry')).n, 1);
});

test('R9-2: a payment that arrives after the sweep timed the order out is credited once by the webhook; a repeat is a duplicate', async () => {
  const w = await world();
  const o = await order(w);
  assert.equal((await status(w, o.id)).status, 'awaiting_payment');
  w.s.clock.t = o.lock_until + 60000; // lock window passed
  assert.deepEqual(await expireOrdersFor(w), { expired: 1 });
  assert.equal((await status(w, o.id)).status, 'failed');
  const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
  const r = await hook(w, A, 'LEGACY', raw, 'late1');
  assert.deepEqual([r.status, r.body.result], [200, 'recorded']);
  assert.equal((await status(w, o.id)).status, 'paid');
  const credits = async () => (await w.s.db.first("SELECT COALESCE(SUM(delta),0) n FROM entry WHERE delta > 0")).n;
  assert.equal(await credits(), 500);
  assert.deepEqual((await evs(w)).map((e) => [e.event_id, e.outcome, e.order_id]), [['late1', 'recorded', o.id]]);
  assert.ok((await P.listPayeeAudit(w.owner)).entries.some((e) => e.action === 'webhook.recorded'));
  assert.equal((await hook(w, A, 'LEGACY', raw, 'late1')).body.result, 'duplicate');
  assert.equal((await hook(w, A, 'LEGACY', raw, 'late2')).body.result, 'duplicate');
  assert.equal(await credits(), 500);
  // a failed order with the wrong currency is refused for good and not credited
  const o2 = await order(w);
  w.s.clock.t = o2.lock_until + 60000;
  await expireOrdersFor(w);
  const bad = await hook(w, A, 'LEGACY', evBody('payment.captured', { order: o2.rail_order_id, pay: 'pay_W5', amount: o2.amount_minor, currency: 'INR' }), 'late3');
  assert.equal(bad.body.result, 'currency_mismatch');
  assert.equal((await status(w, o2.id)).status, 'failed');
  assert.equal(await credits(), 500);
});
const expireOrdersFor = (w) => expireOrders({ ...w.owner });
