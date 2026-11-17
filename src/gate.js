// The gate: the one place products and IT Services meet.
// Products price and spend only in credits and call only this service. This service calls the payment
// rail (IT Services) through a pluggable adapter. Rail calls wait in an outbox, are retried, and end
// up as dead letters a person can requeue. Phase 0 ships only the stub rail.
import { ApiError, MIN, newId, int, ref, isUniqueError } from './util.js';
import { getSettings, minorFromCredits, creditsFromMinor, fmtUsd, fmtCredits, displayText } from './settings.js';
import { findAccount, ensureAccount } from './accounts.js';
import { creditPurchase, payId } from './wallet.js';
import { displayRate, currentRate } from './fx.js';
import { audit } from './audit.js';
import { emit } from './outbox.js';

const MAX_ATTEMPTS = 8;

export const withTimeout = (p, ms) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('rail_timeout')), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
/** Rail error text is outside text: keep a short code-like string, nothing that could carry a name or address. */
const safeError = (e) => String((e && e.code) || (e && e.message) || 'error').replace(/[^A-Za-z0-9 _.:-]/g, '?').slice(0, 80);

// ---------- price list (credits, per tenant and product) ----------
export async function setCatalogue(ctx, b) {
  const product = ref(b.product, 'product', 60);
  const item = ref(b.item, 'item', 60);
  const credits = int(b.credits, 'credits', { min: 1, max: 1000000000 });
  const active = b.active === 0 || b.active === false ? 0 : 1;
  const old = await ctx.db.first('SELECT credits, active FROM catalogue_item WHERE tenant_id = ? AND product = ? AND item = ?', ctx.tenantId, product, item);
  await ctx.db.run(
    'INSERT INTO catalogue_item (tenant_id, product, item, credits, active, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id, product, item) DO UPDATE SET credits = excluded.credits, active = excluded.active, updated_at = excluded.updated_at',
    ctx.tenantId, product, item, credits, active, ctx.now(),
  );
  await audit(ctx, 'catalogue.set', { product, item, from: old ?? null, to: { credits, active } });
  return { product, item, credits, active };
}

export async function listCatalogue(ctx, product = null, { activeOnly = false } = {}) {
  const rows = await ctx.db.all(
    `SELECT product, item, credits, active FROM catalogue_item WHERE tenant_id = ? ${product ? 'AND product = ?' : ''} ${activeOnly ? 'AND active = 1' : ''} ORDER BY product, item`,
    ctx.tenantId, ...(product ? [product] : []),
  );
  return { items: rows };
}

// ---------- prices in money (display helper) ----------
const roundInr = (s, minor) => (s.inr_round_to_rupee ? Math.ceil(minor / 100) * 100 : minor);

/** Cash price of some credits in INR or USD, rounded in our disfavour never: always enough to cover the credits. */
export function priceMinor(s, cur, credits) {
  const raw = minorFromCredits(s, cur, credits);
  return cur === 'INR' ? roundInr(s, raw) : raw;
}

/** Credits, US$, the payment currencies and an optional display-only local figure, with the "rate as of" stamp. */
export async function quote(ctx, credits, currency = null) {
  const s = await getSettings(ctx);
  int(credits, 'credits', { min: 1, max: 1000000000 });
  const out = {
    credits,
    credits_text: `${fmtCredits(credits)} ${s.unit_label}`,
    currency_name: s.currency_name,
    usd: fmtUsd(s, credits),
    usd_minor: minorFromCredits(s, 'USD', credits),
    inr_minor: s.fx_state === 'stale' ? null : priceMinor(s, 'INR', credits), // no price without a usable rate
    pay_in: ['INR', 'USD'],
    base_currency: s.base_currency,
    rate_state: s.fx_state, // fresh, fallback, stale, or none (hand-set rate)
    rate_as_of: s.fx_as_of ? new Date(s.fx_as_of).toISOString() : null,
    inr_paise_per_usd: s.fx_state === 'stale' ? null : s.inr_paise_per_usd,
  };
  if (currency && currency !== 'INR' && currency !== 'USD') {
    const r = await displayRate(ctx, currency);
    out.local = r ? { currency, amount: ((credits / s.credits_per_usd) * r.units_per_usd).toFixed(2), display_only: true, rate_as_of: new Date(r.as_of).toISOString() } : null;
  } else if (s.display_currency) {
    const r = await displayRate(ctx, s.display_currency);
    out.local = r ? { currency: s.display_currency, amount: ((credits / s.credits_per_usd) * r.units_per_usd).toFixed(2), display_only: true, rate_as_of: new Date(r.as_of).toISOString() } : null;
  }
  const localText = out.local ? `about ${out.local.amount} ${out.local.currency}` : out.inr_minor == null ? null : `about Rs ${(out.inr_minor / 100).toFixed(2)}`;
  out.display_text = displayText(s, credits, localText);
  return out;
}

