// Conversion engine skeleton. Commission credits -> an instruction for real money.
// Everything here CALCULATES and RECORDS. Real money moves only behind a payment rail (rail.js),
// and only a person can record that it was paid. Off by default.
//
// lifecycle: requested -> approved -> instructed -> paid      (or -> rejected, credits come back)
import { ApiError, DAY, newId, int, ref } from './util.js';
import { getSettings } from './settings.js';
import { findAccount } from './accounts.js';
import { post } from './ledger.js';
import { emit } from './outbox.js';
import { audit } from './audit.js';
import { createLot, claimPaymentRef, findPayment, payId } from './wallet.js';
import { isReversed, withholdDebt } from './spend.js';

/** Pure calculation. gross is in the conversion currency; tds and gst come from settings; no rounding in the person's disfavour on net. */
export function calculate(s, credits) {
  const cur = s.conversion_currency;
  const grossMinor = Math.floor((credits * (cur === 'INR' ? (s.inr_paise_raw ?? s.inr_paise_per_usd) : 100)) / s.credits_per_usd);
  const tdsMinor = Math.ceil((grossMinor * (s.tds_rate_bps ?? 0)) / 10000);
  const gstMinor = 0; // GST is recorded on entries but not charged on a conversion in Phase 0
  return { currency: cur, gross_minor: grossMinor, tds_minor: tdsMinor, gst_minor: gstMinor, net_minor: grossMinor - tdsMinor - gstMinor };
}

function needOn(s) {
  if (!s.conversion_enabled) throw new ApiError(403, 'conversion_off', 'Conversion is not switched on.');
  if (s.tds_rate_bps == null) throw new ApiError(409, 'conversion_not_configured', 'Conversion needs its tax setting first.');
}

export async function convertRequest(ctx, b) {
  const s = await getSettings(ctx);
  needOn(s);
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
  const calc = calculate(s, credits);
  if (calc.net_minor <= 0) throw new ApiError(422, 'below_minimum', 'Nothing would be left after tax.');
  const id = newId('cnv');
  const status = s.conversion_approval_required ? 'requested' : 'approved';
  await ctx.db.run(
    'INSERT INTO conversion_request (id, tenant_id, account_id, credits, status, currency, gross_minor, tds_minor, gst_minor, net_minor, terms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, ctx.tenantId, acc.id, credits, status, calc.currency, calc.gross_minor, calc.tds_minor, calc.gst_minor, calc.net_minor,
    JSON.stringify({ tds_rate_bps: s.tds_rate_bps, min: s.conversion_min_credits, hold_days: s.conversion_hold_days, credits_per_usd: s.credits_per_usd, inr_paise_per_usd: s.inr_paise_per_usd, approval_required: !!s.conversion_approval_required }),
    now, now,
  );
  let todo = credits;
  for (const l of lots) {
    if (todo <= 0) break;
    const take = Math.min(todo, l.remaining);
    const r = await ctx.db.run('UPDATE lot SET remaining = remaining - ? WHERE id = ? AND remaining >= ?', take, l.id, take);
    if (r.changes !== 1) throw new ApiError(409, 'balance_changed', 'Balance changed. Try again.');
    await post(ctx, { accountId: acc.id, bucket: 'commission', delta: -take, kind: 'conversion_request', ref: id, lotId: l.id, moneyMinor: calc.gross_minor, currency: calc.currency, tdsMinor: calc.tds_minor, gstMinor: calc.gst_minor, status: 'pending' });
    await ctx.db.run('INSERT INTO conversion_part (request_id, lot_id, amount, origin) VALUES (?,?,?,?)', id, l.id, take, l.origin ?? null);
    todo -= take;
  }
  await emit(ctx, 'conversion.requested', { request_id: id, account_id: acc.id, credits, net_minor: calc.net_minor, currency: calc.currency });
  return { request_id: id, status, credits, ...calc, note: 'Recorded only. No payout is made by this system.' };
}

async function load(ctx, id) {
  const r = await ctx.db.first('SELECT * FROM conversion_request WHERE tenant_id = ? AND id = ?', ctx.tenantId, id);
  if (!r) throw new ApiError(404, 'no_conversion', 'No such conversion request.');
  return r;
}
const setStatus = (ctx, id, from, to, extra = {}) =>
  ctx.db.run(
    `UPDATE conversion_request SET status = ?, updated_at = ?, approved_by = COALESCE(?, approved_by), rail_ref = COALESCE(?, rail_ref), ext_ref = COALESCE(?, ext_ref) WHERE id = ? AND tenant_id = ? AND status = ?`,
    to, ctx.now(), extra.approvedBy ?? null, extra.railRef ?? null, extra.extRef ?? null, id, ctx.tenantId, from,
  );

