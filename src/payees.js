// Payee account registry (chunk F2). Says WHO receives the real money. A side record only:
// credits, lots, entries, holds and the ledger chain never read it.
// DARK: every call refuses with 503 payees_disabled unless the flag MNP_PAYEE_ACCOUNTS is '1'
// (env) or ctx.payees === true (tests). The flag defaults off, and nothing else calls this file yet.
// Secrets: only the NAMES of platform secrets are stored. A value is refused. Responses never carry a value.
import { ApiError, newId, sha256Hex } from './util.js';

export const STATUSES = ['draft', 'active', 'paused', 'retired'];
export const MOVES = { draft: ['active'], active: ['paused', 'retired'], paused: ['active', 'retired'], retired: [] };
export const GATEWAYS = ['razorpay', 'stripe', 'cashfree', 'manual_bank']; // F4 replaces this list with the adapter registry
export const CURRENCIES = ['INR', 'USD'];
export const SECRET_KEYS = ['key_id', 'key_secret', 'webhook_secret'];
const IDENTITY = ['legal_name', 'gateway', 'mode', 'secret_names', 'currencies'];
const TEXT = ['display_name', 'checkout', 'invoice', 'note'];
const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

export const payeesEnabled = (ctx) => ctx.payees === true || ctx.env?.MNP_PAYEE_ACCOUNTS === '1';
// A stored secret_names that cannot be read counts as empty. It never raises a raw SyntaxError.
const parseNames = (raw) => {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const badNames = (raw) => {
  try {
    const v = JSON.parse(raw || '{}');
    return !(v && typeof v === 'object' && !Array.isArray(v));
  } catch {
    return true;
  }
};
// Read-only calls (readOnly) only need the flag, so the owner can still look at the registry to see a setup problem.
// Changes and routing calls are also refused while an active payee has no usable secret names.
export const gate = async (ctx, fillId, readOnly = false) => {
  if (!payeesEnabled(ctx)) throw new ApiError(503, 'payees_disabled', 'Payee accounts are not turned on.');
  if (readOnly) return;
  // The one way out: an owner edit that sets only the secret names of such a payee (fillId).
  const rows = await ctx.db.all("SELECT payee_id, legal_name, secret_names FROM payee_account WHERE status = 'active'");
  const empty = rows.filter((r) => !Object.keys(parseNames(r.secret_names)).length);
  if (empty.length && !(fillId && empty.every((r) => r.payee_id === fillId))) {
    const who = empty.map((r) => `${r.legal_name} (${r.payee_id})${badNames(r.secret_names) ? ' [stored secret names are unreadable]' : ''}`).join(', ');
    throw new ApiError(409, 'payee_setup_incomplete', `An active payee has no secret names. An owner must fill in the secret names first. Payee: ${who}.`);
  }
};
// Every change needs the owner role: ctx.callerType === 'owner' (the repo's existing caller type, set only by
// the code that builds the context, never by a request). The actor must be a real name, not 'system'.
const ownerOnly = (ctx) => {
  if (ctx.callerType !== 'owner' || !ctx.actor || ctx.actor === 'system') throw new ApiError(403, 'payee_forbidden', 'Only the owner can change a payee.');
};

/** One hash-chained payee_audit row, written in the caller's transaction. Never a secret value: secret_names holds NAMES only. */
const SAFE = ['legal_name', 'display_name', 'gateway', 'mode', 'status', 'currencies', 'checkout', 'invoice', 'secret_names', 'note', 'version'];
const snap = (r) => r && Object.fromEntries(SAFE.map((k) => [k, view(r)[k]]));
// The audit detail holds only the NAMES of the fields that changed, never a value (free text may be sensitive).
const changedKeys = (before, after) => {
  const b = snap(before) || {};
  const a = snap(after) || {};
  return SAFE.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
};
const isPkConflict = (e) => /UNIQUE constraint failed|PRIMARY KEY|SQLITE_CONSTRAINT/i.test(String(e?.message || e));
async function auditRow(ctx, db, action, payeeId, before, after) {
  return chainRow(ctx, db, action, () => ({ payee_id: payeeId, changed: changedKeys(before, after) }));
}
/** One chained audit row with a caller-made detail (ids and names only, never free text or a secret value). Retries once on a seq clash. */
export async function chainRow(ctx, db, action, detailFn) {
  // seq = last + 1 can clash if another writer got in between: try once more in a fresh transaction, then fail cleanly.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.tx((t) => auditRowOnce(ctx, t, action, detailFn()));
    } catch (e) {
      if (!isPkConflict(e)) throw e;
    }
  }
  throw new ApiError(409, 'audit_conflict', 'The audit log was busy. Nothing was changed. Try again.');
}
async function auditRowOnce(ctx, db, action, detail) {
  const last = await db.first('SELECT seq, hash FROM payee_audit ORDER BY seq DESC LIMIT 1');
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? 'GENESIS';
  const ts = ctx.now();
  const d = JSON.stringify(detail);
  const hash = await sha256Hex(JSON.stringify([seq, ts, ctx.actor, action, d, prev, ctx.keyId || null]));
  await db.run('INSERT INTO payee_audit (seq, ts, actor, key_id, action, detail, change_id, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)', seq, ts, ctx.actor, ctx.keyId || null, action, d, null, prev, hash);
}

