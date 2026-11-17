import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, MIN } from './helpers.js';
import { drain, webhookSecret } from '../src/outbox.js';
import { hmacHex } from '../src/util.js';
import { verifyAudit } from '../src/audit.js';

// ---------- signing, replay ----------
test('unsigned and badly signed calls are refused', async () => {
  const s = await setup();
  const r = await s.app.fetch(new Request('http://t.local/v1/balance?email=a@x.com'));
  assert.equal(r.status, 401);
  assert.equal((await s.api.get('/v1/balance?email=a@x.com', { sign: false })).status, 401);
});

test('a signed request cannot be replayed', async () => {
  const s = await setup();
  const o = { nonce: 'fixed-nonce-1' };
  assert.equal((await s.api.get('/v1/balance?email=a@x.com', o)).status, 200);
  const again = await s.api.get('/v1/balance?email=a@x.com', o);
  assert.equal(again.status, 401);
  assert.equal(again.body.error.code, 'replayed');
});

test('old or far-future timestamps are refused', async () => {
  const s = await setup();
  assert.equal((await s.api.get('/v1/balance?email=a@x.com', { ts: s.clock.t - 6 * MIN })).body.error.code, 'stale_timestamp');
  assert.equal((await s.api.get('/v1/balance?email=a@x.com', { ts: s.clock.t + 6 * MIN })).body.error.code, 'stale_timestamp');
  assert.equal((await s.api.get('/v1/balance?email=a@x.com', { ts: s.clock.t - 4 * MIN })).status, 200);
});

test('changing the path or body after signing breaks the signature', async () => {
  const s = await setup();
  const a = await s.api.get('/v1/balance?email=a@x.com');
  // Re-send the same signed headers against a different query
  const ts = String(s.clock.t);
  const { keySecret, signString } = await import('../src/auth.js');
  const { sha256Hex } = await import('../src/util.js');
  const sig = await hmacHex(await keySecret(s.master, s.demo.api.key_id), signString(ts, 'nn1', 'GET', '/v1/balance?email=a@x.com', await sha256Hex('')));
  const res = await s.app.fetch(new Request('http://t.local/v1/balance?email=other@x.com', { headers: { 'x-mnp-key': s.demo.api.key_id, 'x-mnp-timestamp': ts, 'x-mnp-nonce': 'nn1', 'x-mnp-signature': sig } }));
  assert.equal(a.status, 200);
  assert.equal(res.status, 401);
});

test('a revoked key stops working at once', async () => {
  const s = await setup();
  await s.db.run("UPDATE api_key SET status = 'revoked' WHERE key_id = ?", s.demo.api.key_id);
  assert.equal((await s.api.get('/v1/balance?email=a@x.com')).status, 401);
});

test('api keys and admin keys are not interchangeable', async () => {
  const s = await setup();
  assert.equal((await s.api.get('/v1/admin/settings')).status, 403);
  assert.equal((await s.admin.get('/v1/balance?email=a@x.com')).status, 403);
});

test('rate limit per key', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { api_rate_per_minute: 5 });
  let last;
  for (let i = 0; i < 6; i++) last = await s.api.get('/v1/balance?email=a@x.com');
  assert.equal(last.status, 429);
  s.clock.t += MIN;
  assert.equal((await s.api.get('/v1/balance?email=a@x.com')).status, 200);
});

test('writes need an Idempotency-Key', async () => {
  const s = await setup();
  const r = await buy(s.api, 'a@x.com', 100, 'p1');
  assert.equal(r.status, 200);
  const none = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 1, ref: 'r1' }, { idem: null });
  assert.equal(none.body.error.code, 'idempotency_key_required');
  const adminNone = await s.admin.put('/v1/admin/settings', { unit_name: 'X' }, { idem: null });
  assert.equal(adminNone.status, 400);
});

test('same key + same request replays; same key + different request conflicts', async () => {
  const s = await setup();
  const body = { email: 'a@x.com', bucket: 'bought', amount: 100, paid_minor: 100, currency: 'USD', payment_ref: 'p1' };
  const a = await s.api.pay.post('/v1/credit_purchase', body, { idem: 'K1' });
  const b = await s.api.pay.post('/v1/credit_purchase', body, { idem: 'K1' });
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(a.body, b.body);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
  const c = await s.api.pay.post('/v1/credit_purchase', { ...body, amount: 50 }, { idem: 'K1' });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'idempotency_conflict');
  const rows = await s.db.all("SELECT * FROM entry WHERE kind = 'purchase'");
  assert.equal(rows.length, 1);
});

