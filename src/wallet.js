// Lots, balance, expiry, and the ways credit comes in (purchase, rule event, hand-given bonus).
import { ApiError, DAY, newId, int, ref, str, isUniqueError, canonEmail, normEmail } from './util.js';
import { getSettings, creditsFromMinor, fmtUsd, fmtCredits, creditsText, COIN_SVG } from './settings.js';
import { calculate } from './convert.js';
import { ensureAccount, findAccount, addPaid, emailOrThrow } from './accounts.js';
import { post } from './ledger.js';
import { emit } from './outbox.js';
import { audit } from './audit.js';

// Event names that look like plain browsing never earn credit (rule creation checks the same test).
const VISIT_TOKEN = /^(visit|view|login|logout|click|brows|scroll|impress|pageload|pageview|heartbeat|session|ping|load|pv)/;
const VISIT_EXACT = new Set(['open', 'opens', 'hit', 'hits', 'seen']);
export const NO_CREDIT_RE = /(visit|pageview|impression|login|click|scroll|browse)/;
/** Token match (case-insensitive) so "review_posted" or "account_opened" are not caught, but "page_viewed" is. */
export const isVisitLike = (type) => {
  const t = String(type).toLowerCase();
  return NO_CREDIT_RE.test(t) || t.split(/[^a-z0-9]+/).some((w) => VISIT_TOKEN.test(w) || VISIT_EXACT.has(w));
};

const expiryFor = (s, bucket, now, override) => {
  const d = override ?? s[`${bucket}_expiry_days`];
  return d > 0 ? now + d * DAY : null;
};

/** The domain or any parent of it is on the blocked list. */
export const domainBlocked = (s, domain) => s.blocked_email_domains.some((d) => domain === d || domain.endsWith(`.${d}`));

export async function createLot(ctx, a) {
  const id = newId('lot');
  try {
    await ctx.db.run(
      'INSERT INTO lot (id, tenant_id, account_id, bucket, original, remaining, created_at, expires_at, eligible_at, source, source_ref, rule_id, paid_minor, currency, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, a.accountId, a.bucket, a.amount, a.amount, a.createdAt ?? ctx.now(), a.expiresAt ?? null, a.eligibleAt ?? 0, a.source, a.sourceRef ?? null, a.ruleId ?? null, a.paidMinor ?? null, a.currency ?? null, a.origin ?? null,
    );
  } catch (e) {
    if (isUniqueError(e)) throw new ApiError(409, 'duplicate_ref', 'That reference was already used.');
    throw e;
  }
  await post(ctx, { accountId: a.accountId, bucket: a.bucket, delta: a.amount, kind: a.kind, ref: a.sourceRef ?? null, lotId: id, meta: a.meta, moneyMinor: a.paidMinor, currency: a.currency, extRef: a.extRef, rateCpu: a.rateCpu, rateInr: a.rateInr });
  return id;
}

// ---------- balance ----------
export async function getBalance(ctx, email, { details = false } = {}) {
  const s = await getSettings(ctx);
  const acc = await findAccount(ctx, email);
  const now = ctx.now();
  let r = { balance: 0, can_convert: 0, settling: 0, next_expiry: null };
  const buckets = { bought: 0, bonus: 0, commission: 0 };
  const convertible = s.conversion_enabled && s.tds_rate_bps != null;
  if (acc) {
    const lots = await ctx.db.all(
      'SELECT bucket, remaining, expires_at, eligible_at, created_at FROM lot WHERE tenant_id = ? AND account_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)',
      ctx.tenantId, acc.id, now,
    );
    let balance = 0, settling = 0, convert = 0, next = null;
    for (const l of lots) {
      balance += l.remaining;
      buckets[l.bucket] += l.remaining;
      if (l.bucket === 'commission') {
        if (l.eligible_at > now) settling += l.remaining;
        else if (l.created_at + s.conversion_hold_days * DAY <= now) convert += l.remaining;
      }
      if (l.expires_at != null && (next == null || l.expires_at < next)) next = l.expires_at;
    }
    const net = convertible && acc.status !== 'frozen' && convert >= s.conversion_min_credits ? calculate(s, convert).net_minor : 0;
    r = { balance, can_convert: net > 0 ? convert : 0, settling, next_expiry: next };
  }
  const out = {
    ...r,
    conversion_enabled: !!s.conversion_enabled,
    fx_stale: s.fx_state === 'stale',
    display: {
      label: s.currency_name,
      symbol: s.unit_symbol,
      icon_svg: s.unit_symbol === 'coin' ? COIN_SVG : null,
      terms_url: s.terms_url ?? null,
      text: creditsText(s, r.balance),
      unit: s.unit_label,
      credits: r.balance,
      amount: fmtCredits(r.balance),
      usd: fmtUsd(s, r.balance),
      convert_line: r.can_convert > 0 ? s.wording_convert_line.replace('{amount}', creditsText(s, r.can_convert)) : null,
      settling_line: r.settling > 0 ? s.wording_settling_line.replace('{amount}', creditsText(s, r.settling)) : null,
      theme: s.theme_enabled ? { name: s.theme_name, accent: s.theme_accent } : null,
    },
  };
  if (details) out.buckets = buckets;
  return out;
}

