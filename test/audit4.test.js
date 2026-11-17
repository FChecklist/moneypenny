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
  assert.equal((await s.pay.post('/v1/payment_notice', { payment_ref: 'sale:Q', paid_minor: 5, currency: 'USD' })).body.error.code, 'bad_request');
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
  await note(s.api, 'PY2', 2000, 'USD'); // no payer given by the payment side
  assert.equal((await sale(s.api, { sale_ref: 'PY2', noNotice: true })).body.reason, 'payer_mismatch');
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
  assert.equal((await raw('/v1/payment_notice', { payment_ref: 'PY9', paid_minor: 1000, currency: 'USD' })).status, 200);
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
