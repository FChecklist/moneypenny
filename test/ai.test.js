// AI-ready safeguards: an AI key reads and asks; a person decides. Off-switches, audit, untrusted text, no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, bal, buy, MIN, HOUR, note } from './helpers.js';
import { verifyAudit } from '../src/audit.js';
import { verifyBalances } from '../src/ledger.js';
import { keySecret } from '../src/auth.js';
import { buildContract } from '../scripts/gen-contract.js';
import { ROUTES } from '../src/api.js';
import { OPS } from '../src/contract.js';

const ask = (s, action, params, o = {}) => s.ai.post('/v1/ai/ask', { action, params, ...o });
const priceAsk = (credits = 450) => ({ product: 'demo_product', item: 'sample_item', credits });

test('an AI key can read, and every answer flags text written by others', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 700, 'p1');
  const b = await s.ai.get('/v1/balance?email=a@x.com');
  assert.equal(b.status, 200);
  assert.equal(b.body.balance, 700);
  assert.ok(b.body.untrusted.note.length > 20);
  assert.ok(b.body.untrusted.fields.includes('display.label'));
  assert.equal(b.body.buckets, undefined); // no details for an AI key
  assert.equal((await s.ai.get('/v1/balance?email=a@x.com&details=1')).body.buckets, undefined);
  for (const p of ['/v1/quote?credits=100', '/v1/catalogue?product=demo_product', '/v1/history?email=a@x.com', '/v1/admin/reconcile', '/v1/ai/approvals']) {
    const r = await s.ai.get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.body.untrusted, p);
  }
  assert.deepEqual((await s.ai.get('/v1/catalogue?product=demo_product')).body.untrusted.fields, ['items[].product', 'items[].item']);
});

test('an AI key is refused on every route that changes anything', async () => {
  const s = await setup();
  const calls = [
    ['post', '/v1/credit_purchase', { email: 'a@x.com', amount: 100, paid_minor: 100, currency: 'USD', payment_ref: 'z1' }],
    ['post', '/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 10, ref: 'r1' }],
    ['post', '/v1/event', { email: 'a@x.com', event_type: 'account_created', event_key: 'k1' }],
    ['post', '/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o', amount_minor: 100, currency: 'USD' }],
    ['post', '/v1/spend/reserve_item', { email: 'a@x.com', product: 'demo_product', item: 'sample_item', order_ref: 'o' }],
    ['post', '/v1/spend/capture', { hold_id: 'h' }],
    ['post', '/v1/spend/release', { hold_id: 'h' }],
    ['post', '/v1/refund', { type: 'order', hold_id: 'h' }],
    ['post', '/v1/convert_request', { email: 'a@x.com', credits: 1500 }],
    ['post', '/v1/buy_credits', { email: 'a@x.com', credits: 1000, order_ref: 'b' }],
    ['post', '/v1/rail/confirm', { order_id: 'o', payment_ref: 'p', paid_minor: 1, currency: 'USD' }],
    ['put', '/v1/admin/settings', { kill_switch: 0 }],
    ['put', '/v1/admin/catalogue', { product: 'p', item: 'i', credits: 1 }],
    ['post', '/v1/admin/rules', { event_type: 'x_done', bucket: 'bonus', amount: 1, mode: 'once' }],
    ['post', '/v1/admin/sweep', {}],
    ['post', '/v1/admin/freeze', { email: 'a@x.com' }],
    ['post', '/v1/admin/approvals/apr_x/approve', {}],
    ['post', '/v1/admin/conversions/cnv_x/approve', {}],
    ['post', '/v1/admin/webhooks', { url: 'https://hooks.example.com/x' }],
  ];
  for (const [m, p, b] of calls) assert.equal((await s.ai[m](p, b)).body.error.code, 'wrong_key_type', p);
  assert.equal((await s.ai.get('/v1/admin/settings')).body.error.code, 'wrong_key_type');
  assert.equal((await s.ai.get('/v1/admin/audit')).body.error.code, 'wrong_key_type');
  assert.equal((await s.ai.get('/v1/admin/approvals')).body.error.code, 'wrong_key_type');
});

test('an ask changes nothing; a person approves and only then it runs, once', async () => {
  const s = await setup();
  const a = await ask(s, 'price_change', priceAsk(450), { note: 'quiet week' });
  assert.equal(a.status, 200);
  assert.equal(a.body.status, 'pending');
  const price = async () => (await s.admin.get('/v1/admin/catalogue?product=demo_product')).body.items[0].credits;
  assert.equal(await price(), 500); // nothing done
  const list = (await s.admin.get('/v1/admin/approvals?status=pending')).body.approvals;
  assert.equal(list.length, 1);
  assert.equal(list[0].params.credits, 450);
  assert.equal((await s.ai.post(`/v1/admin/approvals/${a.body.approval_id}/approve`, {})).status, 403);
  assert.equal(await price(), 500);
  const ok = await s.admin.post(`/v1/admin/approvals/${a.body.approval_id}/approve`, {});
  assert.equal(ok.body.status, 'approved');
  assert.equal(await price(), 450);
  assert.equal((await s.admin.post(`/v1/admin/approvals/${a.body.approval_id}/approve`, {})).body.error.code, 'already_decided');
  const mine = (await s.ai.get('/v1/ai/approvals')).body.approvals[0];
  assert.equal(mine.status, 'approved');
  assert.equal(mine.result.credits, 450);
  // another AI key class member cannot see them: a second tenant's AI key sees none
});

