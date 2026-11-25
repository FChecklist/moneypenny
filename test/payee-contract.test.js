// Contract test for the payee routes (owner routes F6, health F8, webhook F7): every payee route in the DOCUMENTED contract
// (contract/v1/openapi.json, the file other people read) exists in the real router and answers with the documented shape.
// Dark: the payee flag is on only inside these tests. No real network. Secret values here are made-up test strings.
//
// SCOPE, said plainly:
//  - Routes and answer shapes: ONE-WAY, contract to code. Every documented payee route is called and its answer is checked against the contract.
//    A payee route that exists in the code but is missing from the contract is NOT found by this file.
//  - Error codes: TWO-WAY. Forward: an error code that a real call gives must be listed for that operation (verifyAnswer). Reverse: every code
//    listed in `x-error-codes` of a payee operation must be given by a real call here (CASES, and the refusals every owner route can give),
//    or be on the short NOT_REACHED list below, with its reason. A stale NOT_REACHED entry also fails.
//  - The contract file as a whole: no `required` list may be empty (OpenAPI 3.0.3 does not allow it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './helpers.js';
import { createApp } from '../src/api.js';
import * as R from '../src/routes.js';
import { buyCredits } from '../src/gate.js';
import { stubRail } from '../src/rail.js';
import { hmacHex } from '../src/util.js';

const contract = JSON.parse(readFileSync(new URL('../contract/v1/openapi.json', import.meta.url), 'utf8'));
const defs = contract.components.schemas;
// every documented payee route, taken from the file: owner routes and the gateway webhook
const documented = Object.entries(contract.paths).flatMap(([path, ms]) => Object.entries(ms).filter(([, op]) => ['owner', 'gateway'].includes(op['x-permission-level'])).map(([method, op]) => ({ method: method.toUpperCase(), path, op })));

const nm = (x) => ({ key_id: `MNP_${x}_KEY_ID`, key_secret: `MNP_${x}_KEY_SECRET`, webhook_secret: `MNP_${x}_WEBHOOK_SECRET` });
const env = { MNP_PAYEE_ACCOUNTS: '1' };
for (const x of ['LEGACY', 'PB', 'PL']) for (const [k, n] of Object.entries(nm(x))) env[n] = `value-${x}-${k}-0123456789abcdefXYZ`;
const A = 'pay_legacy_itservices';
const payeeBody = (x = 'PB', extra = {}) => ({ legal_name: `Payee ${x} Legal`, gateway: 'razorpay', mode: 'test', secret_names: nm(x), currencies: ['INR', 'USD'], ...extra });
const fill = (path, vals) => path.replace(/\{([a-z_]+)\}/g, (_, k) => vals[k]);