/** A secret NAME looks like MNP_PAYEE_X_KEY_SECRET. Anything that looks like a secret VALUE is refused (the text is never echoed). */
export function checkSecretName(v, field) {
  if (typeof v !== 'string' || !NAME_RE.test(v) || /^[A-F0-9]{32,}$/.test(v) || /^RZP_/.test(v)) {
    throw new ApiError(400, 'secret_value_refused', `${field} must be the NAME of a platform secret (capital letters, digits, underscore). Never paste a secret value.`);
  }
  return v;
}

function names(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'bad_secret_names', 'secret_names must give key_id, key_secret and webhook_secret.');
  for (const k of Object.keys(v)) if (!SECRET_KEYS.includes(k)) throw new ApiError(400, 'bad_secret_names', 'secret_names has an unknown field.');
  const out = {};
  for (const k of SECRET_KEYS) out[k] = checkSecretName(v[k], k);
  if (new Set(Object.values(out)).size !== 3) throw new ApiError(400, 'bad_secret_names', 'The three secret names must differ.');
  return out;
}
/** Same value detection as checkSecretName, for free text: long hex or base64-like runs, rzp_ text, key-like words. Never echoes the text. */
const looksSecret = (t) => /rzp_/i.test(t) || /[A-Fa-f0-9]{32,}/.test(t) || (!/[\s./]/.test(t) && /[A-Za-z0-9+/_=-]{32,}/.test(t)) || /\b(?:sk|pk|rk|whsec)_[A-Za-z0-9]{8,}/i.test(t);
/** Bank details must never be stored. Each rule has its own name so a test can reach it. */
export const BANK_RULES = {
  // Strict: account number (9 to 18 digits) or card number (13 to 19), spaces or dashes allowed.
  // Loose (address_lines, number_prefix, receipt_text only): a run of exactly 10 (phone) is allowed, and 6 (PIN) is under 9 anyway;
  // any other run of 9 or more is refused, and so is any run of 6 or more near the words account, a/c, ifsc, iban.
  digits: (t, loose = false) => {
    const runs = (t.match(/\d(?:[ -]?\d)*/g) || []).map((r) => r.replace(/\D/g, '').length);
    if (!loose) return runs.some((n) => n >= 9);
    if (runs.some((n) => n >= 9 && n !== 10)) return true;
    return runs.some((n) => n >= 6) && /account|a\/c|\bac\b|ifsc|iban/i.test(t);
  },
  ifsc: (t) => /(?<![A-Za-z0-9])[A-Za-z]{4}0[A-Za-z0-9]{6}(?![A-Za-z0-9])/.test(t),
  iban: (t) => /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,3})?(?![A-Za-z0-9])/.test(t),
};
const LOOSE_FIELDS = ['address_lines', 'number_prefix', 'receipt_text'];
const looksBank = (t, field = '') => BANK_RULES.digits(t, LOOSE_FIELDS.includes(field.split('.').pop())) || BANK_RULES.ifsc(t) || BANK_RULES.iban(t);
export const text = (v, field, { max = 200, req = false } = {}) => {
  if (v == null || v === '') {
    if (req) throw new ApiError(400, 'bad_field', `${field} is needed.`);
    return null;
  }
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, 'bad_field', `${field} must be text of at most ${max} characters.`);
  if (looksSecret(v)) throw new ApiError(400, 'secret_value_refused', `${field} looks like a secret value. Never paste a secret value.`);
  if (looksBank(v, field)) throw new ApiError(400, 'bank_detail_refused', `${field} looks like a bank detail (account, card, IFSC or IBAN). Bank details are never stored here.`);
  return v.trim();
};
function currencies(v) {
  if (!Array.isArray(v) || !v.length || !v.every((c) => CURRENCIES.includes(c)) || new Set(v).size !== v.length) throw new ApiError(400, 'bad_currencies', 'currencies must be a list of INR and/or USD.');
  return [...v].sort();
}
function bag(v, field, allowed) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'bad_field', `${field} must be an object.`);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!allowed.includes(k)) throw new ApiError(400, 'bad_field', `${field} has an unknown field.`);
    out[k] = text(x, `${field}.${k}`, { max: 500 });
    if (k === 'bank_name' && out[k] != null && !/^[A-Za-z][A-Za-z .&'-]*$/.test(out[k])) throw new ApiError(400, 'bad_field', 'invoice.bank_name must be letters only.');
  }
  return out;
}
const CHECKOUT = ['frame_origin', 'brand_name', 'description'];
const INVOICE = ['issuer_legal_name', 'trade_name', 'address_lines', 'pan', 'gstin', 'state_code', 'sac_code', 'sac_text', 'bank_name', 'footer', 'number_prefix', 'receipt_text', 'refund_text'];
const checkout = (v) => {
  const o = bag(v, 'checkout', CHECKOUT);
  if (o.frame_origin && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o.frame_origin)) throw new ApiError(400, 'bad_field', 'checkout.frame_origin must be an https site address.');
  return o;
};
const validators = {
  legal_name: (v) => text(v, 'legal_name', { req: true }),
  display_name: (v) => text(v, 'display_name', { req: true }),
  gateway: (v) => {
    if (!GATEWAYS.includes(v)) throw new ApiError(400, 'bad_gateway', 'gateway is not a known payment gateway.');
    return v;
  },
  mode: (v) => {
    if (v !== 'test' && v !== 'live') throw new ApiError(400, 'bad_mode', 'mode must be test or live.');
    return v;
  },
  secret_names: names,
  currencies,
  checkout,
  invoice: (v) => bag(v, 'invoice', INVOICE),
  note: (v) => text(v, 'note', { max: 1000 }),
};

