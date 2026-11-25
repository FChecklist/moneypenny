// F1 (migration 0005 and back-fill) and F2 (payee registry). The registry is dark: it needs the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { openDb, migrate, readMigrationFiles } from '../src/db.js';
import { doDb } from '../src/do.js';
import { fakeStorage } from './do-storage.js';
import { MIGRATIONS } from '../src/migrations.gen.js';
import * as P from '../src/payees.js';
import { ADAPTERS } from '../src/gateways/index.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mkDb = () => (process.env.MNP_DB === 'do' ? doDb(fakeStorage()) : openDb());
const old = () => readMigrationFiles().filter(([f]) => f < '0005');
const NAMES = { key_id: 'MNP_PAYEE_B_KEY_ID', key_secret: 'MNP_PAYEE_B_KEY_SECRET', webhook_secret: 'MNP_PAYEE_B_WEBHOOK_SECRET' };
const VALUES = { MNP_PAYEE_B_KEY_ID: 'rzp_' + 'test_AbCdEfGhIjKlMnOp', MNP_PAYEE_B_KEY_SECRET: 'sEcReT-value-1234567890', MNP_PAYEE_B_WEBHOOK_SECRET: 'whsec-value-0987654321' };
const input = (o = {}) => ({ legal_name: 'Payee B Legal', gateway: 'razorpay', mode: 'test', secret_names: NAMES, currencies: ['INR'], ...o });
const LEGACY = { key_id: 'MNP_LEGACY_KEY_ID', key_secret: 'MNP_LEGACY_KEY_SECRET', webhook_secret: 'MNP_LEGACY_WEBHOOK_SECRET' };
const reg = async (extra = {}, { fillLegacy = true } = {}) => {
  const s = await setup();
  // the legacy payee ships with empty secret names; an owner fills them in before the registry is used
  if (fillLegacy) await s.db.run("UPDATE payee_account SET secret_names = ? WHERE payee_id = 'pay_legacy_itservices'", JSON.stringify(LEGACY));
  return { s, ctx: { ...s.ctx(), payees: true, actor: 'owner', callerType: 'owner', env: { ...VALUES }, ...extra } };
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
  await P.createPayee(ctx, input({ mode: 'live', secret_names: { key_id: 'MNP_L_KEY_ID', key_secret: 'MNP_L_KEY_SECRET', webhook_secret: 'MNP_L_WEBHOOK' } })); // other mode is a different payee (own names)
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
  // The gateway cannot be tried here: only gateways with an adapter can be named and there is one today, so it is not changed. The other identity fields are.
  for (const ch of [{ legal_name: 'Other' }, { currencies: ['USD'] }, { secret_names: { ...NAMES, key_id: 'MNP_OTHER_ID' } }]) {
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

const audits = (s) => s.db.all('SELECT * FROM payee_audit ORDER BY seq');

test('F2-i: every mutator writes exactly one audit row; a failed change writes none', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  assert.equal((await audits(s)).length, 1);
  await P.editPayee(ctx, p.payee_id, { note: 'hello' });
  await P.activatePayee(ctx, p.payee_id);
  await P.pausePayee(ctx, p.payee_id);
  await P.activatePayee(ctx, p.payee_id);
  await P.retirePayee(ctx, p.payee_id);
  const rows = await audits(s);
  assert.deepEqual(rows.map((r) => r.action), ['payee.create', 'payee.edit', 'payee.activate', 'payee.pause', 'payee.resume', 'payee.retire']);
  assert.ok(rows.every((r) => r.actor === 'owner'));
  const edit = JSON.parse(rows[1].detail);
  assert.deepEqual(edit.changed, ['note', 'version']); // key names only, no values
  for (const v of Object.values(VALUES)) assert.ok(!JSON.stringify(rows).includes(v));
  const n = rows.length;
  await code(P.pausePayee(ctx, p.payee_id)); // retired: refused
  await code(P.editPayee(ctx, p.payee_id, { note: 'x' }));
  await code(P.createPayee(ctx, input({ legal_name: '' })));
  assert.equal((await audits(s)).length, n);
});

test('F2-j: a failed audit write rolls the change back', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  await s.db.run('DROP TABLE payee_audit');
  await assert.rejects(P.editPayee(ctx, p.payee_id, { note: 'z' }));
  await s.db.run('CREATE TABLE payee_audit (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, key_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, change_id TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)');
  assert.equal((await P.getPayee(ctx, p.payee_id)).note, null);
});

