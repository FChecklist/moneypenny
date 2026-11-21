// The owner's own Rs 1 test, rehearsed with stand-ins: console -> Moneypenny -> (IT Services, simulated) -> back.
// The numbers here are the numbers in docs/GO-LIVE.md. No real payment is made and no real service is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { stubRail } from '../src/rail.js';
import { verifyBalances, verifyChain } from '../src/ledger.js';
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
