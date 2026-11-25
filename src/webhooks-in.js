// Webhook entry per payee (chunk F7). DARK: needs the payee flag. The gateway signature is the only login here.
// Order of work: find the payee (unknown: 404 with no detail) -> check the signature with THAT payee's webhook secret on the raw body
// -> event id seen before for this payee (repeat: 200 duplicate) -> find the order by the gateway order id
// -> the ORDER SNAPSHOT's payee must be this payee, never whatever payee is routed now -> same code as railConfirm.
// Permanent refusals (currency mismatch, order already paid with another payment, wrong payee, ...) are stored as 'ignored' (200). Transient ones (amount short, order not ready, unknown order inside the grace window) answer 409 and store nothing, so the retry is judged again.
// Events that do not apply (unknown order, other payee, other event type, mismatched amount) are stored as 'ignored' and answered 200,
// so the gateway stops retrying. They are never applied. A paused or retired payee still accepts payments (money in means credits).
// A draft payee accepts only test orders. Never a secret value or the raw body in an answer, an audit row or the event table.
// The same payment id for an order that is already paid with it answers 'duplicate' and writes nothing (the event id header is not signed, so a replayed body can carry a fresh one).
// Bad signatures, and a payee with its webhook secret missing: 429 is decided per source and payee (see countFailure and sourceBucket); the audit row is per payee per minute. A good signature is never counted and never refused.
import { ApiError } from './util.js';
import { gate, chainRow, view } from './payees.js';
import { gatewayFor } from './gateways/index.js';
import { makeSecretReader } from './secrets.js';
import { railConfirm } from './gate.js';
import { emit } from './outbox.js';

const MAX_RAW = 65536;
const BAD_PER_MINUTE = 20; // bad signatures one source may send for one payee in a minute; after that that source gets 429
const SOURCE_BUCKETS = 64; // sources are folded into this many counters per payee, so many addresses cannot grow the table, and no address is stored
const UNMATCHED_GRACE_MS = 10 * 60000; // an event for an order we do not know may just be early; after this it is final
const TRANSIENT = new Set(['payment_mismatch', 'order_not_ready', 'unmatched_retry']); // retryable: answered 409, event id NOT stored
// Intake never calls a gateway. The adapter needs a fetch function to be built, so it gets one that always refuses.
const noNetwork = async () => { throw new Error('no network in webhook intake'); };
// One write for every stored event. A row left as 'pending_unmatched' (the order was not known yet) is turned into the final outcome when the same event id comes back; any other existing row is never touched.
export const KEEP_SQL = "INSERT INTO payee_event (payee_id, event_id, type, order_id, outcome, received_at) VALUES (?,?,?,?,?,?) ON CONFLICT(payee_id, event_id) DO UPDATE SET type = excluded.type, order_id = excluded.order_id, outcome = excluded.outcome, received_at = excluded.received_at WHERE payee_event.outcome = 'pending_unmatched'";
const done = (status, body) => ({ status, body: { ok: status < 400, ...body } });
/**
 * Which counter a call belongs to: the address the hosting layer reports (the Worker runs behind Cloudflare, which sets cf-connecting-ip itself),
 * folded into one of SOURCE_BUCKETS. Without the header every call shares one counter. The address itself is never stored.
 */
function sourceBucket(headers) {
  const from = String(headers?.get?.('cf-connecting-ip') || '').slice(0, 64);
  if (!from) return 'x';
  let h = 2166136261; // FNV-1a, 32 bit
  for (let i = 0; i < from.length; i++) h = Math.imul(h ^ from.charCodeAt(i), 16777619) >>> 0;
  return String(h % SOURCE_BUCKETS);
}

/**
 * Counts one failed call for this payee and source in the current minute, and returns the counts. Used by BOTH failure paths that a caller can
 * repeat for free: a bad signature, and a payee whose webhook secret is missing from the platform store (every well-formed call fails there).
 * Two counters per minute: all failed calls for this payee (sizes the chained log: at most one row per payee per minute, with the count of the
 * minute before), and the failed calls of this source for this payee (decides the 429: one flooding source cannot use up the budget of another).
 */
async function countFailure(ctx, payee, headers) {
  const win = Math.floor(ctx.now() / 60000);
  const all = `whbad:${payee.payee_id}`;
  const mine = `${all}:${sourceBucket(headers)}`;
  for (const key of [all, mine]) await ctx.db.run('INSERT INTO rate_limit (key_id, window, n) VALUES (?,?,1) ON CONFLICT(key_id, window) DO UPDATE SET n = n + 1', key, win);
  await ctx.db.run("DELETE FROM rate_limit WHERE key_id LIKE 'whbad:%' AND window < ?", win - 5);
  const total = (await ctx.db.first('SELECT n FROM rate_limit WHERE key_id = ? AND window = ?', all, win)).n;
  const fromSource = (await ctx.db.first('SELECT n FROM rate_limit WHERE key_id = ? AND window = ?', mine, win)).n;
  return { win, total, fromSource, over: fromSource > BAD_PER_MINUTE, previous: async () => (await ctx.db.first('SELECT n FROM rate_limit WHERE key_id = ? AND window = ?', all, win - 1))?.n ?? 0 };
}
const tooMany = () => done(429, { error: { code: 'rate_limited', message: 'Too many bad calls. Slow down.' } });

