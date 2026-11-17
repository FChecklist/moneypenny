// One test (or more) for every finding of independent audit 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, DAY } from './helpers.js';
import { verifyBalances } from '../src/ledger.js';
import { reconcileAll } from '../src/reconcile.js';
import { canonEmail, normEmail, ref } from '../src/util.js';
import { isVisitLike } from '../src/wallet.js';

const sale = (api, o = {}) => event(api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 2000, currency: 'USD', ...o }); // US$20 sale = 2000 credits, 10% = 200
const hook = (s, url) => s.admin.post('/v1/admin/webhooks', { url });

test('commission needs the sale named, and one sale pays once even with new event keys', async () => {
  const s = await setup();
  const none = await s.api.post('/v1/event', { email: 'a@x.com', event_type: 'referral_sale_paid', event_key: 'k1', payer_email: 'b@y.com', cash_minor: 2000, currency: 'USD' });
  assert.equal(none.body.reason, 'sale_ref_required');
  assert.equal((await sale(s.api, { sale_ref: 'pay_S1' })).body.granted, 200);
  const again = await sale(s.api, { sale_ref: 'pay_S1' }); // new event key, same sale
  assert.equal(again.body.reason, 'sale_already_used');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 200);
  const other = await sale(s.api, { sale_ref: 'pay_S1' }).then((r) => r.body.granted);
  assert.equal(other, 0);
});

test('commission is capped per sale and per day, so a huge cash figure cannot mint credits', async () => {
  const s = await setup();
  const big = await sale(s.api, { sale_ref: 'S-big', cash_minor: 10000000000 }); // US$100 million claimed
  assert.equal(big.body.granted, 0);
  assert.equal(big.body.reason, 'over_event_limit');
  await s.admin.put('/v1/admin/settings', { commission_daily_cap: 500 });
  assert.equal((await sale(s.api, { sale_ref: 'S-a' })).body.granted, 200);
  assert.equal((await sale(s.api, { sale_ref: 'S-b' })).body.granted, 200);
  const third = await sale(s.api, { sale_ref: 'S-c' });
  assert.equal(third.body.reason, 'daily_cap_reached');
  s.clock.t += 2 * DAY;
  assert.equal((await sale(s.api, { sale_ref: 'S-c2' })).body.granted, 200);
  assert.equal((await sale(s.api, { sale_ref: 'bad ref' })).body.reason, 'sale_ref_required');
});

test('chargeback of a sale removes its commission and does not pause the earner', async () => {
  const s = await setup();
  await sale(s.api, { sale_ref: 'pay_S9' });
  assert.equal((await bal(s.api, 'a@x.com')).balance, 200);
  const c = await s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'pay_S9' });
  assert.equal(c.body.removed_credits, 200);
  assert.equal(c.body.account_status, 'unchanged');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  assert.equal((await s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'pay_S9' })).body.already, true);
  const unseen = await s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'never-seen' });
  assert.equal(unseen.body.recorded, true); // remembered, so that payment cannot be used if it shows up later
  await buy(s.api, 'a@x.com', 100, 'p1'); // earner is not frozen
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('commission held in an order is not restored after its sale is charged back', async () => {
  const s = await setup();
  await sale(s.api, { sale_ref: 'pay_S5' });
  s.clock.t += 8 * DAY;
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'h1', amount_minor: 200, currency: 'USD' });
  assert.equal(r.body.credit_applied, 200);
  await s.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'pay_S5' });
  assert.equal((await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id })).body.error.code, 'payment_reversed');
  await s.api.post('/v1/spend/release', { hold_id: r.body.hold_id });
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
});

test('webhook addresses: trailing dot, user info, internal names and wildcard-DNS names are refused', async () => {
  const s = await setup();
  for (const u of [
    'https://localhost./x', 'https://localhost/x', 'https://app.localhost/x', 'https://user:pw@example.com/x', 'https://metadata.google.internal/x',
    'https://metadata.google.internal./x', 'https://127.0.0.1.nip.io/x', 'https://a.sslip.io/x', 'https://x.xip.io/x', 'https://x.localtest.me/x',
    'https://10.0.0.1/x', 'https://[::1]/x', 'https://2130706433/x', 'https://intranet/x', 'http://example.com/x',
  ]) assert.equal((await hook(s, u)).status, 400, u);
  const ok = await hook(s, 'https://hooks.example.com./mnp');
  assert.equal(ok.status, 200);
  const logged = JSON.stringify((await s.admin.get('/v1/admin/audit')).body);
  assert.ok(logged.includes('hooks.example.com'));
  assert.ok(!logged.includes('/mnp')); // only the host is logged
});

test('frozen account: no convert line and can_convert is 0; a tax rate that leaves nothing is not offered', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await sale(s.api, { sale_ref: 'S1', cash_minor: 20000 }); // 2000 credits
  s.clock.t += 8 * DAY;
  let b = await bal(s.api, 'a@x.com');
  assert.equal(b.can_convert, 2000);
  assert.ok(b.display.convert_line);
  await s.admin.post('/v1/admin/freeze', { email: 'a@x.com', frozen: true });
  b = await bal(s.api, 'a@x.com');
  assert.equal(b.can_convert, 0);
  assert.equal(b.display.convert_line, null);
  await s.admin.post('/v1/admin/freeze', { email: 'a@x.com', frozen: false });
  await s.admin.put('/v1/admin/settings', { tds_rate_bps: 10000 }); // everything taken as tax
  b = await bal(s.api, 'a@x.com');
  assert.equal(b.can_convert, 0);
  assert.equal(b.display.convert_line, null);
});

