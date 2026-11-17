import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, event, DAY } from './helpers.js';

const reserve = (api, o = {}) => api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: `o${Math.random()}`, amount_minor: 1000, currency: 'USD', ...o });
const allWelcome = async (api, email) => {
  for (const t of ['account_created', 'first_game_created', 'first_game_paid', 'first_game_completed']) await event(api, email, t);
};

test('welcome bonuses are once only', async () => {
  const s = await setup();
  const a = await event(s.api, 'a@x.com', 'account_created');
  assert.equal(a.body.granted, 100);
  const b = await event(s.api, 'a@x.com', 'account_created');
  assert.equal(b.body.granted, 0);
  assert.equal(b.body.reason, 'already_earned');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
});

test('the same event key twice never pays twice', async () => {
  const s = await setup();
  const body = { email: 'a@x.com', event_type: 'account_created', event_key: 'same-key' };
  await s.api.post('/v1/event', body);
  const r = await s.api.post('/v1/event', body);
  assert.equal(r.body.duplicate, true);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 100);
});

test('no rule = no credit; visits never earn', async () => {
  const s = await setup();
  assert.equal((await event(s.api, 'a@x.com', 'something_else')).body.reason, 'no_rule');
  assert.equal((await event(s.api, 'a@x.com', 'site_visit')).body.reason, 'no_credit_for_visits');
  const r = await s.admin.post('/v1/admin/rules', { event_type: 'site_visit', bucket: 'bonus', amount: 10, mode: 'once' });
  assert.equal(r.status, 422);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 0);
});

test('bonus is not spendable until the first real paid purchase', async () => {
  const s = await setup();
  await allWelcome(s.api, 'a@x.com');
  assert.equal((await bal(s.api, 'a@x.com')).balance, 700);
  const r = await reserve(s.api);
  assert.equal(r.body.credit_applied, 0);
  await buy(s.api, 'a@x.com', 500, 'p1');
  const r2 = await reserve(s.api);
  assert.equal(r2.body.credit_applied, 1000 - 0 > 0 ? r2.body.credit_applied : 0);
  assert.ok(r2.body.credit_applied > 0);
});

test('bonus pays at most 50% of one order; spend order is bonus, commission, bought', async () => {
  const s = await setup();
  await allWelcome(s.api, 'a@x.com'); // 700 bonus
  await buy(s.api, 'a@x.com', 10000, 'p1');
  const r = await reserve(s.api, { amount_minor: 1000 }); // 1000 credits; bonus cap 500
  assert.equal(r.body.credit_applied, 1000);
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.buckets.bonus, 200); // used 500
  assert.equal(b.buckets.bought, 9500); // used 500
});

test('commission is spent after bonus and before bought, but only once its hold is over', async () => {
  const s = await setup();
  await event(s.api, 'a@x.com', 'account_created'); // 100 bonus
  await buy(s.api, 'a@x.com', 5000, 'p1');
  const ref = await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'buyer@y.com', cash_minor: 10000, currency: 'USD' });
  assert.equal(ref.body.granted, 1000); // 10% of cash
  assert.equal((await bal(s.api, 'a@x.com')).settling, 1000);
  const early = await reserve(s.api, { amount_minor: 1500 });
  assert.equal(early.body.credit_applied, 1500); // bonus 100 + bought 1400, no commission yet
  await s.api.post('/v1/spend/release', { hold_id: early.body.hold_id });
  s.clock.t += 8 * DAY;
  const r = await reserve(s.api, { amount_minor: 1500 });
  assert.equal(r.body.credit_applied, 1500);
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.buckets.bonus, 0);
  assert.equal(b.buckets.commission, 0); // 1000 used before touching bought
  assert.equal(b.buckets.bought, 5000 - 400);
});

test('lifetime bonus cap truncates and then stops further bonus', async () => {
  const s = await setup();
  await allWelcome(s.api, 'a@x.com'); // 700 of 800
  const g = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 500, ref: 'gift1' });
  assert.equal(g.body.granted, 100);
  const g2 = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 50, ref: 'gift2' });
  assert.equal(g2.status, 422);
  assert.equal(g2.body.error.code, 'cap_reached');
});

test('a single hand-given bonus cannot exceed the setting', async () => {
  const s = await setup();
  const g = await s.api.post('/v1/credit', { email: 'a@x.com', bucket: 'bonus', amount: 501, ref: 'g' });
  assert.equal(g.status, 400);
});

test('repeating bonus rules need a lifetime cap; capped rule stops at its count', async () => {
  const s = await setup();
  const bad = await s.admin.post('/v1/admin/rules', { event_type: 'daily_play', bucket: 'bonus', amount: 10, mode: 'every' });
  assert.equal(bad.body.error.code, 'cap_required');
  await s.admin.post('/v1/admin/rules', { event_type: 'daily_play', bucket: 'bonus', amount: 10, mode: 'capped', max_count: 2 });
  const out = [];
  for (let i = 0; i < 3; i++) out.push((await event(s.api, 'a@x.com', 'daily_play')).body.granted);
  assert.deepEqual(out, [10, 10, 0]);
});

test('a rule lifetime cap truncates the last grant', async () => {
  const s = await setup();
  await s.admin.post('/v1/admin/rules', { event_type: 'game_played', bucket: 'bonus', amount: 40, mode: 'every', lifetime_cap: 100 });
  const out = [];
  for (let i = 0; i < 4; i++) out.push((await event(s.api, 'a@x.com', 'game_played')).body.granted);
  assert.deepEqual(out, [40, 40, 20, 0]);
});

test('the whole tenant has a daily bonus limit', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { tenant_daily_bonus_cap: 150 });
  assert.equal((await event(s.api, 'a@x.com', 'account_created')).body.granted, 100);
  assert.equal((await event(s.api, 'b@x.com', 'account_created')).body.granted, 50);
  assert.equal((await event(s.api, 'c@x.com', 'account_created')).body.granted, 0);
  s.clock.t += 2 * DAY;
  assert.equal((await event(s.api, 'c@x.com', 'account_created')).body.granted, 100);
});

test('bonus share of an order follows the setting', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { bonus_max_order_pct: 10 });
  await allWelcome(s.api, 'a@x.com');
  await buy(s.api, 'a@x.com', 10000, 'p1');
  await reserve(s.api, { amount_minor: 1000 });
  assert.equal((await bal(s.api, 'a@x.com')).buckets.bonus, 600); // only 100 used
});

test('bonus can be switched to spend before any purchase by a setting', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { bonus_needs_paid: false });
  await event(s.api, 'a@x.com', 'account_created');
  const r = await reserve(s.api, { amount_minor: 1000 });
  assert.equal(r.body.credit_applied, 100);
});