test('F2-k: only the owner role may change a payee', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  for (const bad of [{ callerType: 'human' }, { callerType: undefined }, { actor: 'system' }, { actor: undefined }, { callerType: 'ai' }]) {
    const c = { ...ctx, ...bad };
    assert.equal(await code(P.createPayee(c, input({ legal_name: 'Other' }))), 'payee_forbidden');
    assert.equal(await code(P.editPayee(c, p.payee_id, { note: 'n' })), 'payee_forbidden');
    for (const f of [P.activatePayee, P.pausePayee, P.retirePayee]) assert.equal(await code(f(c, p.payee_id)), 'payee_forbidden');
  }
  assert.equal((await audits(s)).length, 1);
  assert.equal((await P.getPayee({ ...ctx, callerType: 'human' }, p.payee_id)).payee_id, p.payee_id); // reads stay open
});

test('F2-l: free text values are screened like secret names', async () => {
  const { ctx } = await reg();
  const bad = ['rzp_' + 'live_AbCdEf12', 'a'.repeat(5) + 'f'.repeat(40), 'QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVuIHNlc2FtZQ==', 'whsec_' + 'abcdefgh12345'];
  for (const v of bad) {
    assert.equal(await code(P.createPayee(ctx, input({ invoice: { footer: v } }))), 'secret_value_refused');
    assert.equal(await code(P.createPayee(ctx, input({ checkout: { description: v } }))), 'secret_value_refused');
    assert.equal(await code(P.createPayee(ctx, input({ note: v }))), 'secret_value_refused');
  }
  const p = await P.createPayee(ctx, input({ invoice: { footer: 'Thank you for your business. GST invoice.' } }));
  for (const v of bad) {
    const e = await code(P.editPayee(ctx, p.payee_id, { invoice: { footer: v } }));
    assert.equal(e, 'secret_value_refused');
    assert.ok(!String(code.last.message).includes(v));
  }
});

test('F2-m: ctx.secrets, when present, replaces ctx.env', async () => {
  const names = NAMES;
  const all = new Map(Object.entries(VALUES));
  assert.equal(P.secretPresence({ env: { ...VALUES } }, names).ok, true);
  assert.equal(P.secretPresence({ env: { ...VALUES }, secrets: new Map() }, names).ok, false); // env ignored
  assert.equal(P.secretPresence({ env: {}, secrets: all }, names).ok, true);
});

test('F1-d: migration header and contract carry the owner checks and payee_forbidden', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../migrations/0005_payee_accounts.sql', import.meta.url), 'utf8');
  assert.match(sql, /OWNER CHECKS BEFORE THIS RUNS ON PRODUCTION/);
  const { buildContract } = await import('../scripts/gen-contract.js');
  const file = JSON.parse(readFileSync(new URL('../contract/v1/openapi.json', import.meta.url), 'utf8'));
  assert.match(JSON.stringify(file), /"payee_forbidden":\{"status":403/);
  assert.deepEqual(file, JSON.parse(JSON.stringify(buildContract())));
});

