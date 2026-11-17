// Random sequences around one sale: whatever order things happen in, once the sale is fully refunded
// and everything is unwound, no commission from it is left, and the ledger still adds up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, buy, event, HOUR } from './helpers.js';
import { verifyBalances } from '../src/ledger.js';

const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
  test(`fuzz ${seed}: a fully refunded sale leaves no commission, whatever happened before`, async () => {
    const r = rng(seed);
    const s = await setup();
    await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000 });
    await buy(s.api, 'b@y.com', 10000, 'FZ1');
    await event(s.api, 'a@x.com', 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 10000, currency: 'USD', sale_ref: 'FZ1', noNotice: true });
    s.clock.t += 40 * 24 * HOUR;
    const holds = [];
    const convs = [];
    let n = 0;
    for (let i = 0; i < 25; i++) {
      const pick = Math.floor(r() * 7);
      n++;
      if (pick === 0) {
        const h = await s.api.post('/v1/spend/reserve', { email: 'a@x.com', order_ref: `f${seed}-${n}`, amount_minor: 100 + Math.floor(r() * 400), currency: 'USD' });
        if (h.body.hold_id) holds.push(h.body.hold_id);
      } else if (pick === 1 && holds.length) await s.api.post('/v1/spend/capture', { hold_id: holds[Math.floor(r() * holds.length)] });
      else if (pick === 2 && holds.length) await s.api.post('/v1/spend/release', { hold_id: holds[Math.floor(r() * holds.length)] });
      else if (pick === 3 && holds.length) await s.api.post('/v1/refund', { type: 'order', hold_id: holds[Math.floor(r() * holds.length)] });
      else if (pick === 4) {
        const c = await s.api.post('/v1/convert_request', { email: 'a@x.com', credits: 100 + Math.floor(r() * 300) });
        if (c.body.request_id) convs.push(c.body.request_id);
      } else if (pick === 5 && convs.length) await s.admin.post(`/v1/admin/conversions/${convs[Math.floor(r() * convs.length)]}/reject`, {});
      else if (pick === 6) await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'FZ1', credits: 500 });
    }
    await s.pay.post('/v1/refund', { type: 'purchase', payment_ref: 'FZ1' }); // the rest
    // unwind: release what is open, return what was captured, reject what is pending
    for (const h of holds) {
      await s.api.post('/v1/spend/release', { hold_id: h });
      await s.api.post('/v1/refund', { type: 'order', hold_id: h });
    }
    for (const c of convs) await s.admin.post(`/v1/admin/conversions/${c}/reject`, {});
    assert.equal((await s.db.first("SELECT COALESCE(SUM(remaining),0) n FROM lot WHERE bucket = 'commission'")).n, 0, `seed ${seed}`);
    assert.deepEqual(await verifyBalances(s.ctx()), []);
  });
}