test('a failed call changes nothing and can be retried with the same key', async () => {
  const s = await setup();
  const bad = { email: 'a@x.com', bucket: 'bought', amount: 9999, paid_minor: 100, currency: 'USD', payment_ref: 'p1' };
  assert.equal((await s.api.pay.post('/v1/credit_purchase', bad, { idem: 'K2' })).status, 422);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  assert.equal((await s.db.all('SELECT * FROM account')).length, 0); // rolled back, even the account row
  assert.equal((await s.api.pay.post('/v1/credit_purchase', { ...bad, amount: 100 }, { idem: 'K2' })).status, 200); // a failed call leaves no trace, so the key is free
});

test('bad JSON, unknown route, giant body', async () => {
  const s = await setup();
  const mkRaw = async (method, path, text) => {
    const { keySecret, signString } = await import('../src/auth.js');
    const { sha256Hex } = await import('../src/util.js');
    const ts = String(s.clock.t), nonce = `x${Math.random()}`, idemK = `k${Math.random()}`;
    const sig = await hmacHex(await keySecret(s.master, s.demo.api.key_id), signString(ts, nonce, method, path, await sha256Hex(text), idemK));
    return s.app.fetch(new Request(`http://t.local${path}`, { method, body: text, headers: { 'x-mnp-key': s.demo.api.key_id, 'x-mnp-timestamp': ts, 'x-mnp-nonce': nonce, 'x-mnp-signature': sig, 'idempotency-key': idemK } }));
  };
  assert.equal((await mkRaw('POST', '/v1/event', '{nope')).status, 400);
  assert.equal((await mkRaw('POST', '/v1/nothing', '{}')).status, 404);
  assert.equal((await mkRaw('POST', '/v1/event', 'x'.repeat(70000))).status, 413);
});

// ---------- tenant isolation ----------
test('tenants cannot see or touch each other', async () => {
  const s = await setup({ other: true });
  const b = s.mkT(s.other);
  await buy(s.api, 'a@x.com', 1000, 'pay-1');
  assert.equal((await bal(b, 'a@x.com')).balance, 0);
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 500, currency: 'USD' });
  assert.equal((await b.post('/v1/spend/capture', { hold_id: r.body.hold_id })).status, 404);
  assert.equal((await b.post('/v1/spend/release', { hold_id: r.body.hold_id })).status, 404);
  assert.equal((await b.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'pay-1' })).status, 404);
  assert.equal((await b.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id })).status, 404);
  const cbOther = await b.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'pay-1-x' }); // unknown to tenant B: only noted there
  assert.equal(cbOther.body.removed_credits, 0);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500); // untouched
  // the same payment reference and e-mail are independent per tenant
  assert.equal((await buy(b, 'a@x.com', 700, 'pay-1')).status, 200);
  assert.equal((await bal(b, 'a@x.com')).balance, 700);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500);
  // the other tenant has no demo rules
  assert.equal((await event(b, 'z@x.com', 'account_created')).body.reason, 'no_rule');
  // separate ledgers, each chain starts at 1
  const seqs = await s.db.all("SELECT tenant_id, MIN(seq) m FROM entry GROUP BY tenant_id ORDER BY tenant_id");
  assert.deepEqual(seqs.map((x) => x.m), [1, 1]);
  // admin keys only reach their own tenant's settings and rules
  const ba = b.admin;
  await ba.put('/v1/admin/settings', { currency_name: 'Pts' });
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.currency_name, 'Moneypenny');
  assert.equal((await ba.get('/v1/admin/rules')).body.rules.length, 0);
  assert.equal((await s.admin.get('/v1/admin/rules')).body.rules.length, 5);
});

test('rule ids from another tenant cannot be edited', async () => {
  const s = await setup({ other: true });
  const rules = (await s.admin.get('/v1/admin/rules')).body.rules;
  const ba = s.mkT(s.other).admin;
  assert.equal((await ba.put(`/v1/admin/rules/${rules[0].id}`, { amount: 99999 })).status, 404);
  assert.equal((await ba.del(`/v1/admin/rules/${rules[0].id}`)).status, 404);
});