// ---- round 2 ----
const bankTexts = {
  digits: '1234567890123', // account-like, 13 digits
  digits_spaced: '1234 5678 9012',
  digits9: '123456789',
  card: '4111 1111 1111 1111',
  card_dash: '4111-1111-1111-1111',
  ifsc: 'Pay to HDFC0001234 branch',
  iban: 'GB82 WEST 1234 5698 7654 32',
  iban_plain: 'DE89370400440532013000',
};
test('R2-1: bank details are refused in every free-text field, never echoed', async () => {
  const { ctx } = await reg();
  assert.ok(P.BANK_RULES.digits('123456789') && !P.BANK_RULES.digits('12345678') && P.BANK_RULES.ifsc('SBIN0ABC123') && P.BANK_RULES.iban('GB82WEST12345698765432'));
  for (const [n, v] of Object.entries(bankTexts)) {
    const fields = [
      { invoice: { footer: v } }, { invoice: { address_lines: v } }, { invoice: { receipt_text: v } }, { checkout: { description: v } },
      { checkout: { brand_name: v } }, { note: v }, { display_name: v },
    ];
    for (const f of fields) {
      assert.equal(await code(P.createPayee(ctx, input(f))), 'bank_detail_refused', n + JSON.stringify(f));
      assert.ok(!String(code.last.message).includes(v));
    }
  }
  const p = await P.createPayee(ctx, input());
  assert.equal(await code(P.editPayee(ctx, p.payee_id, { note: bankTexts.ifsc })), 'bank_detail_refused');
  // ordinary text still passes, including short numbers and dates
  await P.editPayee(ctx, p.payee_id, { invoice: { footer: 'Invoice 2026-11-25, GSTIN 29ABCDE1234F1Z5, SAC 998439', sac_code: '998439' } });
});
test('R2-1b: bank_name stays plain letters', async () => {
  const { ctx } = await reg();
  const p = await P.createPayee(ctx, input({ invoice: { bank_name: 'State Bank of India' } }));
  assert.equal(p.invoice.bank_name, 'State Bank of India');
  for (const v of ['Bank 24', 'Bank <b>', 'HDFC0001234']) assert.equal(await code(P.createPayee(ctx, input({ invoice: { bank_name: v } }))), v === 'HDFC0001234' ? 'bank_detail_refused' : 'bad_field');
});

test('R2-2: audit detail holds key names only, never free text', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input({ note: 'private words', invoice: { footer: 'secret footer' }, checkout: { brand_name: 'Brand Z' } }));
  await P.editPayee(ctx, p.payee_id, { note: 'other words', invoice: { footer: 'new footer' } });
  const rows = await audits(s);
  const all = JSON.stringify(rows.map((r) => r.detail));
  for (const w of ['private words', 'secret footer', 'Brand Z', 'other words', 'new footer', 'Payee B Legal']) assert.ok(!all.includes(w), w);
  assert.deepEqual(JSON.parse(rows[1].detail), { payee_id: p.payee_id, changed: ['invoice', 'note', 'version'] });
  assert.ok(JSON.parse(rows[0].detail).changed.includes('note'));
});

test('R2-3: identity is also locked by a verified payment or a route', async () => {
  for (const kind of ['payment', 'route', 'fallback']) {
    const { s, ctx } = await reg();
    const p = await P.createPayee(ctx, input());
    assert.equal(await P.hasOrders(ctx, p.payee_id), false);
    if (kind === 'payment') await s.db.run("INSERT INTO verified_payment (tenant_id, ref, paid_minor, currency, created_at, payee_id) VALUES ('demo','pp1',100,'USD',1,?)", p.payee_id);
    else await s.db.run(`INSERT INTO payee_route (route_id, tenant_id, product_id, payee_id, fallback_payee_id, effective_from, set_by, created_at) VALUES ('r1','demo','*',?,?,1,'o',1)`, kind === 'route' ? p.payee_id : 'pay_legacy_itservices', kind === 'fallback' ? p.payee_id : null);
    assert.equal(await P.hasOrders(ctx, p.payee_id), true, kind);
    assert.equal(await code(P.editPayee(ctx, p.payee_id, { legal_name: 'Changed' })), 'identity_locked', kind);
    assert.equal((await P.editPayee(ctx, p.payee_id, { note: 'fine' })).note, 'fine');
  }
});

