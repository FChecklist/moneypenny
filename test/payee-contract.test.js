// Contract test for the payee routes (owner routes F6, health F8, webhook F7): every payee route in the DOCUMENTED contract
// (contract/v1/openapi.json, the file other people read) exists in the real router and answers with the documented shape.
// Dark: the payee flag is on only inside these tests. No real network. Secret values here are made-up test strings.
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
for (const x of ['LEGACY', 'PB']) for (const [k, n] of Object.entries(nm(x))) env[n] = `value-${x}-${k}-0123456789abcdefXYZ`;
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
  return { s, app, off, owner, call, hook, order };
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
  ownerCreatePayee: async (w) => [await w.call('POST', '/v1/owner/payees', payeeBody()), await w.call('POST', '/v1/owner/payees', payeeBody()), await w.call('POST', '/v1/owner/payees', payeeBody('PX', { gateway: 'nope' }))],
  ownerEditPayee: async (w) => {
    const id = (await w.call('POST', '/v1/owner/payees', payeeBody())).body.payee.payee_id;
    return [await w.call('PUT', `/v1/owner/payees/${id}`, { note: 'contract test' }), await w.call('PUT', `/v1/owner/payees/${id}`, {}), await w.call('PUT', '/v1/owner/payees/pay_nope', { note: 'x' })];
  },
  ownerPayeeStep: async (w, op) => {
    const id = (await w.call('POST', '/v1/owner/payees', payeeBody())).body.payee.payee_id;
    const steps = op.parameters.find((p) => p.name === 'step').schema.enum; // the documented steps: activate, pause, retire
    const out = [];
    for (const step of steps) out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id, step }), {}));
    out.push(await w.call('POST', fill('/v1/owner/payees/{id}/{step}', { id, step: steps[0] }), {})); // a retired payee cannot be activated: bad_transition
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
    return [await w.call('POST', '/v1/owner/routes', route), await w.call('POST', '/v1/owner/routes', { ...route, effective_from: 20 }), await w.call('POST', '/v1/owner/routes', { ...route, tenant_id: 'nobody' })];
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
    const out = [await w.hook(raw, 'e1'), await w.hook(raw, 'e1'), await w.hook(raw, 'e2')]; // recorded, then duplicate twice (same event id, then the same payment id)
    out.push(await w.hook(evBody('payment.captured', { order: 'order_nobody', amount: 5 }), 'e3')); // 409 retry
    out.push(await w.hook(raw, 'e4', { sign: false }), await w.hook(raw, 'e5', { id: 'pay_unknown' }), await w.hook(raw, undefined)); // 401, 404, 400
    out.push(await w.hook(raw, 'e6', { use: w.off })); // flag off: 503
    for (let i = 0; i < 21; i++) out.push(await w.hook(raw, `f${i}`, { sign: false, source: '203.0.113.9' })); // the 21st bad call from one source: 429
    return out;
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
  for (const { op } of owners) for (const c of ['forbidden', 'replayed', 'payees_disabled', 'rate_limited', 'bad_json', 'payee_forbidden']) assert.ok(op['x-error-codes'].includes(c), `${op.operationId} does not list ${c}`);
  const list = contract.paths['/v1/owner/payees'].get;
  const create = contract.paths['/v1/owner/payees'].post;
  const refused = async (op, answer, code) => { const a = await answer; verifyAnswer(op, a); assert.equal(a.body.error.code, code); };
  await refused(list, w.call('GET', '/v1/owner/payees', undefined, { sign: false }), 'forbidden'); // not signed with the master secret
  assert.equal((await w.call('GET', '/v1/owner/payees', undefined, { nonce: 'once' })).status, 200);
  await refused(list, w.call('GET', '/v1/owner/payees', undefined, { nonce: 'once' }), 'replayed'); // the same signed call again
  await refused(list, w.call('GET', '/v1/owner/payees', undefined, { use: w.off }), 'payees_disabled'); // flag off
  await refused(create, w.call('POST', '/v1/owner/payees', undefined, { raw: 'this is not json' }), 'bad_json');
});
