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
