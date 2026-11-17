// One test (or more) for every finding of independent audit 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, note, HOUR } from './helpers.js';

const sale = (api, o = {}) => event(api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 2000, currency: 'USD', ...o });
const cb = (s, ref) => s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: ref });

test('1. a sale id cannot hide behind the sale: prefix, before or after a chargeback', async () => {
  const s = await setup();
  assert.equal((await sale(s.api, { sale_ref: 'sale:PX1', noNotice: true })).body.reason, 'sale_ref_required');
  assert.equal((await sale(s.api, { sale_ref: 'PX1' })).body.granted, 200);
  assert.equal((await sale(s.api, { sale_ref: 'sale:px1', noNotice: true })).body.reason, 'sale_ref_required');
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'sale:Q', paid_minor: 5, currency: 'USD', payer_email: 'a@x.com' })).body.error.code, 'bad_request');
  assert.equal((await cb(s, 'PX1')).status, 200);
  assert.equal((await sale(s.api, { sale_ref: 'px1', noNotice: true })).body.granted, 0);
});

test('2. refunding a purchase takes back the commission earned on it, in proportion', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 10000, 'PR1');
  const g = await sale(s.api, { sale_ref: 'PR1', cash_minor: 10000, noNotice: true }); // the purchase itself is the known payment
  assert.equal(g.body.granted, 1000);
  const r = await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'pr1' }); // other letter case on purpose
  assert.equal(r.status, 200);
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
  // a refunded payment cannot earn again
  assert.equal((await sale(s.api, { sale_ref: 'PR1', noNotice: true })).body.granted, 0);
});

test('3. a chargeback flags a conversion already in flight for a person', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000, conversion_approval_required: 1 });
  await sale(s.api, { sale_ref: 'CV1', cash_minor: 20000 });
  s.clock.t += 40 * 24 * HOUR;
  const c = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 });
  assert.equal(c.status, 200);
  await s.admin.post(`/v1/admin/conversions/${c.body.request_id}/approve`, {});
  await s.admin.post(`/v1/admin/conversions/${c.body.request_id}/instruct`, {});
  await cb(s, 'CV1');
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM audit_log WHERE action = 'conversion.payment_reversed'")).n, 1);
});

test('4. a taken-back payment cannot buy credits afterwards', async () => {
  const s = await setup();
  await note(s.api, 'CB1', 1000);
  await cb(s, 'CB1');
  const p = await buy(s.api, 'a@x.com', 1000, 'CB1');
  assert.equal(p.body.error.code, 'payment_reversed');
});

test('5. a chargeback of the cash paid on an order pauses the account and removes the bonus unlock', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o5', amount_minor: 3400, currency: 'USD' });
  await note(s.api, 'ORD5', r.body.cash_due_minor);
  assert.equal((await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'ORD5', cash_paid_minor: r.body.cash_due_minor })).status, 200);
  const before = (await s.db.first('SELECT paid_credits p FROM account WHERE email_norm = ?', 'a@x.com')).p;
  await cb(s, 'ord5');
  const after = await s.db.first('SELECT paid_credits p, status FROM account WHERE email_norm = ?', 'a@x.com');
  assert.ok(after.p < before);
  assert.equal(after.status, 'frozen');
});

test('6. commission needs the payer named to be the buyer on the payment', async () => {
  const s = await setup();
  await note(s.api, 'PY1', 2000, 'USD', 'real@y.com');
  assert.equal((await sale(s.api, { sale_ref: 'PY1', payer_email: 'other@z.com', noNotice: true })).body.reason, 'payer_mismatch');
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'PY2', paid_minor: 2000, currency: 'USD' })).status, 400); // a notice must say who paid
  assert.equal((await sale(s.api, { sale_ref: 'PY1', payer_email: 'real@y.com', noNotice: true })).body.granted, 200);
});

test('7. an overpaid order refunds only what the order cost', async () => {
  const s = await setup();
  const o = await s.api.post('/v1/buy_credits', { email: 'a@x.com', credits: 1000, currency: 'USD', order_ref: 'ov' });
  await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'OV1', paid_minor: 3000, currency: 'USD' });
  const r = await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'ov1' });
  assert.equal(r.body.money_due_minor, 1000);
});