async function world() {
  const s = await setup();
  await s.db.run('UPDATE payee_account SET secret_names = ? WHERE payee_id = ?', JSON.stringify(nm('LEGACY')), A);
  const app = createApp({ db: s.db, master: s.master, now: s.now, env, aiWithoutStatus: true });
  const off = createApp({ db: s.db, master: s.master, now: s.now, env: {}, aiWithoutStatus: true }); // the flag is off here
  const owner = { ...s.ctx(), payees: true, env, actor: 'owner', callerType: 'owner', rail: stubRail };
  await R.setRoute(owner, { tenant_id: 'demo', product_id: '*', payee_id: A, effective_from: 0, reason: 'default route for tests' });
  let n = 0;
  // a signed owner call, as the HTTP layer expects it. `raw` sends text as it is (for a body that is not JSON).
  const call = async (method, path, body, { use = app, sign = true, nonce = `c${++n}`, raw } = {}) => {
    const text = raw ?? (body === undefined ? '' : JSON.stringify(body));
    const t = s.now();
    const sig = sign ? await hmacHex(s.master, `mnp-owner\n${t}\n${nonce}\n${method}\n${path}\n${text}`) : 'bad';
    const r = await use.fetch(new Request(`http://t.local${path}`, { method, body: method === 'GET' ? undefined : text, headers: { 'x-owner-ts': String(t), 'x-owner-nonce': nonce, 'x-owner-sig': sig } }));
    return { status: r.status, body: await r.json() };
  };
  // a gateway call for payee A, signed with that payee's webhook secret (or not)
  const hook = async (raw, eventId, { sign = true, source, use = app, id = A } = {}) => {
    const sig = sign ? await hmacHex(env.MNP_LEGACY_WEBHOOK_SECRET, raw) : '0'.repeat(64);
    const r = await use.fetch(new Request(`http://t.local/v1/webhooks/payee/${id}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig, ...(eventId ? { 'x-razorpay-event-id': eventId } : {}), ...(source ? { 'cf-connecting-ip': source } : {}) } }));
    return { status: r.status, body: await r.json() };
  };
  const order = async () => s.db.first('SELECT * FROM purchase_order WHERE id = ?', (await buyCredits({ ...owner }, { email: 'contract@example.com', credits: 500, order_ref: `r${Math.random()}`, currency: 'USD' })).order_id);
  // the legacy payee ships with no secret names until the owner fills them in: while it is active and has none, every change is refused (payee_setup_incomplete)
  const breakLegacy = () => s.db.run("UPDATE payee_account SET secret_names = '{}' WHERE payee_id = ?", A);
  return { s, app, off, owner, call, hook, order, breakLegacy };
}
const evBody = (type, { order, pay = 'pay_C1', amount, currency = 'USD' }) => JSON.stringify({ event: type, payload: { payment: { entity: { id: pay, order_id: order, amount, currency } } } });

// A small checker for the schema words the contract uses: $ref, type, nullable, enum, required, properties, additionalProperties, items.
function check(schema, value, where) {
  if (schema.$ref) return check(defs[schema.$ref.replace('#/components/schemas/', '')], value, where);
  if (value === null) return assert.ok(schema.nullable, `${where} is null, and the contract does not say it can be`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${where} is ${JSON.stringify(value)}, the contract allows ${JSON.stringify(schema.enum)}`);
  const kind = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  assert.equal(kind, schema.type, `${where} is ${kind}, the contract says ${schema.type}`);
  if (kind === 'array') value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`));
  if (kind === 'object') {
    for (const k of schema.required ?? []) assert.ok(k in value, `${where}.${k} is missing, the contract says it is always there`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      assert.ok(sub || schema.additionalProperties !== false, `${where}.${k} is in the answer but not in the contract`);
      if (sub) check(sub, v, `${where}.${k}`);
    }
  }
}

/** One answer: the route exists, and it has the documented shape. A documented status uses its schema; any other failure must be the documented
 *  error shape with a code the contract lists for this operation. */
function verifyAnswer(op, a) {
  const label = `${op.operationId} answered ${a.status}`;
  assert.ok(!(a.status === 404 && /No such route/.test(a.body?.error?.message ?? '')), `${label}: the route is in the contract but not in the router`);
  const doc = op.responses[String(a.status)]?.content?.['application/json']?.schema;
  if (doc) return check(doc, a.body, label);
  assert.ok(a.status >= 400, `${label}: the contract has no answer written for this status`);
  check(defs.Error, a.body, label);
  assert.ok(op['x-error-codes'].includes(a.body.error.code), `${label}: error code ${a.body.error.code} is not listed for this operation`);
}
function verify(op, answers) {
  answers.forEach((a) => verifyAnswer(op, a));
  assert.ok(answers.some((a) => a.status === 200), `${op.operationId}: no successful answer was checked`);
}

// One case per documented operation: real calls, in the order that makes them work (draft, active, paused, retired). Each returns its answers.
const CASES = {
  ownerListPayees: async (w) => [await w.call('GET', '/v1/owner/payees')],
  ownerGetPayee: async (w) => [await w.call('GET', `/v1/owner/payees/${A}`), await w.call('GET', '/v1/owner/payees/pay_nope')],
  ownerCreatePayee: async (w) => {
    const post = (b) => w.call('POST', '/v1/owner/payees', b);
    const out = [await post(payeeBody()), await post(payeeBody()), await post(payeeBody('PX', { gateway: 'nope' }))]; // created, payee_exists, bad_gateway
    out.push(await post(payeeBody('P1', { mode: 'x' })), await post(payeeBody('P2', { currencies: ['EUR'] })), await post(payeeBody('P3', { secret_names: 'x' })));
    out.push(await post(payeeBody('P4', { note: 'pay to 123456789012' })), await post(payeeBody('P5', { note: 'rzp_' + 'test_AbCdEfGhIjKlMnOp' })));
    await w.breakLegacy();
    out.push(await post(payeeBody('P6'))); // payee_setup_incomplete
    return out;
  },
  ownerEditPayee: async (w) => {
    const id = (await w.call('POST', '/v1/owner/payees', payeeBody())).body.payee.payee_id;
    const put = (b, to = id) => w.call('PUT', `/v1/owner/payees/${to}`, b);
    const out = [await put({ note: 'contract test' }), await put({}), await put({ note: 'x' }, 'pay_nope')]; // changed, nothing to change, payee_not_found
    out.push(await put({ gateway: 'nope' }), await put({ mode: 'x' }), await put({ mode: 'live' }), await put({ currencies: ['EUR'] }), await put({ secret_names: 'x' })); // bad_gateway, bad_mode, mode_fixed, bad_currencies, bad_secret_names
    out.push(await put({ note: 'pay to 123456789012' }), await put({ note: 'rzp_' + 'test_AbCdEfGhIjKlMnOp' }), await put({ secret_names: nm('LEGACY') })); // bank_detail_refused, secret_value_refused, payee_exists
    await w.order(); // the legacy payee has now had an order
    out.push(await put({ legal_name: 'Changed Legal Name' }, A)); // identity_locked
    await w.call('POST', `/v1/owner/payees/${id}/activate`, {});
    out.push(await put({ secret_names: nm('NOWHERE') })); // payee_secret_missing: active, and the new names have no value in the store
    await w.call('POST', `/v1/owner/payees/${id}/retire`, {});
    out.push(await put({ note: 'again' })); // payee_retired
    await w.breakLegacy();
    out.push(await put({ note: 'again' })); // payee_setup_incomplete
    return out;
  },
  ownerPayeeStep: async (w, op) => {
    const id = (await w.call('POST', '/v1/owner/payees', payeeBody())).body.payee.payee_id;
    const steps = op.parameters.find((p) => p.name === 'step').schema.enum; // the documented steps: activate, pause, retire
    const out = [];
    for (const step of steps) out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id, step }), {}));
    out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id, step: steps[0] }), {})); // a retired payee cannot be activated: bad_transition
    out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id: 'pay_nope', step: steps[0] }), {})); // payee_not_found
    const lost = (await w.call('POST', '/v1/owner/payees', payeeBody('PZ', { secret_names: nm('NOWHERE') }))).body.payee.payee_id;
    out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id: lost, step: steps[0] }), {})); // payee_secret_missing: the names have no value in the store
    const second = (await w.call('POST', '/v1/owner/payees', payeeBody('PL', { mode: 'live' }))).body.payee.payee_id; // the legacy payee is active for razorpay in live mode
    out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id: second, step: steps[0] }), {})); // payee_gateway_taken
    await w.breakLegacy();
    out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id: second, step: steps[0] }), {})); // payee_setup_incomplete
    return out;
  },
  ownerPayeeSecrets: async (w) => {
    const lost = (await w.call('POST', '/v1/owner/payees', payeeBody('PZ', { secret_names: nm('NOWHERE') }))).body.payee.payee_id; // names with no value in the platform store
    return [await w.call('GET', `/v1/owner/payees/${A}/secrets`), await w.call('GET', `/v1/owner/payees/${lost}/secrets`), await w.call('GET', '/v1/owner/payees/pay_nope/secrets')];
  },
  ownerPayeeHealth: async (w) => [await w.call('GET', `/v1/owner/payees/${A}/health`), await w.call('GET', '/v1/owner/payees/pay_nope/health')],
  ownerSetRoute: async (w) => {
    const id = (await w.call('POST', '/v1/owner/payees', payeeBody())).body.payee.payee_id;
    await w.call('POST', `/v1/owner/payees/${id}/activate`, {});
    const route = { tenant_id: 'demo', product_id: 'p1', payee_id: id, effective_from: 10, reason: 'contract test' };
    const draft = (await w.call('POST', '/v1/owner/payees', payeeBody('PD'))).body.payee.payee_id; // never activated
    const out = [await w.call('POST', '/v1/owner/routes', route), await w.call('POST', '/v1/owner/routes', { ...route, effective_from: 20 }), await w.call('POST', '/v1/owner/routes', { ...route, tenant_id: 'nobody' })];
    out.push(await w.call('POST', '/v1/owner/routes', { ...route, effective_from: 15 })); // route_overlap
    out.push(await w.call('POST', '/v1/owner/routes', { ...route, product_id: 'Bad Product!' })); // bad_product
    out.push(await w.call('POST', '/v1/owner/routes', { ...route, payee_id: 'pay_nope' })); // payee_not_found
    out.push(await w.call('POST', '/v1/owner/routes', { ...route, payee_id: draft })); // payee_not_active
    await w.breakLegacy();
    out.push(await w.call('POST', '/v1/owner/routes', { ...route, effective_from: 30 })); // payee_setup_incomplete
    return out;
  },
  ownerPayeeAudit: async (w) => [await w.call('GET', '/v1/owner/payee_audit?limit=5'), await w.call('GET', '/v1/owner/payee_audit?limit=abc')],
  ownerPayeeAuditVerify: async (w) => {
    const good = await w.call('GET', '/v1/owner/payee_audit/verify');
    await w.s.db.run("UPDATE payee_audit SET actor = 'someone-else' WHERE seq = 1");
    return [good, await w.call('GET', '/v1/owner/payee_audit/verify')]; // the broken chain is still HTTP 200, with ok false and broken_at
  },
  payeeWebhook: async (w) => {
    const o = await w.order();
    const raw = evBody('payment.captured', { order: o.rail_order_id, amount: o.amount_minor });
    const recorded = await w.hook(raw, 'e1');
    const dupEvent = await w.hook(raw, 'e1'); // the same event id again
    const dupPayment = await w.hook(raw, 'e2'); // a new event id, the same payment id
    // The schema makes order_id optional, so the shape check cannot tell these answers apart. Said exactly here: recorded has order_id, duplicate has none.
    assert.deepEqual([recorded.status, recorded.body.result], [200, 'recorded']);
    assert.equal(recorded.body.order_id, o.id);
    for (const d of [dupEvent, dupPayment]) {
      assert.deepEqual([d.status, d.body.result], [200, 'duplicate']);
      assert.ok(!('order_id' in d.body), 'a duplicate answer must carry no order_id');
    }
    const out = [recorded, dupEvent, dupPayment];
    const retry = await w.hook(evBody('payment.captured', { order: 'order_nobody', amount: 5 }), 'e3'); // 409 retry
    assert.deepEqual([retry.status, retry.body.result, retry.body.retry], [409, 'unmatched_retry', true]);
    const unsigned = await w.hook(raw, 'e4', { sign: false });
    const unknown = await w.hook(raw, 'e5', { id: 'pay_unknown' });
    const noEvent = await w.hook(raw, undefined);
    const tooBig = await w.hook('x'.repeat(65537), 'e7'); // over the 64 KiB cap: refused before anything is read
    const flagOff = await w.hook(raw, 'e6', { use: w.off }); // flag off: 503
    // the payee's webhook secret has no value in the platform store (flag on, no secrets): every well-formed call fails the same way
    const noSecret = await createApp({ db: w.s.db, master: w.s.master, now: w.s.now, env: { MNP_PAYEE_ACCOUNTS: '1' }, aiWithoutStatus: true });
    const missing = await w.hook(raw, 'e8', { use: noSecret });
    // The exact error code of each refusal, not only that the code is listed for the route.
    for (const [a, status, code] of [[unsigned, 401, 'webhook_bad_signature'], [unknown, 404, 'payee_not_found'], [noEvent, 400, 'webhook_no_event_id'], [tooBig, 413, 'too_large'], [flagOff, 503, 'payees_disabled'], [missing, 500, 'payee_secret_missing']]) {
      assert.deepEqual([a.status, a.body.error?.code], [status, code], `webhook refusal ${code}`);
    }
    out.push(retry, unsigned, unknown, noEvent, tooBig, flagOff, missing);
    const flood = [];
    for (let i = 0; i < 21; i++) flood.push(await w.hook(raw, `f${i}`, { sign: false, source: '203.0.113.9' })); // the 21st bad call from one source: 429
    assert.deepEqual([flood.slice(0, 20).every((a) => a.status === 401), flood[20].status, flood[20].body.error.code], [true, 429, 'rate_limited']);
    return [...out, ...flood];
  },
};

test('contract: the documented payee routes are exactly the ones this test calls', () => {
  assert.deepEqual(documented.map((d) => d.op.operationId).sort(), Object.keys(CASES).sort());
  for (const { op } of documented) assert.ok(op.responses['200'].content['application/json'].schema, `${op.operationId} has no documented answer`);
});

for (const { method, path, op } of documented) {
  test(`contract: ${method} ${path} (${op.operationId}) exists and answers with the documented shape`, async () => {
    const w = await world();
    verify(op, await CASES[op.operationId](w, op));
  });
}

test('contract: the refusals every owner route can give are listed for it, and the real answers have the documented error shape', async () => {
  const w = await world();
  const owners = documented.filter((d) => d.op['x-permission-level'] === 'owner');
  for (const { op } of owners) for (const c of ['forbidden', 'replayed', 'payees_disabled', 'rate_limited', 'bad_json', 'payee_forbidden']) assert.equal(op['x-error-codes'].includes(c), !(c === 'bad_json' && isGet(op)), `${op.operationId}: ${c} listed wrongly (bad_json belongs to routes with a body only)`);
  const list = contract.paths['/v1/owner/payees'].get;
  const create = contract.paths['/v1/owner/payees'].post;
  const refused = async (op, answer, code) => { const a = await answer; verifyAnswer(op, a); assert.equal(a.body.error.code, code); };
  await refused(list, w.call('GET', '/v1/owner/payees', undefined, { sign: false }), 'forbidden'); // not signed with the master secret
  assert.equal((await w.call('GET', '/v1/owner/payees', undefined, { nonce: 'once' })).status, 200);
  await refused(list, w.call('GET', '/v1/owner/payees', undefined, { nonce: 'once' }), 'replayed'); // the same signed call again
  await refused(list, w.call('GET', '/v1/owner/payees', undefined, { use: w.off }), 'payees_disabled'); // flag off
  await refused(create, w.call('POST', '/v1/owner/payees', undefined, { raw: 'this is not json' }), 'bad_json');
});

// ---------------- reverse check: every listed error code is given by a real call, or is explained ----------------
// Codes that no real HTTP call here can give, each with the reason. Keep this list short; a stale entry fails the test below.
const isGet = (op) => Object.entries(contract.paths).some(([, ms]) => ms.get?.operationId === op.operationId);
const NOT_REACHED = [
  { code: 'payee_forbidden', applies: () => true, why: 'Raised when a caller without the owner role reaches a payee function. Every owner call over HTTP is checked with the master secret and carries the owner role, so no HTTP call can reach it. The function-level test "F5: only the owner role may call any payee mutator or the audit view" covers it.' },
  { code: 'not_found', applies: (op) => op.operationId === 'ownerGetPayee', why: 'The router gives it for a path it does not know, for example a payee id with a dash. That same answer (404, "No such route.") is how this file detects a route that is missing from the router, so it is not tried as a case.' },
];
const explained = (op, code) => NOT_REACHED.some((n) => n.code === code && n.applies(op));
const codesOf = (answers) => answers.filter((a) => a.status >= 400 && a.body?.error?.code).map((a) => a.body.error.code);
/** The listed codes of each operation that were not given by a real call and are not explained. Pure, so it can be tried on made-up input. */
const unexplained = (ops, reached, isExplained) => ops.flatMap((op) => (op['x-error-codes'] ?? []).filter((c) => !reached[op.operationId]?.has(c) && !isExplained(op, c)).map((c) => `${op.operationId}: ${c}`));

/** What each documented payee route really gives: its own CASES, plus (for owner routes) the refusals every owner route can give, tried on that route:
 *  not signed, the same signed call twice, flag off, a body that is not JSON, and the 61st call in a minute (the owner key allows 60). */
async function reachedCodes() {
  const reached = {};
  for (const { method, path, op } of documented) {
    const got = new Set(codesOf(await CASES[op.operationId](await world(), op)));
    if (op['x-permission-level'] === 'owner') {
      const p = fill(path, { id: A, step: 'activate' });
      const body = method === 'GET' ? undefined : {};
      const w = await world();
      const answers = [
        await w.call(method, p, body, { sign: false }),
        await w.call(method, p, body, { use: w.off }),
        await w.call(method, p, body, { nonce: 'same' }),
        await w.call(method, p, body, { nonce: 'same' }),
      ];
      if (method !== 'GET') answers.push(await w.call(method, p, undefined, { raw: 'this is not json' }));
      const busy = await world();
      for (let i = 0; i < 60; i++) await busy.call('GET', '/v1/owner/payees');
      answers.push(await busy.call(method, p, body));
      answers.forEach((a) => verifyAnswer(op, a)); // each refusal also has the documented error shape and a listed code
      for (const c of codesOf(answers)) got.add(c);
    }
    reached[op.operationId] = got;
  }
  return reached;
}

test('contract: every error code listed for a payee route is given by a real call here, or is on NOT_REACHED with its reason', async () => {
  const reached = await reachedCodes();
  const ops = documented.map((d) => d.op);
  assert.deepEqual(unexplained(ops, reached, explained), [], 'listed in the contract, but no call here gives it: fix the contract or add a call (or explain it in NOT_REACHED)');
  // the list cannot go stale: every entry still has a reason, is still listed by a route it applies to, and is still not given by any of those routes
  for (const n of NOT_REACHED) {
    assert.ok(n.why.length > 40, `${n.code} needs a real reason`);
    const listing = ops.filter((op) => n.applies(op) && op['x-error-codes'].includes(n.code));
    assert.ok(listing.length, `${n.code} is on NOT_REACHED but no route it applies to lists it any more: remove it`);
    for (const op of listing) assert.ok(!reached[op.operationId].has(n.code), `${op.operationId} now gives ${n.code}: remove it from NOT_REACHED`);
  }
  // the check itself: a code that is listed but never given, and is not explained, is found
  const probe = { operationId: 'x', 'x-error-codes': ['seen', 'made_up_code', 'explained'] };
  assert.deepEqual(unexplained([probe], { x: new Set(['seen']) }, (op, c) => c === 'explained'), ['x: made_up_code']);
});

// ---------------- the contract file as a whole ----------------
/** The path of every `required` that is an empty list, anywhere in the document. (`required: true` on a parameter is a flag, not a list, and is not looked at.) */
const emptyRequired = (node, path = '#') => {
  if (Array.isArray(node)) return node.flatMap((v, i) => emptyRequired(v, `${path}/${i}`));
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => (k === 'required' && Array.isArray(v) && v.length === 0 ? [`${path}/required`] : emptyRequired(v, `${path}/${k}`)));
};
test('contract: no `required` list is empty anywhere in the contract file (OpenAPI 3.0.3 does not allow it)', () => {
  assert.deepEqual(emptyRequired(contract), []);
  // the check itself: it finds an empty list nested in objects and arrays, and leaves a flag and a filled list alone
  assert.deepEqual(emptyRequired({ a: { b: [{ required: [] }] }, c: { required: true }, d: { required: ['x'] } }), ['#/a/b/0/required']);
  assert.ok(contract.components.schemas.Payee.properties.secret_names, 'the schema that had the empty list is still there');
  assert.ok(!('required' in contract.components.schemas.Payee.properties.secret_names), 'secret_names has only optional keys, so it has no required list at all');
});