// ---------- expiry ----------
/** Zeroes every lot past its end date and writes the matching ledger entry. */
export async function expireLots(ctx) {
  const now = ctx.now();
  const lots = await ctx.db.all('SELECT * FROM lot WHERE tenant_id = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ?', ctx.tenantId, now);
  let total = 0;
  for (const l of lots) {
    const r = await ctx.db.run('UPDATE lot SET remaining = 0 WHERE id = ? AND remaining = ?', l.id, l.remaining);
    if (r.changes !== 1) continue;
    await post(ctx, { accountId: l.account_id, bucket: l.bucket, delta: -l.remaining, kind: 'expire', lotId: l.id });
    total += l.remaining;
  }
  return { lots: lots.length, credits: total };
}

/** One real-payment id can be used once per tenant, whether it bought credits, paid an order or paid out. */
/** A payment id is compared without regard to upper/lower case everywhere, so 'Pay_1' and 'pay_1' are one payment. */
export const lc = (x) => String(x).toLowerCase();
/** A payment id as given by a caller: it may not start with our own internal prefix 'sale:' (that would make one payment look like two). */
export const payId = (x, name = 'payment_ref') => {
  const r = ref(x, name);
  if (/^sale:/i.test(r)) throw new ApiError(400, 'bad_request', `${name} may not start with "sale:".`);
  return lc(r);
};

/** What we know about a real payment: a notice from the payment side, or a purchase we credited. null if unknown. */
export async function findPayment(ctx, refId) {
  const r = lc(refId);
  const v = await ctx.db.first('SELECT paid_minor, currency, payer_canon FROM verified_payment WHERE tenant_id = ? AND ref = ?', ctx.tenantId, r);
  if (v) return { paid_minor: v.paid_minor, currency: v.currency, payer: v.payer_canon };
  const l = await ctx.db.first("SELECT l.paid_minor - l.refunded_minor AS left_minor, l.currency, a.email_canon AS payer FROM lot l JOIN account a ON a.id = l.account_id WHERE l.tenant_id = ? AND l.source = 'purchase' AND lower(l.source_ref) = ?", ctx.tenantId, r);
  return l && l.left_minor > 0 ? { paid_minor: l.left_minor, currency: l.currency, payer: l.payer } : null;
}

/** The payment side tells us a real payment happened (purchase key). Same ref again with the same figures is a no-op. */
export async function paymentNotice(ctx, b) {
  const r = payId(b.payment_ref);
  const paid = int(b.paid_minor, 'paid_minor', { min: 1, max: 100000000000 });
  const cur = b.currency;
  if (cur !== 'INR' && cur !== 'USD') throw new ApiError(400, 'bad_currency', 'Payment is in INR or USD only.');
  const prior = await ctx.db.first('SELECT paid_minor, currency FROM verified_payment WHERE tenant_id = ? AND ref = ?', ctx.tenantId, r);
  if (prior) {
    if (prior.paid_minor !== paid || prior.currency !== cur) throw new ApiError(409, 'payment_conflict', 'This payment id was already noted with different figures.');
    return { payment_ref: r, noted: true, duplicate: true };
  }
  await ctx.db.run('INSERT INTO verified_payment (tenant_id, ref, paid_minor, currency, payer_canon, created_at) VALUES (?,?,?,?,?,?)', ctx.tenantId, r, paid, cur, b.payer_email ? canonEmail(emailOrThrow(b.payer_email)) : null, ctx.now());
  return { payment_ref: r, noted: true };
}

