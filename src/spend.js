// Spending: reserve -> capture / release, refunds, chargeback.
import { ApiError, DAY, MIN, newId, int, str, ref } from './util.js';
import { getSettings, creditsFromMinor, minorFromCredits } from './settings.js';
import { findAccount, addPaid } from './accounts.js';
import { post } from './ledger.js';
import { emit } from './outbox.js';
import { claimPaymentRef, findPayment, lc } from './wallet.js';
import { audit } from './audit.js';

const PRIORITY = { bonus: 0, commission: 1, bought: 2 }; // spend order

function allocate(lots, limit, bonusCap, canUseBonus) {
  const sorted = [...lots].sort(
    (a, b) => PRIORITY[a.bucket] - PRIORITY[b.bucket] || (a.expires_at ?? 9e15) - (b.expires_at ?? 9e15) || a.created_at - b.created_at,
  );
  let left = limit;
  let bonusLeft = bonusCap;
  const parts = [];
  for (const l of sorted) {
    if (left <= 0) break;
    if (l.bucket === 'bonus' && !canUseBonus) continue;
    let take = Math.min(l.remaining, left);
    if (l.bucket === 'bonus') take = Math.min(take, bonusLeft);
    if (take <= 0) continue;
    parts.push({ lot: l, take });
    left -= take;
    if (l.bucket === 'bonus') bonusLeft -= take;
  }
  return parts;
}
const sum = (parts) => parts.reduce((a, p) => a + p.take, 0);

export const isReversed = async (ctx, origin) =>
  origin != null && !!(await ctx.db.first('SELECT 1 x FROM charged_back WHERE tenant_id = ? AND payment_ref = ?', ctx.tenantId, lc(origin.replace(/^sale:/i, ''))));

/** Locked rates of an order, passed to every entry written for it. */
const lockOf = (h) => (h.rate_inr ? { rateCpu: h.rate_cpu, rateInr: h.rate_inr } : {});

export async function reserve(ctx, b) {
  const s = await getSettings(ctx);
  const orderRef = ref(b.order_ref, 'order_ref');
  const orderMinor = int(b.amount_minor, 'amount_minor', { min: 1, max: 100000000000 });
  const cur = b.currency;
  const orderCredits = creditsFromMinor(s, cur, orderMinor); // also validates currency
  if (cur === 'INR' && s.fx_state === 'stale') throw new ApiError(503, 'rate_stale', 'The exchange rate is out of date. Try again shortly or pay in USD.');
  const none = (reason) => ({ hold_id: null, credit_applied: 0, credit_value_minor: 0, cash_due_minor: orderMinor, reason });

  const acc = await findAccount(ctx, b.email);
  if (!acc) return none('no_credits');
  if (acc.status === 'frozen') return none('account_frozen');
  const open = await ctx.db.first("SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'held'", ctx.tenantId, orderRef);
  if (open) throw new ApiError(409, 'order_has_open_hold', 'This order already has a hold. Capture or release it first.');
  const done = await ctx.db.first("SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'", ctx.tenantId, orderRef);
  if (done) throw new ApiError(409, 'order_already_paid_with_credits', 'This order was already completed.');

  const now = ctx.now();
  const lots = await ctx.db.all(
    'SELECT * FROM lot WHERE tenant_id = ? AND account_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?) AND eligible_at <= ?',
    ctx.tenantId, acc.id, now, now,
  );
  const canUseBonus = !s.bonus_needs_paid || acc.paid_credits >= s.bonus_unlock_min_credits;
  const bonusCap = Math.floor((orderCredits * s.bonus_max_order_pct) / 100);

  let parts = allocate(lots, orderCredits, bonusCap, canUseBonus);
  let credits = sum(parts);
  // A sub-credit leftover on a fully covered order of $1 or more is waived in the person's favour.
  const valueOf = (c) => (c >= orderCredits && orderCredits >= 100 ? orderMinor : Math.min(orderMinor, minorFromCredits(s, cur, c)));
  const minCash = cur === 'INR' ? s.min_cash_due_inr : s.min_cash_due_usd;
  let cashDue = orderMinor - valueOf(credits);
  if (cashDue > 0 && cashDue < minCash) {
    const limit = creditsFromMinor(s, cur, Math.max(0, orderMinor - minCash));
    parts = allocate(lots, limit, bonusCap, canUseBonus);
    credits = sum(parts);
    cashDue = orderMinor - valueOf(credits);
    if (cashDue > 0 && cashDue < minCash) {
      parts = [];
      credits = 0;
      cashDue = orderMinor;
    }
  }
  if (credits === 0) return none('nothing_spendable');

  const { holdId, expiresAt } = await placeHold(ctx, s, acc, parts, { orderRef, orderMinor, cur, credits, cashDue });
  return { hold_id: holdId, credit_applied: credits, credit_value_minor: orderMinor - cashDue, cash_due_minor: cashDue, expires_at: expiresAt, reason: 'ok' };
}