test('R2-4: long-run screen skips hostnames and addresses; hex and prefixes are still refused', async () => {
  const { ctx } = await reg();
  const host = 'https://very-long-subdomain-name.example-company.co.in';
  assert.ok(host.length >= 40);
  const p = await P.createPayee(ctx, input({ checkout: { frame_origin: host, description: 'Office at 12 Some Long Road Name Extension Layout Bengaluru' } }));
  assert.equal(p.checkout.frame_origin, host);
  assert.equal(await code(P.createPayee(ctx, input({ note: 'abcdef0123456789'.repeat(2) + 'abcdef01' }))), 'secret_value_refused'); // 40 hex
  assert.equal(await code(P.createPayee(ctx, input({ note: 'Zq'.repeat(20) }))), 'secret_value_refused'); // 40 mixed, no spaces
  for (const v of ['rzp_x', 'sk_abcdefgh12', 'pk_abcdefgh12', 'rk_abcdefgh12', 'whsec_abcdefgh12', 'see Sk_abcdefgh12 here']) assert.equal(await code(P.createPayee(ctx, input({ note: v }))), 'secret_value_refused', v);
});

// A db whose reads are followed by a rival audit write, as if another writer got in between.
const rival = (db, times) => {
  let left = times;
  const wrap = (h) => ({
    ...h,
    first: async (sql, ...a) => {
      const r = await h.first(sql, ...a);
      if (/FROM payee_audit/.test(sql) && left > 0) {
        left--;
        await h.run("INSERT INTO payee_audit (seq, ts, actor, action, detail, prev_hash, hash) VALUES (?,1,'rival','x','{}','p','h')", (r?.seq ?? 0) + 1);
      }
      return r;
    },
    tx: (fn) => h.tx((x) => fn(wrap(x))),
  });
  return wrap(db);
};
test('R2-5: an audit seq clash is retried once, then fails cleanly and rolls back', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  const n = (await audits(s)).length;
  const once = { ...ctx, db: rival(s.db, 1) };
  const e = await P.editPayee(once, p.payee_id, { note: 'a' });
  assert.equal(e.note, 'a');
  const rows = await audits(s);
  assert.equal(rows.length, n + 2); // rival row plus ours
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1));
  assert.equal(rows.at(-1).prev_hash, rows.at(-2).hash);
  const twice = { ...ctx, db: rival(s.db, 2) };
  await assert.rejects(P.editPayee(twice, p.payee_id, { note: 'b' }), (x) => x.code === 'audit_conflict' && x.status === 409);
  assert.equal((await P.getPayee(ctx, p.payee_id)).note, 'a'); // change rolled back
});

// ---- round 3 ----
const mkActive = async (ctx, o) => {
  const p = await P.createPayee(ctx, input(o));
  return P.activatePayee(ctx, p.payee_id);
};
test('R3-1: secret names of a retired payee stay reserved', async () => {
  const { ctx } = await reg();
  const p = await mkActive(ctx);
  await P.retirePayee(ctx, p.payee_id);
  assert.equal(await code(P.createPayee(ctx, input({ legal_name: 'Other Name' }))), 'payee_exists'); // same names
  assert.equal(await code(P.createPayee(ctx, input({ legal_name: 'Other Name', mode: 'live' }))), 'payee_exists'); // other mode too
  const moved = { key_id: 'MNP_NEW_KEY_ID', key_secret: NAMES.key_secret, webhook_secret: 'MNP_NEW_WEBHOOK' }; // one reused name is enough
  assert.equal(await code(P.createPayee(ctx, input({ legal_name: 'Other Name', secret_names: moved }))), 'payee_exists');
  const fresh = await P.createPayee(ctx, input({ legal_name: 'Other Name', secret_names: { key_id: 'MNP_N_KEY_ID', key_secret: 'MNP_N_KEY_SECRET', webhook_secret: 'MNP_N_WEBHOOK' } }));
  assert.equal(await code(P.editPayee(ctx, fresh.payee_id, { secret_names: NAMES })), 'payee_exists'); // edit cannot take them either
});

