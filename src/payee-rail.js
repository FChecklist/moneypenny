// Payee-aware rail (chunk F11). DARK: with the two flags off nothing here is built, and the Worker keeps the rail it had.
//   MNP_PAYEE_ACCOUNTS=1  the payee registry (F1 to F9)
//   MNP_CENTRAL_PAY=1     orders of a central payee may be opened at the central IT Services pay service (this chunk)
// Both default off. selectRail() returns the base rail ITSELF (the same object) unless both are '1' AND an HTTP client was given.
//
// What it does: processRail() hands every order to the rail. This rail looks at the ORDER's own payee snapshot (taken when the
// order was made, never today's route). If that payee's gateway is itservices_central, the order is opened at the central service
// through the adapter. Every other order goes to the base rail exactly as before. Credits, lots, holds and the ledger never read this file.
import { ApiError } from './util.js';
import { payeesEnabled, view } from './payees.js';
import { gatewayFor } from './gateways/index.js';
import { GATEWAY_NAME } from './gateways/itservices-central.js';
import { makeSecretReader } from './secrets.js';

/** Both flags, for code that has a context (tests, owner calls). The Worker decides once, at start, with selectRail. */
export const centralPayEnabled = (c) => payeesEnabled(c) && (c.central === true || c.env?.MNP_CENTRAL_PAY === '1');

const snapshotOf = (o) => {
  try { return JSON.parse(o?.payee_snapshot ?? 'null'); } catch { return null; }
};
export const isCentralOrder = (o) => !!o?.payee_id && snapshotOf(o)?.gateway === GATEWAY_NAME;

/**
 * Whether `rail` may open an order whose payee columns are `pc` (null when the registry is off). A plain rail has no canServe and
 * keeps serving what it served before, EXCEPT an order of a central payee: a plain rail never opens that (it would open the order
 * at the wrong payee's gateway), so with the central flag off such an order is refused instead of being sent to the old rail.
 */
export const railCanServe = (rail, pc) => (typeof rail?.canServe === 'function' ? rail.canServe(pc) : !isCentralOrder(pc));

/** `base` is the rail that served every order before. `fetch` and `store` are injected; the store is read by secret NAME only. */
export function payeeRail(base, { fetch: f, store, adapters } = {}) {
  const reader = makeSecretReader(store ?? {});
  return {
    name: 'payee_rail', // never 'not_configured': buyCredits asks canServe() below before it writes an order
    central: true, // processRail opens an order of a central payee only on a rail that says this
    base,
    /** buyCredits asks before it writes anything. pc is the payee columns of the new order, or null. Central orders are served here; the rest only if the base rail is really connected. */
    canServe(pc) {
      return isCentralOrder(pc) || (!!base && base.name !== 'not_configured');
    },
    async createOrder(o, x = {}) {
      const order = x.order;
      if (!x.ctx || !isCentralOrder(order)) return base.createOrder(o, x);
      const row = await x.ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', order.payee_id);
      if (!row || row.gateway !== GATEWAY_NAME) throw new ApiError(409, 'payee_changed', 'The payee of this order is not a central payee any more.');
      if (row.status === 'retired') throw new ApiError(409, 'central_payee_retired', 'The central payee of this order was retired.');
      const acc = await x.ctx.db.first('SELECT email_norm FROM account WHERE id = ?', order.account_id);
      if (!acc) throw new ApiError(409, 'no_account', 'The person of this order is not known.');
      const out = await gatewayFor(view(row), { reader, fetch: f, adapters }).createOrder({
        order_id: o.order_id, order_ref: o.order_ref, amount_minor: o.amount_minor, currency: o.currency, credits: o.credits, payer_email: acc.email_norm,
      });
      // The pay window of the central service already knows the order; there is no separate pay address to hand out.
      return { rail_order_id: out.gateway_order_id, pay_url: null };
    },
    async health() {
      return base && typeof base.health === 'function' ? base.health() : { ok: false };
    },
    async instruct(req) {
      return base.instruct(req);
    },
  };
}

/** The Worker's one decision. Any doubt (a flag off, no HTTP client) returns the base rail itself, untouched. */
export function selectRail(env, base, { fetch: f, adapters } = {}) {
  if (env?.MNP_PAYEE_ACCOUNTS !== '1' || env?.MNP_CENTRAL_PAY !== '1' || typeof f !== 'function') return base;
  return payeeRail(base, { fetch: f, adapters, store: { get: (n) => (n === 'MNP_MASTER_SECRET' ? undefined : env[n]) } });
}