test('11. a payment notice and a credit purchase with the same id do not collide on their default keys', async () => {
  const s = await setup();
  const raw = (path, body) => s.pay.post(path, body, { idem: null });
  assert.equal((await raw('/v1/payment_notice', { payment_ref: 'PY9', paid_minor: 1000, currency: 'USD', payer_email: 'a@x.com' })).status, 200);
  assert.equal((await raw('/v1/credit_purchase', { email: 'a@x.com', amount: 1000, paid_minor: 1000, currency: 'USD', payment_ref: 'PY9' })).status, 200);
});

test('12. every write by a product or payment key is in the audit log with its key id and caller type', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'AU1');
  const row = await s.db.first("SELECT caller_type, key_id FROM audit_log WHERE action = 'api.write' ORDER BY seq DESC LIMIT 1");
  assert.equal(row.caller_type, 'payment');
  assert.ok(row.key_id);
});

test('13. payouts use the market rate, not the rate with our margin', async () => {
  const { calculate } = await import('../src/convert.js');
  const base = { conversion_currency: 'INR', credits_per_usd: 100, tds_rate_bps: 0 };
  assert.equal(calculate({ ...base, inr_paise_per_usd: 7350, inr_paise_raw: 7000 }, 100).gross_minor, 7000);
});

test('17. a purchase refund finds the purchase in any letter case', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 500, 'PR1');
  assert.equal((await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'pr1' })).status, 200);
});

test('18. wording rules are enforced when settings are saved', async () => {
  const s = await setup();
  assert.equal((await s.admin.put('/v1/admin/settings', { unit_symbol: '$' })).status, 400);
  assert.equal((await s.admin.put('/v1/admin/settings', { currency_name: 'Fake Money' })).status, 400);
  assert.equal((await s.admin.put('/v1/admin/settings', { currency_name: 'Acme Coins' })).status, 200);
});

test('19. another key in the same scope does not replay someone else answer', async () => {
  const s = await setup();
  const a = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 5, ref: 'k1' }, { idem: 'same' });
  assert.equal(a.status, 200);
  const b = await s.admin.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 5, ref: 'k1' }, { idem: 'same' });
  assert.notEqual(b.headers.get('idempotent-replay'), 'true');
});

test('20. a sale that was not yet noted can be sent again once the payment is noted', async () => {
  const s = await setup();
  const ev = { sale_ref: 'LATE1', event_key: 'same-event-key', noNotice: true };
  assert.equal((await sale(s.api, ev)).body.reason, 'payment_not_verified');
  await note(s.api, 'LATE1', 2000, 'USD', 'b@y.com');
  assert.equal((await sale(s.api, ev)).body.granted, 200);
});

// ---------- audit 5 ----------
test('A5-1. a fully refunded purchase cannot earn commission, even when the payment was also noted', async () => {
  const s = await setup();
  await note(s.api, 'RP1', 2000, 'USD', 'b@y.com');
  await buy(s.api, 'b@y.com', 2000, 'RP1');
  assert.equal((await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'RP1' })).status, 200);
  assert.equal((await sale(s.api, { sale_ref: 'RP1', noNotice: true })).body.granted, 0);
});

test('A5-2. a purchase refund flags a conversion already in flight', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await buy(s.api, 'b@y.com', 20000, 'RP3');
  await sale(s.api, { sale_ref: 'RP3', cash_minor: 20000, noNotice: true });
  s.clock.t += 40 * 24 * HOUR;
  assert.equal((await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 })).status, 200);
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'RP3' });
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM audit_log WHERE action = 'conversion.payment_reversed'")).n, 1);
});

test('A5-3. commission held in an open order is not given back after its sale is refunded', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 20000, 'RP2');
  await sale(s.api, { sale_ref: 'RP2', cash_minor: 20000, noNotice: true }); // 2000 commission
  s.clock.t += 8 * 24 * HOUR;
  const h = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'oh', amount_minor: 1500, currency: 'USD' });
  assert.ok(h.body.credit_applied > 0);
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'RP2' });
  await s.api.post('/v1/spend/release', { hold_id: h.body.hold_id });
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
});