test('R3-2: an active payee with empty secret names blocks every operation until an owner fills them in', async () => {
  const { s, ctx } = await reg({ env: { ...VALUES, MNP_LEGACY_KEY_ID: 'a1', MNP_LEGACY_KEY_SECRET: 'b2', MNP_LEGACY_WEBHOOK_SECRET: 'c3' } }, { fillLegacy: false });
  for (const f of [() => P.createPayee(ctx, input()), () => P.pausePayee(ctx, 'pay_legacy_itservices'), () => P.editPayee(ctx, 'pay_legacy_itservices', { note: 'x' })]) {
    const e = await f().then(() => null, (x) => x);
    assert.equal(e?.code, 'payee_setup_incomplete');
    assert.match(e.message, /owner must fill in the secret names first/);
  }
  assert.equal((await audits(s)).length, 0);
  // the one way out: an owner edit that sets only the secret names
  const filled = await P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: LEGACY });
  assert.deepEqual(filled.secret_names, LEGACY);
  await P.pausePayee(ctx, 'pay_legacy_itservices');
  await P.activatePayee(ctx, 'pay_legacy_itservices');
  await P.createPayee(ctx, input());
  // the flag off still wins with its own code
  const off = { ...ctx, payees: false, env: {} };
  assert.equal(await code(P.listPayees(off)), 'payees_disabled');
});

// A db double: real rollback, but one chosen statement fails (before or after it runs).
const flaky = (db, re, after) => {
  const wrap = (h) => ({
    ...h,
    run: async (sql, ...a) => {
      if (!re.test(sql)) return h.run(sql, ...a);
      if (!after) throw new Error('boom');
      await h.run(sql, ...a);
      throw new Error('boom');
    },
    tx: (fn) => h.tx((x) => fn(wrap(x))),
  });
  return wrap(db);
};
test('R3-3: the payee change and its audit row commit or fail together', async () => {
  const { s, ctx } = await reg();
  const p = await P.createPayee(ctx, input());
  const n = (await audits(s)).length;
  const row = () => s.db.first('SELECT version, note, status FROM payee_account WHERE payee_id = ?', p.payee_id).then((r) => ({ ...r }));
  const before = await row();
  const ops = [(c) => P.editPayee(c, p.payee_id, { note: 'n' }), (c) => P.activatePayee(c, p.payee_id), (c) => P.createPayee(c, input({ legal_name: 'Third', secret_names: { key_id: 'MNP_T_KEY_ID', key_secret: 'MNP_T_KEY_SECRET', webhook_secret: 'MNP_T_WEBHOOK' } }))];
  const count = () => s.db.first('SELECT COUNT(*) n FROM payee_account').then((r) => r.n);
  const rows = await count();
  for (const op of ops) {
    // audit write fails (before or after it ran): the business row is unchanged
    for (const after of [false, true]) {
      await assert.rejects(op({ ...ctx, db: flaky(s.db, /INSERT INTO payee_audit/, after) }), /boom/);
      assert.deepEqual(await row(), before);
      assert.equal(await count(), rows);
      assert.equal((await audits(s)).length, n);
    }
    // the reverse: business write fails after the audit row would follow (update/insert), no audit row stays
    await assert.rejects(op({ ...ctx, db: flaky(s.db, /^(UPDATE payee_account|INSERT INTO payee_account)/, true) }), /boom/);
    assert.deepEqual(await row(), before);
    assert.equal(await count(), rows);
    assert.equal((await audits(s)).length, n);
  }
  // success: both rows are there
  await P.editPayee(ctx, p.payee_id, { note: 'ok' });
  assert.equal((await row()).note, 'ok');
  assert.equal((await audits(s)).length, n + 1);
});

