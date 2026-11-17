// One test (or more) for every finding of independent audit 1, plus the owner's later instructions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, DAY, note } from './helpers.js';
import { verifyBalances, verifyChain } from '../src/ledger.js';
import { reconcileAll } from '../src/reconcile.js';
import { calculate } from '../src/convert.js';
import { getSettings } from '../src/settings.js';
import { normEmail } from '../src/util.js';

const res = (api, o = {}) => api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: `o${Math.random()}`, amount_minor: 1000, currency: 'USD', ...o });

// ---- audit 1, finding 1: chargeback must claw back everything from that payment
test('chargeback while credits are held: release does not give them back', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'P1');
  const r = await res(s.api, { amount_minor: 1000 });
  assert.equal(r.body.credit_applied, 1000);
  const cb = await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'P1' });
  assert.equal(cb.body.removed_credits, 0);
  await s.api.post('/v1/spend/release', { hold_id: r.body.hold_id });
  await s.admin.post('/v1/admin/freeze', { email: 'a@x.com', frozen: false });
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
  assert.equal((await verifyChain(s.ctx())).ok, true);
});

test('chargeback while held: capture is refused', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'P1');
  const r = await res(s.api, { amount_minor: 1000 });
  await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'P1' });
  const c = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal(c.body.error.code, 'payment_reversed');
});

test('chargeback after an order was returned: the returned credits are removed too', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'P1');
  const r = await res(s.api, { amount_minor: 1000 });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id });
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  const cb = await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'P1' });
  assert.equal(cb.body.removed_credits, 1000);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  const again = await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'P1' }, { idem: 'other' });
  assert.equal(again.body.already, true);
});

test('order returned after a chargeback restores nothing', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'P1');
  const r = await res(s.api, { amount_minor: 1000 });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'P1' });
  const back = await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id });
  assert.equal(back.body.returned_credits, 0);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

// ---- finding 2
test('a fixed-amount commission rule is refused, and cannot pay even if forced into the table', async () => {
  const s = await setup();
  const r = await s.admin.post('/v1/admin/rules', { event_type: 'free_money', bucket: 'commission', amount: 100000, mode: 'every' });
  assert.equal(r.body.error.code, 'commission_needs_cash');
  s.db.exec("INSERT INTO earning_rule (id, tenant_id, event_type, bucket, amount_type, amount, mode, created_at, updated_at) VALUES ('r_bad','demo','free_money','commission','fixed',100000,'every',0,0)");
  const e = await event(s.api, 'a@x.com', 'free_money');
  assert.equal(e.body.reason, 'rule_invalid');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
});

// ---- finding 3
test('e-mail spellings: trailing dot, double dot, odd characters are not valid', async () => {
  for (const bad of ['a@gmail.com.', 'a@gmail.com..', 'a..b@gmail.com', '.a@gmail.com', 'a.@gmail.com', 'a@@x.com', 'a b@x.com', 'a@x', 'a@-x.com', 'ä@x.com']) assert.equal(normEmail(bad), null, bad);
  assert.equal(normEmail(' John@Example.COM '), 'john@example.com');
  const s = await setup();
  assert.equal((await event(s.api, 'john@gmail.com.', 'account_created')).status, 400);
  const ref = await event(s.api, 'a@gmail.com', 'referral_sale_paid', { payer_email: 'a@gmail.com.', cash_minor: 100, currency: 'USD' });
  assert.equal(ref.body.reason, 'payer_required');
});

// ---- finding 4
test('hand-given bonus obeys the tenant daily cap, the per-person daily limit, and is audited', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { tenant_daily_bonus_cap: 100, account_events_per_day: 2 });
  const out = [];
  for (const e of ['a@x.com', 'b@x.com', 'c@x.com']) out.push((await s.api.post('/v1/credit', { email: e, bucket: 'bonus', amount: 500, ref: `g-${e.slice(0, 1)}` })).status);
  assert.deepEqual(out, [200, 422, 422]);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
  await s.admin.put('/v1/admin/settings', { tenant_daily_bonus_cap: 100000 });
  await s.api.post('/v1/credit', { email: 'z@x.com', bucket: 'bonus', amount: 5, ref: 'z1' });
  await s.api.post('/v1/credit', { email: 'z@x.com', bucket: 'bonus', amount: 5, ref: 'z2' });
  assert.equal((await s.api.post('/v1/credit', { email: 'z@x.com', bucket: 'bonus', amount: 5, ref: 'z3' })).status, 429);
  const acts = (await s.admin.get('/v1/admin/audit?limit=100')).body.entries.map((e) => e.action);
  assert.ok(acts.includes('bonus.manual'));
});