export async function claimPaymentRef(ctx, refId, kind) {
  refId = lc(refId);
  try {
    await ctx.db.run('INSERT INTO payment_ref (tenant_id, ref, kind, created_at) VALUES (?,?,?,?)', ctx.tenantId, refId, kind, ctx.now());
  } catch (e) {
    if (isUniqueError(e)) throw new ApiError(409, kind === 'order' ? 'payment_already_used' : 'duplicate_ref', 'That payment was already used.');
    throw e;
  }
}

// ---------- credit in: purchase ----------
/** Bought credits, only against a verified real payment (payment_ref is the IT Services / Razorpay payment id). */
export async function creditPurchase(ctx, b, { lock = null } = {}) {
  let s = await getSettings(ctx);
  if (lock) s = { ...s, credits_per_usd: lock.rateCpu, inr_paise_per_usd: lock.rateInr }; // an order keeps the rate it was made at
  const amount = int(b.amount, 'amount', { min: 1, max: 100000000 });
  const paidMinor = int(b.paid_minor, 'paid_minor', { min: 1, max: 100000000000 });
  const currency = b.currency;
  const payRef = payId(b.payment_ref);
  if (await ctx.db.first('SELECT 1 x FROM charged_back WHERE tenant_id = ? AND payment_ref = ?', ctx.tenantId, payRef)) throw new ApiError(409, 'payment_reversed', 'That payment was taken back.');
  if (creditsFromMinor(s, currency, paidMinor) < amount) throw new ApiError(422, 'amount_exceeds_payment', 'More credits than the payment covers.');
  // A paused account may still be credited: the money has already been taken, so the credits must exist.
  const acc = await ensureAccount(ctx, b.email);
  await claimPaymentRef(ctx, payRef, 'purchase');
  const lotId = await createLot(ctx, { accountId: acc.id, bucket: 'bought', amount, source: 'purchase', sourceRef: payRef, origin: payRef, expiresAt: expiryFor(s, 'bought', ctx.now()), paidMinor, currency, kind: 'purchase', extRef: payRef, ...(lock || {}) });
  await addPaid(ctx, acc.id, amount);
  await emit(ctx, 'credit.added', { account_id: acc.id, bucket: 'bought', amount, ref: payRef, lot_id: lotId });
  return { lot_id: lotId, account_id: acc.id, credited: amount };
}

// ---------- credit in: earning events ----------
const insertEvent = (ctx, v) =>
  ctx.db.run(
    'INSERT INTO event_in (tenant_id, event_key, event_type, email_canon, account_id, rule_id, bucket, granted, outcome, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ctx.tenantId, v.key, v.type, v.canon, v.accountId ?? null, v.ruleId ?? null, v.bucket ?? null, v.granted ?? 0, v.outcome, ctx.now(),
  );

const reject = async (ctx, ev, outcome, extra = {}) => {
  await insertEvent(ctx, { ...ev, ...extra, outcome });
  return { granted: 0, reason: outcome };
};

/** Shared bonus headroom: lifetime cap per person, tenant daily cap. Returns credits still allowed. */
async function bonusHeadroom(ctx, s, canon, want) {
  const day = ctx.now() - DAY;
  const all = await ctx.db.first("SELECT COALESCE(SUM(granted),0) g FROM event_in WHERE tenant_id = ? AND email_canon = ? AND bucket = 'bonus'", ctx.tenantId, canon);
  const t = await ctx.db.first("SELECT COALESCE(SUM(granted),0) g FROM event_in WHERE tenant_id = ? AND bucket = 'bonus' AND created_at > ?", ctx.tenantId, day);
  return Math.min(want, s.bonus_lifetime_cap - all.g, s.tenant_daily_bonus_cap - t.g);
}

