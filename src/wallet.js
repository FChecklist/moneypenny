// Lots, balance, expiry, and the three ways credit comes in (purchase, rule event, manual bonus).
import { ApiError, DAY, newId, int, str, isUniqueError, canonEmail, normEmail } from './util.js';
import { getSettings, creditsFromMinor, fmtUsd } from './settings.js';
import { ensureAccount, findAccount, markPaid, emailOrThrow } from './accounts.js';
import { post } from './ledger.js';
import { emit } from './outbox.js';

export const NO_CREDIT_EVENTS = ['site_visit', 'page_view', 'pageview', 'visit', 'view', 'login'];

const expiryFor = (s, bucket, now, override) => {
  const d = override ?? s[`${bucket}_expiry_days`];
  return d > 0 ? now + d * DAY : null;
};

export async function createLot(ctx, a) {
  const id = newId('lot');
  try {
    await ctx.db.run(
      'INSERT INTO lot (id, tenant_id, account_id, bucket, original, remaining, created_at, expires_at, eligible_at, source, source_ref, rule_id, paid_minor, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, a.accountId, a.bucket, a.amount, a.amount, ctx.now(), a.expiresAt ?? null, a.eligibleAt ?? 0, a.source, a.sourceRef ?? null, a.ruleId ?? null, a.paidMinor ?? null, a.currency ?? null,
    );
  } catch (e) {
    if (isUniqueError(e)) throw new ApiError(409, 'duplicate_ref', 'That reference was already used.');
    throw e;
  }
  await post(ctx, { accountId: a.accountId, bucket: a.bucket, delta: a.amount, kind: a.kind, ref: a.sourceRef ?? null, lotId: id, meta: a.meta });
  return id;
}