test('reject does nothing; an expired request cannot be approved; the sweep marks it expired', async () => {
  const s = await setup();
  const a = (await ask(s, 'price_change', priceAsk(1))).body.approval_id;
  assert.equal((await s.admin.post(`/v1/admin/approvals/${a}/reject`, {})).body.status, 'rejected');
  assert.equal((await s.admin.post(`/v1/admin/approvals/${a}/approve`, {})).body.error.code, 'already_decided');
  const b = (await ask(s, 'price_change', priceAsk(2))).body.approval_id;
  s.clock.t += 25 * HOUR;
  assert.equal((await s.admin.post(`/v1/admin/approvals/${b}/approve`, {})).body.error.code, 'approval_expired');
  await s.admin.post('/v1/admin/sweep', {});
  assert.equal((await s.ai.get('/v1/ai/approvals?status=expired')).body.approvals.length, 1);
  assert.equal((await s.admin.get('/v1/admin/catalogue?product=demo_product')).body.items[0].credits, 500);
});

test('spend, refund, conversion, payout and rate change are all ask-only', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await buy(s.api, 'a@x.com', 1000, 'p1');
  // spend
  const sp = (await ask(s, 'credit_spend', { email: 'a@x.com', product: 'demo_product', item: 'sample_item', order_ref: 'ai-o1' })).body.approval_id;
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  const done = await s.admin.post(`/v1/admin/approvals/${sp}/approve`, {});
  assert.equal(done.body.result.credits, 500);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500);
  // refund of that order is a different request: capture first by the product, then ask to return
  await s.api.post('/v1/spend/capture', { hold_id: done.body.result.hold_id });
  const rf = (await ask(s, 'refund', { type: 'order', hold_id: done.body.result.hold_id })).body.approval_id;
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500);
  assert.equal((await s.admin.post(`/v1/admin/approvals/${rf}/approve`, {})).body.result.returned_credits, 500);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  // rate change
  const rc = (await ask(s, 'rate_change', { settings: { fx_margin_bps: 300 } })).body.approval_id;
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.fx_margin_bps, 500);
  await s.admin.post(`/v1/admin/approvals/${rc}/approve`, {});
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.fx_margin_bps, 300);
  // conversion then payout steps
  await note(s.api, 'S1', 20000, 'USD', 'b@y.com');
  await s.api.post('/v1/event', { email: 'c@x.com', event_type: 'referral_sale_paid', event_key: 'e1', payer_email: 'b@y.com', cash_minor: 20000, currency: 'USD', sale_ref: 'S1' });
  s.clock.t += 8 * 24 * HOUR;
  const cv = (await ask(s, 'conversion', { email: 'c@x.com', credits: 2000 })).body.approval_id;
  assert.equal((await s.db.all('SELECT * FROM conversion_request')).length, 0);
  const cr = await s.admin.post(`/v1/admin/approvals/${cv}/approve`, {});
  const po = (await ask(s, 'payout', { conversion_id: cr.body.result.request_id, step: 'approve' })).body.approval_id;
  assert.equal((await s.db.first('SELECT status FROM conversion_request')).status, 'requested');
  await s.admin.post(`/v1/admin/approvals/${po}/approve`, {});
  assert.equal((await s.db.first('SELECT status FROM conversion_request')).status, 'approved');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('things an AI key may never even ask for', async () => {
  const s = await setup();
  const code = async (action, params) => (await ask(s, action, params)).body.error.code;
  assert.equal(await code('chargeback', { payment_ref: 'p' }), 'action_not_askable');
  assert.equal(await code('mark_paid', {}), 'action_not_askable');
  assert.equal(await code('payout', { conversion_id: 'c', step: 'mark_paid' }), 'bad_ask');
  assert.equal(await code('refund', { type: 'chargeback', payment_ref: 'p' }), 'bad_ask');
  assert.equal(await code('rate_change', { settings: { kill_switch: 0 } }), 'bad_ask');
  assert.equal(await code('rate_change', { settings: { ai_enabled: 1 } }), 'bad_ask');
  assert.equal(await code('price_change', { product: 'bad item', item: 'x', credits: 5 }), 'bad_request');
  assert.equal((await ask(s, 'price_change', 'nope')).body.error.code, 'bad_ask');
  assert.equal((await s.admin.get('/v1/admin/approvals')).body.approvals.length, 0);
});