test('a conversion handed to a rail cannot be rejected; only approved-or-earlier can', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await sale(s.api, { sale_ref: 'S1', cash_minor: 40000 });
  s.clock.t += 8 * DAY;
  const id = (await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 })).body.request_id;
  await s.admin.post(`/v1/admin/conversions/${id}/approve`, {});
  await s.admin.post(`/v1/admin/conversions/${id}/instruct`, {});
  const rej = await s.admin.post(`/v1/admin/conversions/${id}/reject`, {});
  assert.equal(rej.status, 409);
  assert.equal(rej.body.error.code, 'wrong_state');
  assert.equal((await s.admin.post(`/v1/admin/conversions/${id}/mark_paid`, { payment_ref: 'UTR1' })).body.status, 'paid');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 2000); // the other 2000 stay
});

test('reconcile keys conversions by status and currency and totals them', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
  await sale(s.api, { sale_ref: 'S1', cash_minor: 40000 });
  s.clock.t += 8 * DAY;
  await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 1500 });
  const r = (await s.admin.get('/v1/admin/reconcile')).body;
  assert.equal(r.conversions['requested:INR'].credits, 1500);
  const all = await reconcileAll(s.db, s.now);
  assert.equal(all.total.in_conversion, 1500);
  assert.equal(all.total.conversions['requested:INR'].n, 1);
  assert.equal(all.total.liability_credits, all.by_tenant.reduce((a, t) => a + t.liability_credits, 0));
});

test('returning an order twice, once nothing is left, is refused', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 500, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 500, currency: 'USD' });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal((await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id })).body.returned_credits, 500);
  assert.equal((await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id })).body.error.code, 'nothing_to_return');
});

test('e-mail canon keeps the name when a plus-tag would leave nothing', () => {
  assert.equal(canonEmail(normEmail('+tag@x.com')), '+tag@x.com');
  assert.equal(canonEmail(normEmail('a.b+c@gmail.com')), 'ab@gmail.com');
  assert.notEqual(canonEmail(normEmail('+one@x.com')), canonEmail(normEmail('+two@x.com')));
});

test('visit guard works on words, any case: review and opened are fine, page_viewed and PageLoad are not', () => {
  for (const ok of ['review_posted', 'account_opened', 'first_game_created', 'interview_done', 'purchase_completed']) assert.equal(isVisitLike(ok), false, ok);
  for (const bad of ['page_viewed', 'PageLoad', 'Heartbeat_ping', 'session_started', 'user_visited', 'link_clicked', 'app_open', 'scrolled_down', 'LOGIN_ok', 'home_pageview']) assert.equal(isVisitLike(bad), true, bad);
});

test('references accept a plain safe alphabet only', () => {
  for (const good of ['ord_1', 'pay_ABC.9:x/2=+-']) assert.equal(ref(good, 'r'), good);
  for (const bad of ['a b', 'a@b', 'a#b', 'café', 'á', 'a​b', 'a\nb', 'a\\b', "a'b", 'a;b']) assert.throws(() => ref(bad, 'r'), /may use/, JSON.stringify(bad));
});

test('"pay:" idempotency keys are only for a payment on its own payment route', async () => {
  const s = await setup();
  const evt = { email: 'a@x.com', event_type: 'account_created', event_key: 'e-pay' };
  assert.equal((await s.api.post('/v1/event', evt, { idem: 'pay:p1' })).body.error.code, 'bad_idempotency_key');
  const mine = { email: 'a@x.com', amount: 100, paid_minor: 100, currency: 'USD', payment_ref: 'p1' };
  assert.equal((await s.pay.post('/v1/credit_purchase', mine, { idem: 'pay:other' })).body.error.code, 'bad_idempotency_key');
  assert.equal((await s.pay.post('/v1/credit_purchase', mine, { idem: 'pay:p1' })).status, 200);
  // a stray call cannot pre-use a payment id and block the real one
  assert.equal((await s.api.post('/v1/event', { ...evt, event_key: 'e2' }, { idem: 'pay:p2' })).status, 400);
  assert.equal((await s.pay.post('/v1/credit_purchase', { ...mine, payment_ref: 'p2' }, { idem: null })).status, 200);
});

test('a credit lot with no ledger entry at all is caught by the balance check', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p1');
  const acc = await s.db.first('SELECT id FROM account LIMIT 1');
  await s.db.run(
    "INSERT INTO lot (id, tenant_id, account_id, bucket, original, remaining, created_at, expires_at, eligible_at, source, source_ref) VALUES ('lot_ghost','demo',?,'commission',50,50,1,NULL,0,'rule','ghost')",
    acc.id,
  );
  const bad = await verifyBalances(s.ctx());
  assert.equal(bad.length, 1);
  assert.equal(bad[0].bucket, 'commission');
  assert.equal(bad[0].lots, 50);
});
