// Webhook entry per payee (chunk F7). DARK: needs the payee flag. The gateway signature is the only login here.
// Order of work: find the payee (unknown: 404 with no detail) -> check the signature with THAT payee's webhook secret on the raw body
// -> event id seen before for this payee (repeat: 200 duplicate) -> find the order by the gateway order id
// -> the ORDER SNAPSHOT's payee must be this payee, never whatever payee is routed now -> same code as railConfirm.
// Events that do not apply (unknown order, other payee, other event type, mismatched amount) are stored as 'ignored' and answered 200,
// so the gateway stops retrying. They are never applied. A paused or retired payee still accepts payments (money in means credits).
// A draft payee accepts only test orders. Never a secret value or the raw body in an answer, an audit row or the event table.
import { ApiError } from './util.js';
import { gate, chainRow, view } from './payees.js';
import { gatewayFor } from './gateways/index.js';
import { makeSecretReader } from './secrets.js';
import { railConfirm } from './gate.js';
import { emit } from './outbox.js';

const MAX_RAW = 65536;
// Intake never calls a gateway. The adapter needs a fetch function to be built, so it gets one that always refuses.
const noNetwork = async () => { throw new Error('no network in webhook intake'); };
const done = (status, body) => ({ status, body: { ok: status < 400, ...body } });

/**
 * ctx: { db, now, env | secrets, fetch? }. `adapters` is for tests. Returns { status, body }. Never throws for a bad signature,
 * so the audit row for it is kept (a throw inside a transaction would undo it).
 */
export async function receivePayeeWebhook(ctx0, payeeId, raw, headers, { adapters } = {}) {
  const ctx = { ...ctx0, actor: 'gateway-webhook', callerType: 'payment', keyId: null }; // never the owner role
  await gate(ctx, undefined, true); // only the flag: money that is already paid must never wait on a setup check
  if (typeof raw !== 'string' || raw.length > MAX_RAW) throw new ApiError(413, 'too_large', 'Request is too large.');
  const row = await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', String(payeeId));
  if (!row) throw new ApiError(404, 'payee_not_found', 'No such payee.'); // same answer for any id: ids cannot be guessed
  const payee = view(row);
  const reader = makeSecretReader(ctx.secrets ?? ctx.env ?? {});
  let ev;
  try {
    ev = await gatewayFor(payee, { reader, fetch: ctx.fetch ?? noNetwork, adapters: adapters ?? undefined }).verifyWebhook(raw, headers);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'payee_secret_missing') {
      await chainRow(ctx, ctx.db, 'webhook.secret_missing', () => ({ payee_id: payee.payee_id }));
      throw new ApiError(500, 'payee_secret_missing', 'The webhook secret of this payee is not in the platform store.');
    }
    throw e;
  }
  if (!ev.ok) {
    await chainRow(ctx, ctx.db, 'webhook.bad_signature', () => ({ payee_id: payee.payee_id }));
    return done(401, { error: { code: 'webhook_bad_signature', message: 'Signature not accepted.' } });
  }
  if (typeof ev.event_id !== 'string' || !ev.event_id || ev.event_id.length > 120) throw new ApiError(400, 'webhook_no_event_id', 'The event id is missing.');

  const body = async (db) => {
    const c = { ...ctx, db };
    if (await db.first('SELECT 1 x FROM payee_event WHERE payee_id = ? AND event_id = ?', payee.payee_id, ev.event_id)) return done(200, { result: 'duplicate' });
    const keep = (outcome, orderId) => db.run('INSERT INTO payee_event (payee_id, event_id, type, order_id, outcome, received_at) VALUES (?,?,?,?,?,?)', payee.payee_id, ev.event_id, ev.type ? String(ev.type).slice(0, 60) : null, orderId ?? null, outcome, ctx.now());
    const ignore = async (result, orderId = null, tenantId = null) => {
      await keep('ignored', orderId);
      await chainRow(c, db, 'webhook.ignored', () => ({ payee_id: payee.payee_id, reason: result, order_id: orderId }));
      if (result === 'wrong_payee' && tenantId) await emit({ ...c, tenantId }, 'payee.webhook_wrong_payee', { order_id: orderId, payee_id: payee.payee_id });
      return done(200, { result });
    };
    const n = ev.normalized;
    if (!n) return ignore('not_applicable'); // refund, failure or unreadable events: stored, not applied (F8 handles refunds)
    const orders = await db.all('SELECT * FROM purchase_order WHERE rail_order_id = ?', n.gateway_order_id);
    if (!orders.length) return ignore('unmatched');
    const own = orders.find((o) => o.payee_id === payee.payee_id); // the order's own payee (from its snapshot), never the current route
    if (!own) return ignore('wrong_payee', orders[0].id, orders[0].tenant_id);
    if (payee.status === 'draft' && own.mode !== 'test') return ignore('draft_payee', own.id, own.tenant_id);
    let out;
    try {
      out = await railConfirm({ ...c, tenantId: own.tenant_id }, { order_id: own.id, payment_ref: n.payment_id, paid_minor: n.amount_minor, currency: n.currency });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) throw e;
      throw new Refused(e.code, own); // undo any half-done credit work, then record the event as ignored in a fresh transaction
    }
    await keep('recorded', own.id);
    await chainRow(c, db, 'webhook.recorded', () => ({ payee_id: payee.payee_id, order_id: own.id }));
    return done(200, { result: 'recorded', order_id: out.order_id });
  };
  try {
    return await ctx.db.tx(body);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    // amount, currency or "already paid with another payment": nothing was credited. Kept as ignored for the owner to look at.
    return ctx.db.tx(async (db) => {
      if (await db.first('SELECT 1 x FROM payee_event WHERE payee_id = ? AND event_id = ?', payee.payee_id, ev.event_id)) return done(200, { result: 'duplicate' });
      await db.run('INSERT INTO payee_event (payee_id, event_id, type, order_id, outcome, received_at) VALUES (?,?,?,?,?,?)', payee.payee_id, ev.event_id, ev.type ? String(ev.type).slice(0, 60) : null, e.order.id, 'ignored', ctx.now());
      await chainRow({ ...ctx, db }, db, 'webhook.ignored', () => ({ payee_id: payee.payee_id, reason: e.reason, order_id: e.order.id }));
      return done(200, { result: e.reason });
    });
  }
}
class Refused extends Error {
  constructor(reason, order) { super(reason); this.reason = reason; this.order = order; }
}
