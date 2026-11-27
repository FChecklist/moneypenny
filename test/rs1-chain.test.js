// The owner's own Rs 1 test, rehearsed with stand-ins: console -> Moneypenny -> (IT Services, simulated) -> back.
// The numbers here are the numbers in docs/GO-LIVE.md. No real payment is made and no real service is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { stubRail } from '../src/rail.js';
import { verifyBalances, verifyChain } from '../src/ledger.js';
import { refreshRates, utcDayStart } from '../src/fx.js';
import { createWallet, createPaymentSide, memoryStore } from '../packages/console-wallet/index.js';

test('R1. Rs 1 test: one pack of 1 credit at 100 paise, bought once, spent once, ledger balanced; a repeated webhook credits nothing more', async () => {
  const s = await setup({ requireRate: true }); // like the deployed Worker: no rate has been set
  s.app.rail = stubRail; // stands in for the IT Services adapter
  assert.equal((await s.admin.put('/v1/admin/settings', { inr_packs: { 1: 100 }, buy_min_credits: 1 })).status, 200);
  assert.equal((await s.admin.put('/v1/admin/catalogue', { product: 'tambola', item: 'rs1_test', credits: 1 })).status, 200);
  const granted = [];
  const wallet = createWallet({ mnp: s.api, now: () => s.clock.t, games: { tambola: { entitle: async (a) => granted.push(a.orderRef) } }, store: memoryStore() });
  const paymentSide = createPaymentSide({ pay: s.pay });
  const email = 'owner@example.com';

  const buy = await wallet.startBuy({ email, credits: 1, currency: 'INR', buyId: 'rs1-test' });
  assert.equal(buy.ok, true, JSON.stringify(buy));
  assert.equal(buy.amountMinor, 100); // Rs 1.00, whole paise
  const again = await wallet.startBuy({ email, credits: 1, currency: 'INR', buyId: 'rs1-test' }); // the owner double-clicks
  assert.equal(again.orderId, buy.orderId);

  // IT Services: Razorpay says "paid" (signature checked there), then it tells Moneypenny
  const paid = { orderId: buy.orderId, paymentRef: 'pay_example_rs1', paidMinor: 100, currency: 'INR' };
  assert.equal((await paymentSide.paymentVerified({ ...paid, paidMinor: 99 })).ok, false); // 1 paisa short gives nothing
  assert.equal((await wallet.balance(email)).balance ?? 0, 0);
  assert.equal((await paymentSide.paymentVerified(paid)).credited, 1);
  assert.equal((await paymentSide.paymentVerified(paid)).ok, true); // Razorpay sends the webhook twice
  assert.equal((await wallet.balance(email)).balance, 1);

  const spent = await wallet.spend({ email, product: 'tambola', item: 'rs1_test', spendKey: 'click-1' });
  assert.equal(spent.ok, true, JSON.stringify(spent));
  const repeat = await wallet.spend({ email, product: 'tambola', item: 'rs1_test', spendKey: 'click-1' }); // a double click
  assert.equal(repeat.ok, true);
  assert.equal(granted.length, 1, 'the game gave the item once');
  assert.equal((await wallet.balance(email)).balance, 0);

  assert.deepEqual(await verifyBalances(s.ctx()), []);
  assert.equal((await verifyChain(s.ctx())).ok, true);
  const kinds = (await s.db.all('SELECT kind, delta FROM entry ORDER BY seq')).map((e) => `${e.kind}:${e.delta}`);
  assert.deepEqual(kinds, ['purchase:1', 'hold:-1', 'capture:0']);
});

test('R2. exchange-rate rule from step 2: a stub-source rate refuses INR orders; a rate set by hand does not', async () => {
  const s = await setup({ requireRate: true });
  s.app.rail = stubRail;
  await s.admin.put('/v1/admin/settings', { inr_packs: { 1: 100 }, buy_min_credits: 1 });
  const ask = (ref) => s.api.post('/v1/buy_credits', { email: 'owner@example.com', credits: 1, currency: 'INR', order_ref: ref });
  await refreshRates(s.db, { name: 'stub', async fetch() { return { rates: { INR: 88 } }; } }, utcDayStart(s.clock.t));
  const refused = await ask('r2-stub');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'rate_source_not_configured');
  // the owner puts a rate in by hand (setup call source 'manual'): the pack can be bought again
  await s.db.tx((t) => t.run("INSERT INTO fx_rate (currency, rate_x10000, source, fetched_at, valid_from, valid_to, margin_bps, status, note) VALUES ('INR', 880000, 'manual', ?, ?, ?, 0, 'active', 'test')", s.clock.t, s.clock.t, utcDayStart(s.clock.t) + 86400000));
  const ok = await ask('r2-manual');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.amount_minor, 100);
});
