import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, DAY } from './helpers.js';
import { verifyChain, verifyBalances } from '../src/ledger.js';
import { creditsFromMinor, minorFromCredits } from '../src/settings.js';
import { getSettings } from '../src/settings.js';

test('chain is intact after a mix of operations, and ledger equals lots', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 5000, 'pay1');
  await event(s.api, 'a@x.com', 'account_created');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o1', amount_minor: 1000, currency: 'USD' });
  assert.equal(r.status, 200);
  await s.api.post('/v1/spend/capture', { hold_id: r.body.hold_id });
  const r2 = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o2', amount_minor: 500, currency: 'USD' });
  await s.api.post('/v1/spend/release', { hold_id: r2.body.hold_id });
  await s.api.post('/v1/refund', { type: 'order', hold_id: r.body.hold_id, credits: 300 });
  s.clock.t += 400 * DAY;
  await s.admin.post('/v1/admin/sweep', {});
  const c = s.ctx();
  assert.deepEqual(await verifyChain(c), { ok: true, entries: (await verifyChain(c)).entries });
  assert.ok((await verifyChain(c)).entries >= 8);
  assert.deepEqual(await verifyBalances(c), []);
});

test('ledger rows cannot be edited or deleted', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p1');
  await assert.rejects(() => s.db.run('UPDATE entry SET delta = 999'), /append-only/);
  await assert.rejects(() => s.db.run('DELETE FROM entry'), /append-only/);
});

test('tampering with a row (triggers bypassed) is caught by the chain check', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p1');
  await buy(s.api, 'a@x.com', 200, 'p2');
  s.db.exec('DROP TRIGGER entry_no_update');
  s.db.exec('UPDATE entry SET delta = 9999 WHERE seq = 1');
  const v = await verifyChain(s.ctx());
  assert.equal(v.ok, false);
  assert.equal(v.broken_at, 1);
});

test('a ledger/lot mismatch is detected', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 100, 'p1');
  s.db.exec('UPDATE lot SET remaining = 50');
  assert.equal((await verifyBalances(s.ctx())).length, 1);
});

test('100 credits = US$1 and INR rate is a setting', async () => {
  const s = await setup();
  const st = await getSettings(s.ctx());
  assert.equal(creditsFromMinor(st, 'USD', 3400), 3400); // $34 = 3,400 credits
  assert.equal(minorFromCredits(st, 'USD', 100), 100); // 100 credits = 100 cents
  assert.equal(creditsFromMinor(st, 'INR', 239900), Math.floor((239900 * 100) / 7000));
  await buy(s.api, 'a@x.com', 1250, 'p1');
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.balance, 1250);
  assert.equal(b.display.usd, '12.50');
  await s.admin.put('/v1/admin/settings', { inr_paise_per_usd: 7500 });
  assert.equal(creditsFromMinor(await getSettings({ ...s.ctx() }), 'INR', 7500), 100);
});

test('cannot mint more credits than the payment covers', async () => {
  const s = await setup();
  const r = await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 5000, paid_minor: 1000, currency: 'USD', payment_ref: 'p1' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'amount_exceeds_payment');
});

test('INR purchase credits at the INR rate', async () => {
  const s = await setup();
  const r = await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 3427, paid_minor: 239900, currency: 'INR', payment_ref: 'p-inr' });
  assert.equal(r.status, 200);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 3427);
});

test('history lists entries newest first and pages', async () => {
  const s = await setup();
  for (let i = 0; i < 5; i++) await buy(s.api, 'a@x.com', 10, `p${i}`);
  const h = await s.api.get('/v1/history?email=a@x.com&limit=2');
  assert.equal(h.body.entries.length, 2);
  assert.ok(h.body.entries[0].seq > h.body.entries[1].seq);
  const h2 = await s.api.get(`/v1/history?email=a@x.com&limit=10&before_seq=${h.body.next_before_seq}`);
  assert.equal(h2.body.entries.length, 3);
});
