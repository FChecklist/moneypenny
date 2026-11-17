// Spending: reserve -> capture / release, refunds, chargeback, conversion request.
import { ApiError, DAY, MIN, newId, int, str, isUniqueError } from './util.js';
import { getSettings, creditsFromMinor, minorFromCredits } from './settings.js';
import { findAccount, markPaid } from './accounts.js';
import { post } from './ledger.js';
import { emit } from './outbox.js';
import { getBalance } from './wallet.js';

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

export async function reserve(ctx, b) {
  const s = await getSettings(ctx);
  const orderRef = str(b.order_ref, 'order_ref', { max: 100 });
  const orderMinor = int(b.amount_minor, 'amount_minor', { min: 1, max: 100000000000 });
  const cur = b.currency;
  const orderCredits = creditsFromMinor(s, cur, orderMinor); // also validates currency
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
  const canUseBonus = !s.bonus_needs_paid || acc.first_paid_at != null;
  const bonusCap = Math.floor((orderCredits * s.bonus_max_order_pct) / 100);

  let parts = allocate(lots, orderCredits, bonusCap, canUseBonus);
  let credits = sum(parts);
  const valueOf = (c) => (c >= orderCredits ? orderMinor : Math.min(orderMinor, minorFromCredits(s, cur, c)));
  const minCash = cur === 'INR' ? s.min_cash_due_inr : s.min_cash_due_usd;
  let cashDue = orderMinor - valueOf(credits);
  if (cashDue > 0 && cashDue < minCash) {
    // leave at least the gateway minimum to pay in cash
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

  const holdId = newId('hold');
  const expiresAt = now + s.hold_minutes * MIN;
  await ctx.db.run(
    "INSERT INTO hold (id, tenant_id, account_id, order_ref, order_minor, currency, credits, credit_value_minor, cash_due_minor, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,'held',?,?)",
    holdId, ctx.tenantId, acc.id, orderRef, orderMinor, cur, credits, orderMinor - cashDue, cashDue, now, expiresAt,
  );
  for (const p of parts) {
    const r = await ctx.db.run('UPDATE lot SET remaining = remaining - ? WHERE id = ? AND remaining >= ?', p.take, p.lot.id, p.take);
    if (r.changes !== 1) throw new ApiError(409, 'balance_changed', 'Balance changed. Try again.');
    await ctx.db.run('INSERT INTO hold_part (hold_id, lot_id, bucket, amount) VALUES (?,?,?,?)', holdId, p.lot.id, p.lot.bucket, p.take);
    await post(ctx, { accountId: acc.id, bucket: p.lot.bucket, delta: -p.take, kind: 'hold', ref: holdId, lotId: p.lot.id });
  }
  return { hold_id: holdId, credit_applied: credits, credit_value_minor: orderMinor - cashDue, cash_due_minor: cashDue, expires_at: expiresAt, reason: 'ok' };
}

async function loadHold(ctx, id) {
  const h = await ctx.db.first('SELECT * FROM hold WHERE tenant_id = ? AND id = ?', ctx.tenantId, str(id, 'hold_id', { max: 100 }));
  if (!h) throw new ApiError(404, 'no_hold', 'No such hold.');
  return h;
}

export async function capture(ctx, b) {
  const s = await getSettings(ctx);
  const h = await loadHold(ctx, b.hold_id);
  if (h.status === 'captured') throw new ApiError(409, 'hold_already_captured', 'This hold was already captured.');
  if (h.status === 'released') throw new ApiError(409, 'hold_closed', 'This hold was released. Reserve again.');
  if (ctx.now() > h.expires_at + s.capture_grace_minutes * MIN) throw new ApiError(410, 'hold_expired', 'This hold has run out. Reserve again.');
  let payRef = null;
  if (h.cash_due_minor > 0) {
    payRef = str(b.payment_ref, 'payment_ref', { max: 100 });
    if (int(b.cash_paid_minor, 'cash_paid_minor', { min: 1 }) < h.cash_due_minor) throw new ApiError(422, 'underpaid', 'The cash paid is less than the cash due.');
  }
  try {
    const r = await ctx.db.run("UPDATE hold SET status = 'captured', closed_at = ?, payment_ref = ? WHERE id = ? AND status = 'held'", ctx.now(), payRef, h.id);
    if (r.changes !== 1) throw new ApiError(409, 'hold_closed', 'This hold is no longer open.');
  } catch (e) {
    if (isUniqueError(e)) throw new ApiError(409, 'payment_already_used', 'That payment was already used for another order.');
    throw e;
  }
  const parts = await ctx.db.all('SELECT * FROM hold_part WHERE hold_id = ?', h.id);
  for (const p of parts) await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: 0, kind: 'capture', ref: h.id, lotId: p.lot_id, meta: { amount: p.amount } });
  if (h.cash_due_minor > 0) await markPaid(ctx, h.account_id);
  await emit(ctx, 'spend.captured', { hold_id: h.id, account_id: h.account_id, order_ref: h.order_ref, credit_applied: h.credits, cash_due_minor: h.cash_due_minor, payment_ref: payRef });
  return { hold_id: h.id, status: 'captured', credit_applied: h.credits, cash_due_minor: h.cash_due_minor };
}