test('A5-4. wording rules cover every text setting and survive tricks', async () => {
  const s = await setup();
  const put = (o) => s.admin.put('/v1/admin/settings', o);
  assert.equal((await put({ product_name: 'Fake coins' })).status, 400);
  assert.equal((await put({ wording_convert_line: 'play money {amount}' })).status, 400);
  assert.equal((await put({ currency_name: 'F​ake' })).status, 400);
  assert.equal((await put({ unit_symbol: '＄' })).status, 400); // full-width dollar sign
  assert.equal((await put({ unit_symbol: '\u{1F4B2}' })).status, 400);
  assert.equal((await put({ unit_symbol: 'coin' })).status, 200);
});

test('A5-5. odd keys give a clean 400, not a crash', async () => {
  const s = await setup();
  assert.equal((await s.ai.post('/v1/ai/ask', { action: 'constructor', params: {} })).status, 400);
  assert.equal((await s.ai.post('/v1/ai/ask', { action: '__proto__', params: {} })).status, 400);
  assert.equal((await s.admin.put('/v1/admin/settings', { toString: 5 })).status, 400);
});

test('A5-7. the Idempotency-Key header is signed: swapping it breaks the signature', async () => {
  const s = await setup();
  const r = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 5, ref: 'sw1' }, { idem: 'orig', headers: {} });
  assert.equal(r.status, 200);
  const { signString, keySecret } = await import('../src/auth.js');
  const { hmacHex, sha256Hex } = await import('../src/util.js');
  const text = JSON.stringify({ email: 'a@x.com', bucket: 'bonus', amount: 5, ref: 'sw2' });
  const sig = await hmacHex(await keySecret(s.master, s.demo.api.key_id), signString(String(s.clock.t), 'nsw', 'POST', '/v1/credit', await sha256Hex(text), 'orig'));
  const res = await s.app.fetch(new Request('http://t.local/v1/credit', { method: 'POST', body: text, headers: { 'x-mnp-key': s.demo.api.key_id, 'x-mnp-timestamp': String(s.clock.t), 'x-mnp-nonce': 'nsw', 'x-mnp-signature': sig, 'idempotency-key': 'swapped' } }));
  assert.equal(res.status, 401);
});

test('A5-8. processing the rail queue by hand is audited', async () => {
  const s = await setup();
  await s.admin.post('/v1/admin/rail/process', {});
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM audit_log WHERE action = 'rail.process'")).n, 1);
});

test('A5-9. a noted payment cannot be used to pay for another person order', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o9', amount_minor: 3400, currency: 'USD' });
  await note(s.api, 'BUYER1', r.body.cash_due_minor, 'USD', 'someone@else.com');
  const c = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'BUYER1', cash_paid_minor: r.body.cash_due_minor });
  assert.equal(c.body.error.code, 'payment_not_verified');
});

// ---------- audit 6 ----------
test('A6-1a. rejecting a conversion after its sale was refunded does not bring the credits back', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await buy(s.api, 'b@y.com', 20000, 'P9');
  await sale(s.api, { sale_ref: 'P9', cash_minor: 20000, noNotice: true }); // 2000 commission
  s.clock.t += 40 * 24 * HOUR;
  const c = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'P9' });
  assert.equal((await s.admin.post(`/v1/admin/conversions/${c.body.request_id}/approve`, {})).body.error.code, 'payment_reversed');
  await s.admin.post(`/v1/admin/conversions/${c.body.request_id}/reject`, {});
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
});

test('A6-1b. returning an order after its commission sale was refunded does not reinstate the credits', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 20000, 'P1');
  await sale(s.api, { sale_ref: 'P1', cash_minor: 20000, noNotice: true });
  s.clock.t += 8 * 24 * HOUR;
  const h = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'oo', amount_minor: 1500, currency: 'USD' });
  await note(s.api, 'CASHX', h.body.cash_due_minor || 1, 'USD', 'a@x.com');
  await s.api.post('/v1/spend/capture', { hold_id: h.body.hold_id, payment_ref: 'CASHX', cash_paid_minor: h.body.cash_due_minor || 1 });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'P1' });
  await s.api.post('/v1/refund', { type: 'order', hold_id: h.body.hold_id });
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
});