test('bought credit cannot be minted with a product key', async () => {
  const s = await setup();
  const r = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bought', amount: 1000, ref: 'x' });
  assert.equal(r.status, 400);
  const r2 = await s.api.post('/v1/credit_purchase', { email: 'a@x.com', amount: 1, paid_minor: 1, currency: 'USD', payment_ref: 'p' });
  assert.equal(r2.status, 403);
});

// ---- finding 5
test('bonus stays locked until real paid value reaches the unlock amount', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created');
  await buy(s.api, 'a@x.com', 1, 'tiny'); // $0.01 is below the $1 unlock amount
  assert.equal((await res(s.api, { amount_minor: 200 })).body.credit_applied, 1); // only the bought credit
});

test('bonus unlock is net of refunds: buy, refund the money, bonus locks again; buy again, it unlocks', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created'); // 100 bonus
  await buy(s.api, 'a@x.com', 500, 'p');
  await s.api.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'p' });
  assert.equal((await res(s.api, { amount_minor: 200 })).body.credit_applied, 0);
  await buy(s.api, 'a@x.com', 500, 'p2');
  const r = await res(s.api, { amount_minor: 200 }); // 200 credits: bonus up to 50% = 100, then bought
  assert.equal(r.body.credit_applied, 200);
  assert.equal((await bal(s.api, 'a@x.com')).buckets.bonus, 0);
});

test('bonus after a chargeback: locked again', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created');
  await buy(s.api, 'a@x.com', 500, 'p');
  await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'p' });
  await s.admin.post('/v1/admin/freeze', { email: 'a@x.com', frozen: false });
  assert.equal((await res(s.api, { amount_minor: 200 })).body.credit_applied, 0);
});

test('cash paid on an order also counts toward the bonus unlock', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created');
  await buy(s.api, 'a@x.com', 1, 'seed'); // a little bought credit so a hold exists; still below the unlock amount
  const r = await res(s.api, { amount_minor: 1000 });
  assert.equal(r.body.credit_applied, 1);
  await note(s.api, 'rzp-cash', 999);
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'rzp-cash', cash_paid_minor: 999 });
  const r2 = await res(s.api, { amount_minor: 1000 });
  assert.equal(r2.body.credit_applied, 100); // bonus now unlocked ($9.99 cash on record)
});

// ---- finding 6
test('credits-per-dollar is locked once credits exist; INR rate moves at most 10% per change', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { credits_per_usd: 100 }); // unchanged value is fine
  await buy(s.api, 'a@x.com', 1000, 'p');
  const r = await s.admin.put('/v1/admin/settings', { credits_per_usd: 1 });
  assert.equal(r.body.error.code, 'rate_locked');
  assert.equal((await s.admin.put('/v1/admin/settings', { inr_paise_per_usd: 10000 })).body.error.code, 'rate_change_too_big');
  assert.equal((await s.admin.put('/v1/admin/settings', { inr_paise_per_usd: 7500 })).status, 200);
});

test('every entry records the rates in force at that moment', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  await s.admin.put('/v1/admin/settings', { inr_paise_per_usd: 7500 });
  await buy(s.api, 'a@x.com', 500, 'p2');
  const rows = await s.db.all("SELECT rate_cpu, rate_inr, money_minor, currency, ext_ref, status FROM entry WHERE kind = 'purchase' ORDER BY seq");
  assert.deepEqual(rows.map((r) => r.rate_inr), [7000, 7500]);
  assert.deepEqual(rows.map((r) => [r.rate_cpu, r.money_minor, r.currency, r.ext_ref, r.status]), [[100, 1000, 'USD', 'p1', 'posted'], [100, 500, 'USD', 'p2', 'posted']]);
});

// ---- findings 7, 8, 9, 10, 11
test('visit-like event names are all refused (not just exact names)', async () => {
  const s = await setup();
  for (const n of ['site_visits', 'page_viewed', 'user_login', 'banner_click']) {
    assert.equal((await s.admin.post('/v1/admin/rules', { event_type: n, bucket: 'bonus', amount: 10, mode: 'once' })).status, 422, n);
    assert.equal((await event(s.api, 'a@x.com', n)).body.reason, 'no_credit_for_visits');
  }
});

