import { randomBytes } from 'node:crypto';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/api.js';
import { seedDemo } from '../src/seed.js';
import { createTenant } from '../src/admin.js';
import { keySecret, signString } from '../src/auth.js';
import { hmacHex, sha256Hex, DAY, MIN } from '../src/util.js';

export { DAY, MIN };
export const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

/** Fresh in-memory app with a controllable clock and the 'demo' tenant. */
export async function setup({ other = false } = {}) {
  const db = openDb();
  migrate(db);
  const clock = { t: T0 };
  const now = () => clock.t;
  const master = randomBytes(24).toString('hex'); // random per run: no secret in code
  const app = createApp({ db, master, now });
  const demo = await db.tx((t) => seedDemo({ db: t, now, master }));
  let b = null;
  if (other) b = await db.tx((t) => createTenant({ db: t, now, master }, { id: 'tenb', name: 'Other' }));
  const mk = (keys) => makeClient(app, clock, keys);
  return { db, app, clock, master, now, demo, other: b, api: mk(demo.api), admin: mk(demo.admin), mk, ctx: (tenantId = 'demo') => ({ db, now, master, tenantId, actor: 'test', _settings: null }) };
}

let n = 0;
export function makeClient(app, clock, keys) {
  async function raw(method, path, body, { idem, headers = {}, ts, nonce, sign = true } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const t = String(ts ?? clock.t);
    const nn = nonce ?? `n${++n}-${Math.random()}`;
    const sig = await hmacHex(await keySecret(app.master, keys.key_id), signString(t, nn, method, path, await sha256Hex(text)));
    const h = { 'x-mnp-key': keys.key_id, 'x-mnp-timestamp': t, 'x-mnp-nonce': nn, 'x-mnp-signature': sign ? sig : 'bad', ...headers };
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      if (idem !== null) h['idempotency-key'] = idem ?? `k${++n}-${Math.random()}`;
    }
    const res = await app.fetch(new Request(`http://t.local${path}`, { method, headers: h, body: method === 'GET' ? undefined : text }));
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return { raw, get: (p, o) => raw('GET', p, undefined, o), post: (p, b, o) => raw('POST', p, b, o), put: (p, b, o) => raw('PUT', p, b, o), del: (p, o) => raw('DELETE', p, {}, o) };
}

export const bal = async (api, email, details = true) => (await api.get(`/v1/balance?email=${encodeURIComponent(email)}${details ? '&details=1' : ''}`)).body;

/** Buy credits (real payment) for an account. */
export const buy = (api, email, credits, ref, extra = {}) =>
  api.post('/v1/credit', { email, bucket: 'bought', amount: credits, paid_minor: credits, currency: 'USD', payment_ref: ref, ...extra });

let ek = 0;
export const event = (api, email, type, extra = {}) => api.post('/v1/event', { email, event_type: type, event_key: `ev-${++ek}-${Math.random()}`, ...extra });