/** The rules engine. One event in; the tenant's rule decides credits out. No rule = no credit. */
export async function processEvent(ctx, b) {
  const s = await getSettings(ctx);
  const email = emailOrThrow(b.email);
  const type = str(b.event_type, 'event_type', { max: 50 });
  const key = ref(b.event_key, 'event_key', 120);
  const canon = canonEmail(email);
  const ev = { key, type, canon };

  const prior = await ctx.db.first('SELECT * FROM event_in WHERE tenant_id = ? AND event_key = ?', ctx.tenantId, key);
  if (prior) return { granted: prior.granted, reason: prior.outcome, duplicate: true };

  if (isVisitLike(type)) return reject(ctx, ev, 'no_credit_for_visits');
  if (domainBlocked(s, email.split('@')[1])) return reject(ctx, ev, 'blocked_domain');

  const day = ctx.now() - DAY;
  const evCount = await ctx.db.first('SELECT COUNT(*) n FROM event_in WHERE tenant_id = ? AND email_canon = ? AND created_at > ?', ctx.tenantId, canon, day);
  if (evCount.n >= s.account_events_per_day) return reject(ctx, ev, 'too_many_events');

  const rule = await ctx.db.first('SELECT * FROM earning_rule WHERE tenant_id = ? AND event_type = ? AND enabled = 1', ctx.tenantId, type);
  if (!rule) return reject(ctx, ev, 'no_rule');
  const rb = { ruleId: rule.id, bucket: rule.bucket };
  // Commission is only ever a share of cash received (also enforced when rules are saved).
  if (rule.bucket === 'commission' && rule.amount_type !== 'pct_cash_bps') return reject(ctx, ev, 'rule_invalid', rb);

  let amount = rule.amount;
  let saleRef = null;
  if (rule.amount_type === 'pct_cash_bps') {
    const payer = normEmail(b.payer_email);
    if (!payer) return reject(ctx, ev, 'payer_required', rb);
    if (canonEmail(payer) === canon) return reject(ctx, ev, 'self_referral', rb);
    if (!Number.isInteger(b.cash_minor) || b.cash_minor <= 0 || b.cash_minor > 100000000000) return reject(ctx, ev, 'no_cash_no_commission', rb);
    // The sale itself must be named (the real payment id), and each sale can pay commission once per tenant.
    if (typeof b.sale_ref !== 'string' || !/^[A-Za-z0-9._:/=+-]{1,100}$/.test(b.sale_ref) || /^sale:/i.test(b.sale_ref)) return reject(ctx, ev, 'sale_ref_required', rb);
    saleRef = lc(b.sale_ref);
    // the sale must be a payment the payment side told us about, for at least this much, in this currency
    const pay = await findPayment(ctx, saleRef);
    // not remembered under this event key: once the payment side has noted the payment, the same event can be sent again
    if (!pay) return { granted: 0, reason: 'payment_not_verified' };
    if (!pay.payer || pay.payer !== canonEmail(payer)) return reject(ctx, ev, 'payer_mismatch', rb); // the buyer on the payment must be the payer named
    if (await ctx.db.first('SELECT 1 x FROM charged_back WHERE tenant_id = ? AND payment_ref = ?', ctx.tenantId, saleRef)) return reject(ctx, ev, 'sale_reversed', rb);
    if (pay.currency !== b.currency || b.cash_minor > pay.paid_minor) return { granted: 0, reason: 'cash_exceeds_payment' };
    if (await ctx.db.first('SELECT 1 x FROM payment_ref WHERE tenant_id = ? AND ref = ?', ctx.tenantId, `sale:${saleRef}`)) return reject(ctx, ev, 'sale_already_used', rb);
    const cash = creditsFromMinor(s, b.currency, b.cash_minor);
    amount = Math.floor((cash * rule.amount) / 10000);
    if (amount < 1) return reject(ctx, ev, 'amount_zero', rb);
    if (amount > s.commission_max_per_event) return reject(ctx, ev, 'over_event_limit', rb);
    const dayTotal = await ctx.db.first("SELECT COALESCE(SUM(granted),0) g FROM event_in WHERE tenant_id = ? AND bucket = 'commission' AND created_at > ?", ctx.tenantId, ctx.now() - DAY);
    if (dayTotal.g + amount > s.commission_daily_cap) return reject(ctx, ev, 'daily_cap_reached', rb);
  }

  const used = (extra, ...p) =>
    ctx.db.first(`SELECT COALESCE(SUM(granted),0) g, COUNT(CASE WHEN granted > 0 THEN 1 END) c FROM event_in WHERE tenant_id = ? AND email_canon = ? ${extra}`, ctx.tenantId, canon, ...p);
  const byRule = await used('AND rule_id = ?', rule.id);
  if (rule.mode === 'once' && byRule.c >= 1) return reject(ctx, ev, 'already_earned', rb);
  if (rule.mode === 'capped' && byRule.c >= (rule.max_count ?? 1)) return reject(ctx, ev, 'limit_reached', rb);
  if (rule.lifetime_cap) amount = Math.min(amount, rule.lifetime_cap - byRule.g);
  if (rule.bucket === 'bonus') amount = await bonusHeadroom(ctx, s, canon, amount);
  if (amount < 1) return reject(ctx, ev, 'cap_reached', rb);

  const acc = await ensureAccount(ctx, email, { velocity: true });
  if (acc.status === 'frozen') return reject(ctx, ev, 'account_frozen', { ...rb, accountId: acc.id });
  const eligibleAt = rule.bucket === 'commission' ? ctx.now() + s.commission_hold_days * DAY : 0;
  if (saleRef) await claimPaymentRef(ctx, `sale:${saleRef}`, 'sale');
  const lotId = await createLot(ctx, {
    accountId: acc.id, bucket: rule.bucket, amount, source: 'rule', sourceRef: key, ruleId: rule.id,
    expiresAt: expiryFor(s, rule.bucket, ctx.now(), rule.expiry_days), eligibleAt, kind: rule.bucket, meta: { event_type: type },
    ...(rule.bucket === 'commission' ? { paidMinor: b.cash_minor, currency: b.currency, origin: `sale:${saleRef}`, extRef: saleRef } : {}),
  });
  await insertEvent(ctx, { ...ev, accountId: acc.id, ruleId: rule.id, bucket: rule.bucket, granted: amount, outcome: 'granted' });
  await emit(ctx, 'credit.added', { account_id: acc.id, bucket: rule.bucket, amount, ref: key, lot_id: lotId });
  return { granted: amount, reason: 'granted', lot_id: lotId, eligible_at: eligibleAt || null };
}

