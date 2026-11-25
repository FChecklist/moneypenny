// A fake of the central IT Services pay service, for tests. No network: it is an injected fetch.
// It copies the checks and the status codes of the REAL files, read at commit 7d3d0b0 of the repository itservices-site:
//   functions/api/pay/credit-order.js   POST, header x-site-key, opens ONE gateway order, safe to repeat with the same payment_ref
//   functions/api/pay/credit-verify.js  POST, header x-site-key, runs verify.js and answers the facts of the order
//   GET /api/pay/ping                   liveness
// It cannot prove that the live service behaves the same. Only the owner's Rs 1 test can (docs/OWNER-ASK-CENTRAL-PAY-SERVICE.md).
import { createHmac, randomBytes } from 'node:crypto';

export const MNP_HOST = 'moneypenny.corporatetambola.com';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

export function fakeCentral({ site = MNP_HOST, siteKey = randomBytes(24).toString('hex'), gatewaySecret = randomBytes(16).toString('hex') } = {}) {
  const orders = new Map(); // payment_ref (Moneypenny order id) -> order
  const payments = new Map(); // gateway payment id -> payment
  const calls = []; // every call: { method, origin, path, headers, body, signal }
  const state = {
    configured: true, // false: the service answers 503 "not configured", like the real one without its gateway secrets
    down: null, // a status number: every call answers it
    offline: false, // true: the call itself fails (network)
    tweak: null, // (path, answer) => answer: change a good answer, to prove Moneypenny does not trust it blindly
  };
  const sign = (oid, pid) => createHmac('sha256', gatewaySecret).update(`${oid}|${pid}`).digest('hex');

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const text = typeof init.body === 'string' ? init.body : '';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, origin: u.origin, path: u.pathname, headers, body: text ? parse(text) : null, signal: init.signal ?? null });
    if (state.offline) throw new TypeError(`connect ECONNREFUSED ${siteKey}`); // the text carries the key on purpose: a test proves it never leaks
    if (state.down) return reply(state.down, { error: 'down' });
    const out = await route(method, u.pathname, headers, text);
    if (out.status === 200 && state.tweak) {
      const j = await out.clone().json();
      return reply(200, state.tweak(u.pathname, j) ?? j);
    }
    return out;
  }

  async function route(method, path, headers, text) {
    if (method === 'GET' && path === '/api/pay/ping') return reply(200, { ok: true });
    if (method !== 'POST' || (path !== '/api/pay/credit-order' && path !== '/api/pay/credit-verify')) return new Response('Not found', { status: 404 });
    const b = parse(text);
    if (!b || typeof b !== 'object') return reply(400, { error: 'bad request' });
    if (headers['x-site-key'] !== siteKey || b.site !== site) return reply(401, { error: 'unknown site or wrong key' });
    if (!state.configured) return reply(503, { error: 'payments are not configured' });
    return path === '/api/pay/credit-order' ? order(b) : verify(b);
  }

  function order(b) {
    const credits = Number(b.credits), amount = Number(b.amount_minor), cur = String(b.currency ?? '');
    if (!Number.isInteger(credits) || credits < 1 || credits > 1_000_000_000) return reply(400, { error: 'bad credits' });
    if (!Number.isInteger(amount) || amount < 100 || amount > 500_000_000) return reply(400, { error: 'bad amount' });
    if (cur !== 'INR' && cur !== 'USD') return reply(400, { error: 'bad currency' });
    const ref = String(b.payment_ref ?? '');
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(ref)) return reply(400, { error: 'bad payment_ref' });
    const payer = String(b.payer_email ?? '').trim().toLowerCase();
    if (!EMAIL.test(payer)) return reply(400, { error: 'bad payer e-mail' });
    const plan = `credits_${credits}`;
    const prior = orders.get(ref);
    if (prior) {
      if (prior.amount_minor !== amount || prior.currency !== cur || prior.plan !== plan || prior.payer_email !== payer) return reply(409, { error: 'this payment_ref was used for a different order' });
      return reply(200, { ok: true, txn_id: prior.txn_id, keyId: 'test_key_id', orderId: prior.orderId, amount_minor: prior.amount_minor, currency: prior.currency, repeat: true });
    }
    const o = { orderId: `order_${randomBytes(7).toString('hex')}`, payment_ref: ref, plan, amount_minor: amount, currency: cur, payer_email: payer, txn_id: `txn_${randomBytes(4).toString('hex')}`, status: 'created' };
    orders.set(ref, o);
    return reply(200, { ok: true, txn_id: o.txn_id, keyId: 'test_key_id', orderId: o.orderId, amount_minor: amount, currency: cur });
  }

  function verify(b) {
    const oid = String(b.razorpay_order_id ?? ''), pid = String(b.razorpay_payment_id ?? ''), sig = String(b.razorpay_signature ?? '');
    if (!/^order_\w+$/.test(oid) || !/^pay_\w+$/.test(pid)) return reply(400, { error: 'bad ids' });
    if (sig !== sign(oid, pid)) return reply(400, { error: 'bad signature' });
    const o = [...orders.values()].find((x) => x.orderId === oid);
    if (!o) return reply(404, { error: 'unknown order for this site' });
    const p = payments.get(pid);
    if (!p) return reply(502, { error: 'payment not found at the gateway' });
    if (p.order_id !== oid || p.amount !== o.amount_minor || p.currency !== o.currency) return reply(409, { error: 'payment does not match the order' });
    if (p.status === 'authorized') p.status = 'captured'; // the real service captures an authorized payment
    const paid = p.status === 'captured';
    if (paid) o.status = 'paid';
    return reply(200, { ok: true, paid, status: p.status, razorpay_order_id: oid, razorpay_payment_id: pid, amount_minor: o.amount_minor, currency: o.currency, payment_ref: o.payment_ref, order_payer_email: o.payer_email, game_id: null, txn_id: o.txn_id });
  }

  return {
    fetch, calls, state, orders, payments, siteKey, site,
    /** A person pays at the gateway. Returns the three values the browser reports after checkout (signed like the gateway signs). */
    pay(orderId, { payment_id = `pay_${randomBytes(7).toString('hex')}`, status = 'captured', amount, currency } = {}) {
      const o = [...orders.values()].find((x) => x.orderId === orderId);
      payments.set(payment_id, { order_id: orderId, status, amount: amount ?? o?.amount_minor, currency: currency ?? o?.currency });
      return { razorpay_order_id: orderId, razorpay_payment_id: payment_id, razorpay_signature: sign(orderId, payment_id) };
    },
    sign,
    of: (path) => calls.filter((c) => c.path === path),
  };
}
