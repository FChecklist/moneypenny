// F8 (payee health) and F9 (owner console screen). Dark behind the payee flag. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/api.js';
import { payeeHealth } from '../src/payee-health.js';
import { ownerPage } from '../src/owner-page.js';
import { hmacHex } from '../src/util.js';

const nm = { key_id: 'MNP_H_KEY_ID', key_secret: 'MNP_H_KEY_SECRET', webhook_secret: 'MNP_H_WEBHOOK_SECRET' };
const VALUE = 'value-H-secret-0123456789abcdefXYZ';
const env = { MNP_PAYEE_ACCOUNTS: '1', MNP_H_KEY_ID: VALUE + 'a', MNP_H_KEY_SECRET: VALUE + 'b' }; // webhook secret left missing
const A = 'pay_legacy_itservices';
const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

async function world(flagEnv = env) {
  const s = await setup();
  await s.db.run('UPDATE payee_account SET secret_names = ? WHERE payee_id = ?', JSON.stringify(nm), A);
  const app = createApp({ db: s.db, master: s.master, now: s.now, env: flagEnv, aiWithoutStatus: true });
  const owner = { ...s.ctx(), payees: true, env: flagEnv, actor: 'owner', callerType: 'owner' };
  return { s, app, owner };
}
let nn = 0;
async function oc(w, path) {
  const t = w.s.now(), nonce = `h${++nn}`;
  const sig = await hmacHex(w.s.master, `mnp-owner\n${t}\n${nonce}\nGET\n${path}\n`);
  const r = await w.app.fetch(new Request(`http://t.local${path}`, { headers: { 'x-owner-ts': String(t), 'x-owner-nonce': nonce, 'x-owner-sig': sig } }));
  return { status: r.status, body: await r.json() };
}

test('F8: health shows names and present flags, counts, and never a secret value', async () => {
  const w = await world();
  const ev = (id, outcome, at) => w.s.db.run('INSERT INTO payee_event (payee_id, event_id, type, order_id, outcome, received_at) VALUES (?,?,?,?,?,?)', A, id, 't', null, outcome, at);
  await ev('e1', 'ignored', 1000); await ev('e2', 'applied', 5000); await ev('e3', 'ignored', 3000);
  const h = await payeeHealth(w.owner, A);
  assert.equal(h.gateway, 'razorpay');
  assert.equal(h.secrets.key_id.present, true);
  assert.equal(h.secrets.webhook_secret.present, false);
  assert.equal(h.secrets.webhook_secret.name, 'MNP_H_WEBHOOK_SECRET');
  assert.equal(h.secrets_ok, false);
  assert.equal(h.last_webhook_at, 5000);
  assert.equal(h.ignored_events, 2);
  assert.equal(h.pending_rail_orders, 0);
  assert.ok(!JSON.stringify(h).includes('value-H-secret'));
});

test('F8: counts orders in pending_rail for this payee only, and writes no audit row', async () => {
  const w = await world();
  const before = (await w.s.db.first('SELECT COUNT(*) n FROM payee_audit')).n;
  const h0 = await payeeHealth(w.owner, A);
  assert.equal(h0.last_webhook_at, null);
  assert.equal((await w.s.db.first('SELECT COUNT(*) n FROM payee_audit')).n, before);
  const { buyCredits } = await import('../src/gate.js');
  const { stubRail } = await import('../src/rail.js');
  const { setRoute } = await import('../src/routes.js');
  await setRoute(w.owner, { tenant_id: 'demo', product_id: '*', payee_id: A, effective_from: 0, reason: 'default route for tests' });
  const buy = (ref) => buyCredits({ ...w.owner, rail: stubRail }, { email: 'h@example.com', credits: 500, order_ref: ref, currency: 'USD' });
  const o1 = await buy('o1'), o2 = await buy('o2'), o3 = await buy('o3'), o4 = await buy('o4');
  const set = (id, st) => w.s.db.run('UPDATE purchase_order SET status = ?, created_at = 777, updated_at = 777 WHERE id = ?', st, id);
  await set(o1.order_id, 'pending_rail'); await set(o2.order_id, 'paid'); await set(o3.order_id, 'paid'); await set(o4.order_id, 'awaiting_payment');
  const h = await payeeHealth(w.owner, A);
  assert.equal(h.pending_rail_orders, 1);
  assert.equal(h.oldest_pending_rail_at, 777);
});

test('F8: owner only, unknown payee refused, flag off refused, read works while setup is incomplete', async () => {
  const w = await world();
  assert.equal(await code(payeeHealth({ ...w.owner, callerType: 'product' }, A)), 'payee_forbidden');
  assert.equal(await code(payeeHealth(w.owner, 'pay_nope')), 'payee_not_found');
  assert.equal(await code(payeeHealth({ ...w.owner, payees: false, env: {} }, A)), 'payees_disabled');
  await w.s.db.run("UPDATE payee_account SET secret_names = '{}' WHERE payee_id = ?", A); // active payee with no names: changes are blocked, reads are not
  const h = await payeeHealth(w.owner, A);
  assert.equal(h.secrets_ok, false);
  assert.equal(h.secrets.key_id.name, null);
});

test('F8: HTTP route is signed owner only', async () => {
  const w = await world();
  const r = await oc(w, `/v1/owner/payees/${A}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.body.health.payee_id, A);
  const bad = await w.app.fetch(new Request(`http://t.local/v1/owner/payees/${A}/health`));
  assert.equal(bad.status, 403);
});

test('F9: screen is dark when the flag is off and served when on', async () => {
  const off = await world({});
  assert.equal((await off.app.fetch(new Request('http://t.local/owner'))).status, 404);
  const on = await world();
  const r = await on.app.fetch(new Request('http://t.local/owner'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('F9: screen text follows the owner rules and calls the F6 routes', () => {
  const html = ownerPage();
  const visible = html.replace(/<script[\s\S]*<\/script>/, '').replace(/<style[\s\S]*<\/style>/, '');
  assert.doesNotMatch(visible, /\b(my|mine|your|yours|host|nickname)\b/i);
  assert.doesNotMatch(html, /type="checkbox"/);
  for (const part of ['/v1/owner/payees', '/health', '/v1/owner/routes', 'activate', 'pause', 'retire', 'display_name']) assert.ok(html.includes(part), part);
  assert.ok(!html.includes('Razorpay') && !html.includes('IT Services')); // payee name comes from the record
  assert.ok(html.includes("esc(p.display_name)"));
  assert.match(html, /SECRETISH/); // a secret-looking value is refused in the page before any call
});