export const view = (r) =>
  r && {
    payee_id: r.payee_id, legal_name: r.legal_name, display_name: r.display_name, gateway: r.gateway, mode: r.mode,
    secret_names: parseNames(r.secret_names), status: r.status, currencies: JSON.parse(r.currencies),
    checkout: JSON.parse(r.checkout), invoice: JSON.parse(r.invoice), version: r.version,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, retired_at: r.retired_at, note: r.note,
  };

async function load(ctx, id) {
  const r = await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', id);
  if (!r) throw new ApiError(404, 'payee_not_found', 'No such payee.');
  return r;
}
// Locked once an order, a verified payment or a route points at the payee.
export const hasOrders = async (ctx, id) =>
  !!(
    (await ctx.db.first('SELECT 1 x FROM purchase_order WHERE payee_id = ? LIMIT 1', id)) ||
    (await ctx.db.first('SELECT 1 x FROM verified_payment WHERE payee_id = ? LIMIT 1', id)) ||
    (await ctx.db.first('SELECT 1 x FROM payee_route WHERE payee_id = ? OR fallback_payee_id = ? LIMIT 1', id, id))
  );

/** Which of this payee's secret NAMES exist in the platform store. Returns names and true/false only, never a value. */
export function secretPresence(ctx, names_) {
  const get = (n) => (ctx.secrets ? ctx.secrets.get(n) : ctx.env?.[n]);
  const found = {};
  for (const k of SECRET_KEYS) {
    const v = get(names_[k]);
    found[k] = typeof v === 'string' && v.length > 0;
  }
  return { ok: SECRET_KEYS.every((k) => found[k]), found, missing: SECRET_KEYS.filter((k) => !found[k]).map((k) => names_[k]) };
}