let uniq = 0;
test('R3-4: strict digit rule everywhere, PIN and phone allowed only in three fields', async () => {
  const { ctx } = await reg();
  const loose = (v) => [{ invoice: { address_lines: v } }, { invoice: { number_prefix: v } }, { invoice: { receipt_text: v } }];
  const strict = (v) => [{ invoice: { footer: v } }, { invoice: { refund_text: v } }, { checkout: { description: v } }, { note: v }, { display_name: v }, { invoice: { sac_text: v } }];
  const ok = ['12 MG Road, Bengaluru 560001', 'Phone 9876543210', 'Ph 98765 43210, PIN 560001', 'INV-560001-'];
  for (const v of ok) {
    for (const f of loose(v)) await P.createPayee(ctx, input({ ...f, legal_name: 'Law ' + (++uniq), secret_names: { key_id: 'MNP_' + Math.random().toString(36).slice(2, 8).toUpperCase() + '_ID', key_secret: 'MNP_S' + Math.random().toString(36).slice(2, 8).toUpperCase(), webhook_secret: 'MNP_W' + Math.random().toString(36).slice(2, 8).toUpperCase() } })).catch((e) => assert.fail(v + JSON.stringify(f) + e.code));
    for (const f of strict(v)) if (/\d{9,}|\d{5} \d{5}/.test(v)) assert.equal(await code(P.createPayee(ctx, input(f))), 'bank_detail_refused', v + JSON.stringify(f));
  }
  for (const f of strict('PIN 560001')) assert.ok(!P.BANK_RULES.digits('PIN 560001')); // 6 digits are not 9+ anywhere
  const bad = ['123456789', '12345678901', '1234567890123', '4111 1111 1111 1111', '560001 9876543210', 'Account 560001', 'A/C 560001', 'a/c no 9876543210', 'IFSC code, 560001', 'IBAN ref 9876543210', 'account: 98765 43210'];
  for (const v of bad) for (const f of loose(v)) assert.equal(await code(P.createPayee(ctx, input(f))), 'bank_detail_refused', v + JSON.stringify(f));
  // rule level
  assert.ok(P.BANK_RULES.digits('9876543210') && !P.BANK_RULES.digits('9876543210', true) && P.BANK_RULES.digits('12345678901', true));
});

// ---- round 4 ----
const BAD_ENV = { MNP_LEGACY_KEY_ID: 'a1', MNP_LEGACY_KEY_SECRET: 'b2', MNP_LEGACY_WEBHOOK_SECRET: 'c3' };
const N2 = { key_id: 'MNP_Z_KEY_ID', key_secret: 'MNP_Z_KEY_SECRET', webhook_secret: 'MNP_Z_WEBHOOK' };
test('R4-1: read-only calls work while setup is incomplete; the error names the payee', async () => {
  const { ctx } = await reg({ env: { ...VALUES, ...BAD_ENV } }, { fillLegacy: false });
  assert.equal((await P.listPayees(ctx)).length, 1);
  assert.equal((await P.getPayee(ctx, 'pay_legacy_itservices')).status, 'active');
  assert.equal((await P.checkPayeeSecrets(ctx, 'pay_legacy_itservices')).ok, false);
  assert.equal(P.secretPresence(ctx, {}).ok, false);
  for (const f of [() => P.createPayee(ctx, input()), () => P.pausePayee(ctx, 'pay_legacy_itservices')]) {
    const e = await f().then(() => null, (x) => x);
    assert.equal(e?.code, 'payee_setup_incomplete');
    assert.match(e.message, /pay_legacy_itservices/);
    assert.match(e.message, /IT Services/);
  }
});

test('R4-2: a corrupt secret_names row does not brick the registry', async () => {
  const { s, ctx } = await reg({ env: { ...VALUES, ...BAD_ENV } }, { fillLegacy: false });
  for (const bad of ['{not json', 'null', '[1]', '"x"']) {
    await s.db.run("UPDATE payee_account SET secret_names = ? WHERE payee_id = 'pay_legacy_itservices'", bad);
    assert.deepEqual((await P.listPayees(ctx))[0].secret_names, {});
    const e = await P.createPayee(ctx, input()).then(() => null, (x) => x);
    assert.equal(e?.code, 'payee_setup_incomplete'); // never a SyntaxError
    assert.ok(e instanceof Error && !(e instanceof SyntaxError));
  }
  await s.db.run("UPDATE payee_account SET secret_names = '{bad' WHERE payee_id = 'pay_legacy_itservices'");
  assert.match(await P.createPayee(ctx, input()).then(() => '', (x) => x.message), /unreadable/);
  assert.equal((await P.checkPayeeSecrets(ctx, 'pay_legacy_itservices')).ok, false);
  assert.deepEqual((await P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: LEGACY })).secret_names, LEGACY); // owner can repair it
});