/**
 * ctx: { db, now, env | secrets, fetch? }. `adapters` is for tests. Returns { status, body }. Never throws for a bad signature,
 * so the audit row for it is kept (a throw inside a transaction would undo it).
 */
export async function receivePayeeWebhook(ctx0, payeeId, raw, headers, { adapters } = {}) {
  const ctx = { ...ctx0, actor: 'gateway-webhook', callerType: 'payment', keyId: null }; // never the owner role
  await gate(ctx, undefined, true); // only the flag: money that is already paid must never wait on a setup check
  if (typeof raw !== 'string' || raw.length > MAX_RAW) throw new ApiError(413, 'too_large', 'Request is too large.');
  // A missing or malformed signature (a sha256 hex is 64 characters) is refused here: no HMAC, no payee lookup, no database write.
  if (!/^[0-9a-fA-F]{64}$/.test(String(headers?.get?.('x-razorpay-signature') || ''))) return done(401, { error: { code: 'webhook_bad_signature', message: 'Signature not accepted.' } });
  const row = await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', String(payeeId));
  if (!row) throw new ApiError(404, 'payee_not_found', 'No such payee.'); // same answer for any id: ids cannot be guessed
  const payee = view(row);
  const reader = makeSecretReader(ctx.secrets ?? ctx.env ?? {});
  let ev;
  try {
    ev = await gatewayFor(payee, { reader, fetch: ctx.fetch ?? noNetwork, adapters: adapters ?? undefined }).verifyWebhook(raw, headers);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'payee_secret_missing') {
      // Every well-formed call fails here, so a caller could repeat it for free. It is counted like a bad signature (same per-source budget, same
      // one audit row per payee per minute) and nothing else is written: no event row, no order change, no credit.
      const bad = await countFailure(ctx, payee, headers);
      if (bad.over) return tooMany();
      if (bad.total === 1) {
        const before = await bad.previous();
        await chainRow(ctx, ctx.db, 'webhook.secret_missing', () => ({ payee_id: payee.payee_id, window: bad.win, count: bad.total, previous_minute_count: before }));
      }
      throw new ApiError(500, 'payee_secret_missing', 'The webhook secret of this payee is not in the platform store.');
    }
    throw e;
  }
  if (!ev.ok) {
    // Only here, after the cheap checks (flag, size, signature shape, payee exists) and the real signature check, is anything counted.
    // A good signature is never counted and never refused, so nobody's bad calls can lock out the real gateway.
    const bad = await countFailure(ctx, payee, headers);
    if (bad.over) return tooMany();
    if (bad.total === 1) {
      const before = await bad.previous();
      await chainRow(ctx, ctx.db, 'webhook.bad_signature', () => ({ payee_id: payee.payee_id, window: bad.win, count: bad.total, previous_minute_count: before }));
    }
    return done(401, { error: { code: 'webhook_bad_signature', message: 'Signature not accepted.' } });
  }
  if (typeof ev.event_id !== 'string' || !ev.event_id || ev.event_id.length > 120) throw new ApiError(400, 'webhook_no_event_id', 'The event id is missing.');

  const body = async (db) => {
    const c = { ...ctx, db };
    const seen = await db.first('SELECT outcome, received_at FROM payee_event WHERE payee_id = ? AND event_id = ?', payee.payee_id, ev.event_id);
    if (seen && seen.outcome !== 'pending_unmatched') return done(200, { result: 'duplicate' });
    const keep = (outcome, orderId) => db.run(KEEP_SQL, payee.payee_id, ev.event_id, ev.type ? String(ev.type).slice(0, 60) : null, orderId ?? null, outcome, ctx.now());
    const ignore = async (result, orderId = null, tenantId = null) => {
      await keep('ignored', orderId);
      await chainRow(c, db, 'webhook.ignored', () => ({ payee_id: payee.payee_id, reason: result, order_id: orderId }));
      if (result === 'wrong_payee' && tenantId) await emit({ ...c, tenantId }, 'payee.webhook_wrong_payee', { order_id: orderId, payee_id: payee.payee_id });
      return done(200, { result });
    };
    const n = ev.normalized;
    if (!n) return ignore('not_applicable'); // refund, failure or unreadable events: stored, not applied (F8 handles refunds)
    // The lookup is filtered by payee in the SQL (the order's own payee from its snapshot, never the current route). The tenant is not known
    // from a gateway call; if one payee somehow has the same gateway order id in two tenants, nothing is applied.
    const mine = await db.all('SELECT * FROM purchase_order WHERE rail_order_id = ? AND payee_id = ? LIMIT 2', n.gateway_order_id, payee.payee_id);
    if (mine.length > 1) return ignore('ambiguous_order');
    const own = mine[0];
    if (!own) {
      const other = await db.first('SELECT id, tenant_id FROM purchase_order WHERE rail_order_id = ? AND payee_id IS NOT ? LIMIT 1', n.gateway_order_id, payee.payee_id); // only to name the refusal; never applied
      if (other) return ignore('wrong_payee', other.id, other.tenant_id);
      // unknown order: it may be early. Retryable until the grace window has passed, then final.
      if (!seen) await db.run('INSERT INTO payee_event (payee_id, event_id, type, order_id, outcome, received_at) VALUES (?,?,?,?,?,?)', payee.payee_id, ev.event_id, ev.type ? String(ev.type).slice(0, 60) : null, null, 'pending_unmatched', ctx.now());
      if (!seen || ctx.now() - seen.received_at < UNMATCHED_GRACE_MS) return done(409, { result: 'unmatched_retry', retry: true });
      await db.run("UPDATE payee_event SET outcome = 'ignored', received_at = ? WHERE payee_id = ? AND event_id = ?", ctx.now(), payee.payee_id, ev.event_id);
      await chainRow(c, db, 'webhook.ignored', () => ({ payee_id: payee.payee_id, reason: 'unmatched', order_id: null }));
      return done(200, { result: 'unmatched' });
    }
    if (payee.status === 'draft' && (own.mode == null || own.mode !== 'test')) return ignore('draft_payee', own.id, own.tenant_id); // no snapshot counts as not live: refused for good
    // A 'failed' order was timed out by the sweep; the money is in, so it is credited like /v1/rail/confirm does (railConfirm checks amount and currency). The order was found by its gateway order id above, so it always has one.
    const lateFailed = own.status === 'failed';
    if (own.status !== 'paid' && own.status !== 'awaiting_payment' && !lateFailed) return done(409, { result: 'order_not_ready', retry: true }); // e.g. pending_rail: the event may arrive first
    if ((own.status === 'awaiting_payment' || lateFailed) && n.currency !== own.currency) return ignore('currency_mismatch', own.id, own.tenant_id);
    let out;
    try {
      out = await railConfirm({ ...c, tenantId: own.tenant_id }, { order_id: own.id, payment_ref: n.payment_id, paid_minor: n.amount_minor, currency: n.currency });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) throw e;
      // currency mismatch is final; only a short amount can be fixed by a top-up. An order that is already paid is final.
      const reason = e.code === 'payment_mismatch' && n.currency !== own.currency ? 'currency_mismatch' : e.code;
      throw new Refused(reason, own); // undo any half-done credit work, then record the event as ignored in a fresh transaction
    }
    // railConfirm says `already` when this very payment id was applied to this order before (another event for the same payment, or the confirm route got there first).
    // That is a duplicate: nothing was credited and nothing is written, so a replayed body with a fresh event id cannot grow the event or audit tables.
    if (out.already) return done(200, { result: 'duplicate' });
    await keep('recorded', own.id);
    await chainRow(c, db, 'webhook.recorded', () => ({ payee_id: payee.payee_id, order_id: own.id }));
    return done(200, { result: 'recorded', order_id: out.order_id });
  };
  try {
    return await ctx.db.tx(body);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    if (TRANSIENT.has(e.reason)) return done(409, { result: e.reason, retry: true }); // the amount may be fixed or topped up: the event id is not stored
    // amount, currency or "already paid with another payment": nothing was credited. Kept as ignored for the owner to look at.
    return ctx.db.tx(async (db) => {
      const had = await db.first('SELECT outcome FROM payee_event WHERE payee_id = ? AND event_id = ?', payee.payee_id, ev.event_id);
      if (had && had.outcome !== 'pending_unmatched') return done(200, { result: 'duplicate' });
      await db.run(KEEP_SQL, payee.payee_id, ev.event_id, ev.type ? String(ev.type).slice(0, 60) : null, e.order.id, 'ignored', ctx.now());
      await chainRow({ ...ctx, db }, db, 'webhook.ignored', () => ({ payee_id: payee.payee_id, reason: e.reason, order_id: e.order.id }));
      return done(200, { result: e.reason });
    });
  }
}
class Refused extends Error {
  constructor(reason, order) { super(reason); this.reason = reason; this.order = order; }
}
