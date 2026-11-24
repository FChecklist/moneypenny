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