async function giveBack(ctx, h, kind) {
  const parts = await ctx.db.all('SELECT * FROM hold_part WHERE hold_id = ?', h.id);
  for (const p of parts) {
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
export async function refund(ctx, b) {
  const type = b.type;
  if (type === 'order') return refundOrder(ctx, b);
  if (type === 'purchase') return refundPurchase(ctx, b);
  if (type === 'chargeback') return chargeback(ctx, b);
  throw new ApiError(400, 'bad_request', "type must be 'order', 'purchase' or 'chargeback'.");
}

/** A paid order is cancelled: credits go back to the buckets they came from. */
async function refundOrder(ctx, b) {
  const s = await getSettings(ctx);
  const h = await loadHold(ctx, b.hold_id);
  if (h.status !== 'captured') throw new ApiError(409, 'hold_not_captured', 'Only a completed order can be returned.');
  const left = h.credits - h.refunded_credits;
  const want = b.credits == null ? left : int(b.credits, 'credits', { min: 1 });
  if (want > left) throw new ApiError(409, 'more_than_spent', `Only ${left} credits can still be returned for this order.`);
  const parts = await ctx.db.all('SELECT hp.*, l.expires_at, l.eligible_at FROM hold_part hp JOIN lot l ON l.id = hp.lot_id WHERE hp.hold_id = ? ORDER BY hp.bucket', h.id);
  let todo = want;
  const now = ctx.now();
  for (const p of parts) {
    if (todo <= 0) break;
    const give = Math.min(todo, p.amount - p.refunded);
    if (give <= 0) continue;
    const r = await ctx.db.run('UPDATE hold_part SET refunded = refunded + ? WHERE hold_id = ? AND lot_id = ? AND refunded + ? <= amount', give, h.id, p.lot_id, give);
    if (r.changes !== 1) throw new ApiError(409, 'more_than_spent', 'Already returned.');
    let expires = p.expires_at;
    if (expires != null) expires = Math.max(expires, now + s.reinstate_min_days * DAY);
    const id = newId('lot');
    const ref = `${h.id}:${p.lot_id}:${h.refunded_credits + (want - todo)}`;
    await ctx.db.run(
      "INSERT INTO lot (id, tenant_id, account_id, bucket, original, remaining, created_at, expires_at, eligible_at, source, source_ref) VALUES (?,?,?,?,?,?,?,?,?,'reinstate',?)",
      id, ctx.tenantId, h.account_id, p.bucket, give, give, now, expires, 0, ref,
    );
    await post(ctx, { accountId: h.account_id, bucket: p.bucket, delta: give, kind: 'reinstate', ref: h.id, lotId: id });
    todo -= give;
  }
  await ctx.db.run('UPDATE hold SET refunded_credits = refunded_credits + ? WHERE id = ?', want, h.id);
  await emit(ctx, 'refund.credits_returned', { hold_id: h.id, account_id: h.account_id, credits: want });
  return { returned_credits: want, money_due_minor: 0 };
}

/** Real money back, only for unspent bought credits. We never move money: the event tells IT Services. */
async function refundPurchase(ctx, b) {
  const s = await getSettings(ctx);
  if (!s.refund_money_enabled) throw new ApiError(403, 'refunds_off', 'Money refunds are switched off.');
  const ref = str(b.payment_ref, 'payment_ref', { max: 100 });
  const lot = await ctx.db.first("SELECT * FROM lot WHERE tenant_id = ? AND source = 'purchase' AND source_ref = ?", ctx.tenantId, ref);
  if (!lot) throw new ApiError(404, 'no_purchase', 'No such purchase.');
  if (lot.expires_at != null && lot.expires_at <= ctx.now()) throw new ApiError(409, 'purchase_expired', 'These credits have ended.');
  const want = b.credits == null ? lot.remaining : int(b.credits, 'credits', { min: 1 });
  if (want < 1 || want > lot.remaining) throw new ApiError(409, 'credits_already_used', `Only ${lot.remaining} unspent credits can be refunded.`, { refundable_credits: lot.remaining });
  // Money per credit is what was paid; rounded in the person's favour, never more than is left to refund.
  const money = Math.min(lot.paid_minor - lot.refunded_minor, Math.ceil((lot.paid_minor * want) / lot.original));
  const r = await ctx.db.run('UPDATE lot SET remaining = remaining - ?, refunded_minor = refunded_minor + ? WHERE id = ? AND remaining >= ?', want, money, lot.id, want);
  if (r.changes !== 1) throw new ApiError(409, 'balance_changed', 'Balance changed. Try again.');
  await post(ctx, { accountId: lot.account_id, bucket: 'bought', delta: -want, kind: 'refund_money', ref, lotId: lot.id, meta: { money_minor: money, currency: lot.currency } });
  await emit(ctx, 'refund.money_due', { account_id: lot.account_id, payment_ref: ref, amount_minor: money, currency: lot.currency, credits: want });
  return { returned_credits: want, money_due_minor: money, currency: lot.currency };
}

/** Bank took the money back: remove what is left of that purchase and pause the account. */
async function chargeback(ctx, b) {
  const ref = str(b.payment_ref, 'payment_ref', { max: 100 });
  const lot = await ctx.db.first("SELECT * FROM lot WHERE tenant_id = ? AND source = 'purchase' AND source_ref = ?", ctx.tenantId, ref);
  if (!lot) throw new ApiError(404, 'no_purchase', 'No such purchase.');
  const left = lot.remaining;
  if (left > 0) {
    await ctx.db.run('UPDATE lot SET remaining = 0 WHERE id = ?', lot.id);
    await post(ctx, { accountId: lot.account_id, bucket: 'bought', delta: -left, kind: 'chargeback', ref, lotId: lot.id });
  }
  await ctx.db.run("UPDATE account SET status = 'frozen' WHERE id = ?", lot.account_id);
  await emit(ctx, 'account.frozen', { account_id: lot.account_id, reason: 'chargeback', payment_ref: ref, removed_credits: left });
  return { removed_credits: left, account_status: 'frozen' };
}

// ---------- conversion request (records only; never pays) ----------
export async function convertRequest(ctx, b) {
  const s = await getSettings(ctx);
  if (!s.conversion_enabled) throw new ApiError(403, 'conversion_off', 'Conversion is not switched on.');
  if (s.tds_rate_bps == null) throw new ApiError(409, 'conversion_not_configured', 'Conversion needs its tax setting first.');
  const acc = await findAccount(ctx, b.email);
  if (!acc) throw new ApiError(404, 'no_account', 'No such person.');
  if (acc.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const credits = int(b.credits, 'credits', { min: 1 });
  if (credits < s.conversion_min_credits) throw new ApiError(422, 'below_minimum', `The smallest request is ${s.conversion_min_credits} credits.`);
  const now = ctx.now();
  const lots = await ctx.db.all(
    "SELECT * FROM lot WHERE tenant_id = ? AND account_id = ? AND bucket = 'commission' AND remaining > 0 AND eligible_at <= ? AND created_at + ? <= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at",
    ctx.tenantId, acc.id, now, s.conversion_hold_days * DAY, now, now,
  );
  const avail = lots.reduce((a, l) => a + l.remaining, 0);
  if (credits > avail) throw new ApiError(422, 'more_than_convertible', `Only ${avail} credits can be converted now.`, { can_convert: avail });
  const id = newId('cnv');
  await ctx.db.run(
    "INSERT INTO conversion_request (id, tenant_id, account_id, credits, status, terms, created_at) VALUES (?,?,?,?, 'requested', ?, ?)",
    id, ctx.tenantId, acc.id, credits, JSON.stringify({ tds_rate_bps: s.tds_rate_bps, min: s.conversion_min_credits, hold_days: s.conversion_hold_days, credits_per_usd: s.credits_per_usd, inr_paise_per_usd: s.inr_paise_per_usd }), now,
  );
  let todo = credits;
  for (const l of lots) {
    if (todo <= 0) break;
    const take = Math.min(todo, l.remaining);
    const r = await ctx.db.run('UPDATE lot SET remaining = remaining - ? WHERE id = ? AND remaining >= ?', take, l.id, take);
    if (r.changes !== 1) throw new ApiError(409, 'balance_changed', 'Balance changed. Try again.');
    await post(ctx, { accountId: acc.id, bucket: 'commission', delta: -take, kind: 'convert_request', ref: id, lotId: l.id });
    todo -= take;
  }
  await emit(ctx, 'conversion.requested', { request_id: id, account_id: acc.id, credits });
  return { request_id: id, status: 'requested', credits, note: 'Recorded only. No payout is made by this system.' };
}

export { getBalance };
