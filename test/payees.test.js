// F1 (migration 0005 and back-fill) and F2 (payee registry). The registry is dark: it needs the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { openDb, migrate, readMigrationFiles } from '../src/db.js';
import { doDb } from '../src/do.js';
import { fakeStorage } from './do-storage.js';
import { MIGRATIONS } from '../src/migrations.gen.js';
import * as P from '../src/payees.js';

const mkDb = () => (process.env.MNP_DB === 'do' ? doDb(fakeStorage()) : openDb());
const old = () => readMigrationFiles().filter(([f]) => f < '0005');
const NAMES = { key_id: 'MNP_PAYEE_B_KEY_ID', key_secret: 'MNP_PAYEE_B_KEY_SECRET', webhook_secret: 'MNP_PAYEE_B_WEBHOOK_SECRET' };
const VALUES = { MNP_PAYEE_B_KEY_ID: 'rzp_' + 'test_AbCdEfGhIjKlMnOp', MNP_PAYEE_B_KEY_SECRET: 'sEcReT-value-1234567890', MNP_PAYEE_B_WEBHOOK_SECRET: 'whsec-value-0987654321' };
const input = (o = {}) => ({ legal_name: 'Payee B Legal', gateway: 'razorpay', mode: 'test', secret_names: NAMES, currencies: ['INR'], ...o });
const reg = async (extra = {}) => {
  const s = await setup();
  return { s, ctx: { ...s.ctx(), payees: true, actor: 'owner', env: { ...VALUES }, ...extra } };
};
const code = (p) => assert.rejects(p, (e) => (code.last = e.code) && true).then(() => code.last);
const addOrder = async (s, payeeId) => {
  await s.db.run("INSERT INTO account (id, tenant_id, email_norm, email_canon, created_at) VALUES ('ac1','demo','a@x.com','a@x.com',1)");
  await s.db.run("INSERT INTO purchase_order (id, tenant_id, account_id, order_ref, credits, currency, amount_minor, lock_until, rate_cpu, rate_inr, status, created_at, updated_at, payee_id) VALUES ('o1','demo','ac1','r1',100,'USD',100,1,1,1,'awaiting_payment',1,1,?)", payeeId);
};

test('F1-a: fresh migration makes the tables, columns and the legacy payee', async () => {
  const db = mkDb();
  migrate(db, MIGRATIONS);
  for (const t of ['payee_account', 'payee_route', 'payee_change', 'payee_audit', 'payee_event', 'reconcile_run']) assert.ok(await db.first("SELECT 1 x FROM sqlite_master WHERE name = ?", t), t);
  const cols = async (t) => (await db.all(`PRAGMA table_info(${t})`)).map((c) => c.name);
  for (const c of ['product', 'payee_id', 'route_id', 'payee_version', 'mode', 'payee_snapshot']) assert.ok((await cols('purchase_order')).includes(c), c);
  assert.ok((await cols('verified_payment')).includes('payee_id'));
  const p = await db.first("SELECT * FROM payee_account WHERE payee_id = 'pay_legacy_itservices'");
  assert.equal(p.status, 'active');
  assert.equal(p.secret_names, '{}');
});

test('F1-b: upgrade back-fills every old order, payment and tenant', async () => {
  const db = mkDb();
  migrate(db, old());
  await db.run("INSERT INTO tenant (id, name, created_at) VALUES ('t1','One',1), ('t2','Two',1)");
  await db.run("INSERT INTO account (id, tenant_id, email_norm, email_canon, created_at) VALUES ('a1','t1','a@x.com','a@x.com',1)");
  for (const n of [1, 2]) await db.run("INSERT INTO purchase_order (id, tenant_id, account_id, order_ref, credits, currency, amount_minor, lock_until, rate_cpu, rate_inr, status, created_at, updated_at) VALUES (?,?,?,?,100,'USD',100,1,1,1,'paid',1,1)", `o${n}`, 't1', 'a1', `r${n}`);
  await db.run("INSERT INTO verified_payment (tenant_id, ref, paid_minor, currency, created_at) VALUES ('t1','p1',100,'USD',1)");
  migrate(db, MIGRATIONS);
  assert.equal((await db.first("SELECT COUNT(*) n FROM purchase_order WHERE payee_id = 'pay_legacy_itservices' AND payee_version = 1")).n, 2);
  assert.equal((await db.first("SELECT COUNT(*) n FROM purchase_order WHERE payee_id IS NULL")).n, 0);
  assert.equal((await db.first("SELECT payee_id FROM verified_payment")).payee_id, 'pay_legacy_itservices');
  const routes = (await db.all("SELECT tenant_id, product_id, payee_id FROM payee_route ORDER BY tenant_id")).map((r) => ({ ...r }));
  assert.deepEqual(routes, [{ tenant_id: 't1', product_id: '*', payee_id: 'pay_legacy_itservices' }, { tenant_id: 't2', product_id: '*', payee_id: 'pay_legacy_itservices' }]);
  migrate(db, MIGRATIONS); // second run changes nothing
  assert.equal((await db.first('SELECT COUNT(*) n FROM payee_route')).n, 2);
});

