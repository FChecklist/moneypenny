// Contract test: the real answers must carry every field shown in contract/v1/examples.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, buy, note } from './helpers.js';

const ex = JSON.parse(readFileSync(new URL('../contract/v1/examples.json', import.meta.url), 'utf8'));
const has = (actual, sample, path = '') => {
  for (const k of Object.keys(sample)) {
    assert.ok(k in actual, `missing ${path}${k}`);
    if (sample[k] && typeof sample[k] === 'object' && !Array.isArray(sample[k]) && actual[k] && typeof actual[k] === 'object') has(actual[k], sample[k], `${path}${k}.`);
  }
};

test('answers carry every field the contract shows', async () => {
  const s = await setup();
  await buy(s.api, 'person@example.com', 300, 'p1');
  has((await s.read.get('/v1/balance?email=person@example.com')).body, ex.balance.response);
  const { local, rate_attribution, ...quoteShape } = ex.quote.response; // local appears only when a display rate exists; rate_attribution only with a real rate source
  has((await s.read.get('/v1/quote?credits=2000')).body, quoteShape);
  const bad = await s.api.post('/v1/spend/reserve_item', { email: 'person@example.com', product: 'demo_product', item: 'sample_item', order_ref: 'ord-1' });
  has(bad.body, ex.reserve_item.response_not_enough);
  await buy(s.api, 'person@example.com', 300, 'p2');
  const ok = await s.api.post('/v1/spend/reserve_item', { email: 'person@example.com', product: 'demo_product', item: 'sample_item', order_ref: 'ord-2' });
  has(ok.body, ex.reserve_item.response_ok);
  has((await s.api.post('/v1/spend/capture', { hold_id: ok.body.hold_id })).body, ex.capture.response);
  const o = await s.api.post('/v1/buy_credits', { email: 'person@example.com', credits: 2000, currency: 'USD', order_ref: 'buy-1' });
  const { rate_attribution: _ra, ...orderShape } = ex.buy_credits.response; // attribution only with a real rate source
  has(o.body, orderShape);
  has((await s.pay.post('/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: 'pay_C1', paid_minor: 2000, currency: 'USD' })).body, ex.rail_confirm.response);
  await note(s.api, ex.event_commission.request.body.sale_ref, ex.event_commission.request.body.cash_minor, 'USD', ex.event_commission.request.body.payer_email);
  const sale = await s.api.post('/v1/event', ex.event_commission.request.body);
  has(sale.body, ex.event_commission.response);
  const h = await (await s.app.fetch(new Request('http://t.local/health'))).json();
  has(h, ex.health.response);
  has((await s.api.get('/v1/admin/health')).body, ex.error_shape);
});
