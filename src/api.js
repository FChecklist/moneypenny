// The whole HTTP surface. Standard Request/Response so it runs in a Worker, Node or tests alike.
import { ApiError, sha256Hex } from './util.js';
import { authenticate } from './auth.js';
import { getSettings } from './settings.js';
import { getBalance, creditPurchase, creditManualBonus, processEvent, history } from './wallet.js';
import { reserve, capture, release, refund, sweepHolds } from './spend.js';
import { convertRequest, conversionAction, listConversions } from './convert.js';
import * as admin from './admin.js';
import { adminPage } from './admin-page.js';
import { stubRail } from './rail.js';

const MAX_BODY = 65536;

// [method, path, allowed key types, needs Idempotency-Key, handler]
//  api      = a product's server (spend, events, hand-given bonus, order returns)
//  read     = balance only
//  purchase = the payment system (credit bought, money refunds, chargebacks)
//  admin    = tenant admin
const ROUTES = [
  ['GET', '/v1/balance', ['api', 'read'], false, (c, b, q) => getBalance(c, q.get('email'), { details: q.get('details') === '1' && c.scope === 'api' })],
  ['POST', '/v1/credit_purchase', ['purchase'], true, (c, b) => creditPurchase(c, b)],
  ['POST', '/v1/credit', ['api'], true, (c, b) => creditBonus(c, b)],
  ['POST', '/v1/event', ['api'], true, (c, b) => processEvent(c, b)],
  ['POST', '/v1/spend/reserve', ['api'], true, async (c, b) => { await sweepHolds(c); return reserve(c, b); }],
  ['POST', '/v1/spend/capture', ['api'], true, (c, b) => capture(c, b)],
  ['POST', '/v1/spend/release', ['api'], true, (c, b) => release(c, b)],
  ['POST', '/v1/refund', ['api', 'purchase'], true, (c, b) => refund(c, b, c.scope)],
  ['GET', '/v1/history', ['api'], false, (c, b, q) => history(c, q.get('email'), { limit: intParam(q, 'limit', 50), beforeSeq: q.has('before_seq') ? intParam(q, 'before_seq', 0) : null })],
  ['POST', '/v1/convert_request', ['api'], true, (c, b) => convertRequest(c, b)],
  ['GET', '/v1/admin/settings', ['admin'], false, (c) => getSettings(c).then((s) => ({ settings: s }))],
  ['PUT', '/v1/admin/settings', ['admin'], true, (c, b) => admin.setSettings(c, b).then((s) => ({ settings: s }))],
  ['GET', '/v1/admin/rules', ['admin'], false, (c) => admin.listRules(c)],
  ['POST', '/v1/admin/rules', ['admin'], true, (c, b) => admin.createRule(c, b)],
  ['GET', '/v1/admin/audit', ['admin'], false, (c, b, q) => admin.auditList(c, intParam(q, 'limit', 100))],
  ['GET', '/v1/admin/health', ['admin'], false, (c) => admin.health(c)],
  ['GET', '/v1/admin/reconcile', ['admin'], false, (c) => admin.reconcile(c)],
  ['GET', '/v1/admin/conversions', ['admin'], false, (c, b, q) => listConversions(c, q.get('status'))],
  ['POST', '/v1/admin/sweep', ['admin'], true, (c) => admin.sweep(c)],
  ['POST', '/v1/admin/freeze', ['admin'], true, (c, b) => admin.freeze(c, b)],
  ['POST', '/v1/admin/webhooks', ['admin'], true, (c, b) => admin.addWebhook(c, b)],
];

function intParam(q, name, def) {
  const raw = q.get(name);
  if (raw == null) return def;
  if (!/^\d{1,15}$/.test(raw)) throw new ApiError(400, 'bad_request', `${name} must be a whole number`);
  return Number(raw);
}

// Bonus by hand only. Bought credit comes only through /v1/credit_purchase (the payment system's key).
async function creditBonus(c, b) {
  if (b.bucket !== 'bonus') throw new ApiError(400, 'bad_request', "bucket must be 'bonus'. Bought credit arrives through credit_purchase; commission through earning events.");
  return creditManualBonus(c, b);
}