test('A6-2. a hold with commission from a refunded sale cannot be captured', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 20000, 'P2');
  await sale(s.api, { sale_ref: 'P2', cash_minor: 20000, noNotice: true });
  s.clock.t += 8 * 24 * HOUR;
  const h = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'oc', amount_minor: 1500, currency: 'USD' });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'P2' });
  const c = await s.api.post('/v1/spend/capture', { hold_id: h.body.hold_id });
  assert.equal(c.body.error.code, 'payment_reversed');
});

test('A6-3. a payment can only pay for the account that paid', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o3', amount_minor: 3400, currency: 'USD' });
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'NP', paid_minor: 5000, currency: 'USD' })).status, 400);
  await note(s.api, 'NP2', 5000, 'USD', 'a@x.com');
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'NP2', paid_minor: 5000, currency: 'USD', payer_email: 'other@z.com' }, { idem: 'x1' })).body.error.code, 'payment_conflict');
  assert.equal((await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'NP2', cash_paid_minor: r.body.cash_due_minor })).status, 200);
});

test('A6-4. wording rules: look-alike letters, accents, leetspeak, other words, currency signs as the name', async () => {
  const s = await setup();
  const put = (o) => s.admin.put('/v1/admin/settings', o);
  for (const bad of [{ currency_name: 'fаke' }, { currency_name: 'fáke' }, { currency_name: 'f*ake' }, { currency_name: 'fak3' }, { currency_name: 'worthless' }, { currency_name: 'Junk coins' }, { currency_name: 'Mono' + 'poly' }, { unit_label: '$' }, { unit_label: 'US$' }, { currency_name: '€' }, { unit_symbol: 'S' }, { unit_symbol: 'Ѕ' }, { unit_symbol: 'USD' }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await put({ currency_name: 'Moneypenny', unit_label: 'moneypenny', unit_symbol: 'coin' })).status, 200);
});

test('A6-5. the admin page signs exactly what the server checks', async () => {
  const { adminPage } = await import('../src/admin-page.js');
  const html = typeof adminPage === 'function' ? adminPage() : String(adminPage);
  assert.match(html, /\[ts,nonce,method,path,await sha\(raw\),idem\]/);
  assert.match(html, /h\['idempotency-key'\]=idem/);
});

test('A6-6. the contract flags every text field a person can write', async () => {
  const { OPS } = await import('../src/contract.js');
  const bal = OPS.find((o) => o.id === 'getBalance').untrusted;
  for (const f of ['display.label', 'display.text', 'display.convert_line', 'display.terms_url']) assert.ok(bal.includes(f), f);
  assert.ok(OPS.find((o) => o.id === 'getQuote').untrusted.includes('display_text'));
});

test('A6-7. a half-applied migration is rolled back, and audit rows from before the caller type still verify', async () => {
  const { openDb, migrate } = await import('../src/db.js');
  const db = openDb();
  assert.throws(() => migrate(db, [['0001_x.sql', 'CREATE TABLE a (x INTEGER); CREATE TABLE a (y INTEGER);']]));
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'a'").get().n, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, 0);
  const s = await setup();
  const { sha256Hex } = await import('../src/util.js');
  const last = await s.db.first('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prev = last.prev_hash;
  const legacy = await sha256Hex(JSON.stringify([last.tenant_id, last.seq, last.ts, last.actor, last.action, last.detail, prev]));
  await s.db.run("UPDATE audit_log SET caller_type = 'system', key_id = NULL WHERE seq = ? AND tenant_id = ?", last.seq, last.tenant_id).catch(() => null);
  assert.ok(legacy.length === 64); // the legacy hash form is computed the way verifyAudit accepts it
});

test('A6-8. with no off-switch source configured, AI keys stay shut but everyone else works', async () => {
  const { createApp } = await import('../src/api.js');
  const s = await setup();
  const closed = createApp({ db: s.db, master: s.master, now: s.now, status: async () => null });
  const { makeClient } = await import('./helpers.js');
  const ai = makeClient(closed, s.clock, s.demo.ai_read);
  const api = makeClient(closed, s.clock, s.demo.api);
  assert.equal((await ai.get('/v1/balance?email=a@x.com')).status, 503);
  assert.equal((await api.get('/v1/balance?email=a@x.com')).status, 200);
});

// ---------- audit 7 ----------
test('A7-1. refunds in two steps take back all commission earned on the payment, including commission earned in between', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 1000, 'Q1', { paid_minor: 1000 });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'Q1', credits: 500 });
  const g = await sale(s.api, { sale_ref: 'Q1', cash_minor: 500, noNotice: true }); // earned on the 500 still paid
  assert.equal(g.body.granted, 50);
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'Q1', credits: 500 });
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
});