test('R4-3: first fill on a payee with orders still runs the name rules and clash; only the lock is skipped', async () => {
  const { s, ctx } = await reg({ env: { ...VALUES, ...BAD_ENV } }, { fillLegacy: false });
  await addOrder(s, 'pay_legacy_itservices');
  const other = await s.db.run("INSERT INTO payee_account (payee_id, legal_name, display_name, gateway, mode, secret_names, status, currencies, version, created_by, created_at, updated_at) VALUES ('pay_o','Other','Other','no_adapter_gw','test',?, 'retired','[\"INR\"]',1,'x',1,1)", JSON.stringify(N2));
  assert.equal(await code(P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: N2 })), 'payee_exists'); // retired payee's names
  await s.db.run("UPDATE payee_account SET status = 'paused' WHERE payee_id = 'pay_o'");
  assert.equal(await code(P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: N2 })), 'payee_exists'); // live payee's names
  assert.equal(await code(P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: { ...LEGACY, key_id: 'rzp_live_abc' } })), 'secret_value_refused'); // name rules
  assert.deepEqual((await P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: LEGACY })).secret_names, LEGACY); // clean fill works despite the order
  assert.equal(await code(P.editPayee(ctx, 'pay_legacy_itservices', { secret_names: NAMES })), 'identity_locked'); // lock back on once filled
});

test('R4-4: a second payee cannot go active for the same gateway and mode', async () => {
  const { ctx } = await reg();
  Object.assign(ctx.env, { MNP_Z_KEY_ID: 'v', MNP_Z_KEY_SECRET: 'v', MNP_Z_WEBHOOK: 'v' });
  const a = await mkActive(ctx); // razorpay test
  const b = await P.createPayee(ctx, input({ legal_name: 'Second', secret_names: N2 }));
  assert.equal(await code(P.activatePayee(ctx, b.payee_id)), 'payee_gateway_taken');
  const live = await P.createPayee(ctx, input({ legal_name: 'Live', mode: 'live', secret_names: { key_id: 'MNP_L_KEY_ID', key_secret: 'MNP_L_KEY_SECRET', webhook_secret: 'MNP_L_WEBHOOK' } }));
  ctx.env.MNP_L_KEY_ID = ctx.env.MNP_L_KEY_SECRET = ctx.env.MNP_L_WEBHOOK = 'v'; // other mode: not blocked by a (test mode) active payee... but legacy is live
  assert.equal(await code(P.activatePayee(ctx, live.payee_id)), 'payee_gateway_taken'); // legacy is active razorpay live
  await P.pausePayee(ctx, a.payee_id);
  assert.equal((await P.activatePayee(ctx, b.payee_id)).status, 'active'); // switch by pausing the first
  assert.equal(await code(P.activatePayee(ctx, a.payee_id)), 'payee_gateway_taken'); // resume is blocked too
  await P.retirePayee(ctx, b.payee_id);
  assert.equal((await P.activatePayee(ctx, a.payee_id)).status, 'active');
});

test('R4-5: no lockfile is needed (no dependencies)', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.dependencies && !pkg.devDependencies);
  // a lockfile appears whenever someone runs npm install and is not a fault
});

test('R4-6: the guarded back-fill can be re-run on a migrated copy without duplicating or rewriting', async () => {
  const { readFileSync } = await import('node:fs');
  const db = mkDb();
  migrate(db, old());
  await db.run("INSERT INTO tenant (id, name, created_at) VALUES ('t1','One',1)");
  await db.run("INSERT INTO account (id, tenant_id, email_norm, email_canon, created_at) VALUES ('a1','t1','a@x.com','a@x.com',1)");
  await db.run("INSERT INTO purchase_order (id, tenant_id, account_id, order_ref, credits, currency, amount_minor, lock_until, rate_cpu, rate_inr, status, created_at, updated_at) VALUES ('o1','t1','a1','r1',100,'USD',100,1,1,1,'paid',1,1)");
  migrate(db, MIGRATIONS);
  // after migration an owner edits things the back-fill must never touch again
  await db.run("UPDATE payee_account SET secret_names = '{\"k\":1}', note = 'edited' WHERE payee_id = 'pay_legacy_itservices'");
  await db.run("INSERT INTO payee_account (payee_id, legal_name, display_name, gateway, mode, secret_names, status, currencies, version, created_by, created_at, updated_at) VALUES ('pay_n','N','N','no_adapter_gw','test','{}','draft','[\"INR\"]',1,'x',1,1)");
  await db.run("UPDATE purchase_order SET payee_id = 'pay_n', mode = 'test', payee_version = 7 WHERE id = 'o1'");
  const sql = readFileSync(new URL('../migrations/0005_payee_accounts.sql', import.meta.url), 'utf8');
  db.exec(sql.slice(sql.indexOf('-- Back-fill')));
  assert.equal((await db.first("SELECT COUNT(*) n FROM payee_account WHERE payee_id = 'pay_legacy_itservices'")).n, 1);
  assert.equal((await db.first("SELECT note FROM payee_account WHERE payee_id = 'pay_legacy_itservices'")).note, 'edited');
  const o = await db.first("SELECT payee_id, mode, payee_version FROM purchase_order WHERE id = 'o1'");
  assert.deepEqual({ ...o }, { payee_id: 'pay_n', mode: 'test', payee_version: 7 });
  assert.equal((await db.first('SELECT COUNT(*) n FROM payee_route')).n, 1);
});

