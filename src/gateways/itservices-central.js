// Central IT Services pay service adapter (chunk F10). DARK: it is only reachable through the payee registry
// (flag MNP_PAYEE_ACCOUNTS) and, for orders, the second flag MNP_CENTRAL_PAY. Both default off.
//
// Why this exists: when IT Services is the payee, its Razorpay account lives INSIDE the central pay service (a Cloudflare
// Pages project with its own database). Moneypenny never holds those Razorpay secrets and never calls Razorpay for this
// payee. It asks the central service, which is what the service documents (repository itservices-site, commit 7d3d0b0,
// functions/api/pay/credit-order.js and credit-verify.js, docs/CENTRAL_PAYMENT_SERVICE.md).
//
// The three secret NAMES of the payee record mean, for this gateway only:
//   key_id         the site name the central service knows Moneypenny by (a public name, kept in the store so it can change)
//   key_secret     the site key sent in the x-site-key header (only its sha256 is kept by the central service)
//   webhook_secret reserved for a payee-bound check of pushes from the central service. Not read by this chunk.
//                  The registry requires three names for every gateway, so a value must exist; see docs/OWNER-ASK-CENTRAL-PAY-SERVICE.md.
// The address of the central service is a plain platform variable (MNP_CENTRAL_BASE_URL), not part of the payee record.
//
// HTTP goes only through an INJECTED fetch: there is no default, so nothing here can reach the network unless the caller passes one.
// Errors never carry a secret value, the site key or the raw text of the other side.
import { ApiError } from '../util.js';
import { resolveSecrets } from '../secrets.js';

export const GATEWAY_NAME = 'itservices_central';
export const BASE_NAME = 'MNP_CENTRAL_BASE_URL';
export const CALL_MS = 3500; // under the 4000 ms the order step allows a payment side (processRail)
const SITE_RE = /^[a-z0-9]([a-z0-9.-]{1,98})[a-z0-9]$/;

