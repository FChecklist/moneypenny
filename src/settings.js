// Every rule is a per-tenant setting stored in the database. DEFAULTS below is only
// the starting template copied to a new tenant; the engine reads the database.
import { ApiError } from './util.js';
import { audit } from './audit.js';
import { currentRate } from './fx.js';

export const SCHEMA = {
  product_name: { type: 'str', def: 'Corporate Moneypenny', doc: 'Public product name shown to people.' },
  currency_name: { type: 'str', def: 'Moneypenny Credits', doc: 'Name of the credit currency shown to people (a tenant can rename it).' },
  unit_label: { type: 'str', def: 'credits', doc: 'Word used after a number of credits.' },
  unit_symbol: { type: 'str', def: 'MC', doc: 'Short symbol for the currency. It is never a dollar sign.' },
  credits_per_usd: { type: 'int', def: 100, min: 1, max: 100000, doc: 'Credits per US$1 (100 = one credit is one cent).' },
  inr_paise_per_usd: { type: 'int', def: 7000, min: 100, max: 1000000, doc: 'Paise per US$1 (7000 = Rs 70). Used only until the daily rate table has a rate; after that the table (plus fx_margin_bps) is used.' },
  base_currency: { type: 'cur', def: 'INR', doc: 'Currency a person pays in by default (INR or USD; nothing else can be paid in).' },
  display_currency: { type: 'curnull', def: null, doc: 'Optional third currency shown next to prices for information only (for example EUR). Never charged.' },
  fx_margin_bps: { type: 'int', def: 0, min: 0, max: 2000, doc: 'Margin added to the daily INR rate for this tenant, in basis points (100 = 1%).' },
  fx_max_age_hours: { type: 'int', def: 72, min: 1, max: 720, doc: 'How old the last good exchange rate may be before new INR orders are paused.' },
  inr_round_to_rupee: { type: 'bool', def: 1, doc: 'Round INR prices for credit orders up to a whole rupee.' },
  buy_min_credits: { type: 'int', def: 100, min: 1, max: 100000000, doc: 'Smallest credit order (100 = US$1).' },
  buy_max_credits: { type: 'int', def: 500000, min: 1, max: 1000000000, doc: 'Largest single credit order (500000 = US$5,000).' },
  order_expiry_minutes: { type: 'int', def: 60, min: 5, max: 10080, doc: 'Minutes before an unpaid credit order is marked failed (a late payment is still credited at the locked rate).' },
  read_cache_max_age_seconds: { type: 'int', def: 300, min: 0, max: 86400, doc: 'If the database fails, a balance seen this recently may still be shown (marked degraded). 0 = never.' },
  bought_expiry_days: { type: 'int', def: 365, min: 0, max: 3650, doc: 'Days a bought lot stays valid. 0 = no end.' },
  bonus_expiry_days: { type: 'int', def: 365, min: 0, max: 3650, doc: 'Days a bonus lot stays valid. 0 = no end.' },
  commission_expiry_days: { type: 'int', def: 0, min: 0, max: 3650, doc: 'Days a commission lot stays valid. 0 = no end (it is money owed).' },
  reinstate_min_days: { type: 'int', def: 30, min: 0, max: 3650, doc: 'A returned lot is valid for at least this many days.' },
  bonus_max_order_pct: { type: 'int', def: 50, min: 0, max: 100, doc: 'Bonus may pay at most this percent of one order.' },
  bonus_lifetime_cap: { type: 'int', def: 800, min: 0, max: 10000000, doc: 'Most bonus credits one person can ever earn (800 = $8).' },
  bonus_needs_paid: { type: 'bool', def: 1, doc: 'Bonus is spendable only once the person has real paid value on record (net of refunds and chargebacks).' },
  bonus_unlock_min_credits: { type: 'int', def: 100, min: 1, max: 100000000, doc: 'Real paid value (in credits) needed before bonus can be spent (100 = $1).' },
  commission_hold_days: { type: 'int', def: 7, min: 0, max: 365, doc: 'Days before commission credits can be spent.' },
  hold_minutes: { type: 'int', def: 15, min: 1, max: 120, doc: 'Minutes a reserve (hold) lasts.' },
  capture_grace_minutes: { type: 'int', def: 5, min: 0, max: 120, doc: 'Extra minutes a late payment may still capture a hold.' },
  min_cash_due_inr: { type: 'int', def: 100, min: 0, max: 100000000, doc: 'Smallest cash left to pay in paise (payment gateway minimum). 0 = none.' },
  min_cash_due_usd: { type: 'int', def: 0, min: 0, max: 100000000, doc: 'Smallest cash left to pay in cents. 0 = none.' },
  commission_max_per_event: { type: 'int', def: 50000, min: 1, max: 1000000000, doc: 'Largest commission one sale can pay (50000 = $500).' },
  commission_daily_cap: { type: 'int', def: 500000, min: 1, max: 1000000000, doc: 'Most commission credits paid across the whole tenant per 24 hours.' },
  manual_bonus_max: { type: 'int', def: 500, min: 0, max: 10000000, doc: 'Largest single hand-given bonus (credits).' },
  conversion_enabled: { type: 'bool', def: 0, doc: 'Commission-to-cash requests. OFF until owner switches it on.' },
  conversion_hold_days: { type: 'int', def: 7, min: 0, max: 365, doc: 'Days a commission lot must age before it counts as convertible.' },
  conversion_min_credits: { type: 'int', def: 1500, min: 1, max: 100000000, doc: 'Smallest conversion request (1500 = $15).' },
  conversion_approval_required: { type: 'bool', def: 1, doc: 'A person must approve each conversion request before it can be sent to a payment rail.' },
  conversion_currency: { type: 'cur', def: 'INR', doc: 'Currency a conversion is calculated in (INR or USD).' },
  gst_rate_bps: { type: 'intnull', def: null, min: 0, max: 10000, doc: 'GST rate on conversions in basis points. Recorded on entries; unset = none.' },
  tds_rate_bps: { type: 'intnull', def: null, min: 0, max: 10000, doc: 'TDS rate in basis points. Must be set (by the CA) before conversion can be used.' },
  refund_money_enabled: { type: 'bool', def: 1, doc: 'Allow real-money refunds of unspent bought credits.' },
  blocked_email_domains: { type: 'domains', def: ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com'], doc: 'Throw-away e-mail domains that earn nothing.' },
  account_events_per_day: { type: 'int', def: 20, min: 1, max: 100000, doc: 'Earning events counted per person per 24 hours.' },
  new_accounts_per_hour: { type: 'int', def: 100, min: 1, max: 1000000, doc: 'New people created by earning events per hour.' },
  tenant_daily_bonus_cap: { type: 'int', def: 50000, min: 0, max: 1000000000, doc: 'Most bonus credits given across the whole tenant per 24 hours.' },
  api_rate_per_minute: { type: 'int', def: 600, min: 1, max: 1000000, doc: 'Signed calls allowed per key per minute.' },
  wording_convert_line: { type: 'str', def: 'You can convert {amount}', doc: 'Line under the balance. {amount} is filled in with credits and their US$ value.' },
  wording_settling_line: { type: 'str', def: 'Settling soon: {amount}', doc: 'Line for credits still settling. {amount} is filled in.' },
  theme_enabled: { type: 'bool', def: 1, doc: 'Show the theme skin. Balances are identical with it off.' },
  theme_name: { type: 'str', def: 'classic', doc: 'Theme pack name.' },
  theme_accent: { type: 'color', def: '#0b6b57', doc: 'Accent colour for the balance widget.' },
};

export const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.def]));

