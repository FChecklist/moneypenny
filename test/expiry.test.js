import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, DAY } from './helpers.js';
import { verifyBalances, verifyChain } from '../src/ledger.js';

test('bought credits end after 365 days; balance ignores them even before the sweep', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  s.clock.t += 364 * DAY;
  assert.equal((await bal(s.api, 'a@x.com')).balance, 1000);
  s.clock.t += 2 * DAY;
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
  const sw = await s.admin.post('/v1/admin/sweep', {});
  assert.equal(sw.body.lots.credits, 1000);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
  assert.equal((await verifyChain(s.ctx())).ok, true);
});

test('expired credits cannot be spent, even if the sweep has not run', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  s.clock.t += 400 * DAY;
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o', amount_minor: 500, currency: 'USD' });
  assert.equal(r.body.credit_applied, 0);
});

test('each bucket has its own end date setting', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { bonus_expiry_days: 30, bought_expiry_days: 90 });
  await event(s.api, 'a@x.com', 'account_created');
  await buy(s.api, 'a@x.com', 1000, 'p1');
  assert.equal((await bal(s.api, 'a@x.com')).next_expiry, s.clock.t + 30 * DAY);
  s.clock.t += 31 * DAY;
  const b = await bal(s.api, 'a@x.com');
  assert.deepEqual(b.buckets, { bought: 1000, bonus: 0, commission: 0 });
  s.clock.t += 60 * DAY;
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
});

test('commission never ends by default', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 10000, currency: 'USD' });
  s.clock.t += 1500 * DAY;
  await s.admin.post('/v1/admin/sweep', {});
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.buckets.commission, 1000);
  assert.equal(b.next_expiry, null);
});

test('a rule can set its own end date', async () => {
  const s = await setup();
  await s.admin.post('/v1/admin/rules', { event_type: 'promo', bucket: 'bonus', amount: 50, mode: 'once', expiry_days: 7 });
  await event(s.api, 'a@x.com', 'promo');
  assert.equal((await bal(s.api, 'a@x.com')).next_expiry, s.clock.t + 7 * DAY);
});

test('credits held for an order that ends later are not lost to the sweep', async () => {
  const s = await setup();
  await buy(s.api, 'a@x.com', 1000, 'p1');
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: 'o', amount_minor: 500, currency: 'USD' });
  await s.admin.post('/v1/admin/sweep', {});
  assert.equal((await bal(s.api, 'a@x.com')).balance, 500);
  assert.equal(r.body.credit_applied, 500);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});