const json = (status, obj, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

export function createApp({ db, master, now = Date.now, rail = stubRail }) {
  if (!master || master.length < 16) throw new Error('MNP_MASTER_SECRET is required (16+ characters).');

  async function fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/admin') {
        return new Response(adminPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' } });
      }
      const raw = await request.text();
      if (raw.length > MAX_BODY) throw new ApiError(413, 'too_large', 'Request is too large.');
      const method = request.method.toUpperCase();
      const pathQuery = url.pathname + url.search;

      let route = ROUTES.find((r) => r[0] === method && r[1] === url.pathname);
      let m;
      if (!route && (m = url.pathname.match(/^\/v1\/admin\/rules\/([A-Za-z0-9_]+)$/)) && (method === 'PUT' || method === 'DELETE')) {
        route = [method, url.pathname, ['admin'], true, (c, b) => (method === 'PUT' ? admin.updateRule(c, m[1], b) : admin.disableRule(c, m[1]))];
      }
      if (!route && (m = url.pathname.match(/^\/v1\/admin\/conversions\/([A-Za-z0-9_]+)\/(approve|instruct|mark_paid|reject)$/)) && method === 'POST') {
        route = [method, url.pathname, ['admin'], true, (c, b) => conversionAction(c, m[1], m[2], b)];
      }

      // 1) who is calling (own transaction so nonce and rate counters survive a later failure)
      const auth = await db.tx((t) =>
        authenticate({ db: t, now, master }, request.headers, method, pathQuery, raw, async (tenantId) => (await getSettings({ db: t, tenantId, now })).api_rate_per_minute),
      );
      if (auth.limited) throw new ApiError(429, 'rate_limited', 'Too many requests. Slow down a little.');
      if (!route) throw new ApiError(404, 'not_found', 'No such route.');
      if (!route[2].includes(auth.scope)) throw new ApiError(403, 'wrong_key_type', 'This key cannot use this route.');

      let body = {};
      if (method !== 'GET') {
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new ApiError(400, 'bad_json', 'Body must be JSON.');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'bad_json', 'Body must be a JSON object.');
      }
      let idem = request.headers.get('idempotency-key');
      // credit bought: the real payment id IS the idempotency key unless the caller sends its own
      if (!idem && route[1] === '/v1/credit_purchase' && typeof body.payment_ref === 'string') idem = `pay:${body.payment_ref}`;
      if (route[3] && (!idem || idem.length > 120)) throw new ApiError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (up to 120 characters).');

      // 2) the work, all or nothing
      const out = await db.tx(async (t) => {
        const ctx = { db: t, tenantId: auth.tenantId, now, master, rail: app.rail, scope: auth.scope, actor: auth.keyId, idem: idem || null, _settings: null };
        let reqHash = null;
        if (route[3]) {
          reqHash = await sha256Hex(`${method}\n${pathQuery}\n${raw}`);
          const prior = await t.first('SELECT * FROM idempotency WHERE tenant_id = ? AND key = ?', ctx.tenantId, idem);
          if (prior) {
            if (prior.req_hash !== reqHash) throw new ApiError(409, 'idempotency_conflict', 'This key was used for a different request.');
            return { status: prior.status, text: prior.response, replay: true };
          }
        }
        const result = await route[4](ctx, body, url.searchParams);
        const text = JSON.stringify({ ok: true, ...result });
        if (route[3]) await t.run('INSERT INTO idempotency (tenant_id, key, req_hash, status, response, created_at) VALUES (?,?,?,?,?,?)', ctx.tenantId, idem, reqHash, 200, text, now());
        return { status: 200, text, replay: false };
      });
      return new Response(out.text, { status: out.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(out.replay ? { 'idempotent-replay': 'true' } : {}) } });
    } catch (e) {
      if (e instanceof ApiError) return json(e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } });
      console.error('internal error', e && e.message);
      return json(500, { ok: false, error: { code: 'internal', message: 'Something went wrong on our side. Nothing was changed.' } });
    }
  }

  const app = { fetch, db, master, now, rail };
  return app;
}
