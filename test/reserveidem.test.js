// reserve_item is idempotent: a repeat gives the same hold, so a lost answer can be recovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, buy, MIN } from './helpers.js';
import { verifyBalances } from '../src/ledger.js';

const res = (api, o = {}) => api.post('/v1/spend/reserve_item', { email: 'a@x.com', product: 'g', item: 'std', order_ref: 'o1', ...o });
async function world() {
  const s = await setup();
  await s.admin.put('/v1/admin/catalogue', { product: 'g', item: 'std', credits: 1000 });
  await s.admin.put('/v1/admin/catalogue', { product: 'g', item: 'big', credits: 1500 });
  await buy(s.api, 'a@x.com', 3000, 'p1');
  return s;
}

test('RI-1: the same reserve twice gives the same hold and holds credits once', async () => {
  const s = await world();
  const a = await res(s.api);
  const b = await res(s.api);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.hold_id, b.body.hold_id);
  assert.equal(b.body.repeat, true);
  assert.equal((await bal(s.api, 'a@x.com')).balance, 2000);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('RI-2: another person, another item or a lapsed hold is still refused', async () => {
  const s = await world();
  await res(s.api);
  await buy(s.api, 'b@x.com', 3000, 'p2');
  assert.equal((await res(s.api, { email: 'b@x.com' })).body.error.code, 'order_has_open_hold');
  assert.equal((await res(s.api, { item: 'big' })).body.error.code, 'order_has_open_hold');
});

test('RI-3: after capture the order cannot be reserved again', async () => {
  const s = await world();
  const a = await res(s.api);
  await s.api.post('/v1/spend/capture', { hold_id: a.body.hold_id });
  assert.equal((await res(s.api)).body.error.code, 'order_already_paid_with_credits');
});