test('an ask is idempotent, and one AI key cannot flood the approvers', async () => {
  const s = await setup();
  const o = { idem: 'same-ask' };
  const a = await s.ai.post('/v1/ai/ask', { action: 'price_change', params: priceAsk(5) }, o);
  const b = await s.ai.post('/v1/ai/ask', { action: 'price_change', params: priceAsk(5) }, o);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(a.body.approval_id, b.body.approval_id);
  assert.equal((await s.admin.get('/v1/admin/approvals')).body.approvals.length, 1);
  await s.admin.put('/v1/admin/settings', { ai_pending_max: 3 });
  await ask(s, 'price_change', priceAsk(6));
  await ask(s, 'price_change', priceAsk(7));
  const over = await ask(s, 'price_change', priceAsk(8));
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'too_many_pending');
  assert.equal((await s.ai.post('/v1/ai/ask', { action: 'price_change', params: priceAsk(9) }, { idem: null })).body.error.code, 'idempotency_key_required');
});

test('an AI key has its own rate limit', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { ai_rate_per_minute: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.ai.get('/v1/quote?credits=100')).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal((await s.read.get('/v1/quote?credits=100')).status, 200); // other keys are not affected
});

test('the audit log records the key id and the kind of caller, and stays a valid chain', async () => {
  const s = await setup();
  const a = (await ask(s, 'price_change', priceAsk(450))).body.approval_id;
  await s.ai.get('/v1/balance?email=a@x.com');
  await s.admin.post(`/v1/admin/approvals/${a}/approve`, {});
  const rows = (await s.admin.get('/v1/admin/audit?limit=50')).body.entries;
  const by = (act) => rows.find((r) => r.action === act);
  assert.equal(by('approval.requested').caller_type, 'ai');
  assert.equal(by('ai.read').caller_type, 'ai');
  assert.equal(by('ai.ask').caller_type, 'ai');
  assert.equal(by('approval.approve').caller_type, 'human');
  assert.equal(by('catalogue.set').caller_type, 'human'); // the approved change ran as the person
  assert.match(by('approval.approve').key_id, /^mk_/);
  assert.notEqual(by('approval.approve').key_id, by('approval.requested').key_id);
  assert.equal(by('tenant.create').caller_type, 'owner');
  assert.equal((await verifyAudit(s.ctx())).ok, true);
  await assert.rejects(() => s.db.run("UPDATE audit_log SET caller_type = 'human'"));
  await assert.rejects(() => s.db.run('DELETE FROM audit_log'));
});

test('tenant kill switch stops everyone but admin; ai_enabled stops only AI keys', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { ai_enabled: false });
  assert.equal((await s.ai.get('/v1/quote?credits=100')).body.error.code, 'ai_off');
  assert.equal((await s.read.get('/v1/quote?credits=100')).status, 200);
  await s.admin.put('/v1/admin/settings', { ai_enabled: true, kill_switch: true });
  for (const c of [s.api, s.read, s.ai]) assert.equal((await c.get('/v1/quote?credits=100')).body.error.code, 'paused');
  assert.equal((await s.pay.post('/v1/credit_purchase', { email: 'a@x.com', amount: 100, paid_minor: 100, currency: 'USD', payment_ref: 'k1' })).body.error.code, 'paused');
  assert.equal((await s.api.post('/v1/event', { email: 'a@x.com', event_type: 'account_created', event_key: 'k' })).status, 503);
  assert.equal((await s.admin.get('/v1/admin/settings')).status, 200);
  assert.equal((await s.admin.put('/v1/admin/settings', { kill_switch: false })).status, 200);
  assert.equal((await s.read.get('/v1/quote?credits=100')).status, 200);
});