/** Writes the hold, takes the credits out of their lots, and locks the rates in force right now. */
async function placeHold(ctx, s, acc, parts, h) {
  const now = ctx.now();
  const holdId = newId('hold');
  const expiresAt = now + s.hold_minutes * MIN;
  await ctx.db.run(
    "INSERT INTO hold (id, tenant_id, account_id, order_ref, order_minor, currency, credits, credit_value_minor, cash_due_minor, status, created_at, expires_at, rate_cpu, rate_inr, product, item) VALUES (?,?,?,?,?,?,?,?,?,'held',?,?,?,?,?,?)",
    holdId, ctx.tenantId, acc.id, h.orderRef, h.orderMinor, h.cur, h.credits, h.orderMinor - h.cashDue, h.cashDue, now, expiresAt, s.credits_per_usd, s.inr_paise_per_usd, h.product ?? null, h.item ?? null,
  );
  for (const p of parts) {
    const r = await ctx.db.run('UPDATE lot SET remaining = remaining - ? WHERE id = ? AND remaining >= ?', p.take, p.lot.id, p.take);
    if (r.changes !== 1) throw new ApiError(409, 'balance_changed', 'Balance changed. Try again.');
    await ctx.db.run('INSERT INTO hold_part (hold_id, lot_id, bucket, amount) VALUES (?,?,?,?)', holdId, p.lot.id, p.lot.bucket, p.take);
    await post(ctx, { accountId: acc.id, bucket: p.lot.bucket, delta: -p.take, kind: 'hold', ref: holdId, lotId: p.lot.id, status: 'pending' });
  }
  return { holdId, expiresAt };
}

/**
 * Spend by price list: the item costs a fixed number of credits, nothing else. All or nothing:
 * not enough usable credits means 402 and the shortfall, never a part-payment in cash.
 */