// ---------- balance ----------
export async function getBalance(ctx, email, { details = false } = {}) {
  const s = await getSettings(ctx);
  const acc = await findAccount(ctx, email);
  const now = ctx.now();
  const zero = { balance: 0, can_convert: 0, settling: 0, next_expiry: null };
  let r = zero;
  let buckets = { bought: 0, bonus: 0, commission: 0 };
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
    r = { balance, can_convert: s.conversion_enabled ? convert : 0, settling, next_expiry: next };
  }
  const out = {
    ...r,
    conversion_enabled: !!s.conversion_enabled,
    display: {
      label: s.unit_name,
      amount: fmtUsd(s, r.balance),
      convert_line: r.can_convert > 0 ? s.wording_convert_line.replace('{amount}', `$${fmtUsd(s, r.can_convert)}`) : null,
      settling_line: r.settling > 0 ? s.wording_settling_line.replace('{amount}', `$${fmtUsd(s, r.settling)}`) : null,
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

// ---------- credit in: purchase ----------
/** Bought credits, only against a verified real payment (payment_ref is the IT Services payment id). */
export async function creditPurchase(ctx, b) {
  const s = await getSettings(ctx);
  const acc = await ensureAccount(ctx, b.email);
  const amount = int(b.amount, 'amount', { min: 1, max: 100000000 });
  const paidMinor = int(b.paid_minor, 'paid_minor', { min: 1, max: 100000000000 });
  const currency = b.currency;
  const ref = str(b.payment_ref, 'payment_ref', { max: 100 });
  if (creditsFromMinor(s, currency, paidMinor) < amount) throw new ApiError(422, 'amount_exceeds_payment', 'More credits than the payment covers.');
  if (acc.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const lotId = await createLot(ctx, { accountId: acc.id, bucket: 'bought', amount, source: 'purchase', sourceRef: ref, expiresAt: expiryFor(s, 'bought', ctx.now()), paidMinor, currency, kind: 'purchase' });
  await markPaid(ctx, acc.id);
  await emit(ctx, 'credit.added', { account_id: acc.id, bucket: 'bought', amount, ref, lot_id: lotId });
  return { lot_id: lotId, account_id: acc.id, credited: amount };
}

// ---------- credit in: earning events ----------
const reject = async (ctx, ev, outcome, extra = {}) => {
  await ctx.db.run(
    'INSERT INTO event_in (tenant_id, event_key, event_type, email_canon, account_id, rule_id, bucket, granted, outcome, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ctx.tenantId, ev.key, ev.type, ev.canon, extra.accountId ?? null, extra.ruleId ?? null, extra.bucket ?? null, 0, outcome, ctx.now(),
  );
  return { granted: 0, reason: outcome };
};

/** The rules engine. One event in; the tenant's rule decides credits out. No rule = no credit. */
export async function processEvent(ctx, b) {
  const s = await getSettings(ctx);
  const email = emailOrThrow(b.email);
  const type = str(b.event_type, 'event_type', { max: 50 });
  const key = str(b.event_key, 'event_key', { max: 120 });
  const canon = canonEmail(email);
  const ev = { key, type, canon };

  const prior = await ctx.db.first('SELECT * FROM event_in WHERE tenant_id = ? AND event_key = ?', ctx.tenantId, key);
  if (prior) return { granted: prior.granted, reason: prior.outcome, duplicate: true };

  if (NO_CREDIT_EVENTS.includes(type)) return reject(ctx, ev, 'no_credit_for_visits');
  const domain = email.split('@')[1];
  if (s.blocked_email_domains.includes(domain)) return reject(ctx, ev, 'blocked_domain');

  const day = ctx.now() - DAY;
  const evCount = await ctx.db.first('SELECT COUNT(*) n FROM event_in WHERE tenant_id = ? AND email_canon = ? AND created_at > ?', ctx.tenantId, canon, day);
  if (evCount.n >= s.account_events_per_day) return reject(ctx, ev, 'too_many_events');

  const rule = await ctx.db.first('SELECT * FROM earning_rule WHERE tenant_id = ? AND event_type = ? AND enabled = 1', ctx.tenantId, type);
  if (!rule) return reject(ctx, ev, 'no_rule');
  const rb = { ruleId: rule.id, bucket: rule.bucket };

  // How much, before caps
  let amount = rule.amount;
  if (rule.amount_type === 'pct_cash_bps') {
    const payer = normEmail(b.payer_email);
    if (!payer) return reject(ctx, ev, 'payer_required', rb);
    if (canonEmail(payer) === canon) return reject(ctx, ev, 'self_referral', rb);
    if (!Number.isInteger(b.cash_minor) || b.cash_minor <= 0) return reject(ctx, ev, 'no_cash_no_commission', rb);
    const cash = creditsFromMinor(s, b.currency, b.cash_minor);
    amount = Math.floor((cash * rule.amount) / 10000);
    if (amount < 1) return reject(ctx, ev, 'amount_zero', rb);
  }

  // Caps (by normalised e-mail, so + tags and gmail dots do not make a second person)
  const used = async (extra, ...p) => (await ctx.db.first(`SELECT COALESCE(SUM(granted),0) g, COUNT(CASE WHEN granted > 0 THEN 1 END) c FROM event_in WHERE tenant_id = ? AND email_canon = ? ${extra}`, ctx.tenantId, canon, ...p));
  const byRule = await used('AND rule_id = ?', rule.id);
  if (rule.mode === 'once' && byRule.c >= 1) return reject(ctx, ev, 'already_earned', rb);
  if (rule.mode === 'capped' && byRule.c >= (rule.max_count ?? 1)) return reject(ctx, ev, 'limit_reached', rb);
  if (rule.lifetime_cap) amount = Math.min(amount, rule.lifetime_cap - byRule.g);
  if (rule.bucket === 'bonus') {
    const allBonus = await used("AND bucket = 'bonus'");
    amount = Math.min(amount, s.bonus_lifetime_cap - allBonus.g);
    const t = await ctx.db.first("SELECT COALESCE(SUM(granted),0) g FROM event_in WHERE tenant_id = ? AND bucket = 'bonus' AND created_at > ?", ctx.tenantId, day);
    amount = Math.min(amount, s.tenant_daily_bonus_cap - t.g);
  }
  if (amount < 1) return reject(ctx, ev, 'cap_reached', rb);

  const acc = await ensureAccount(ctx, email, { velocity: true });
  if (acc.status === 'frozen') return reject(ctx, ev, 'account_frozen', { ...rb, accountId: acc.id });
  const eligibleAt = rule.bucket === 'commission' ? ctx.now() + s.commission_hold_days * DAY : 0;
  const lotId = await createLot(ctx, {
    accountId: acc.id, bucket: rule.bucket, amount, source: 'rule', sourceRef: key, ruleId: rule.id,
    expiresAt: expiryFor(s, rule.bucket, ctx.now(), rule.expiry_days), eligibleAt, kind: 'earn', meta: { event_type: type },
  });
  await ctx.db.run(
    'INSERT INTO event_in (tenant_id, event_key, event_type, email_canon, account_id, rule_id, bucket, granted, outcome, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ctx.tenantId, key, type, canon, acc.id, rule.id, rule.bucket, amount, 'granted', ctx.now(),
  );
  await emit(ctx, 'credit.added', { account_id: acc.id, bucket: rule.bucket, amount, ref: key, lot_id: lotId });
  return { granted: amount, reason: 'granted', lot_id: lotId, eligible_at: eligibleAt || null };
}

/** Hand-given bonus: same caps and guards as a rule, one reference per grant. */
export async function creditManualBonus(ctx, b) {
  const s = await getSettings(ctx);
  const amount = int(b.amount, 'amount', { min: 1, max: s.manual_bonus_max });
  const email = emailOrThrow(b.email);
  const key = `manual:${str(b.ref, 'ref', { max: 100 })}`;
  const canon = canonEmail(email);
  const prior = await ctx.db.first('SELECT * FROM event_in WHERE tenant_id = ? AND event_key = ?', ctx.tenantId, key);
  if (prior) throw new ApiError(409, 'duplicate_ref', 'That reference was already used.');
  if (s.blocked_email_domains.includes(email.split('@')[1])) throw new ApiError(422, 'blocked_domain', 'This e-mail domain earns nothing.');
  const all = await ctx.db.first("SELECT COALESCE(SUM(granted),0) g FROM event_in WHERE tenant_id = ? AND email_canon = ? AND bucket = 'bonus'", ctx.tenantId, canon);
  const grant = Math.min(amount, s.bonus_lifetime_cap - all.g);
  if (grant < 1) throw new ApiError(422, 'cap_reached', 'This person has reached the lifetime bonus limit.');
  const acc = await ensureAccount(ctx, email, { velocity: true });
  if (acc.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const lotId = await createLot(ctx, { accountId: acc.id, bucket: 'bonus', amount: grant, source: 'manual', sourceRef: key, expiresAt: expiryFor(s, 'bonus', ctx.now()), kind: 'earn', meta: { manual: true } });
  await ctx.db.run(
    'INSERT INTO event_in (tenant_id, event_key, event_type, email_canon, account_id, rule_id, bucket, granted, outcome, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ctx.tenantId, key, 'manual_bonus', canon, acc.id, null, 'bonus', grant, 'granted', ctx.now(),
  );
  await emit(ctx, 'credit.added', { account_id: acc.id, bucket: 'bonus', amount: grant, ref: key, lot_id: lotId });
  return { granted: grant, lot_id: lotId };
}

export async function history(ctx, email, { limit = 50, beforeSeq = null } = {}) {
  const acc = await findAccount(ctx, email);
  if (!acc) return { entries: [] };
  const n = Math.min(Math.max(limit | 0, 1), 100);
  const rows = await ctx.db.all(
    'SELECT seq, ts, bucket, delta, kind, ref FROM entry WHERE tenant_id = ? AND account_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    ctx.tenantId, acc.id, beforeSeq ?? Number.MAX_SAFE_INTEGER, n,
  );
  return { entries: rows, next_before_seq: rows.length === n ? rows[rows.length - 1].seq : null };
}