// ---------- buy credits ----------
/** A product asks for credits for a person. We ask the rail for an order; credits arrive only on confirmation. */
export async function buyCredits(ctx, b) {
  const s = await getSettings(ctx);
  const orderRef = ref(b.order_ref, 'order_ref');
  const credits = int(b.credits, 'credits', { min: s.buy_min_credits, max: s.buy_max_credits });
  const cur = b.currency ?? s.base_currency;
  if (cur !== 'INR' && cur !== 'USD') throw new ApiError(400, 'bad_currency', 'Payment is in INR or USD only.');
  if (cur === 'INR' && s.fx_state === 'stale') throw new ApiError(503, 'rate_stale', 'The exchange rate is out of date. Try again shortly or pay in USD.');
  const amount = priceMinor(s, cur, credits);

  const prior = await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND order_ref = ?', ctx.tenantId, orderRef);
  if (prior) {
    const acc = await findAccount(ctx, b.email);
    if (!acc || acc.id !== prior.account_id || prior.credits !== credits || prior.currency !== cur) throw new ApiError(409, 'order_ref_used', 'That order reference was used for a different order.');
    return orderView(prior);
  }
  const known = await findAccount(ctx, b.email);
  if (known && known.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const acc = await ensureAccount(ctx, b.email, { velocity: true });
  const id = newId('ord');
  const now = ctx.now();
  await ctx.db.run(
    "INSERT INTO purchase_order (id, tenant_id, account_id, order_ref, credits, currency, amount_minor, lock_until, rate_cpu, rate_inr, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending_rail',?,?)",
    id, ctx.tenantId, acc.id, orderRef, credits, cur, amount, now + s.rate_lock_minutes * MIN, s.credits_per_usd, s.inr_paise_per_usd, now, now,
  );
  await ctx.db.run('INSERT INTO rail_outbox (id, tenant_id, order_id, next_at, created_at) VALUES (?,?,?,?,?)', newId('rob'), ctx.tenantId, id, now, now);
  await processRail(ctx, ctx.rail, { orderId: id });
  return orderView(await ctx.db.first('SELECT * FROM purchase_order WHERE id = ?', id));
}

const orderView = (o) => ({
  order_id: o.id, order_ref: o.order_ref, status: o.status, credits: o.credits, currency: o.currency, amount_minor: o.amount_minor,
  pay_url: o.pay_url ?? null, rail_order_id: o.rail_order_id ?? null,
});

/** Sends waiting orders to the rail. A failure waits (back-off) and tries again; after too many tries it is a dead letter. */
export async function processRail(ctx, rail, { orderId = null, limit = 25 } = {}) {
  if (!rail || typeof rail.createOrder !== 'function') return { sent: 0, failed: 0, dead: 0 };
  const due = orderId
    ? await ctx.db.all("SELECT * FROM rail_outbox WHERE tenant_id = ? AND order_id = ? AND status = 'pending'", ctx.tenantId, orderId)
    : await ctx.db.all("SELECT * FROM rail_outbox WHERE tenant_id = ? AND status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT ?", ctx.tenantId, ctx.now(), limit);
  let sent = 0, failed = 0, dead = 0;
  for (const j of due) {
    const o = await ctx.db.first('SELECT * FROM purchase_order WHERE id = ?', j.order_id);
    if (o.status !== 'pending_rail') {
      await ctx.db.run("UPDATE rail_outbox SET status = 'sent' WHERE id = ?", j.id);
      continue;
    }
    try {
      // The rail must treat order_id as its idempotency key: a retry must not make a second order.
      const out = await withTimeout(rail.createOrder({ order_id: o.id, order_ref: o.order_ref, amount_minor: o.amount_minor, currency: o.currency, credits: o.credits }), 4000);
      if (!out || typeof out.rail_order_id !== 'string') throw new Error('rail gave no order id');
      await ctx.db.run("UPDATE purchase_order SET status = 'awaiting_payment', rail_order_id = ?, pay_url = ?, updated_at = ? WHERE id = ?", out.rail_order_id, typeof out.pay_url === 'string' ? out.pay_url : null, ctx.now(), o.id);
      await ctx.db.run("UPDATE rail_outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL WHERE id = ?", j.id);
      sent++;
    } catch (e) {
      const attempts = j.attempts + 1;
      const msg = safeError(e);
      if (attempts >= MAX_ATTEMPTS) {
        await ctx.db.run("UPDATE rail_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?", attempts, msg, j.id);
        await ctx.db.run("UPDATE purchase_order SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending_rail'", ctx.now(), o.id);
        await emit(ctx, 'rail.dead_letter', { order_id: o.id, order_ref: o.order_ref, error: msg });
        dead++;
      } else {
        await ctx.db.run("UPDATE rail_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?", attempts, ctx.now() + Math.min(2 ** attempts, 60) * MIN, msg, j.id);
        failed++;
      }
    }
  }
  return { sent, failed, dead };
}

/** Unpaid orders past their time are marked failed (a late payment is still credited, see railConfirm). */
export async function expireOrders(ctx) {
  const s = await getSettings(ctx);
  const r = await ctx.db.run("UPDATE purchase_order SET status = 'failed', updated_at = ? WHERE tenant_id = ? AND status = 'awaiting_payment' AND lock_until < ?", ctx.now(), ctx.tenantId, ctx.now());
  return { expired: r.changes };
}

export async function listDeadLetters(ctx) {
  return { dead_letters: await ctx.db.all("SELECT j.id, j.order_id, j.attempts, j.last_error, o.order_ref, o.credits, o.currency, o.amount_minor FROM rail_outbox j JOIN purchase_order o ON o.id = j.order_id WHERE j.tenant_id = ? AND j.status = 'dead' ORDER BY j.created_at", ctx.tenantId) };
}

export async function requeueDeadLetter(ctx, b) {
  const id = ref(b.id, 'id', 100);
  const j = await ctx.db.first("SELECT * FROM rail_outbox WHERE tenant_id = ? AND id = ? AND status = 'dead'", ctx.tenantId, id);
  if (!j) throw new ApiError(404, 'no_dead_letter', 'No such dead letter.');
  const s = await getSettings(ctx);
  await ctx.db.run("UPDATE rail_outbox SET status = 'pending', attempts = 0, next_at = ?, last_error = NULL WHERE id = ?", ctx.now(), id);
  // a fresh start: a new rate lock window and a new unpaid-order clock
  const ord = await ctx.db.first('SELECT credits, currency FROM purchase_order WHERE id = ?', j.order_id);
  if (ord && ord.currency === 'INR' && s.fx_state === 'stale') throw new ApiError(503, 'rate_stale', 'The exchange rate is out of date. Try again shortly.');
  // re-quoted at today's rate: an order that waited out an outage is not paid at an old price
  if (ord) await ctx.db.run("UPDATE purchase_order SET amount_minor = ?, rate_cpu = ?, rate_inr = ? WHERE id = ? AND status = 'failed' AND rail_order_id IS NULL", priceMinor(s, ord.currency, ord.credits), s.credits_per_usd, s.inr_paise_per_usd, j.order_id);
  await ctx.db.run("UPDATE purchase_order SET status = 'pending_rail', created_at = ?, lock_until = ?, updated_at = ? WHERE id = ? AND status = 'failed' AND rail_order_id IS NULL", ctx.now(), ctx.now() + s.rate_lock_minutes * MIN, ctx.now(), j.order_id);
  await audit(ctx, 'rail.requeue', { id, order_id: j.order_id });
  return { id, status: 'pending' };
}

// ---------- the rail says: paid ----------
/**
 * IT Services confirms a payment for an order (purchase key). The amount and currency must match what we
 * asked for. Credits are added at the rate locked when the order was made, even if rates have moved since,
 * and even if the order had already timed out (the money is in; the person gets the credits).
 */
export async function railConfirm(ctx, b) {
  const payRef = payId(b.payment_ref);
  const o = b.order_id
    ? await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND id = ?', ctx.tenantId, ref(b.order_id, 'order_id'))
    : await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND order_ref = ?', ctx.tenantId, ref(b.order_ref, 'order_ref'));
  if (!o) throw new ApiError(404, 'no_order', 'No such order.');
  if (o.status === 'paid') {
    if (o.payment_ref === payRef) return { order_id: o.id, status: 'paid', credited: o.credits, already: true };
    throw new ApiError(409, 'order_already_paid', 'This order was already paid with another payment.');
  }
  const paid = int(b.paid_minor, 'paid_minor', { min: 1, max: 10000000000 });
  if (b.currency !== o.currency) throw new ApiError(422, 'payment_mismatch', 'The payment currency does not match the order.');
  if (paid < o.amount_minor) throw new ApiError(422, 'payment_mismatch', 'The payment is less than the order amount.');
  const acc = await ctx.db.first('SELECT email_norm FROM account WHERE id = ?', o.account_id);
  // Inside the lock window the order's own rate and credits apply. Later, an INR payment is re-priced at today's rate
  // (the money is in, so it is never refused); it can never buy more credits than the money is worth at that rate.
  const s = await getSettings(ctx);
  const late = ctx.now() > o.lock_until; // fixed when the order was made; changing the setting later does not re-price open orders
  const repriced = late && o.currency === 'INR' && s.fx_state !== 'stale'; // with no usable rate the order's own terms apply
  const credits = repriced ? Math.max(1, creditsFromMinor(s, 'INR', paid)) : o.credits;
  const out = await creditPurchase(ctx, { email: acc.email_norm, amount: credits, paid_minor: repriced ? paid : Math.min(paid, o.amount_minor), currency: o.currency, payment_ref: payRef }, repriced ? {} : { lock: { rateCpu: o.rate_cpu, rateInr: o.rate_inr } });
  await ctx.db.run("UPDATE purchase_order SET status = 'paid', payment_ref = ?, paid_minor = ?, updated_at = ? WHERE id = ?", payRef, paid, ctx.now(), o.id);
  // More money than the order asked for: credits are given for the order only. The extra is flagged so the payment side can refund it.
  const overpaid = !repriced && paid > o.amount_minor ? paid - o.amount_minor : 0;
  if (overpaid) await emit(ctx, 'payment.overpaid', { order_id: o.id, payment_ref: payRef, overpaid_minor: overpaid, currency: o.currency });
  await ctx.db.run("UPDATE rail_outbox SET status = 'sent' WHERE order_id = ? AND status != 'sent'", o.id);
  return { order_id: o.id, status: 'paid', credited: out.credited, ...(repriced ? { repriced: true } : {}), ...(overpaid ? { overpaid_minor: overpaid } : {}) };
}

// ---------- health ----------
export async function railHealth(ctx) {
  try {
    const r = ctx.rail && typeof ctx.rail.health === 'function' ? await ctx.rail.health() : { ok: !!ctx.rail };
    return { name: ctx.rail?.name ?? 'none', ok: !!r.ok };
  } catch {
    return { name: ctx.rail?.name ?? 'none', ok: false };
  }
}

export async function fxHealth(ctx) {
  const s = await getSettings(ctx);
  return { state: s.fx_state, as_of: s.fx_as_of ? new Date(s.fx_as_of).toISOString() : null };
}

export { isUniqueError, creditsFromMinor, currentRate };