test('sub-domains of blocked domains are blocked', async () => {
  const s = await setup();
  assert.equal((await event(s.api, 'a@sub.mailinator.com', 'account_created')).body.reason, 'blocked_domain');
  assert.equal((await event(s.api, 'a@notmailinator.com', 'account_created')).body.granted, 100);
});

test('rounding waiver only applies to orders of $1 or more', async () => {
  const s = await setup();
  await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', amount: 1, paid_minor: 70, currency: 'INR', payment_ref: 'p' });
  const r = await res(s.api, { amount_minor: 139, currency: 'INR' });
  assert.ok(r.body.cash_due_minor >= 69, `cash due ${r.body.cash_due_minor}`);
});

test('one payment id can be used once across purchases and order cash', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 500, 'PAY-1');
  await buy(s.api, 'b@x.com', 1000, 'pb');
  const r = await res(s.api, { email: 'b@x.com', amount_minor: 1500 });
  await note(s.api, 'PAY-1', 500, 'USD', 'b@x.com');
  const c = await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id, payment_ref: 'PAY-1', cash_paid_minor: 500 });
  assert.equal(c.body.error.code, 'payment_already_used');
  const dup = await buy(s.api, 'c@x.com', 100, 'PAY-1');
  assert.equal(dup.status, 409);
});

test('can_convert shows only when conversion can really proceed', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true });
  await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 20000, currency: 'USD' });
  s.clock.t += 30 * DAY;
  assert.equal((await bal(s.api, 'a@x.com')).display.convert_line, null); // tax setting missing
  await s.admin.put('/v1/admin/settings', { tds_rate_bps: 1000 });
  assert.match((await bal(s.api, 'a@x.com')).display.convert_line, /convert/);
});

// ---- finding 12-15
test('webhook addresses must be public https hosts', async () => {
  const s = await setup();
  for (const u of ['https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://intranet/x', 'https://svc.internal/x', 'https://[::1]/x', 'http://example.com/x', 'ftp://x.com']) {
    assert.equal((await s.admin.post('/v1/admin/webhooks', { url: u })).status, 400, u);
  }
  assert.equal((await s.admin.post('/v1/admin/webhooks', { url: 'https://hooks.example.com/x' })).status, 200);
});

test('references with "@" or spaces are refused, so e-mails never reach events', async () => {
  const s = await setup();
  assert.equal((await s.api.post('/v1/event', { email: 'a@x.com', event_type: 'account_created', event_key: 'a@x.com' })).status, 400);
  assert.equal((await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'order for a@x.com', amount_minor: 100, currency: 'USD' })).status, 400);
  assert.equal((await buy(s.api, 'a@x.com', 10, 'pay a@x.com')).status, 400);
});

test('bad paging numbers are refused; key creation and chargebacks are audited; admin page cannot be framed', async () => {
  const s = await setup();
  assert.equal((await s.api.get('/v1/history?email=a@x.com&before_seq=abc')).status, 400);
  await buy(s.api, 'a@x.com', 100, 'p');
  await s.api.pay.post('/v1/refund', { type: 'chargeback', payment_ref: 'p' });
  const acts = (await s.admin.get('/v1/admin/audit?limit=200')).body.entries.map((e) => e.action);
  assert.ok(acts.includes('key.create') && acts.includes('account.freeze'));
  const page = await s.app.fetch(new Request('http://t.local/admin'));
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('old idempotency records are cleaned by the sweep', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p');
  s.clock.t += 31 * DAY;
  await s.admin.post('/v1/admin/sweep', {});
  assert.equal((await s.db.all("SELECT * FROM idempotency WHERE key = 'pay:p'")).length, 0);
});

// ---- owner instructions: key types and the integration flow
test('credit bought: the payment id is the idempotency key; the same payment never credits twice', async () => {
  const s = await setup();
  const body = { email: 'a@x.com', amount: 3400, paid_minor: 3400, currency: 'USD', payment_ref: 'pay_Razor123' };
  const a = await s.api.pay.post('/v1/credit_purchase', body, { idem: null }); // no header at all
  const b = await s.api.pay.post('/v1/credit_purchase', body, { idem: null });
  assert.equal(a.status, 200);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 3400);
});