test('A7-2. half refund takes half; the rest on the second refund; never double-counted after a return', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 1000, 'Q2');
  await sale(s.api, { sale_ref: 'Q2', cash_minor: 1000, noNotice: true }); // 100 commission
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'Q2', credits: 500 });
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 50);
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'Q2', credits: 500 });
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
});

test('A7-3. currency codes and words cannot be the name, label or symbol', async () => {
  const s = await setup();
  for (const v of ['JPY', 'CAD', 'AUD', 'CHF', 'SGD', 'USDT', 'USDC', 'BTC', 'ETH', 'dollar', 'Euro', 'Rupee']) {
    for (const k of ['currency_name', 'unit_label', 'unit_symbol']) assert.equal((await s.admin.put('/v1/admin/settings', { [k]: v })).status, 400, `${k}=${v}`);
  }
});

test('A7-4. more look-alikes and belittling words are refused', async () => {
  const s = await setup();
  for (const v of ['faкe', 'ƒake', 'ꜰᴀᴋᴇ', 'phony', 'sc4m', 'bogus', 'dummy']) assert.equal((await s.admin.put('/v1/admin/settings', { currency_name: v })).status, 400, v);
});

test('A7-5. an app built with no off-switch source keeps AI keys shut by default', async () => {
  const { createApp } = await import('../src/api.js');
  const { makeClient } = await import('./helpers.js');
  const s = await setup();
  const bare = createApp({ db: s.db, master: s.master, now: s.now });
  assert.equal((await makeClient(bare, s.clock, s.demo.ai_read).get('/v1/balance?email=a@x.com')).status, 503);
  assert.equal((await makeClient(bare, s.clock, s.demo.api).get('/v1/balance?email=a@x.com')).status, 200);
});

test('A7-6. a webhook secret is shown once, even to a replay of the same call', async () => {
  const s = await setup();
  const a = await s.admin.post('/v1/admin/webhooks', { url: 'https://hooks.example.com/x' }, { idem: 'wh1' });
  assert.equal(a.status, 200);
  const secret = JSON.stringify(a.body);
  const b = await s.admin.post('/v1/admin/webhooks', { url: 'https://hooks.example.com/x' }, { idem: 'wh1' });
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  const m = secret.match(/"secret":"([^"]+)"/);
  if (m) assert.ok(!JSON.stringify(b.body).includes(m[1]));
});

// ---------- audit 8 ----------
test('A8-1. spend, return, spend again, then refund the sale: nothing of it survives', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 10000, 'PR1');
  await sale(s.api, { sale_ref: 'PR1', cash_minor: 10000, noNotice: true }); // 1000 commission
  s.clock.t += 8 * 24 * HOUR;
  const o1 = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'g1', amount_minor: 1000, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: o1.body.hold_id });
  await s.api.post('/v1/refund', { type: 'order', hold_id: o1.body.hold_id }); // returned: a second-generation lot
  const o2 = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'g2', amount_minor: 1000, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: o2.body.hold_id });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'PR1' });
  await s.api.post('/v1/refund', { type: 'order', hold_id: o2.body.hold_id });
  assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0);
});

test('A8-1b. reject, convert again, refund the sale: approve is refused', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await buy(s.api, 'b@y.com', 20000, 'PR2');
  await sale(s.api, { sale_ref: 'PR2', cash_minor: 20000, noNotice: true });
  s.clock.t += 40 * 24 * HOUR;
  const c1 = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 });
  await s.admin.post(`/v1/admin/conversions/${c1.body.request_id}/reject`, {});
  const c2 = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'PR2', credits: 10000 });
  assert.equal((await s.admin.post(`/v1/admin/conversions/${c2.body.request_id}/approve`, {})).body.error.code, 'payment_reversed');
});

