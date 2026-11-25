// Razorpay adapter (chunk F4). HTTP goes only through an INJECTED fetch: there is no default, so nothing here
// can reach Razorpay unless the caller passes one. Secrets are read by NAME from the payee record through the reader.
// Errors never carry a secret value or the gateway's raw text.
import { ApiError, hmacHex, safeEqual } from '../util.js';
import { resolveSecrets } from '../secrets.js';

const BASE = 'https://api.razorpay.com/v1';

/** Pure: reads a Razorpay webhook body. Only payment.captured and order.paid carry a payment we can apply. Anything unreadable gives normalized null. */
export function normalizeRazorpayEvent(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { return { type: null, normalized: null }; }
  const type = typeof j?.event === 'string' ? j.event : null;
  const p = j?.payload?.payment?.entity;
  if ((type === 'payment.captured' || type === 'order.paid') && p && typeof p.id === 'string' && typeof p.order_id === 'string' && Number.isSafeInteger(p.amount) && typeof p.currency === 'string') {
    return { type, normalized: { gateway_order_id: p.order_id, payment_id: p.id, amount_minor: p.amount, currency: p.currency } };
  }
  return { type, normalized: null };
}

export function razorpayGateway({ payee, reader, fetch: f }) {
  if (typeof f !== 'function') throw new ApiError(500, 'gateway_not_configured', 'No HTTP client was given to the gateway.');
  const secrets = () => resolveSecrets(reader, payee.secret_names);
  const call = async (method, path, body, idem) => {
    const s = secrets();
    const headers = { authorization: `Basic ${btoa(`${s.key_id}:${s.key_secret}`)}`, 'content-type': 'application/json' };
    if (idem) headers['x-payout-idempotency'] = idem;
    let res;
    try {
      res = await f(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new ApiError(502, 'gateway_error', 'The payment gateway could not be reached.');
    }
    let json = null;
    try { json = await res.json(); } catch { /* error mapped below */ }
    if (!res.ok || !json) throw new ApiError(502, 'gateway_error', `The payment gateway refused the call (status ${Number(res.status) || 0}).`);
    return json;
  };
  return {
    name: 'razorpay',
    /** Same order_id gives the same receipt, so a repeat is safe. */
    async createOrder({ order_id, amount_minor, currency }) {
      const j = await call('POST', '/orders', { amount: amount_minor, currency, receipt: String(order_id).slice(0, 40) });
      if (typeof j.id !== 'string') throw new ApiError(502, 'gateway_error', 'The payment gateway gave an unreadable answer.');
      return { gateway_order_id: j.id, amount_minor: j.amount, currency: j.currency, key_id: secrets().key_id };
    },
    /** Checkout signature: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
    async verifySignature({ order_id, payment_id, signature }) {
      return safeEqual(await hmacHex(secrets().key_secret, `${order_id}|${payment_id}`), String(signature || ''));
    },
    /** Webhook check: HMAC-SHA256 of the RAW body with THIS payee's webhook secret, hex, in x-razorpay-signature. Checked before the body is read. */
    async verifyWebhook(raw, headers) {
      const ok = safeEqual(await hmacHex(secrets().webhook_secret, raw), String(headers.get('x-razorpay-signature') || ''));
      if (!ok) return { ok: false };
      return { ok: true, event_id: headers.get('x-razorpay-event-id') || null, ...normalizeRazorpayEvent(raw) };
    },
    async refund({ payment_id, amount_minor, idem }) {
      const j = await call('POST', `/payments/${encodeURIComponent(payment_id)}/refund`, { amount: amount_minor }, idem);
      if (typeof j.id !== 'string') throw new ApiError(502, 'gateway_error', 'The payment gateway gave an unreadable answer.');
      return { refund_id: j.id, amount_minor: j.amount };
    },
  };
}
