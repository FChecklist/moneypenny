// Fake gateway for tests. No network, no real money. Same shape as every adapter.
import { hmacHex, safeEqual } from '../util.js';

export function fakeGateway({ secrets }) {
  const orders = new Map();
  const refunds = new Map();
  return {
    name: 'fake',
    calls: [],
    async createOrder(o) {
      this.calls.push('createOrder');
      if (!orders.has(o.order_id)) orders.set(o.order_id, { gateway_order_id: `fake_${o.order_id}`, amount_minor: o.amount_minor, currency: o.currency });
      return { ...orders.get(o.order_id), key_id: secrets.key_id };
    },
    async verifySignature({ order_id, payment_id, signature }) {
      this.calls.push('verifySignature');
      return safeEqual(await hmacHex(secrets.key_secret, `${order_id}|${payment_id}`), String(signature || ''));
    },
    async refund({ payment_id, amount_minor, idem }) {
      this.calls.push('refund');
      if (!refunds.has(idem)) refunds.set(idem, { refund_id: `fakerf_${payment_id}_${refunds.size + 1}`, amount_minor });
      return refunds.get(idem);
    },
  };
}