/** Hand-given bonus: same caps and guards as a rule, one reference per grant, and it is audited. */
export async function creditManualBonus(ctx, b) {
  const s = await getSettings(ctx);
  const amount = int(b.amount, 'amount', { min: 1, max: s.manual_bonus_max });
  const email = emailOrThrow(b.email);
  const key = `manual:${ref(b.ref, 'ref')}`;
  const canon = canonEmail(email);
  const prior = await ctx.db.first('SELECT 1 x FROM event_in WHERE tenant_id = ? AND event_key = ?', ctx.tenantId, key);
  if (prior) throw new ApiError(409, 'duplicate_ref', 'That reference was already used.');
  if (domainBlocked(s, email.split('@')[1])) throw new ApiError(422, 'blocked_domain', 'This e-mail domain earns nothing.');
  const evCount = await ctx.db.first('SELECT COUNT(*) n FROM event_in WHERE tenant_id = ? AND email_canon = ? AND created_at > ?', ctx.tenantId, canon, ctx.now() - DAY);
  if (evCount.n >= s.account_events_per_day) throw new ApiError(429, 'too_many_events', 'Too many events for this person today.');
  const grant = await bonusHeadroom(ctx, s, canon, amount);
  if (grant < 1) throw new ApiError(422, 'cap_reached', 'This person or this tenant has reached the bonus limit.');
  const acc = await ensureAccount(ctx, email, { velocity: true });
  if (acc.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const lotId = await createLot(ctx, { accountId: acc.id, bucket: 'bonus', amount: grant, source: 'manual', sourceRef: key, expiresAt: expiryFor(s, 'bonus', ctx.now()), kind: 'bonus', meta: { manual: true } });
  await insertEvent(ctx, { key, type: 'manual_bonus', canon, accountId: acc.id, bucket: 'bonus', granted: grant, outcome: 'granted' });
  await audit(ctx, 'bonus.manual', { account_id: acc.id, amount: grant, ref: key });
  await emit(ctx, 'credit.added', { account_id: acc.id, bucket: 'bonus', amount: grant, ref: key, lot_id: lotId });
  return { granted: grant, lot_id: lotId };
}

export async function history(ctx, email, { limit = 50, beforeSeq = null } = {}) {
  const acc = await findAccount(ctx, email);
  if (!acc) return { entries: [] };
  const n = Math.min(Math.max(limit | 0, 1), 100);
  const rows = await ctx.db.all(
    'SELECT seq, ts, bucket, delta, kind, ref, money_minor, currency, tds_minor, gst_minor, status, ext_ref, rate_cpu, rate_inr FROM entry WHERE tenant_id = ? AND account_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    ctx.tenantId, acc.id, beforeSeq ?? Number.MAX_SAFE_INTEGER, n,
  );
  return { entries: rows, next_before_seq: rows.length === n ? rows[rows.length - 1].seq : null };
}

export { ApiError };