export async function reserveItem(ctx, b) {
  const s = await getSettings(ctx);
  const orderRef = ref(b.order_ref, 'order_ref');
  const product = ref(b.product, 'product', 60);
  const item = ref(b.item, 'item', 60);
  const cat = await ctx.db.first('SELECT * FROM catalogue_item WHERE tenant_id = ? AND product = ? AND item = ? AND active = 1', ctx.tenantId, product, item);
  if (!cat) throw new ApiError(404, 'no_item', 'No such item on the price list.');
  if (b.credits != null && b.credits !== cat.credits) throw new ApiError(409, 'price_changed', 'The price has changed.', { price_credits: cat.credits });
  const need = cat.credits;
  const acc = await findAccount(ctx, b.email);
  if (acc && acc.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const open = await ctx.db.first("SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'held'", ctx.tenantId, orderRef);
  if (open) throw new ApiError(409, 'order_has_open_hold', 'This order already has a hold. Capture or release it first.');
  const done = await ctx.db.first("SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'", ctx.tenantId, orderRef);
  if (done) throw new ApiError(409, 'order_already_paid_with_credits', 'This order was already completed.');
  const now = ctx.now();
  const lots = acc
    ? await ctx.db.all('SELECT * FROM lot WHERE tenant_id = ? AND account_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?) AND eligible_at <= ?', ctx.tenantId, acc.id, now, now)
    : [];
  const canUseBonus = acc ? !s.bonus_needs_paid || acc.paid_credits >= s.bonus_unlock_min_credits : false;
  const parts = allocate(lots, need, Math.floor((need * s.bonus_max_order_pct) / 100), canUseBonus);
  const have = sum(parts);
  if (have < need) throw new ApiError(402, 'insufficient_credits', 'Not enough credits for this.', { price_credits: need, usable_credits: have, short_by: need - have });
  const { holdId, expiresAt } = await placeHold(ctx, s, acc, parts, { orderRef, orderMinor: 0, cur: 'CRD', credits: need, cashDue: 0, product, item });
  return { hold_id: holdId, credits: need, product, item, expires_at: expiresAt };
}

async function loadHold(ctx, id) {
  const h = await ctx.db.first('SELECT * FROM hold WHERE tenant_id = ? AND id = ?', ctx.tenantId, str(id, 'hold_id', { max: 100 }));
  if (!h) throw new ApiError(404, 'no_hold', 'No such hold.');
  return h;
}

const partsOf = (ctx, holdId) =>
  ctx.db.all('SELECT hp.*, l.origin, l.expires_at, l.created_at lot_created FROM hold_part hp JOIN lot l ON l.id = hp.lot_id WHERE hp.hold_id = ?', holdId);

export async function capture(ctx, b) {
  const s = await getSettings(ctx);
  const h = await loadHold(ctx, b.hold_id);
  if (h.status === 'captured') throw new ApiError(409, 'hold_already_captured', 'This hold was already captured.');
  if (h.status === 'released') throw new ApiError(409, 'hold_closed', 'This hold was released. Reserve again.');
  if (ctx.now() > h.expires_at + s.capture_grace_minutes * MIN) throw new ApiError(410, 'hold_expired', 'This hold has run out. Reserve again.');
  const parts = await partsOf(ctx, h.id);
  for (const p of parts) if (await isReversed(ctx, p.origin)) throw new ApiError(409, 'payment_reversed', 'Some of these credits came from a payment that was reversed. Release this hold.');
  let payRef = null;
  if (h.cash_due_minor > 0) {
    payRef = lc(ref(b.payment_ref, 'payment_ref'));
    if (int(b.cash_paid_minor, 'cash_paid_minor', { min: 1 }) < h.cash_due_minor) throw new ApiError(422, 'underpaid', 'The cash paid is less than the cash due.');
    const known = await findPayment(ctx, payRef);
    if (!known) throw new ApiError(402, 'payment_not_verified', 'That payment has not been confirmed by the payment side yet.');
    if (known.currency !== h.currency || known.paid_minor < h.cash_due_minor) throw new ApiError(402, 'payment_not_verified', 'That payment does not cover this order.');
    await claimPaymentRef(ctx, payRef, 'order'); // one payment, one use, across purchases and orders
  }
  const r = await ctx.db.run("UPDATE hold SET status = 'captured', closed_at = ?, payment_ref = ? WHERE id = ? AND status = 'held'", ctx.now(), payRef, h.id);
  if (r.changes !== 1) throw new ApiError(409, 'hold_closed', 'This hold is no longer open.');
  const lock = lockOf(h);
  for (const p of parts) await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: 0, kind: 'capture', ref: h.id, lotId: p.lot_id, meta: { amount: p.amount }, ...lock });
  if (h.cash_due_minor > 0) {
    await post(ctx, { accountId: h.account_id, bucket: '-', delta: 0, kind: 'collection', ref: h.id, moneyMinor: h.cash_due_minor, currency: h.currency, extRef: payRef, ...lock });
    await addPaid(ctx, h.account_id, creditsFromMinor(h.rate_inr ? { ...s, credits_per_usd: h.rate_cpu, inr_paise_per_usd: h.rate_inr } : s, h.currency, h.cash_due_minor));
  }
  await emit(ctx, 'spend.captured', { hold_id: h.id, account_id: h.account_id, order_ref: h.order_ref, credit_applied: h.credits, cash_due_minor: h.cash_due_minor, payment_ref: payRef });
  return { hold_id: h.id, status: 'captured', credit_applied: h.credits, cash_due_minor: h.cash_due_minor };
}

/** Puts held credits back. Credits that came from a reversed (charged-back) payment are NOT restored. */
async function giveBack(ctx, h, kind) {
  for (const p of await partsOf(ctx, h.id)) {
    if (await isReversed(ctx, p.origin)) {
      await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: 0, kind: 'reversal', ref: h.id, lotId: p.lot_id, meta: { not_restored: p.amount } });
      continue;
    }
    const r = await ctx.db.run('UPDATE lot SET remaining = remaining + ? WHERE id = ? AND remaining + ? <= original', p.amount, p.lot_id, p.amount);
    if (r.changes !== 1) throw new ApiError(500, 'ledger_mismatch', 'Could not give credits back.');
    await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: p.amount, kind, ref: h.id, lotId: p.lot_id });
  }
}

export async function release(ctx, b) {
  const h = await loadHold(ctx, b.hold_id);
  if (h.status === 'released') return { hold_id: h.id, status: 'released' };
  if (h.status === 'captured') throw new ApiError(409, 'hold_already_captured', 'This hold was already captured.');
  const r = await ctx.db.run("UPDATE hold SET status = 'released', closed_at = ? WHERE id = ? AND status = 'held'", ctx.now(), h.id);
  if (r.changes !== 1) throw new ApiError(409, 'hold_closed', 'This hold is no longer open.');
  await giveBack(ctx, h, 'release');
  return { hold_id: h.id, status: 'released' };
}