/** The address must be the plain https origin of a public host. Same shape rules as webhook addresses (outbox.js). Returns the origin. */
export function checkBaseUrl(raw) {
  const fail = () => new ApiError(503, 'central_not_configured', 'The address of the payment side is not set, or it is not a plain https address of a public host.');
  let u;
  try { u = new URL(String(raw)); } catch { throw fail(); }
  const h = u.hostname.replace(/\.+$/, '').toLowerCase();
  const blockedName = /(^|\.)(local|internal|lan|home|corp|intranet|private|localdomain|localhost)$/.test(h) || /^localhost(\.|$)/.test(h) || /(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|traefik\.me|vcap\.me|1u\.ms|metadata\.google\.internal)$/.test(h);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[') || h.includes(':') || blockedName || !h.includes('.')) throw fail();
  return u.origin;
}

/** What each status of the central service means to us. 2xx never gets here. */
function refuse(status) {
  if (status === 401 || status === 403) throw new ApiError(502, 'central_key_refused', 'The payment side did not accept the site key.');
  if (status === 503) throw new ApiError(502, 'central_not_ready', 'The payment side says it is not set up yet.');
  if (status === 409) throw new ApiError(409, 'central_conflict', 'The payment side holds a different order or amount under this reference.');
  if (status === 408 || status === 429 || status >= 500) throw new ApiError(502, 'central_unreachable', 'The payment side is busy or could not be reached.');
  throw new ApiError(502, 'central_refused', `The payment side refused the call (status ${Number(status) || 0}).`);
}

export function centralGateway({ payee, reader, fetch: f }) {
  if (typeof f !== 'function') throw new ApiError(500, 'gateway_not_configured', 'No HTTP client was given to the gateway.');
  const secrets = () => resolveSecrets(reader, payee.secret_names);
  const site = (s) => {
    if (!SITE_RE.test(String(s.key_id))) throw new ApiError(503, 'central_not_configured', 'The site name stored for the payment side is not a plain host name.');
    return s.key_id;
  };
  const send = async (method, path, { body, auth } = {}) => {
    const origin = checkBaseUrl(reader?.get?.(BASE_NAME));
    const headers = { 'content-type': 'application/json' };
    if (auth) headers['x-site-key'] = auth;
    let res;
    try {
      res = await f(`${origin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(CALL_MS) });
    } catch {
      throw new ApiError(502, 'central_unreachable', 'The payment side is busy or could not be reached.');
    }
    let json = null;
    try { json = await res.json(); } catch { /* an unreadable answer is judged below */ }
    return { status: Number(res.status) || 0, ok: !!res.ok, json };
  };
  return {
    name: GATEWAY_NAME,
    /**
     * Opens ONE order at the central service for a Moneypenny order. The central service treats payment_ref as the idempotency key:
     * the same order_id always gives the same gateway order (a retry never makes a second one). The central service must echo the
     * amount and currency we asked for; anything else is refused, so the price can never be changed on the other side.
     */
    async createOrder({ order_id, amount_minor, currency, credits, payer_email }) {
      const s = secrets();
      const r = await send('POST', '/api/pay/credit-order', { auth: s.key_secret, body: { site: site(s), payment_ref: String(order_id), credits, amount_minor, currency, payer_email } });
      if (!r.ok) refuse(r.status);
      const j = r.json;
      if (!j || j.ok !== true || typeof j.orderId !== 'string' || !j.orderId || j.amount_minor !== amount_minor || j.currency !== currency) {
        throw new ApiError(502, 'central_bad_answer', 'The payment side gave an answer that does not match the order.');
      }
      return { gateway_order_id: j.orderId, amount_minor: j.amount_minor, currency: j.currency, key_id: typeof j.keyId === 'string' ? j.keyId : null, txn_id: typeof j.txn_id === 'string' ? j.txn_id : null, repeat: j.repeat === true };
    },
    /**
     * The browser reports a finished checkout. The central service checks the gateway signature itself, asks the gateway what really
     * happened and answers the facts. Safe to repeat. Moneypenny credits only from these facts, never from what the browser says.
     */
    async verifyCheckout({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
      const s = secrets();
      const r = await send('POST', '/api/pay/credit-verify', { auth: s.key_secret, body: { site: site(s), razorpay_order_id, razorpay_payment_id, razorpay_signature } });
      if (r.status === 400) throw new ApiError(422, 'central_proof_refused', 'The payment side did not accept the payment proof.');
      if (r.status === 404) throw new ApiError(404, 'central_order_unknown', 'The payment side does not know this order.');
      if (!r.ok) refuse(r.status);
      const j = r.json;
      if (!j || j.ok !== true || typeof j.paid !== 'boolean') throw new ApiError(502, 'central_bad_answer', 'The payment side gave an unreadable answer.');
      if (!j.paid) return { paid: false, status: typeof j.status === 'string' ? j.status.slice(0, 40) : null };
      const readable = Number.isSafeInteger(j.amount_minor) && j.amount_minor > 0 && typeof j.currency === 'string' && ['razorpay_order_id', 'razorpay_payment_id', 'payment_ref', 'order_payer_email'].every((k) => typeof j[k] === 'string' && j[k]);
      if (!readable) throw new ApiError(502, 'central_bad_answer', 'The payment side gave an unreadable answer.');
      return { paid: true, status: typeof j.status === 'string' ? j.status.slice(0, 40) : null, razorpay_order_id: j.razorpay_order_id, razorpay_payment_id: j.razorpay_payment_id, amount_minor: j.amount_minor, currency: j.currency, payment_ref: j.payment_ref, order_payer_email: j.order_payer_email };
    },
    /** A person-facing liveness check. Never throws: the answer is only ok true or false. */
    async health() {
      try {
        const r = await send('GET', '/api/pay/ping');
        return { ok: r.ok };
      } catch {
        return { ok: false };
      }
    },
    /** Payments reach Moneypenny from the central service (a push) or from the browser (verifyCheckout), never as a gateway webhook for this payee. */
    async verifyWebhook() {
      return { ok: false };
    },
    async verifySignature() {
      throw new ApiError(422, 'central_no_local_proof', 'This payee has no local payment proof. The payment side checks it (verifyCheckout).');
    },
    /** The central service records refunds and disputes but never sends them; a person makes the refund in the payment gateway. */
    async refund() {
      throw new ApiError(422, 'refund_by_central_service', 'The central payment side does not take refund calls. A person makes the cash refund in the payment gateway.');
    },
  };
}