async function clash(ctx, p, exceptId) {
  const rows = await ctx.db.all("SELECT payee_id, legal_name, gateway, mode, secret_names, status FROM payee_account WHERE payee_id != ?", exceptId ?? '');
  const mine = new Set(Object.values(p.secret_names));
  for (const r of rows) {
    const theirs = parseNames(r.secret_names);
    // A secret name belongs to one payee only. The names of a retired payee stay reserved for good.
    if (Object.values(theirs).some((n) => mine.has(n))) {
      if (r.status === 'retired') throw new ApiError(409, 'payee_exists', 'A secret name was used by a retired payee. A retired payee\'s secret names can never be used again.');
      throw new ApiError(409, 'payee_exists', 'A secret name already belongs to another payee.');
    }
    if (r.status === 'retired') continue;
    const same = r.gateway === p.gateway && r.mode === p.mode;
    if (same && r.legal_name.toLowerCase() === p.legal_name.toLowerCase()) {
      throw new ApiError(409, 'payee_exists', 'A payee with the same name or key name already exists for this gateway and mode.');
    }
  }
}

export async function createPayee(ctx, input = {}) {
  await gate(ctx);
  ownerOnly(ctx);
  if (!input || typeof input !== 'object') throw new ApiError(400, 'bad_field', 'Body must be an object.');
  for (const k of Object.keys(input)) if (![...IDENTITY, ...TEXT].includes(k)) throw new ApiError(400, 'bad_field', `${k} is not a payee field.`);
  const p = {};
  for (const k of ['legal_name', 'gateway', 'mode', 'secret_names', 'currencies']) p[k] = validators[k](input[k]);
  p.display_name = validators.display_name(input.display_name ?? p.legal_name);
  p.checkout = validators.checkout(input.checkout);
  p.invoice = validators.invoice(input.invoice);
  p.note = validators.note(input.note);
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db };
    await clash(c, p);
    const id = newId('pay');
    const ts = ctx.now();
    await db.run(
      'INSERT INTO payee_account (payee_id, legal_name, display_name, gateway, mode, secret_names, status, currencies, checkout, invoice, version, created_by, created_at, updated_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, p.legal_name, p.display_name, p.gateway, p.mode, JSON.stringify(p.secret_names), 'draft', JSON.stringify(p.currencies), JSON.stringify(p.checkout), JSON.stringify(p.invoice), 1, ctx.actor || 'system', ts, ts, p.note,
    );
    const row = await load(c, id);
    await auditRow(ctx, db, 'payee.create', id, null, row);
    return view(row);
  });
}

export async function getPayee(ctx, id) {
  await gate(ctx, undefined, true);
  return view(await load(ctx, id));
}
export async function listPayees(ctx) {
  await gate(ctx, undefined, true);
  return (await ctx.db.all('SELECT * FROM payee_account ORDER BY created_at, payee_id')).map(view);
}