// ---- round 8 ----
// Owner rule: nothing may name a gateway that has no adapter. Today that is every gateway but razorpay and itservices_central. The names are built from pieces here
// so that no file in the repo has to spell them out.
const OTHER_GATEWAYS = ['stri' + 'pe', 'cash' + 'free', 'manual_' + 'bank'];
test('R8-5: the gateway list is built from the adapters; a payee with a gateway that has no adapter cannot be stored, and the refusal names no gateway', async () => {
  const { s, ctx } = await reg();
  assert.deepEqual(P.GATEWAYS, Object.keys(ADAPTERS)); // built from the adapter registry, not typed in
  assert.deepEqual(P.GATEWAYS, ['razorpay', 'itservices_central']); // 0.2.16: the central IT Services pay service (F10) has an adapter too
  assert.ok(Object.isFrozen(P.GATEWAYS)); // shared list: no test or code can add to it
  assert.throws(() => P.GATEWAYS.push('x'), TypeError);
  assert.deepEqual(P.GATEWAYS, ['razorpay', 'itservices_central']); // 0.2.16: the central IT Services pay service (F10) has an adapter too
  const rows = async () => [(await s.db.first('SELECT COUNT(*) n FROM payee_account')).n, (await s.db.first('SELECT COUNT(*) n FROM payee_audit')).n];
  const before = await rows();
  // 'fake' is a test double in src/gateways but not in ADAPTERS; the others have no adapter at all; the rest are wrong spellings and wrong types
  const tried = [...OTHER_GATEWAYS, 'fake', 'nope', 'Razorpay', 'razorpay ', '', null, 7];
  for (const gateway of tried) {
    await assert.rejects(P.createPayee(ctx, input({ gateway })), (e) => {
      assert.equal(e.code, 'bad_gateway', JSON.stringify(gateway));
      assert.equal(e.status, 400);
      const msg = String(e.message).toLowerCase();
      for (const name of [...OTHER_GATEWAYS, 'fake']) assert.ok(!msg.includes(name), `the refusal names a gateway: ${name}`);
      if (typeof gateway === 'string' && gateway) assert.ok(!msg.includes(gateway.toLowerCase()), 'the refusal echoes the value it was given');
      return true;
    });
  }
  assert.deepEqual(await rows(), before); // nothing was stored, nothing was audited
  // an edit cannot move a payee to one either
  const p = await P.createPayee(ctx, input());
  for (const gateway of OTHER_GATEWAYS) await assert.rejects(P.editPayee(ctx, p.payee_id, { gateway }), (e) => e.code === 'bad_gateway');
  assert.equal((await P.getPayee(ctx, p.payee_id)).gateway, 'razorpay');
});

test('R8-5: no file that ships names a gateway without an adapter', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const skip = new Set(['node_modules', '.git', '.data', 'test']); // this test folder names them only to check for them
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|json|md|sql|html|toml|txt|yml|yaml)$/i.test(name)) {
        const text = readFileSync(path, 'utf8').toLowerCase();
        for (const g of OTHER_GATEWAYS) if (text.includes(g)) hits.push(`${path.slice(root.length)}: ${g}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