test('read key: balance only, no bucket detail, nothing else', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p');
  const b = await s.api.read.get('/v1/balance?email=a@x.com&details=1');
  assert.equal(b.body.balance, 1000);
  assert.equal(b.body.buckets, undefined);
  assert.equal((await s.api.read.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o', amount_minor: 100, currency: 'USD' })).status, 403);
  assert.equal((await s.api.read.get('/v1/history?email=a@x.com')).status, 403);
});

test('payment key can only credit purchases and make money-side refunds; product key cannot', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p');
  assert.equal((await s.api.pay.get('/v1/balance?email=a@x.com')).status, 403);
  assert.equal((await s.api.pay.post('/v1/event', { email: 'a@x.com', event_type: 'account_created', event_key: 'k' })).status, 403);
  assert.equal((await s.api.post('/v1/refund', { type: 'purchase', payment_ref: 'p' })).status, 403);
  assert.equal((await s.api.post('/v1/refund', { type: 'chargeback', payment_ref: 'p' })).status, 403);
  const r = await res(s.api, { amount_minor: 100 });
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  assert.equal((await s.api.pay.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id })).status, 403);
});

test('no end-user pages: only /health and the admin page answer without a signature', async () => {
  const s = await setup();
  for (const p of ['/', '/login', '/app']) assert.equal((await s.app.fetch(new Request(`http://t.local${p}`))).status, 401);
});

// ---- ledger completeness
test('the ledger carries kind, money, tax, status and the external payment id', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created');
  await buy(s.api, 'a@x.com', 200, 'pay1');
  await event(s.api, 'r@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 5000, currency: 'USD' });
  const h = await res(s.api, { amount_minor: 1000 });
  await note(s.api, 'rzp9', 900);
  await s.api.post('/v1/spend/capture', { hold_id: h.body.hold_id, payment_ref: 'rzp9', cash_paid_minor: 900 });
  await s.api.post('/v1/refund', { type: 'order', hold_id: h.body.hold_id, credits: 50 });
  s.clock.t += 400 * DAY;
  await s.admin.post('/v1/admin/sweep', {});
  const kinds = new Set((await s.db.all('SELECT DISTINCT kind FROM entry')).map((r) => r.kind));
  for (const k of ['purchase', 'bonus', 'commission', 'hold', 'capture', 'collection', 'reinstate', 'expire']) assert.ok(kinds.has(k), k);
  const coll = await s.db.first("SELECT * FROM entry WHERE kind = 'collection'");
  assert.equal(coll.money_minor, 1000 - h.body.credit_applied);
  assert.deepEqual([coll.currency, coll.ext_ref, coll.delta, coll.status], ['USD', 'rzp9', 0, 'posted']);
  assert.equal((await s.db.first("SELECT status FROM entry WHERE kind = 'hold' LIMIT 1")).status, 'pending');
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

// ---- conversion engine skeleton + rail + reconcile
async function withCommission(s, credits = 2000) {
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000, conversion_hold_days: 7 });
  await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: credits * 10, currency: 'USD' });
  s.clock.t += 8 * DAY;
}

test('conversion calculation: TDS rounded up, net is gross minus tax', async () => {
  const s = await setup();
  const st = await getSettings(s.ctx());
  const c = calculate({ ...st, tds_rate_bps: 1000 }, 2000); // $20 = Rs 1,400 = 140,000 paise
  assert.deepEqual([c.currency, c.gross_minor, c.tds_minor, c.net_minor], ['INR', 140000, 14000, 126000]);
  const u = calculate({ ...st, conversion_currency: 'USD', tds_rate_bps: 0 }, 2000);
  assert.deepEqual([u.gross_minor, u.net_minor], [2000, 2000]);
});

test('conversion lifecycle: request, approve, instruct (stub rail, no money), paid by a person with the real payment id', async () => {
  const s = await setup();
  await withCommission(s);
  const rq = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 });
  assert.equal(rq.body.status, 'requested');
  assert.equal(rq.body.net_minor, 126000);
  const id = rq.body.request_id;
  const act = (a, b = {}) => s.admin.post(`/v1/admin/conversions/${id}/${a}`, b);
  assert.equal((await act('instruct')).body.error.code, 'wrong_state'); // cannot skip approval
  assert.equal((await act('mark_paid', { payment_ref: 'UTR1' })).body.error.code, 'wrong_state');
  assert.equal((await act('approve')).body.status, 'approved');
  const ins = await act('instruct');
  assert.equal(ins.body.rail, 'stub');
  assert.equal(ins.body.executed, false);
  assert.equal((await s.admin.get('/v1/admin/conversions?status=instructed')).body.conversions.length, 1);
  assert.equal((await act('mark_paid', {})).status, 400); // a real payment id is required
  assert.equal((await act('mark_paid', { payment_ref: 'UTR1' })).body.status, 'paid');
  const pay = await s.db.first("SELECT * FROM entry WHERE kind = 'payout'");
  assert.deepEqual([pay.money_minor, pay.tds_minor, pay.currency, pay.ext_ref, pay.status, pay.delta], [126000, 14000, 'INR', 'UTR1', 'paid', 0]);
  assert.equal((await act('reject')).body.error.code, 'wrong_state'); // paid cannot be undone
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('the same payout reference cannot be recorded twice', async () => {
  const s = await setup();
  await withCommission(s, 4000);
  const ids = [];
  for (const c of [1500, 1500]) ids.push((await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: c })).body.request_id);
  for (const id of ids) {
    await s.admin.post(`/v1/admin/conversions/${id}/approve`, {});
    await s.admin.post(`/v1/admin/conversions/${id}/instruct`, {});
  }
  assert.equal((await s.admin.post(`/v1/admin/conversions/${ids[0]}/mark_paid`, { payment_ref: 'UTR9' })).status, 200);
  assert.equal((await s.admin.post(`/v1/admin/conversions/${ids[1]}/mark_paid`, { payment_ref: 'UTR9' })).status, 409);
});

