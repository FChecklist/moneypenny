// Product-to-payee routing and the order snapshot (chunk F3). DARK: every call needs the payee flag (see payees.js gate).
// resolvePayee picks who receives the money for a new order. The choice is copied onto the order once
// (payee id, route, version, mode, snapshot) and never changes later. Credits, lots, holds and the ledger never read it.
import { ApiError, newId } from './util.js';
import { gate, chainRow, text, view, requireOwner } from './payees.js';
import { emit } from './outbox.js';

const PRODUCT_RE = /^(\*|[a-z][a-z0-9_]{1,63})$/;
export const productId = (v) => {
  if (v == null || v === '') return '*';
  if (typeof v !== 'string' || !PRODUCT_RE.test(v)) throw new ApiError(400, 'bad_product', 'product must be small letters, digits and underscore.');
  return v;
};

/** The copy kept on the order. Display, checkout and invoice text as they are NOW. No secret names, no secrets. */
export const snapshotOf = (p) => ({ payee_id: p.payee_id, display_name: p.display_name, legal_name: p.legal_name, gateway: p.gateway, mode: p.mode, currencies: p.currencies, checkout: p.checkout, invoice: p.invoice, version: p.version });

const usable = (p, currency) => p && p.status === 'active' && p.currencies.includes(currency);
async function payee(ctx, id) {
  const r = id && (await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', id));
  return r ? view(r) : null;
}

/**
 * Who receives the money for a new order of (tenant, product) at time `at`.
 * Route for the product, else the '*' route, else refuse no_route (503).
 * Main payee active and takes the currency: use it. Otherwise the fallback if it is active; otherwise refuse payee_unavailable (503).
 * A route marked test_only is skipped unless ctx.testOrders is true. Health is not read yet (chunk F9).
 */
export async function resolvePayee(ctx, { tenantId = ctx.tenantId, product, currency, at = ctx.now() } = {}) {
  await gate(ctx);
  const prod = productId(product);
  const rows = await ctx.db.all(
    'SELECT * FROM payee_route WHERE tenant_id = ? AND product_id IN (?, ?) AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY effective_from DESC',
    tenantId, prod, '*', at, at,
  );
  const ok = rows.filter((r) => !r.test_only || ctx.testOrders === true);
  const route = ok.find((r) => r.product_id === prod) || ok.find((r) => r.product_id === '*');
  if (!route) throw new ApiError(503, 'no_route', 'No payee is set up for this product.');
  const main = await payee(ctx, route.payee_id);
  if (usable(main, currency)) return { payee: main, route_id: route.route_id, via: route.product_id === '*' && prod !== '*' ? 'default' : 'route', product: prod };
  if (main && main.status === 'active') throw new ApiError(422, 'currency_unsupported', 'The payee does not take this currency.');
  const fb = await payee(ctx, route.fallback_payee_id);
  if (usable(fb, currency)) return { payee: fb, route_id: route.route_id, via: 'fallback', product: prod, main_payee_id: route.payee_id };
  throw new ApiError(503, 'payee_unavailable', 'No payee can take this order now.');
}

/** What buyCredits writes on the order. A fallback use leaves an audit row and an owner alert. Ids only. */
export async function orderPayeeColumns(ctx, args) {
  const r = await resolvePayee(ctx, args);
  if (r.via === 'fallback') {
    await chainRow(ctx, ctx.db, 'route.fallback_used', () => ({ route_id: r.route_id, main_payee_id: r.main_payee_id, payee_id: r.payee.payee_id, product: r.product }));
    await emit(ctx, 'payee.fallback_used', { route_id: r.route_id, main_payee_id: r.main_payee_id, payee_id: r.payee.payee_id });
  }
  return { product: r.product, payee_id: r.payee.payee_id, route_id: r.route_id, payee_version: r.payee.version, mode: r.payee.mode, payee_snapshot: JSON.stringify(snapshotOf(r.payee)) };
}

/** Owner only. Adds a route row that starts at effective_from. The open row for the same key is closed at that instant (the only update). Overlap is refused. */
export async function setRoute(ctx, b = {}) {
  await gate(ctx);
  requireOwner(ctx, 'change a route');
  const prod = productId(b.product_id);
  const from = b.effective_from;
  if (!Number.isSafeInteger(from) || from < 0) throw new ApiError(400, 'bad_field', 'effective_from must be a time in milliseconds.');
  if (typeof b.tenant_id !== 'string' || !b.tenant_id) throw new ApiError(400, 'bad_field', 'tenant_id is needed.');
  const reason = text(b.reason, 'reason', { max: 300, req: true });
  const test = b.test_only === true ? 1 : b.test_only == null || b.test_only === false ? 0 : null;
  if (test === null) throw new ApiError(400, 'bad_field', 'test_only must be true or false.');
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db };
    if (!(await db.first('SELECT 1 x FROM tenant WHERE id = ?', b.tenant_id))) throw new ApiError(404, 'tenant_not_found', 'No such tenant.');
    for (const id of [b.payee_id, b.fallback_payee_id]) {
      if (id == null && id === b.fallback_payee_id) continue;
      const p = await payee(c, id);
      if (!p) throw new ApiError(404, 'payee_not_found', 'No such payee.');
      if (p.status !== 'active') throw new ApiError(409, 'payee_not_active', 'A route can point only to an active payee.');
    }
    if (b.fallback_payee_id === b.payee_id) throw new ApiError(400, 'bad_field', 'The fallback must be a different payee.');
    const clash = await db.first('SELECT 1 x FROM payee_route WHERE tenant_id = ? AND product_id = ? AND test_only = ? AND (effective_from >= ? OR (effective_to IS NOT NULL AND effective_to > ?)) LIMIT 1', b.tenant_id, prod, test, from, from);
    if (clash) throw new ApiError(409, 'route_overlap', 'Another route for this product overlaps that time.');
    const open = await db.first('SELECT route_id FROM payee_route WHERE tenant_id = ? AND product_id = ? AND test_only = ? AND effective_to IS NULL', b.tenant_id, prod, test);
    if (open) await db.run('UPDATE payee_route SET effective_to = ? WHERE route_id = ?', from, open.route_id);
    const id = newId('route');
    await db.run('INSERT INTO payee_route (route_id, tenant_id, product_id, payee_id, effective_from, fallback_payee_id, test_only, set_by, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, b.tenant_id, prod, b.payee_id, from, b.fallback_payee_id ?? null, test, ctx.actor, reason, ctx.now());
    await chainRow(c, db, 'route.set', () => ({ route_id: id, tenant_id: b.tenant_id, product_id: prod, payee_id: b.payee_id, closed_route_id: open?.route_id ?? null }));
    return { route_id: id, closed_route_id: open?.route_id ?? null };
  });
}