function parse(key, raw) {
  const s = SCHEMA[key];
  const v = JSON.parse(raw);
  return v === undefined ? s.def : v;
}

export async function getSettings(ctx) {
  if (ctx._settings) return ctx._settings;
  const rows = await ctx.db.all('SELECT key, value FROM tenant_setting WHERE tenant_id = ?', ctx.tenantId);
  const out = { ...DEFAULTS };
  for (const r of rows) if (r.key in SCHEMA) out[r.key] = parse(r.key, r.value);
  // Daily rate table beats the hand-typed INR figure once it has a rate. 'stale' keeps the last rate but pauses new INR orders.
  const fx = await currentRate(ctx, 'INR', out.fx_max_age_hours);
  out.fx_state = fx.state;
  out.fx_as_of = fx.as_of ?? null;
  if (fx.state !== 'none') out.inr_paise_per_usd = Math.max(100, Math.round((fx.row.rate_x10000 / 100) * (10000 + out.fx_margin_bps) / 10000));
  ctx._settings = out;
  return out;
}

export function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) throw new ApiError(400, 'unknown_setting', `Unknown setting: ${key}`);
  const bad = (m) => new ApiError(400, 'bad_setting', `${key}: ${m}`);
  switch (s.type) {
    case 'int':
      if (!Number.isInteger(value) || value < s.min || value > s.max) throw bad(`whole number ${s.min} to ${s.max}`);
      return value;
    case 'intnull':
      if (value === null) return null;
      if (!Number.isInteger(value) || value < s.min || value > s.max) throw bad(`null or whole number ${s.min} to ${s.max}`);
      return value;
    case 'bool':
      if (value === true || value === 1) return 1;
      if (value === false || value === 0) return 0;
      throw bad('must be 0 or 1');
    case 'str':
      if (typeof value !== 'string' || !value.length || value.length > 120) throw bad('text up to 120 characters');
      if (/[<>]/.test(value)) throw bad('no angle brackets');
      return value;
    case 'cur':
      if (value !== 'INR' && value !== 'USD') throw bad("must be 'INR' or 'USD'");
      return value;
    case 'curnull':
      if (value === null) return null;
      if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw bad('null or a 3-letter code like EUR');
      return value;
    case 'color':
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw bad('colour like #0b6b57');
      return value;
    case 'domains':
      if (!Array.isArray(value) || value.length > 500 || !value.every((d) => typeof d === 'string' && /^[a-z0-9.-]{3,100}$/.test(d))) throw bad('list of lower-case domains');
      return value;
  }
}