// ---------- webhook outbox ----------
test('events are signed and delivered; failures retry with back-off', async () => {
  const s = await setup();
  const w = await s.admin.post('/v1/admin/webhooks', { url: 'https://hooks.example.com/mnp' });
  assert.equal(w.status, 200);
  assert.equal((await s.admin.post('/v1/admin/webhooks', { url: 'http://hooks.example.com/mnp' })).status, 400);
  await buy(s.api, 'a@x.com', 100, 'p1');
  const sent = [];
  let fail = true;
  const send = async (url, init) => { sent.push({ url, ...init }); return { status: fail ? 500 : 200 }; };
  const c = s.ctx();
  assert.equal((await drain(c, send)).sent, 0);
  assert.equal((await drain(c, send)).tried, 0); // backing off
  fail = false;
  s.clock.t += 3 * MIN;
  assert.equal((await drain(c, send)).sent, 1);
  const last = sent.at(-1);
  const sig = await hmacHex(await webhookSecret(s.master, w.body.id), `${last.headers['x-mnp-timestamp']}.${last.body}`);
  assert.equal(last.headers['x-mnp-signature'], sig);
  const ev = JSON.parse(last.body);
  assert.equal(ev.type, 'credit.added');
  assert.ok(!JSON.stringify(ev).includes('a@x.com')); // no e-mail leaves in events
  assert.equal((await drain(c, send)).tried, 0);
});

test('events wait in the outbox when no webhook is set up', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p1');
  assert.equal((await drain(s.ctx(), async () => ({ status: 200 }))).sent, 0);
  assert.equal((await s.db.all("SELECT * FROM outbox WHERE status = 'pending'")).length, 1);
});

// ---------- tenant admin + audit ----------
test('every setting and rule change is audited, and the audit chain verifies', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { bonus_max_order_pct: 30, credits_per_usd: 200 });
  const rules = (await s.admin.get('/v1/admin/rules')).body.rules;
  await s.admin.put(`/v1/admin/rules/${rules[0].id}`, { amount: 150 });
  await s.admin.del(`/v1/admin/rules/${rules[1].id}`);
  const a = (await s.admin.get('/v1/admin/audit')).body.entries.map((e) => e.action);
  for (const x of ['setting.change', 'rule.update', 'rule.disable', 'rule.create', 'tenant.create']) assert.ok(a.includes(x), x);
  assert.deepEqual(await verifyAudit(s.ctx()), { ok: true, entries: (await verifyAudit(s.ctx())).entries });
  const d = JSON.parse((await s.db.all("SELECT detail FROM audit_log WHERE action = 'setting.change' ORDER BY seq"))[0].detail);
  assert.deepEqual([d.key, d.from, d.to], ['bonus_max_order_pct', 50, 30]);
  s.db.exec('DROP TRIGGER audit_no_update');
  s.db.exec("UPDATE audit_log SET detail = '{}' WHERE seq = 3");
  assert.equal((await verifyAudit(s.ctx())).ok, false);
  assert.equal((await s.admin.get('/v1/admin/health')).body.audit.ok, false);
});

test('bad settings are refused and change nothing', async () => {
  const s = await setup();
  for (const bad of [{ bonus_max_order_pct: 150 }, { nope: 1 }, { credits_per_usd: 0 }, { theme_accent: 'red' }, { unit_name: '<b>x</b>' }, { blocked_email_domains: 'x' }]) {
    assert.equal((await s.admin.put('/v1/admin/settings', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await s.admin.put('/v1/admin/settings', { bonus_max_order_pct: 40, nope: 1 })).status, 400);
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.bonus_max_order_pct, 50);
});

test('rule changes take effect at once; disabled rule pays nothing', async () => {
  const s = await setup();
  const rules = (await s.admin.get('/v1/admin/rules')).body.rules;
  const ac = rules.find((r) => r.event_type === 'account_created');
  await s.admin.put(`/v1/admin/rules/${ac.id}`, { amount: 40 });
  assert.equal((await event(s.api, 'a@x.com', 'account_created')).body.granted, 40);
  await s.admin.del(`/v1/admin/rules/${ac.id}`);
  assert.equal((await event(s.api, 'b@x.com', 'account_created')).body.reason, 'no_rule');
  assert.equal((await s.admin.post('/v1/admin/rules', { event_type: 'account_created', bucket: 'bonus', amount: 1, mode: 'once' })).status, 409);
});

test('settings drive the display: rate and wording', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { credits_per_usd: 200 });
  await buy(s.api, 'a@x.com', 1000, 'p1');
  assert.equal((await bal(s.api, 'a@x.com')).display.usd, '5.00');
});

test('health endpoint reports a clean chain', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p1');
  const h = (await s.admin.get('/v1/admin/health')).body;
  assert.equal(h.chain.ok, true);
  assert.deepEqual(h.balance_mismatches, []);
});

test('admin page loads without any secret in it', async () => {
  const s = await setup();
  const r = await s.app.fetch(new Request('http://t.local/admin'));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Moneypenny admin'));
  assert.ok(!html.includes(s.master));
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'none'"));
});
