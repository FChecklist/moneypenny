// Payee account registry (chunk F2). Says WHO receives the real money. A side record only:
// credits, lots, entries, holds and the ledger chain never read it.
// DARK: every call refuses with 503 payees_disabled unless the flag MNP_PAYEE_ACCOUNTS is '1'
// (env) or ctx.payees === true (tests). The flag defaults off, and nothing else calls this file yet.
// Secrets: only the NAMES of platform secrets are stored. A value is refused. Responses never carry a value.
import { ApiError, newId } from './util.js';

export const STATUSES = ['draft', 'active', 'paused', 'retired'];
export const MOVES = { draft: ['active'], active: ['paused', 'retired'], paused: ['active', 'retired'], retired: [] };
export const GATEWAYS = ['razorpay', 'stripe', 'cashfree', 'manual_bank']; // F4 replaces this list with the adapter registry
export const CURRENCIES = ['INR', 'USD'];
export const SECRET_KEYS = ['key_id', 'key_secret', 'webhook_secret'];
const IDENTITY = ['legal_name', 'gateway', 'mode', 'secret_names', 'currencies'];
const TEXT = ['display_name', 'checkout', 'invoice', 'note'];
const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

export const payeesEnabled = (ctx) => ctx.payees === true || ctx.env?.MNP_PAYEE_ACCOUNTS === '1';
const gate = (ctx) => {
  if (!payeesEnabled(ctx)) throw new ApiError(503, 'payees_disabled', 'Payee accounts are not turned on.');
};

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
const text = (v, field, { max = 200, req = false } = {}) => {
  if (v == null || v === '') {
    if (req) throw new ApiError(400, 'bad_field', `${field} is needed.`);
    return null;
  }
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, 'bad_field', `${field} must be text of at most ${max} characters.`);
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

const view = (r) =>
  r && {
    payee_id: r.payee_id, legal_name: r.legal_name, display_name: r.display_name, gateway: r.gateway, mode: r.mode,
    secret_names: JSON.parse(r.secret_names), status: r.status, currencies: JSON.parse(r.currencies),
    checkout: JSON.parse(r.checkout), invoice: JSON.parse(r.invoice), version: r.version,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, retired_at: r.retired_at, note: r.note,
  };

async function load(ctx, id) {
  const r = await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', id);
  if (!r) throw new ApiError(404, 'payee_not_found', 'No such payee.');
  return r;
}
export const hasOrders = async (ctx, id) => !!(await ctx.db.first('SELECT 1 x FROM purchase_order WHERE payee_id = ? LIMIT 1', id));

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
  const rows = await ctx.db.all("SELECT payee_id, legal_name, gateway, mode, secret_names, status FROM payee_account WHERE payee_id != ? AND status != 'retired'", exceptId ?? '');
  for (const r of rows) {
    const same = r.gateway === p.gateway && r.mode === p.mode;
    if (same && (r.legal_name.toLowerCase() === p.legal_name.toLowerCase() || JSON.parse(r.secret_names).key_id === p.secret_names.key_id)) {
      throw new ApiError(409, 'payee_exists', 'A payee with the same name or key name already exists for this gateway and mode.');
    }
  }
}

export async function createPayee(ctx, input = {}) {
  gate(ctx);
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
    return view(await load(c, id));
  });
}

export async function getPayee(ctx, id) {
  gate(ctx);
  return view(await load(ctx, id));
}
export async function listPayees(ctx) {
  gate(ctx);
  return (await ctx.db.all('SELECT * FROM payee_account ORDER BY created_at, payee_id')).map(view);
}

export async function editPayee(ctx, id, changes = {}) {
  gate(ctx);
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
    const identityKeys = keys.filter((k) => IDENTITY.includes(k) && JSON.stringify(clean[k]) !== JSON.stringify(k === 'secret_names' || k === 'currencies' ? JSON.parse(cur[k]) : cur[k]));
    if (identityKeys.length && (await hasOrders(c, id))) throw new ApiError(409, 'identity_locked', 'This payee has had an order. Name, gateway, secret names and currencies cannot change. Make a new payee.');
    const next = { ...view(cur), ...clean };
    if (identityKeys.length) await clash(c, next, id);
    if (cur.status === 'active' && identityKeys.includes('secret_names') && !secretPresence(ctx, next.secret_names).ok) throw new ApiError(409, 'payee_secret_missing', 'A secret name is not in the platform store.');
    const changed = keys.filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(view(cur)[k]));
    if (!changed.length) return view(cur);
    const ser = (k) => (['secret_names', 'currencies', 'checkout', 'invoice'].includes(k) ? JSON.stringify(clean[k]) : clean[k]);
    await db.run(`UPDATE payee_account SET ${changed.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE payee_id = ?`, ...changed.map(ser), ctx.now(), id);
    return view(await load(c, id));
  });
}

/** One move of the state machine. Activate needs all three secret names present in the platform store. */
async function move(ctx, id, to) {
  gate(ctx);
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db };
    const cur = await load(c, id);
    if (!MOVES[cur.status].includes(to)) throw new ApiError(409, 'bad_transition', `A ${cur.status} payee cannot become ${to}.`);
    if (to === 'active') {
      const s = secretPresence(ctx, JSON.parse(cur.secret_names));
      if (!s.ok) throw new ApiError(409, 'payee_secret_missing', 'A secret name is not in the platform store.', { missing: s.missing });
    }
    const ts = ctx.now();
    await db.run('UPDATE payee_account SET status = ?, version = version + 1, updated_at = ?, retired_at = ? WHERE payee_id = ?', to, ts, to === 'retired' ? ts : null, id);
    return view(await load(c, id));
  });
}
export const activatePayee = (ctx, id) => move(ctx, id, 'active'); // also the resume from paused
export const pausePayee = (ctx, id) => move(ctx, id, 'paused');
export const retirePayee = (ctx, id) => move(ctx, id, 'retired');

/** Read-only check, safe to show: which names are present. Never a value. */
export async function checkPayeeSecrets(ctx, id) {
  gate(ctx);
  const r = secretPresence(ctx, JSON.parse((await load(ctx, id)).secret_names));
  return { payee_id: id, ok: r.ok, found: r.found, missing: r.missing };
}