export async function conversionAction(ctx, id, action, b = {}) {
  const s = await getSettings(ctx);
  const r = await load(ctx, id);
  if (action !== 'reject') needOn(s);
  const stale = () => new ApiError(409, 'wrong_state', `This request is ${r.status}; it cannot ${action}.`);

  if (action === 'approve' || action === 'instruct') {
    // credits that came from a payment the bank took back must not become a payout
    for (const p of await ctx.db.all('SELECT origin, lot_id FROM conversion_part WHERE request_id = ?', id)) {
      if (((await ctx.db.first('SELECT refunded_credits r FROM lot WHERE id = ?', p.lot_id))?.r ?? 0) > 0) throw new ApiError(409, 'payment_reversed', 'Some of these credits came from a sale that was refunded. Reject this request.');
      if ((await isReversed(ctx, p.origin)) || (p.origin && !(await findPayment(ctx, p.origin.replace(/^sale:/i, ''))))) throw new ApiError(409, 'payment_reversed', 'Some of these credits came from a payment that was taken back. Reject this request.');
    }
  }
  if (action === 'approve') {
    if (r.status !== 'requested') throw stale();
    await setStatus(ctx, id, 'requested', 'approved', { approvedBy: ctx.actor });
    await audit(ctx, 'conversion.approve', { id });
    return { id, status: 'approved' };
  }
  if (action === 'instruct') {
    if (r.status !== 'approved') throw stale();
    const out = await ctx.rail.instruct({ request_id: id, currency: r.currency, net_minor: r.net_minor, gross_minor: r.gross_minor, tds_minor: r.tds_minor });
    await setStatus(ctx, id, 'approved', 'instructed', { railRef: out.ref });
    await audit(ctx, 'conversion.instruct', { id, rail: ctx.rail.name, rail_ref: out.ref, executed: !!out.executed });
    return { id, status: 'instructed', rail: ctx.rail.name, rail_ref: out.ref, executed: !!out.executed };
  }
  if (action === 'mark_paid') {
    if (r.status !== 'instructed') throw stale();
    payId(b.payment_ref); // may not start with the internal prefix
    const extRef = ref(b.payment_ref, 'payment_ref'); // the real payment id (for example a bank UTR), typed by a person
    await claimPaymentRef(ctx, extRef, 'payout');
    await setStatus(ctx, id, 'instructed', 'paid', { extRef });
    await post(ctx, { accountId: r.account_id, bucket: 'commission', delta: 0, kind: 'payout', ref: id, moneyMinor: r.net_minor, currency: r.currency, tdsMinor: r.tds_minor, gstMinor: r.gst_minor, status: 'paid', extRef });
    await audit(ctx, 'conversion.paid', { id, ext_ref: extRef });
    await emit(ctx, 'conversion.paid', { request_id: id, account_id: r.account_id, net_minor: r.net_minor, currency: r.currency });
    return { id, status: 'paid' };
  }
  if (action === 'reject') {
    // once handed to a rail the money may already be moving: only a person can close it, by marking it paid
    if (!['requested', 'approved'].includes(r.status)) throw stale();
    await setStatus(ctx, id, r.status, 'rejected');
    // credits come back as a fresh commission lot; its age is kept so the hold is not restarted
    // each part goes back with the payment it came from; a part whose payment was taken back stays removed
    let lotId = null;
    let back = 0;
    for (const p of await ctx.db.all('SELECT * FROM conversion_part WHERE request_id = ?', id)) {
      if (await isReversed(ctx, p.origin)) continue;
      const keep = await withholdDebt(ctx, p.lot_id, p.amount, id, r.account_id, 'commission');
      if (keep < 1) continue;
      lotId = await createLot(ctx, { accountId: r.account_id, bucket: 'commission', amount: keep, source: 'reinstate', sourceRef: `cnv:${id}:${p.lot_id}`, createdAt: r.created_at - s.conversion_hold_days * DAY, kind: 'reversal', meta: { conversion_rejected: id }, extRef: null, ...(p.origin ? { origin: p.origin } : {}) });
      back += keep;
    }
    await audit(ctx, 'conversion.reject', { id, lot_id: lotId });
    return { id, status: 'rejected', returned_credits: back };
  }
  throw new ApiError(400, 'bad_request', 'action must be approve, instruct, mark_paid or reject.');
}

export async function listConversions(ctx, status = null) {
  const rows = status
    ? await ctx.db.all('SELECT * FROM conversion_request WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200', ctx.tenantId, status)
    : await ctx.db.all('SELECT * FROM conversion_request WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200', ctx.tenantId);
  return { conversions: rows };
}
