// Guards of the central pay service chunks (F10 to F13), in the same format as GUARDS in scripts/guard-check.js:
// [id, what the guard does, file, exact text to find (must occur exactly once in that file), replacement].
// Each one is removed in a throw-away copy; at least one test must fail, or guard-check reports a hole.
// Kept in its own file so the main list stays short and two branches that add guards do not touch the same lines.
export const CENTRAL_GUARDS = [
  // --- a central payee's money only ever goes through the central rail
  ['central-plain-rail-buy', 'an order of a central payee is refused on a plain rail (it would open the wrong payee\'s gateway order)', 'src/gate.js', 'if (!railCanServe(ctx.rail, pc)) throw', 'if (false) throw'],
  ['central-plain-rail-retry', 'a waiting order of a central payee is never sent to a plain rail', 'src/gate.js', 'if (isCentralOrder(o) && rail.central !== true) throw', 'if (false) throw'],
  ['central-snapshot', 'the order snapshot, not today\'s route, decides that an order opens at the central service', 'src/payee-rail.js', 'if (!x.ctx || !isCentralOrder(order)) return base.createOrder(o, x);', 'return base.createOrder(o, x);'],
  ['central-retired', 'a retired central payee opens no new order', 'src/payee-rail.js', "if (row.status === 'retired') throw", 'if (false) throw'],
  ['central-select-flag', 'the central rail is built only when both flags are 1', 'src/payee-rail.js', "env?.MNP_CENTRAL_PAY !== '1' ||", 'false ||'],
  // --- the central service's answer is checked, never trusted
  ['central-price-echo', 'an answer that changes the amount or currency of the order is refused', 'src/gateways/itservices-central.js', 'j.amount_minor !== amount_minor || j.currency !== currency', 'false'],
  ['central-https-only', 'the central address must be https', 'src/gateways/itservices-central.js', "u.protocol !== 'https:' ||", 'false ||'],
  ['central-site-key', 'every call to the central service carries the site key', 'src/gateways/itservices-central.js', "if (auth) headers['x-site-key'] = auth;", ''],
  // --- credits come only from the central service's facts, once, for the right order, payment and person
  ['central-facts', 'facts that do not name this order, payment and person credit nothing', 'src/central-confirm.js', 'if (!matches) throw', 'if (false) throw'],
  ['central-own-order', 'a proof for another order is refused before the central service is asked', 'src/central-confirm.js', 'if (!o.rail_order_id || o.rail_order_id !== proof.razorpay_order_id) throw', 'if (false) throw'],
  ['central-not-central', 'only an order of a central payee can be confirmed here', 'src/central-confirm.js', 'if (!isCentralOrder(o)) throw', 'if (false) throw'],
  ['central-payid-case', 'a repeat of the same payment is recognised whatever the letter case of its id', 'src/central-confirm.js', 'lc(o.payment_ref) === lc(proof.razorpay_payment_id)', 'o.payment_ref === proof.razorpay_payment_id'],
  // --- off-switches and owner scope
  ['central-confirm-flag', 'confirmation of a central payment is off unless both flags are on', 'src/central-confirm.js', 'if (!centralPayEnabled(ctx)) throw', 'if (false) throw'],
  ['central-health-flag', 'central health is off unless both flags are on', 'src/central-health.js', 'if (!centralPayEnabled(ctx)) throw', 'if (false) throw'],
  ['central-health-owner', 'central health is for the owner only', 'src/central-health.js', "requireOwner(ctx, 'see the health of the central payment side');", ''],
];