export async function setSettings(ctx, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'bad_request', 'Send an object of settings.');
  const clean = {};
  for (const [k, v] of Object.entries(patch)) clean[k] = validate(k, v);
  const before = await getSettings(ctx);
  if ('credits_per_usd' in clean && clean.credits_per_usd !== before.credits_per_usd) {
    const any = await ctx.db.first('SELECT 1 x FROM entry WHERE tenant_id = ? LIMIT 1', ctx.tenantId);
    if (any) throw new ApiError(409, 'rate_locked', 'Credits per US$1 cannot change once credits exist.');
  }
  if ('inr_paise_per_usd' in clean && before.fx_state === 'none') {
    const o = before.inr_paise_per_usd;
    if (Math.abs(clean.inr_paise_per_usd - o) * 10 > o) throw new ApiError(422, 'rate_change_too_big', 'The INR rate can move by at most 10% in one change.');
  }
  for (const [k, v] of Object.entries(clean)) {
    await ctx.db.run(
      'INSERT INTO tenant_setting (tenant_id, key, value, updated_at) VALUES (?,?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ctx.tenantId, k, JSON.stringify(v), ctx.now(),
    );
    await audit(ctx, 'setting.change', { key: k, from: before[k], to: v });
  }
  ctx._settings = null;
  return getSettings(ctx);
}

export async function seedDefaults(ctx) {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    await ctx.db.run('INSERT INTO tenant_setting (tenant_id, key, value, updated_at) VALUES (?,?,?,?)', ctx.tenantId, k, JSON.stringify(v), ctx.now());
  }
}

// ----- money conversion (credits <-> currency minor units) -----
export function minorPerUsd(s, cur) {
  if (cur === 'USD') return 100;
  if (cur === 'INR') return s.inr_paise_per_usd;
  throw new ApiError(400, 'bad_currency', 'Currency must be INR or USD.');
}
/** Whole credits worth at most this much money (rounds down, never over-applies). */
export function creditsFromMinor(s, cur, minor) {
  return Math.floor((minor * s.credits_per_usd) / minorPerUsd(s, cur));
}
/** Money value of credits, rounded in the person's favour. */
export function minorFromCredits(s, cur, credits) {
  return Math.ceil((credits * minorPerUsd(s, cur)) / s.credits_per_usd);
}
export function fmtUsd(s, credits) {
  return (credits / s.credits_per_usd).toFixed(2);
}
export const fmtCredits = (n) => Number(n).toLocaleString('en-US');
/** "2,000 credits (US$20.00)" - credits first, US$ second. */
export const creditsText = (s, n) => `${fmtCredits(n)} ${s.unit_label} (US$${fmtUsd(s, n)})`;