test('F1-c: lot and entry table definitions are byte-identical to before 0005', async () => {
  const a = mkDb();
  migrate(a, old());
  const b = mkDb();
  migrate(b, MIGRATIONS);
  for (const t of ['lot', 'entry']) {
    const q = "SELECT sql FROM sqlite_master WHERE name = ?";
    assert.equal((await b.first(q, t)).sql, (await a.first(q, t)).sql);
  }
});

test('F2-a: the registry is dark without the flag', async () => {
  const s = await setup();
  assert.equal(await code(P.createPayee({ ...s.ctx(), actor: 'o' }, input())), 'payees_disabled');
  assert.equal(await code(P.listPayees(s.ctx())), 'payees_disabled');
  const on = { ...s.ctx(), env: { MNP_PAYEE_ACCOUNTS: '1' } };
  assert.equal(P.payeesEnabled(on), true);
  assert.equal(P.payeesEnabled({ env: { MNP_PAYEE_ACCOUNTS: '0' } }), false);
});

test('F2-b: create starts as draft, valid and invalid input', async () => {
  const { ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  assert.match(p.payee_id, /^pay_/);
  assert.equal(p.status, 'draft');
  assert.equal(p.version, 1);
  assert.equal(p.display_name, 'Payee B Legal');
  for (const bad of [{ gateway: 'nope' }, { mode: 'x' }, { currencies: ['EUR'] }, { currencies: [] }, { legal_name: '' }, { secret_names: { key_id: 'A_B_C' } }, { checkout: { frame_origin: 'http://x.com' } }, { invoice: { evil: 'x' } }]) {
    await assert.rejects(P.createPayee(ctx, input({ ...bad, legal_name: bad.legal_name ?? 'Other' })), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal(await code(P.createPayee(ctx, { ...input(), stray: 1 })), 'bad_field');
});

test('F2-c: payee_exists for the same name or key name, same gateway and mode', async () => {
  const { ctx } = await reg();
  await P.createPayee(ctx, input());
  assert.equal(await code(P.createPayee(ctx, input({ legal_name: 'payee b legal' }))), 'payee_exists');
  assert.equal(await code(P.createPayee(ctx, input({ legal_name: 'Different' }))), 'payee_exists'); // same key_id name
  await P.createPayee(ctx, input({ mode: 'live' })); // other mode is a different payee
});

test('F2-d: valid and invalid state moves', async () => {
  const { ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  assert.equal(await code(P.pausePayee(ctx, p.payee_id)), 'bad_transition'); // draft to paused
  assert.equal(await code(P.retirePayee(ctx, p.payee_id)), 'bad_transition'); // draft to retired
  assert.equal((await P.activatePayee(ctx, p.payee_id)).status, 'active');
  assert.equal(await code(P.activatePayee(ctx, p.payee_id)), 'bad_transition');
  assert.equal((await P.pausePayee(ctx, p.payee_id)).status, 'paused');
  assert.equal((await P.activatePayee(ctx, p.payee_id)).status, 'active'); // resume
  await P.pausePayee(ctx, p.payee_id);
  const r = await P.retirePayee(ctx, p.payee_id);
  assert.equal(r.status, 'retired');
  assert.ok(r.retired_at);
  assert.equal(r.secret_names.key_secret, NAMES.key_secret); // retired keeps its names
  for (const f of [P.activatePayee, P.pausePayee, P.retirePayee]) assert.equal(await code(f(ctx, p.payee_id)), 'bad_transition');
  assert.equal(await code(P.editPayee(ctx, p.payee_id, { note: 'x' })), 'payee_retired');
  assert.equal(await code(P.getPayee(ctx, 'pay_none')), 'payee_not_found');
});

test('F2-e: activate needs all three secret names in the store', async () => {
  const { ctx } = await reg({ env: { MNP_PAYEE_B_KEY_ID: 'x', MNP_PAYEE_B_KEY_SECRET: 'y' } });
  const p = await P.createPayee(ctx, input());
  const e = await P.activatePayee(ctx, p.payee_id).catch((x) => x);
  assert.equal(e.code, 'payee_secret_missing');
  assert.deepEqual(e.extra.missing, [NAMES.webhook_secret]);
  assert.equal((await P.getPayee(ctx, p.payee_id)).status, 'draft');
  const chk = await P.checkPayeeSecrets(ctx, p.payee_id);
  assert.deepEqual(chk.found, { key_id: true, key_secret: true, webhook_secret: false });
});

test('F2-f: identity is locked after the first order; text still changes and bumps the version', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  const t = await P.editPayee(ctx, p.payee_id, { display_name: 'Shown Name', checkout: { brand_name: 'Brand' } });
  assert.equal(t.version, 2);
  assert.equal((await P.editPayee(ctx, p.payee_id, { display_name: 'Shown Name' })).version, 2); // no change, no bump
  assert.equal((await P.editPayee(ctx, p.payee_id, { legal_name: 'New Legal', currencies: ['INR', 'USD'] })).version, 3); // still free before any order
  assert.equal(await code(P.editPayee(ctx, p.payee_id, { mode: 'live' })), 'mode_fixed'); // never, even with no order
  await addOrder(s, p.payee_id);
  for (const ch of [{ legal_name: 'Other' }, { gateway: 'stripe' }, { currencies: ['USD'] }, { secret_names: { ...NAMES, key_id: 'MNP_OTHER_ID' } }]) {
    assert.equal(await code(P.editPayee(ctx, p.payee_id, ch)), 'identity_locked', JSON.stringify(ch));
  }
  const ok = await P.editPayee(ctx, p.payee_id, { invoice: { footer: 'Thanks' }, legal_name: 'New Legal' }); // same value is not a change
  assert.equal(ok.invoice.footer, 'Thanks');
  assert.equal(ok.version, 4);
});

test('F2-g: a pasted secret value is refused and never echoed or stored', async () => {
  const { s, ctx } = await reg();
  const pasted = ['rzp_' + 'live_AbCdEfGhIjKlMnOpQrSt', 'rzp_' + 'test_AbCdEfGhIjKlMnOp', 'a'.repeat(20) + 'b'.repeat(20), 'ABCDEF01234567'.repeat(2) + 'ABCDEF0123', 'sEcReT-value-1234567890', 'lower_case_name'];
  for (const v of pasted) {
    for (const k of P.SECRET_KEYS) {
      const e = await P.createPayee(ctx, input({ secret_names: { ...NAMES, [k]: v } })).catch((x) => x);
      assert.equal(e.code, 'secret_value_refused', v);
      assert.ok(!JSON.stringify([e.message, e.extra]).includes(v));
    }
  }
  const p = await P.createPayee(ctx, input());
  assert.equal(await code(P.editPayee(ctx, p.payee_id, { secret_names: { ...NAMES, key_secret: pasted[0] } })), 'secret_value_refused');
  assert.equal(await code(P.createPayee(ctx, input({ legal_name: 'Dup names', secret_names: { key_id: 'SAME_ONE', key_secret: 'SAME_ONE', webhook_secret: 'OTHER_ONE' } }))), 'bad_secret_names');
  assert.equal((await s.db.first("SELECT COUNT(*) n FROM payee_account WHERE payee_id != 'pay_legacy_itservices'")).n, 1);
});

test('F2-h: no response, error or stored row carries a secret value', async () => {
  const { s, ctx } = await reg();
  const seen = [];
  const p = await P.createPayee(ctx, input());
  seen.push(p, await P.editPayee(ctx, p.payee_id, { note: 'n' }), await P.checkPayeeSecrets(ctx, p.payee_id), await P.activatePayee(ctx, p.payee_id), await P.getPayee(ctx, p.payee_id), await P.listPayees(ctx), await P.pausePayee(ctx, p.payee_id), await P.retirePayee(ctx, p.payee_id));
  const bad = await P.activatePayee({ ...ctx, env: {} }, 'pay_none').catch((e) => e);
  const miss = await P.createPayee({ ...ctx, env: {} }, input({ legal_name: 'M', secret_names: { key_id: 'M_ID', key_secret: 'M_SECRET', webhook_secret: 'M_HOOK' } }));
  seen.push(bad.message, await P.activatePayee({ ...ctx, env: {} }, miss.payee_id).catch((e) => [e.message, e.extra]));
  seen.push(await s.db.all('SELECT * FROM payee_account'));
  const all = JSON.stringify(seen);
  for (const v of Object.values(VALUES)) assert.ok(!all.includes(v), v);
});
