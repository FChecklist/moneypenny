// Payment-rail adapter. The ledger only CALCULATES and records instructions; a rail turns an
// approved instruction into real money. Phase 0 ships only this stub: nothing is connected and
// no money can move. A real rail (for example RazorpayX run by IT Services) would implement the same shape.
//
//   rail.instruct({ request_id, currency, net_minor, gross_minor, tds_minor }) -> { ref, executed }
//
// "executed" must stay false until a person records the real payment id with mark_paid.

export const stubRail = {
  name: 'stub',
  async instruct(req) {
    return { ref: `STUB-${req.request_id}`, executed: false };
  },
};