/** Gives back holds nobody captured in time. Run on a schedule and before reserving. */
export async function sweepHolds(ctx) {
  const s = await getSettings(ctx);
  const old = await ctx.db.all("SELECT * FROM hold WHERE tenant_id = ? AND status = 'held' AND expires_at + ? < ?", ctx.tenantId, s.capture_grace_minutes * MIN, ctx.now());
  for (const h of old) {
    const r = await ctx.db.run("UPDATE hold SET status = 'released', closed_at = ? WHERE id = ? AND status = 'held'", ctx.now(), h.id);
    if (r.changes === 1) await giveBack(ctx, h, 'release_timeout');
  }
  return { released: old.length };
}

// ---------- refunds ----------
export async function refund(ctx, b, scope) {
  const type = b.type;
  // Money-side refunds come from the payment system's key; credit-side from a product key.
  if (type === 'order' && scope !== 'api') throw new ApiError(403, 'wrong_key_type', 'Order returns need a product key.');
  if ((type === 'purchase' || type === 'chargeback') && scope !== 'purchase') throw new ApiError(403, 'wrong_key_type', 'Money refunds and chargebacks need the payment key.');
  if (type === 'order') return refundOrder(ctx, b);
  if (type === 'purchase') return refundPurchase(ctx, b);
  if (type === 'chargeback') return chargeback(ctx, b);
  throw new ApiError(400, 'bad_request', "type must be 'order', 'purchase' or 'chargeback'.");
}

/** A paid order is cancelled: credits go back to the buckets they came from (never from a reversed payment). */
async function refundOrder(ctx, b) {
  const s = await getSettings(ctx);
  const h = await loadHold(ctx, b.hold_id);
  if (h.status !== 'captured') throw new ApiError(409, 'hold_not_captured', 'Only a completed order can be returned.');
  const left = h.credits - h.refunded_credits;
  if (left <= 0) throw new ApiError(409, 'nothing_to_return', 'Everything on this order was already returned.');
  const want = b.credits == null ? left : int(b.credits, 'credits', { min: 1 });
  if (want > left) throw new ApiError(409, 'more_than_spent', `Only ${left} credits can still be returned for this order.`);
  const parts = (await partsOf(ctx, h.id)).sort((a, c) => a.bucket.localeCompare(c.bucket));
  let todo = want;
  let returned = 0;
  const now = ctx.now();
  for (const p of parts) {
    if (todo <= 0) break;
    const give = Math.min(todo, p.amount - p.refunded);
    if (give <= 0) continue;
    const r = await ctx.db.run('UPDATE hold_part SET refunded = refunded + ? WHERE hold_id = ? AND lot_id = ? AND refunded + ? <= amount', give, h.id, p.lot_id, give);
    if (r.changes !== 1) throw new ApiError(409, 'more_than_spent', 'Already returned.');
    todo -= give;
    if (await isReversed(ctx, p.origin)) {
      await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: 0, kind: 'reversal', ref: h.id, lotId: p.lot_id, meta: { not_restored: give } });
      continue;
    }
    let expires = p.expires_at;
    if (expires != null) expires = Math.max(expires, now + s.reinstate_min_days * DAY);
    const id = newId('lot');
    await ctx.db.run(
      "INSERT INTO lot (id, tenant_id, account_id, bucket, original, remaining, created_at, expires_at, eligible_at, source, source_ref, origin) VALUES (?,?,?,?,?,?,?,?,?,'reinstate',?,?)",
      id, ctx.tenantId, h.account_id, p.bucket, give, give, now, expires, 0, `${h.id}:${p.lot_id}:${p.refunded}`, p.origin,
    );
    await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: give, kind: 'reinstate', ref: h.id, lotId: id });
    returned += give;
  }
  await ctx.db.run('UPDATE hold SET refunded_credits = refunded_credits + ? WHERE id = ?', want, h.id);
  await emit(ctx, 'refund.credits_returned', { hold_id: h.id, account_id: h.account_id, credits: returned });
  return { returned_credits: returned, money_due_minor: 0 };
}

