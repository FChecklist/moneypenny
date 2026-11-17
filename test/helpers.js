import { doDb } from '../src/do.js';
import { fakeStorage } from './do-storage.js';
import { randomBytes } from 'node:crypto';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/api.js';
import { seedDemo } from '../src/seed.js';
import { createTenant } from '../src/admin.js';
import { keySecret, signString } from '../src/auth.js';
import { hmacHex, sha256Hex, DAY, MIN, HOUR } from '../src/util.js';

export { DAY, MIN, HOUR };
export const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

/** Fresh in-memory app with a controllable clock and the 'demo' tenant. */
export async function setup({ other = false, requireRate = false } = {}) {
  const db = process.env.MNP_DB === 'do' ? doDb(fakeStorage()) : openDb(); // MNP_DB=do runs the whole suite on the Durable Object adapter
  migrate(db);
  const clock = { t: T0 };
  const now = () => clock.t;
  const master = randomBytes(24).toString('hex'); // random per run: no secret in code
  const app = createApp({ db, master, now, aiWithoutStatus: true, requireRate });
  const demo = await db.tx((t) => seedDemo({ db: t, now, master }));
  let b = null;
  if (other) b = await db.tx((t) => createTenant({ db: t, now, master }, { id: 'tenb', name: 'Other' }));
  const mkT = (t) => {
    const c = makeClient(app, clock, t.api);
    c.pay = makeClient(app, clock, t.purchase);
    c.read = makeClient(app, clock, t.read);
    c.admin = makeClient(app, clock, t.admin);
    c.ai = makeClient(app, clock, t.ai_read);
    return c;
  };
  const mk = (keys) => makeClient(app, clock, keys);
  const api = mkT(demo);
  return { db, app, clock, master, now, demo, other: b, api, admin: api.admin, pay: api.pay, read: api.read, ai: api.ai, mk, mkT, ctx: (tenantId = 'demo') => ({ db, now, master, tenantId, actor: 'test', _settings: null }) };
}

let n = 0;
export function makeClient(app, clock, keys) {
  async function raw(method, path, body, { idem, headers = {}, ts, nonce, sign = true } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const t = String(ts ?? clock.t);
    const nn = nonce ?? `n${++n}-${Math.random()}`;
    const idemVal = method === 'GET' || idem === null ? undefined : idem ?? `k${++n}-${Math.random()}`;
    const sig = await hmacHex(await keySecret(app.master, keys.key_id), signString(t, nn, method, path, await sha256Hex(text), (headers['idempotency-key'] ?? idemVal) ?? ''));
    const h = { 'x-mnp-key': keys.key_id, 'x-mnp-timestamp': t, 'x-mnp-nonce': nn, 'x-mnp-signature': sign ? sig : 'bad', ...headers };
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      if (idemVal !== undefined) h['idempotency-key'] = idemVal;
    }
    const res = await app.fetch(new Request(`http://t.local${path}`, { method, headers: h, body: method === 'GET' ? undefined : text }));
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return { raw, get: (p, o) => raw('GET', p, undefined, o), post: (p, b, o) => raw('POST', p, b, o), put: (p, b, o) => raw('PUT', p, b, o), del: (p, o) => raw('DELETE', p, {}, o) };
}

export const bal = async (api, email, details = true) => (await api.get(`/v1/balance?email=${encodeURIComponent(email)}${details ? '&details=1' : ''}`)).body;

/** Buy credits (real payment) for an account. */
export const buy = (api, email, credits, ref, extra = {}) =>
  (api.pay || api).post('/v1/credit_purchase', { email, amount: credits, paid_minor: credits, currency: 'USD', payment_ref: ref, ...extra });

let ek = 0;
/** A real payment is noted first (by the payment side), as in life. Pass noNotice: true to skip it. */
export const note = (api, payment_ref, paid_minor, currency = 'USD', payer_email = undefined) =>
  (api.pay || api).post('/v1/payment_notice', { payment_ref, paid_minor, currency, payer_email: payer_email ?? 'a@x.com' });

export const event = async (api, email, type, extra = {}) => {
  const { noNotice, ...rest } = extra;
  if (rest.cash_minor !== undefined && rest.sale_ref === undefined) rest.sale_ref = `sale-${++ek}-${Math.random().toString(36).slice(2)}`;
  if (rest.cash_minor !== undefined && !noNotice && typeof rest.sale_ref === 'string' && Number.isInteger(rest.cash_minor) && rest.cash_minor > 0) await note(api, rest.sale_ref, rest.cash_minor, rest.currency ?? 'USD', rest.payer_email);
  return api.post('/v1/event', { email, event_type: type, event_key: `ev-${++ek}-${Math.random()}`, ...rest });
};