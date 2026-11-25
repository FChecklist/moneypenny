// Confirmation of a central payment (chunk F12). DARK: needs both flags (see payee-rail.js).
// The browser reports a finished checkout. We do NOT believe the browser: the central service checks the gateway signature itself,
// asks the gateway what really happened and answers the facts (adapter.verifyCheckout). Credits are given only from those facts,
// through the same railConfirm every other payment uses, so the amount, the currency, the one-payment-once rule and the rate lock are unchanged.
//
// Order of work: the order and its OWN payee snapshot (never today's route) -> the proof must name this order's gateway order
// -> ONE call to the central service, made before any transaction opens -> the facts must name this very order, payment and person
// -> railConfirm and one chained audit row in a single transaction (a failed audit undoes the credit; the retry is safe).
// ctx must be a plain database context (ctx.db.tx), like the webhook intake: the HTTP call must never run inside a transaction.
import { ApiError, ref } from './util.js';
import { gate, chainRow, view } from './payees.js';
import { gatewayFor } from './gateways/index.js';
import { GATEWAY_NAME } from './gateways/itservices-central.js';
import { makeSecretReader } from './secrets.js';
import { railConfirm } from './gate.js';
import { lc } from './wallet.js';
import { centralPayEnabled, isCentralOrder } from './payee-rail.js';

const noNetwork = async () => { throw new Error('no network'); };
const PROOF_RE = /^[0-9a-fA-F]{32,128}$/;

export async function confirmCentralPayment(ctx, b = {}, { adapters } = {}) {
  await gate(ctx, undefined, true);
  if (!centralPayEnabled(ctx)) throw new ApiError(503, 'central_disabled', 'The central payment side is not turned on.');
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'bad_request', 'Body must be an object.');
  const orderId = ref(b.order_id, 'order_id');
  const proof = { razorpay_order_id: ref(b.razorpay_order_id, 'razorpay_order_id'), razorpay_payment_id: ref(b.razorpay_payment_id, 'razorpay_payment_id'), razorpay_signature: String(b.razorpay_signature ?? '') };
  if (!PROOF_RE.test(proof.razorpay_signature)) throw new ApiError(400, 'bad_request', 'razorpay_signature must be the hex signature of the checkout.');

  const o = await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND id = ?', ctx.tenantId, orderId);
  if (!o) throw new ApiError(404, 'no_order', 'No such order.');
  if (!isCentralOrder(o)) throw new ApiError(409, 'not_central_order', 'This order was not made through the central payment side.');
  if (!o.rail_order_id || o.rail_order_id !== proof.razorpay_order_id) throw new ApiError(409, 'order_mismatch', 'The payment proof is for another order.');
  if (o.status === 'paid') {
    if (lc(o.payment_ref) === lc(proof.razorpay_payment_id)) return { order_id: o.id, status: 'paid', credited: o.credits, already: true, paid: true }; // payment ids are kept in lower case
    throw new ApiError(409, 'order_already_paid', 'This order was already paid with another payment.');
  }
  const row = await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', o.payee_id);
  if (!row || row.gateway !== GATEWAY_NAME) throw new ApiError(409, 'payee_changed', 'The payee of this order is not a central payee any more.');
  const payee = view(row);
  const acc = await ctx.db.first('SELECT email_norm FROM account WHERE id = ?', o.account_id);
  if (!acc) throw new ApiError(409, 'no_account', 'The person of this order is not known.');

  const reader = makeSecretReader(ctx.secrets ?? ctx.env ?? {});
  const facts = await gatewayFor(payee, { reader, fetch: ctx.fetch ?? noNetwork, adapters }).verifyCheckout(proof); // the one outside call, before any transaction
  if (!facts.paid) return { order_id: o.id, status: o.status, paid: false };
  const matches = facts.razorpay_order_id === o.rail_order_id && facts.razorpay_payment_id === proof.razorpay_payment_id && facts.payment_ref === o.id && lc(facts.order_payer_email) === lc(acc.email_norm);
  if (!matches) throw new ApiError(409, 'central_facts_mismatch', 'The payment facts do not match this order. Nothing was credited.');

  const c0 = { ...ctx, actor: ctx.actor ?? 'central-confirm' };
  const out = await ctx.db.tx(async (db) => {
    const c = { ...c0, db };
    const r = await railConfirm(c, { order_id: o.id, payment_ref: facts.razorpay_payment_id, paid_minor: facts.amount_minor, currency: facts.currency });
    await chainRow(c, db, 'central.confirmed', () => ({ payee_id: payee.payee_id, order_id: o.id }));
    return r;
  });
  return { ...out, paid: true };
}