/** Real money back, only for unspent bought credits. We never move money: the event tells IT Services. */
async function refundPurchase(ctx, b) {
  const s = await getSettings(ctx);
  if (!s.refund_money_enabled) throw new ApiError(403, 'refunds_off', 'Money refunds are switched off.');
  const payRef = ref(b.payment_ref, 'payment_ref');
  const lot = await ctx.db.first("SELECT * FROM lot WHERE tenant_id = ? AND source = 'purchase' AND source_ref = ?", ctx.tenantId, payRef);
  if (!lot) throw new ApiError(404, 'no_purchase', 'No such purchase.');
  if (lot.expires_at != null && lot.expires_at <= ctx.now()) throw new ApiError(409, 'purchase_expired', 'These credits have ended.');
  const want = b.credits == null ? lot.remaining : int(b.credits, 'credits', { min: 1 });
  if (want < 1 || want > lot.remaining) throw new ApiError(409, 'credits_already_used', `Only ${lot.remaining} unspent credits can be refunded.`, { refundable_credits: lot.remaining });
  // Money per credit is what was paid; rounded in the person's favour, never more than is left to refund.
  const money = Math.min(lot.paid_minor - lot.refunded_minor, Math.ceil((lot.paid_minor * want) / lot.original));
  const r = await ctx.db.run('UPDATE lot SET remaining = remaining - ?, refunded_minor = refunded_minor + ?, refunded_credits = refunded_credits + ? WHERE id = ? AND remaining >= ?', want, money, want, lot.id, want);
  if (r.changes !== 1) throw new ApiError(409, 'balance_changed', 'Balance changed. Try again.');
  await addPaid(ctx, lot.account_id, -want);
  await post(ctx, { accountId: lot.account_id, bucket: 'bought', delta: -want, kind: 'refund', ref: payRef, lotId: lot.id, moneyMinor: money, currency: lot.currency, extRef: payRef, meta: { money_back: true } });
  await emit(ctx, 'refund.money_due', { account_id: lot.account_id, payment_ref: payRef, amount_minor: money, currency: lot.currency, credits: want });
  return { returned_credits: want, money_due_minor: money, currency: lot.currency };
}

/**
 * Bank took the money back. Everything that came from that payment is removed: what is left in the
 * purchase lot, anything returned from orders later, and anything still held (not restored on release).
 */
async function chargeback(ctx, b) {
  const payRef = lc(ref(b.payment_ref, 'payment_ref'));
  // The payment may have bought credits, or it may be the sale that earned a commission (or both ids may never have been seen).
  const lot = await ctx.db.first("SELECT * FROM lot WHERE tenant_id = ? AND source = 'purchase' AND lower(source_ref) = ?", ctx.tenantId, payRef);
  const sale = await ctx.db.first('SELECT 1 x FROM payment_ref WHERE tenant_id = ? AND ref = ?', ctx.tenantId, `sale:${payRef}`);
  const noted = await ctx.db.first('SELECT 1 x FROM verified_payment WHERE tenant_id = ? AND ref = ?', ctx.tenantId, payRef);
  if (!lot && !sale && !noted) throw new ApiError(404, 'no_purchase', 'No such purchase or sale.');
  const seen = await ctx.db.first('SELECT 1 x FROM charged_back WHERE tenant_id = ? AND payment_ref = ?', ctx.tenantId, payRef);
  if (seen) return { removed_credits: 0, account_status: lot ? 'frozen' : 'unchanged', already: true };
  await ctx.db.run('INSERT INTO charged_back (tenant_id, payment_ref, created_at) VALUES (?,?,?)', ctx.tenantId, payRef, ctx.now());
  const family = await ctx.db.all("SELECT * FROM lot WHERE tenant_id = ? AND (lower(origin) = ? OR lower(origin) = ?) AND remaining > 0", ctx.tenantId, payRef, `sale:${payRef}`);
  let removed = 0;
  for (const l of family) {
    await ctx.db.run('UPDATE lot SET remaining = 0 WHERE id = ?', l.id);
    await post(ctx, { accountId: l.account_id, bucket: l.bucket, delta: -l.remaining, kind: 'reversal', ref: payRef, lotId: l.id, extRef: payRef, status: 'reversed' });
    removed += l.remaining;
  }
  if (!lot) {
    // a sale was taken back: the commission it earned goes, the earner is not paused
    await audit(ctx, 'sale.chargeback', { payment_ref: payRef, removed_credits: removed });
    await emit(ctx, 'commission.reversed', { payment_ref: payRef, removed_credits: removed });
    return { removed_credits: removed, account_status: 'unchanged' };
  }
  await addPaid(ctx, lot.account_id, -(lot.original - lot.refunded_credits));
  await ctx.db.run("UPDATE account SET status = 'frozen' WHERE id = ?", lot.account_id);
  await audit(ctx, 'account.freeze', { account_id: lot.account_id, reason: 'chargeback', payment_ref: payRef });
  await emit(ctx, 'account.frozen', { account_id: lot.account_id, reason: 'chargeback', payment_ref: payRef, removed_credits: removed });
  return { removed_credits: removed, account_status: 'frozen' };
}