export async function editPayee(ctx, id, changes = {}) {
  await gate(ctx, changes && typeof changes === 'object' && Object.keys(changes).join() === 'secret_names' ? id : undefined);
  ownerOnly(ctx);
  if (!changes || typeof changes !== 'object') throw new ApiError(400, 'bad_field', 'Body must be an object.');
  for (const k of Object.keys(changes)) if (![...IDENTITY, ...TEXT].includes(k)) throw new ApiError(400, 'bad_field', `${k} is not a payee field.`);
  const keys = Object.keys(changes);
  if (!keys.length) throw new ApiError(400, 'bad_field', 'Nothing to change.');
  const clean = {};
  for (const k of keys) clean[k] = validators[k](changes[k]);
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db };
    const cur = await load(c, id);
    if (cur.status === 'retired') throw new ApiError(409, 'payee_retired', 'A retired payee cannot be changed.');
    if (clean.mode !== undefined && clean.mode !== cur.mode) throw new ApiError(409, 'mode_fixed', 'The mode is fixed at creation. Make a new payee.');
    const identityKeys = keys.filter((k) => IDENTITY.includes(k) && JSON.stringify(clean[k]) !== JSON.stringify(k === 'secret_names' ? parseNames(cur[k]) : k === 'currencies' ? JSON.parse(cur[k]) : cur[k]));
    const filling = identityKeys.join() === 'secret_names' && !Object.keys(parseNames(cur.secret_names)).length; // first fill-in is not a change of a name. Only the lock is skipped: name rules and clash still run.
    if (identityKeys.length && !filling && (await hasOrders(c, id))) throw new ApiError(409, 'identity_locked', 'This payee has had an order. Name, gateway, secret names and currencies cannot change. Make a new payee.');
    const next = { ...view(cur), ...clean };
    if (identityKeys.length) await clash(c, next, id);
    if (cur.status === 'active' && identityKeys.includes('secret_names') && !secretPresence(ctx, next.secret_names).ok) throw new ApiError(409, 'payee_secret_missing', 'A secret name is not in the platform store.');
    const changed = keys.filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(view(cur)[k]));
    if (!changed.length) return view(cur);
    const ser = (k) => (['secret_names', 'currencies', 'checkout', 'invoice'].includes(k) ? JSON.stringify(clean[k]) : clean[k]);
    await db.run(`UPDATE payee_account SET ${changed.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE payee_id = ?`, ...changed.map(ser), ctx.now(), id);
    const row = await load(c, id);
    await auditRow(ctx, db, 'payee.edit', id, cur, row);
    return view(row);
  });
}

/** One move of the state machine. Activate needs all three secret names present in the platform store. */
async function move(ctx, id, to) {
  await gate(ctx);
  ownerOnly(ctx);
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db };
    const cur = await load(c, id);
    if (!MOVES[cur.status].includes(to)) throw new ApiError(409, 'bad_transition', `A ${cur.status} payee cannot become ${to}.`);
    if (to === 'active') {
      const s = secretPresence(ctx, parseNames(cur.secret_names));
      if (!s.ok) throw new ApiError(409, 'payee_secret_missing', 'A secret name is not in the platform store.', { missing: s.missing });
      // One payee, one gateway: pause or retire the active one first.
      const taken = await db.first("SELECT 1 x FROM payee_account WHERE status = 'active' AND gateway = ? AND mode = ? AND payee_id != ? LIMIT 1", cur.gateway, cur.mode, id);
      if (taken) throw new ApiError(409, 'payee_gateway_taken', 'Another payee is active for this gateway and mode. Pause or retire it first.');
    }
    const ts = ctx.now();
    await db.run('UPDATE payee_account SET status = ?, version = version + 1, updated_at = ?, retired_at = ? WHERE payee_id = ?', to, ts, to === 'retired' ? ts : null, id);
    const row = await load(c, id);
    await auditRow(ctx, db, `payee.${to === 'active' ? (cur.status === 'paused' ? 'resume' : 'activate') : to === 'paused' ? 'pause' : 'retire'}`, id, cur, row);
    return view(row);
  });
}
export const activatePayee = (ctx, id) => move(ctx, id, 'active'); // also the resume from paused
export const pausePayee = (ctx, id) => move(ctx, id, 'paused');
export const retirePayee = (ctx, id) => move(ctx, id, 'retired');

/** Read-only check, safe to show: which names are present. Never a value. */
export async function checkPayeeSecrets(ctx, id) {
  await gate(ctx, undefined, true);
  const r = secretPresence(ctx, parseNames((await load(ctx, id)).secret_names));
  return { payee_id: id, ok: r.ok, found: r.found, missing: r.missing };
}