test('rejecting a conversion gives the credits back, still convertible', async () => {
  const s = await setup();
  await withCommission(s);
  const id = (await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 })).body.request_id;
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  const rj = await s.admin.post(`/v1/admin/conversions/${id}/reject`, {});
  assert.equal(rj.body.returned_credits, 2000);
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.balance, 2000);
  assert.equal(b.can_convert, 2000);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('approval can be switched off; conversion actions need conversion ON', async () => {
  const s = await setup();
  await withCommission(s);
  await s.admin.put('/v1/admin/settings', { conversion_approval_required: false });
  const rq = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 1500 });
  assert.equal(rq.body.status, 'approved');
  await s.admin.put('/v1/admin/settings', { conversion_enabled: false });
  assert.equal((await s.admin.post(`/v1/admin/conversions/${rq.body.request_id}/instruct`, {})).body.error.code, 'conversion_off');
});

test('a custom payment rail can be plugged in, and the stub is the default', async () => {
  const s = await setup();
  assert.equal(s.app.rail.name, 'stub');
  await withCommission(s);
  const calls = [];
  s.app.rail = { name: 'custom', instruct: async (r) => { calls.push(r); return { ref: 'RAIL-1', executed: false }; } };
  const id = (await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 2000 })).body.request_id;
  await s.admin.post(`/v1/admin/conversions/${id}/approve`, {});
  const out = await s.admin.post(`/v1/admin/conversions/${id}/instruct`, {});
  assert.equal(out.body.rail_ref, 'RAIL-1');
  assert.deepEqual([calls[0].net_minor, calls[0].currency], [126000, 'INR']);
});

test('reconcile: liability by bucket and tenant, conversions pending and paid', async () => {
  const s = await setup({ other: true });
  await withCommission(s, 3000);
  await buy(s.api, 'p@x.com', 1000, 'pp');
  await event(s.api, 'q@x.com', 'account_created');
  const h = await res(s.api, { email: 'p@x.com', amount_minor: 300 });
  const c1 = (await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 1500 })).body.request_id;
  const c2 = (await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 1500 })).body.request_id;
  await s.admin.post(`/v1/admin/conversions/${c1}/approve`, {});
  await s.admin.post(`/v1/admin/conversions/${c1}/instruct`, {});
  await s.admin.post(`/v1/admin/conversions/${c1}/mark_paid`, { payment_ref: 'U1' });
  const r = (await s.admin.get('/v1/admin/reconcile')).body;
  assert.deepEqual(r.outstanding, { bought: 700, bonus: 100, commission: 0 });
  assert.deepEqual(r.held_in_orders, { bought: 300, bonus: 0, commission: 0 });
  assert.equal(r.conversions['paid:INR'].n, 1);
  assert.equal(r.conversions['requested:INR'].credits, 1500);
  assert.equal(r.in_conversion, 1500);
  assert.equal(r.liability_credits, 700 + 100 + 300 + 1500);
  assert.deepEqual(r.ledger.mismatches, []);
  assert.ok(h.body.hold_id && c2);
  const all = await reconcileAll(s.db, s.now);
  assert.deepEqual(all.by_tenant.map((t) => t.tenant_id), ['demo', 'tenb']);
  assert.equal(all.total.liability_credits, all.by_tenant[0].liability_credits);
  assert.ok((await s.db.all('SELECT * FROM v_outstanding')).length > 0);
});
