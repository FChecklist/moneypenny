// Payment-rail adapter. The ledger only CALCULATES and records instructions; a rail turns an
// approved instruction into real money. Phase 0 ships only this stub: nothing is connected and
// no money can move. A real rail (for example RazorpayX run by IT Services) would implement the same shape.
//
//   rail.instruct({ request_id, currency, net_minor, gross_minor, tds_minor }) -> { ref, executed }
//
// "executed" must stay false until a person records the real payment id with mark_paid.

//   rail.createOrder({ order_id, order_ref, amount_minor, currency, credits }) -> { rail_order_id, pay_url }
//        must be safe to call twice with the same order_id (it returns the same order).
//   rail.health() -> { ok }
//
// Moneypenny sits between every product and IT Services: products never call the rail themselves.

export const stubRail = {
  name: 'stub',
  async createOrder(o) {
    return { rail_order_id: `STUB-ORD-${o.order_id}`, pay_url: `https://pay.invalid/stub/${o.order_id}` };
  },
  async health() {
    return { ok: true };
  },
  async instruct(req) {
    return { ref: `STUB-${req.request_id}`, executed: false };
  },
};

/** Used by the deployed Worker until a real payment side is connected: money routes refuse instead of pretending. */
export const unconfiguredRail = {
  name: 'not_configured',
  async createOrder() {
    throw new Error('rail_not_configured');
  },
  async health() {
    return { ok: false };
  },
  async instruct() {
    throw new Error('rail_not_configured');
  },
};

/**
 * What every real payment-rail adapter must do, as a check. Run it against the adapter (with a sandbox account, never real money):
 * it returns the list of broken promises (empty = good). A repeat of createOrder with the same order_id MUST return the same order,
 * because Moneypenny repeats the call after a timeout, a restart or a requeue.
 */
export async function railContract(rail, { timeoutMs = 4000 } = {}) {
  const bad = [];
  const slow = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('too long')), timeoutMs))]);
  const order = (id) => ({ order_id: id, order_ref: `REF-${id}`, amount_minor: 100, currency: 'INR', credits: 100 });
  try {
    const h = await slow(rail.health());
    if (!h || typeof h.ok !== 'boolean') bad.push('health() must return { ok: true or false }');
    else if (h.ok !== true) bad.push('health() says the rail is not ok');
  } catch (e) { bad.push(`health() failed or took too long: ${String(e && e.message).slice(0, 60)}`); }
  try {
    const a = await slow(rail.createOrder(order('contract-1')));
    if (!a || typeof a.rail_order_id !== 'string' || !a.rail_order_id) bad.push('createOrder() must return a text rail_order_id');
    else {
      const again = await slow(rail.createOrder(order('contract-1')));
      if (!again || again.rail_order_id !== a.rail_order_id) bad.push('createOrder() twice with the same order_id must return the same order (same rail_order_id), never a second order');
      const other = await slow(rail.createOrder(order('contract-2')));
      if (other && other.rail_order_id === a.rail_order_id) bad.push('createOrder() for another order_id must make another order');
    }
    if (a && a.pay_url != null && !(typeof a.pay_url === 'string' && /^https:\/\//.test(a.pay_url))) bad.push('pay_url must be an https address');
  } catch (e) { bad.push(`createOrder() failed or took too long (limit ${timeoutMs} ms): ${String(e && e.message).slice(0, 60)}`); }
  return bad;
}