test('global off-switch (the Hub status file): off, read-only, one action off, and unreadable', async () => {
  const s = await setup();
  let st = { hub: { mode: 'on' }, products: { mnp: { mode: 'on', reads_allowed: true, writes_allowed: true, disabled_actions: [] } } };
  s.app.status = async () => st;
  assert.equal((await s.read.get('/v1/quote?credits=100')).status, 200);
  st = { hub: { mode: 'on' }, products: { mnp: { mode: 'off', reason: 'maintenance' } } };
  const off = await s.read.get('/v1/quote?credits=100');
  assert.equal(off.body.error.code, 'paused_global');
  assert.equal((await s.admin.get('/v1/admin/settings')).status, 200); // a person can always look
  st = { hub: { mode: 'off' }, products: {} };
  assert.equal((await s.api.get('/v1/catalogue')).body.error.code, 'paused_global');
  st = { hub: { mode: 'on' }, products: { mnp: { mode: 'on', reads_allowed: true, writes_allowed: false, disabled_actions: [] } } };
  assert.equal((await s.read.get('/v1/quote?credits=100')).status, 200);
  assert.equal((await s.api.post('/v1/event', { email: 'a@x.com', event_type: 'account_created', event_key: 'k' })).body.error.code, 'paused_global');
  st = { hub: { mode: 'on' }, products: { mnp: { mode: 'on', reads_allowed: true, writes_allowed: true, disabled_actions: ['getQuote'] } } };
  assert.equal((await s.read.get('/v1/quote?credits=100')).body.error.code, 'action_disabled');
  assert.equal((await s.read.get('/v1/catalogue')).status, 200);
  st = null; // the switch cannot be read: people carry on, an AI key does not
  assert.equal((await s.read.get('/v1/quote?credits=100')).status, 200);
  const ai = await s.ai.get('/v1/quote?credits=100');
  assert.equal(ai.status, 503);
  assert.equal(ai.body.error.code, 'status_unknown');
});

test('no answer carries a secret', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 700, 'p1');
  await ask(s, 'price_change', priceAsk(450));
  const bodies = [];
  for (const [c, p] of [[s.admin, '/v1/admin/settings'], [s.admin, '/v1/admin/audit'], [s.admin, '/v1/admin/health'], [s.admin, '/v1/admin/rules'], [s.admin, '/v1/admin/approvals'], [s.ai, '/v1/ai/approvals'], [s.ai, '/v1/balance?email=a@x.com'], [s.api, '/v1/history?email=a@x.com'], [s.read, '/v1/catalogue']]) bodies.push(JSON.stringify((await c.get(p)).body));
  bodies.push(JSON.stringify((await s.api.post('/v1/spend/capture', { hold_id: 'nope' })).body));
  bodies.push(await (await s.app.fetch(new Request('http://t.local/health'))).text());
  bodies.push(await (await s.app.fetch(new Request('http://t.local/v1/balance'))).text());
  const all = bodies.join('\n');
  assert.ok(!all.includes(s.master));
  for (const k of await s.db.all('SELECT key_id FROM api_key')) assert.ok(!all.includes(await keySecret(s.master, k.key_id)), k.key_id);
  assert.ok(!/stack|at file:|node:internal|SQLITE/i.test(all));
});

test('contract: every route is described, flags are complete, and the file is up to date', async () => {
  const doc = buildContract();
  const file = JSON.parse(readFileSync(new URL('../contract/v1/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, doc, 'contract/v1/openapi.json is out of date: run node scripts/gen-contract.js');
  const key = (m, p) => `${m} ${p}`;
  const ops = new Set(OPS.map((o) => key(o.method, o.path)));
  for (const r of ROUTES) assert.ok(ops.has(key(r[0], r[1])), `route ${r[0]} ${r[1]} has no contract entry`);
  const routes = new Set(ROUTES.map((r) => key(r[0], r[1])));
  for (const o of OPS) if (!o.path.includes('{') && o.path !== '/health') assert.ok(routes.has(key(o.method, o.path)), `contract ${o.method} ${o.path} has no route`);
  const codes = doc['x-error-codes'];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(item)) {
      const where = `${m} ${path}`;
      assert.ok(op.operationId && op.summary && op.description, where);
      assert.ok(['read', 'write'].includes(op['x-rw']), where);
      assert.equal(typeof op['x-money'], 'boolean', where);
      assert.ok(['public', 'read', 'spend', 'purchase', 'admin', 'ai_ask'].includes(op['x-permission-level']), where);
      assert.ok(['read', 'ask', 'no'].includes(op['x-ai'].access), where);
      assert.equal(op['x-rw'] === 'write', m !== 'get', where);
      if (op['x-ai'].access === 'read') assert.equal(op['x-rw'], 'read', where);
      if (op['x-ai'].access === 'no' && op['x-key-classes'].includes('ai_read')) assert.fail(where);
      if (op['x-ai'].access === 'read') assert.ok(op['x-key-classes'].includes('ai_read'), where);
      if (op['x-requires-idempotency-key']) assert.equal(op['x-rw'], 'write', where);
      for (const c of op['x-error-codes']) assert.ok(codes[c], `${where}: unknown error code ${c}`);
    }
  }
  // an AI key may only reach read operations and the one ask route
  for (const r of ROUTES.filter((x) => x[2].includes('ai_read'))) assert.ok(r[0] === 'GET' || r[1] === '/v1/ai/ask', r[1]);
  // every write that moves money is flagged
  for (const o of OPS.filter((x) => x.rw === 'write' && /spend|capture|refund|credit|convert|buy|confirm|event|settings|catalogue|rules|conversions|approvals/.test(x.path))) assert.equal(o.money, true, o.path);
});