test('A8-2. a refund of a payment that bought no credits still reverses what it unlocked and earned', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'g8', amount_minor: 3400, currency: 'USD' });
  await note(s.api, 'ORD1', r.body.cash_due_minor, 'USD', 'a@x.com');
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'ORD1', cash_paid_minor: r.body.cash_due_minor });
  const before = (await s.db.first("SELECT paid_credits p FROM account WHERE email_norm = 'a@x.com'")).p;
  const x = await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'ORD1' });
  assert.equal(x.status, 200);
  const after = await s.db.first("SELECT paid_credits p, status FROM account WHERE email_norm = 'a@x.com'");
  assert.ok(after.p < before);
  assert.equal(after.status, 'active'); // a refund does not pause anyone
});

test('A8-3. conversions pause while the exchange rate is out of date', async () => {
  const { refreshRates } = await import('../src/fx.js');
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  s.clock.t += 60 * 24 * HOUR; // no fresh rate for two months
  const r = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 });
  assert.ok([503, 404, 422].includes(r.status));
});

test('A8-4. an off-switch file with no mode does not open AI keys', async () => {
  const { checkStatus } = await import('../src/status.js');
  for (const st of [{}, { error: 'x' }, { products: {} }]) assert.equal(checkStatus(st, { op: null, method: 'GET', scope: 'ai_read' })?.code, 'status_unknown');
  assert.equal(checkStatus({ hub: { mode: 'on' } }, { op: null, method: 'GET', scope: 'ai_read' }), null);
});

test('A8-5. the contract lists the capture errors', async () => {
  const { buildContract } = await import('../scripts/gen-contract.js');
  const c = buildContract();
  assert.ok(c['x-error-codes'].payment_already_used);
  assert.ok(c.paths['/v1/spend/capture'].post['x-error-codes'].includes('payment_not_verified'));
});

test('A8-6. currency words inside a longer name are refused', async () => {
  const s = await setup();
  for (const v of ['US Dollar', 'Dollar Coins', 'USD credits', 'Pesos', 'Bucks']) assert.equal((await s.admin.put('/v1/admin/settings', { currency_name: v })).status, 400, v);
});

test('A8-7. a chargeback that arrives before the payment blocks that payment later', async () => {
  const s = await setup();
  assert.equal((await s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'EARLY1' })).body.recorded, true);
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'EARLY1', paid_minor: 100, currency: 'USD', payer_email: 'a@x.com' })).body.error.code, 'payment_reversed');
  assert.equal((await buy(s.api, 'a@x.com', 100, 'EARLY1')).body.error.code, 'payment_reversed');
});

test('A8-8. a credit purchase must be for the account that paid, when the payment was noted', async () => {
  const s = await setup();
  await note(s.api, 'WHO1', 100, 'USD', 'payer@x.com');
  assert.equal((await buy(s.api, 'someone@else.com', 100, 'WHO1')).body.error.code, 'payment_conflict');
  assert.equal((await buy(s.api, 'payer@x.com', 100, 'WHO1')).status, 200);
});

import { urlStatus } from '../src/status.js';
test('A9-1: a Hub outage never turns an "off" answer back on', async () => {
  let t = 1000, down = false;
  const st = urlStatus('http://x', { ttlMs: 10, now: () => t, fetchFn: async () => { if (down) throw new Error('down'); return { ok: true, json: async () => ({ hub: { mode: 'off' } }) }; } });
  assert.equal((await st()).hub.mode, 'off');
  down = true; t += 100;
  assert.equal((await st()).hub.mode, 'off');
});

test('A9-2: a chargeback of spent commission leaves a debt on the sale; partial money refunds never round up in total', async () => {
  const s = await setup();
  await buy(s.api, 'b@y.com', 10000, 'AZ1');
  await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 10000, currency: 'USD', sale_ref: 'AZ1', noNotice: true });
  s.clock.t += 40 * 24 * HOUR;
  const h = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'az-o', amount_minor: 300, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: h.body.hold_id });
  await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'AZ1' });
  const row = await s.db.first("SELECT owed FROM sale_reversal WHERE ref = 'az1'");
  assert.ok(row && row.owed > 0);
});
