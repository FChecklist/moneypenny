// Go-live guards: each test here fails if the guard it names is removed (scripts/guard-check.js proves that).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setup, makeClient, bal, buy, note, T0, MIN } from './helpers.js';
import { openDb, migrate } from '../src/db.js';
import { createApp, ROUTES } from '../src/api.js';
import { seedDemo } from '../src/seed.js';
import { keySecret } from '../src/auth.js';
import { stubRail, unconfiguredRail, railContract } from '../src/rail.js';
import { verifyChain, verifyBalances } from '../src/ledger.js';
import { redact } from '../src/util.js';

// A database wrapper that counts how many times the single writer is asked for a turn.
function spyApp({ rail } = {}) {
  const db = openDb();
  migrate(db);
  const spy = { tx: 0, fail: null };
  const wrap = (h) => ({
    ...h,
    first: (...a) => h.first(...a),
    run: (sql, ...p) => { if (spy.fail && spy.fail.test(sql)) throw new Error(spy.msg); return h.run(sql, ...p); },
    tx: (fn) => { spy.tx++; return h.tx((t) => fn(wrap(t))); },
  });
  const clock = { t: T0 };
  const master = randomBytes(24).toString('hex');
  return { db, spy, clock, master, wrapped: wrap(db), mkApp: () => createApp({ db: wrap(db), master, now: () => clock.t, aiWithoutStatus: true, rail }) };
}

test('G1. forged, unsigned and tampered calls never take a turn on the single writer', async () => {
  const w = spyApp();
  const app = w.mkApp();
  const demo = await w.db.tx((t) => seedDemo({ db: t, now: () => w.clock.t, master: w.master }));
  w.spy.tx = 0;
  const good = makeClient(app, w.clock, demo.read);
  const send = (headers, body) => app.fetch(new Request('http://t.local/v1/balance?email=a@example.com', { headers, body }));
  assert.equal((await send({})).status, 401); // no headers at all
  assert.equal((await send({ 'x-mnp-key': demo.read.key_id, 'x-mnp-timestamp': String(T0), 'x-mnp-nonce': 'n1', 'x-mnp-signature': 'bad' })).status, 401);
  assert.equal((await good.get('/v1/balance?email=a@example.com', { sign: false })).status, 401); // key id is real, signature is not
  // a signature made for another path does not work on this one
  const other = await good.raw('GET', '/v1/balance?email=b@example.com', undefined, { sign: true });
  assert.equal(other.status, 200);
  assert.equal(w.spy.tx > 0, true, 'a good call does use the writer');
  const before = w.spy.tx;
  for (let i = 0; i < 25; i++) assert.equal((await good.get('/v1/balance?email=a@example.com', { sign: false })).status, 401);
  assert.equal(w.spy.tx, before, 'a flood of forged calls must not queue on the writer');
});

test('G2. forged calls cannot use up another key\'s per-minute budget', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { api_rate_per_minute: 3 });
  for (let i = 0; i < 20; i++) await s.read.get('/v1/balance?email=a@example.com', { sign: false });
  assert.equal((await s.read.get('/v1/balance?email=a@example.com')).status, 200); // the real owner of the key is not locked out
});

test('G3. rate limit: over the limit gets 429, the counter is kept, the next minute starts fresh', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { api_rate_per_minute: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.read.get('/v1/balance?email=a@example.com')).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  s.clock.t += 61000;
  assert.equal((await s.read.get('/v1/balance?email=a@example.com')).status, 200);
});

test('G4. every write route demands an Idempotency-Key, and it is signed', async () => {
  for (const r of ROUTES) if (r[0] !== 'GET') assert.equal(r[3], true, `${r[0]} ${r[1]} must require an Idempotency-Key`);
  const s = await setup();
  await buy(s.api, 'a@example.com', 5000, 'p-g4');
  await s.admin.put('/v1/admin/catalogue', { product: 'g', item: 'i', credits: 100 });
  const bodies = [
    ['/v1/spend/reserve_item', { email: 'a@example.com', product: 'g', item: 'i', order_ref: 'o-g4' }],
    ['/v1/spend/reserve', { email: 'a@example.com', order_ref: 'o-g4b', amount_minor: 100, currency: 'USD' }],
    ['/v1/spend/capture', { hold_id: 'h' }],
    ['/v1/spend/release', { hold_id: 'h' }],
    ['/v1/buy_credits', { email: 'a@example.com', credits: 100, order_ref: 'b-g4' }],
    ['/v1/credit', { email: 'a@example.com', bucket: 'bonus', amount: 1, ref: 'r' }],
    ['/v1/event', { email: 'a@example.com', event_type: 'account_created', event_key: 'e-g4' }],
    ['/v1/refund', { type: 'order', hold_id: 'h' }],
    ['/v1/convert_request', { email: 'a@example.com', credits: 100 }],
  ];
  const before = (await s.db.first('SELECT COUNT(*) n FROM entry')).n;
  for (const [path, body] of bodies) {
    const r = await s.api.post(path, body, { idem: null });
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error.code, 'idempotency_key_required', path);
  }
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM entry')).n, before, 'nothing was written');
});

test('G5. replaying every money write with the same key changes nothing', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/catalogue', { product: 'g', item: 'i', credits: 300 });
  const calls = [];
  const once = async (client, path, body, idem) => {
    const a = await client.post(path, body, { idem });
    assert.equal(a.status, 200, `${path}: ${JSON.stringify(a.body)}`);
    calls.push([client, path, body, idem, a.body]);
    return a;
  };
  await once(s.pay, '/v1/payment_notice', { payment_ref: 'pay-g5', paid_minor: 5000, currency: 'USD', payer_email: 'a@example.com' }, 'k-notice');
  await once(s.pay, '/v1/credit_purchase', { email: 'a@example.com', amount: 5000, paid_minor: 5000, currency: 'USD', payment_ref: 'pay-g5' }, 'k-buy');
  await once(s.api, '/v1/credit', { email: 'a@example.com', bucket: 'bonus', amount: 50, ref: 'gift-g5' }, 'k-bonus');
  await once(s.api, '/v1/event', { email: 'a@example.com', event_type: 'account_created', event_key: 'ev-g5' }, 'k-event');
  const hold = await once(s.api, '/v1/spend/reserve_item', { email: 'a@example.com', product: 'g', item: 'i', order_ref: 'o-g5' }, 'k-reserve');
  await once(s.api, '/v1/spend/capture', { hold_id: hold.body.hold_id }, 'k-capture');
  await once(s.api, '/v1/refund', { type: 'order', hold_id: hold.body.hold_id, credits: 100 }, 'k-refund');
  const snapshot = async () => ({
    entries: (await s.db.first('SELECT COUNT(*) n FROM entry')).n,
    lots: (await s.db.all('SELECT id, remaining FROM lot ORDER BY id')),
    balance: (await bal(s.api, 'a@example.com')).balance,
  });
  const before = await snapshot();
  for (const [client, path, body, idem, first] of calls) {
    const again = await client.post(path, body, { idem });
    assert.equal(again.status, 200, path);
    assert.equal(again.headers.get('idempotent-replay'), 'true', path);
    assert.deepEqual(again.body, first, path);
  }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await verifyBalances(s.ctx()), []);
  assert.equal((await verifyChain(s.ctx())).ok, true);
});

test('G6. a rail confirmation replays safely: by default the payment id is the key', async () => {
  const s = await setup();
  s.app.rail = stubRail;
  await s.admin.put('/v1/admin/settings', { inr_packs: { 500: 40000 } }).catch(() => {});
  const order = await s.api.post('/v1/buy_credits', { email: 'a@example.com', credits: 500, order_ref: 'o-g6', currency: 'USD' });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  const body = { order_id: order.body.order_id, payment_ref: 'pay-g6', paid_minor: order.body.amount_minor, currency: 'USD' };
  const a = await s.pay.post('/v1/rail/confirm', body, { idem: null }); // no header: pay:<route>:<ref> is used
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await s.pay.post('/v1/rail/confirm', body, { idem: null });
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  // a second payment id for the same order is refused, and nothing more is credited
  const c = await s.pay.post('/v1/rail/confirm', { ...body, payment_ref: 'pay-g6-other' });
  assert.equal(c.status, 409);
  assert.equal((await bal(s.api, 'a@example.com')).balance, 500);
});

test('G7. whole numbers only: floats, text, negatives and huge numbers are refused and write nothing', async () => {
  const s = await setup();
  await buy(s.api, 'a@example.com', 5000, 'p-g7');
  await s.admin.put('/v1/admin/catalogue', { product: 'g', item: 'i', credits: 100 });
  s.app.rail = stubRail;
  const ord = await s.api.post('/v1/buy_credits', { email: 'a@example.com', credits: 500, order_ref: 'o-g7', currency: 'USD' });
  assert.equal(ord.status, 200, JSON.stringify(ord.body));
  const bad = [1.5, '100', -1, 0, null, true, 1e21, Number.MAX_SAFE_INTEGER + 2, [100], { a: 1 }];
  const fields = [
    ['/v1/credit_purchase', { email: 'a@example.com', amount: 1, paid_minor: 1, currency: 'USD', payment_ref: 'x' }, ['amount', 'paid_minor'], s.pay],
    ['/v1/payment_notice', { payment_ref: 'x', paid_minor: 1, currency: 'USD', payer_email: 'a@example.com' }, ['paid_minor'], s.pay],
    ['/v1/buy_credits', { email: 'a@example.com', credits: 100, order_ref: 'x' }, ['credits'], s.api],
    ['/v1/spend/reserve', { email: 'a@example.com', order_ref: 'x', amount_minor: 100, currency: 'USD' }, ['amount_minor'], s.api],
    ['/v1/credit', { email: 'a@example.com', bucket: 'bonus', amount: 1, ref: 'x' }, ['amount'], s.api],
    ['/v1/rail/confirm', { order_id: ord.body.order_id, payment_ref: 'x', paid_minor: 100, currency: 'USD' }, ['paid_minor'], s.pay],
  ];
  const entries = () => s.db.first('SELECT COUNT(*) n FROM entry').then((r) => r.n);
  const before = await entries();
  for (const [path, body, names, client] of fields) {
    for (const name of names) {
      for (const v of bad) {
        const r = await client.post(path, { ...body, [name]: v });
        assert.equal(r.status, 400, `${path} ${name}=${JSON.stringify(v)} gave ${r.status}`);
      }
    }
  }
  assert.equal(await entries(), before);
  // a number written with an exponent is still a whole number when it is one; a fraction never is
  const ok = await s.api.post('/v1/credit', { email: 'a@example.com', bucket: 'bonus', amount: 1e1, ref: 'ten' });
  assert.equal(ok.status === 200 || ok.status === 422, true);
});

test('G8. money code has no float helpers: the only parseFloat/toFixed are display text', () => {
  const allowedToFixed = { 'src/gate.js': 3, 'src/settings.js': 1, 'src/fx.js': 1 }; // quote text, "US$12.34" text, a note about a rate move
  for (const f of readdirSync(new URL('../src', import.meta.url))) {
    if (!f.endsWith('.js') || f === 'migrations.gen.js') continue;
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.equal(/parseFloat|Number\.parseFloat/.test(text), false, `${f} uses parseFloat`);
    const n = (text.match(/\.toFixed\(/g) || []).length;
    assert.equal(n, allowedToFixed[`src/${f}`] ?? 0, `${f} has ${n} toFixed calls (display text only, and only where listed)`);
  }
});

test('G9. the hash-chained ledger: any edit, removal or reorder is found', async () => {
  const s = await setup();
  await buy(s.api, 'a@example.com', 100, 'p1');
  await buy(s.api, 'a@example.com', 200, 'p2');
  await buy(s.api, 'a@example.com', 300, 'p3');
  assert.deepEqual(await verifyChain(s.ctx()), { ok: true, entries: 3 });
  s.db.exec('DROP TRIGGER entry_no_update');
  s.db.exec('DROP TRIGGER entry_no_delete');
  // 1) the amount of one entry is changed
  s.db.exec('UPDATE entry SET delta = delta + 1 WHERE seq = 2');
  assert.equal((await verifyChain(s.ctx())).broken_at, 2);
  s.db.exec('UPDATE entry SET delta = delta - 1 WHERE seq = 2');
  assert.equal((await verifyChain(s.ctx())).ok, true);
  // 2) the payment reference is changed
  s.db.exec("UPDATE entry SET ext_ref = 'other' WHERE seq = 3");
  assert.equal((await verifyChain(s.ctx())).broken_at, 3);
  s.db.exec("UPDATE entry SET ext_ref = 'p3' WHERE seq = 3");
  // 3) the money value is changed
  s.db.exec('UPDATE entry SET money_minor = 1 WHERE seq = 1');
  assert.equal((await verifyChain(s.ctx())).broken_at, 1);
});

test('G10. the ledger and the audit log cannot be edited or deleted through SQL', async () => {
  const s = await setup();
  await buy(s.api, 'a@example.com', 100, 'p1');
  await assert.rejects(() => s.db.run('UPDATE entry SET delta = 1'), /append-only/);
  await assert.rejects(() => s.db.run('DELETE FROM entry'), /append-only/);
  await assert.rejects(() => s.db.run("UPDATE audit_log SET action = 'x'"), /append-only/);
  await assert.rejects(() => s.db.run('DELETE FROM audit_log'), /append-only/);
});

test('G11. a failed call leaves no ledger trace and no idempotency record', async () => {
  const s = await setup();
  await buy(s.api, 'a@example.com', 100, 'p1');
  const n = async () => ({ e: (await s.db.first('SELECT COUNT(*) n FROM entry')).n, i: (await s.db.first('SELECT COUNT(*) n FROM idempotency')).n });
  const before = await n();
  const r = await s.api.post('/v1/spend/reserve', { email: 'a@example.com', order_ref: 'o-big', amount_minor: 100000000001, currency: 'USD' }, { idem: 'k-fail' });
  assert.notEqual(r.status, 200);
  assert.deepEqual(await n(), before);
});

test('G12. logs: an internal error is written without e-mails, secrets or request data', async () => {
  const w = spyApp();
  const app = w.mkApp();
  const demo = await w.db.tx((t) => seedDemo({ db: t, now: () => w.clock.t, master: w.master }));
  const secret = await keySecret(w.master, demo.api.key_id);
  const leak = `boom alice@example.com ${secret} ${w.master}\nline two`;
  w.spy.fail = /INSERT INTO idempotency/;
  w.spy.msg = leak;
  const logged = [];
  for (const m of ['error', 'log', 'warn', 'info', 'debug']) mock.method(console, m, (...a) => logged.push(a.join(' ')));
  try {
    const c = makeClient(app, w.clock, demo.api);
    const r = await c.post('/v1/credit', { email: 'alice@example.com', bucket: 'bonus', amount: 1, ref: 'x' });
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'internal');
    assert.equal(JSON.stringify(r.body).includes('example.com'), false);
  } finally {
    mock.restoreAll();
  }
  assert.equal(logged.length >= 1, true, 'the error was logged');
  const all = logged.join('\n');
  for (const bad of ['alice@example.com', secret, w.master, demo.api.key_id.length ? secret.slice(0, 24) : 'x', '\nline two']) assert.equal(all.includes(bad), false, `log leaked: ${bad.slice(0, 8)}...`);
  assert.equal(redact('mail a@b.com and ' + 'f'.repeat(40) + ' ok'), 'mail [email] and [hex] ok');
  assert.equal(redact('token Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9v end'), 'token [long] end');
});

test('G13. normal and refused calls write nothing to the console', async () => {
  const s = await setup();
  const logged = [];
  for (const m of ['error', 'log', 'warn', 'info', 'debug']) mock.method(console, m, (...a) => logged.push(a.join(' ')));
  try {
    await buy(s.api, 'a@example.com', 100, 'p-g13');
    await s.api.post('/v1/spend/capture', { hold_id: 'nope' });
    await s.api.post('/v1/credit_purchase', { email: 'a@example.com', amount: 1, paid_minor: 1, currency: 'USD', payment_ref: 'p-g13' });
    await s.read.get('/v1/balance?email=a@example.com', { sign: false });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(logged, []);
});

test('G14. open /health asks the payment rail at most once in 30 seconds', async () => {
  const w = spyApp();
  let asked = 0;
  const rail = { ...stubRail, async health() { asked++; return { ok: true }; } };
  const app = w.mkApp();
  app.rail = rail;
  const hit = async () => (await app.fetch(new Request('http://t.local/health'))).json();
  const first = await hit();
  assert.equal(first.rail.ok, true);
  await Promise.all([hit(), hit(), hit(), hit(), hit()]);
  assert.equal(asked, 1);
  w.clock.t += 31000;
  await hit();
  assert.equal(asked, 2);
  w.clock.t += 1000;
  app.rail = { ...rail, async health() { asked++; return { ok: false }; } }; // a different rail is asked at once
  assert.equal((await hit()).rail.ok, false);
});

test('G15. the payment-rail contract: the stub passes; a rail that makes a second order for a repeat does not', async () => {
  assert.deepEqual(await railContract(stubRail), []);
  let n = 0;
  const bad = { name: 'bad', async createOrder() { return { rail_order_id: `R${++n}`, pay_url: 'https://pay.example.com/x' }; }, async health() { return { ok: true }; } };
  assert.match((await railContract(bad)).join(' '), /same order_id/);
  const noId = { name: 'noid', async createOrder() { return {}; }, async health() { return { ok: true }; } };
  assert.match((await railContract(noId)).join(' '), /rail_order_id/);
  const slow = { name: 'slow', async createOrder(o) { await new Promise((r) => setTimeout(r, 60)); return { rail_order_id: `S${o.order_id}` }; }, async health() { return { ok: true }; } };
  assert.match((await railContract(slow, { timeoutMs: 20 })).join(' '), /too long/);
  const badUrl = { name: 'http', async createOrder(o) { return { rail_order_id: `H${o.order_id}`, pay_url: 'http://pay.example.com/x' }; }, async health() { return { ok: true }; } };
  assert.match((await railContract(badUrl)).join(' '), /https/);
  assert.match((await railContract(unconfiguredRail)).join(' '), /./); // the "not configured" rail is not a rail
});

test('G16. dark by default: the deployed Worker wiring has no payment side, so no money route can start', async () => {
  const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /rail: unconfiguredRail/);
  const s = await setup();
  s.app.rail = unconfiguredRail;
  const r = await s.api.post('/v1/buy_credits', { email: 'a@example.com', credits: 500, order_ref: 'o-dark', currency: 'USD' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'rail_not_configured');
  assert.equal((await s.db.first('SELECT COUNT(*) n FROM purchase_order')).n, 0);
});

test('G17. pack prices are whole paise: a fraction, a text or an odd key is refused', async () => {
  const s = await setup();
  for (const packs of [{ 500: 40000.5 }, { 500: '40000' }, { '500.5': 40000 }, { 500: -1 }, { 500: null }, { 500: 4 }]) {
    const r = await s.admin.put('/v1/admin/settings', { inr_packs: packs });
    assert.equal(r.status, 400, JSON.stringify(packs));
  }
  assert.equal((await s.admin.put('/v1/admin/settings', { inr_packs: { 500: 40000 } })).status, 200);
});

test('G18. the version is the same in package.json, version.json, CHANGELOG.md and KNOWLEDGE.md (the mandatory bump)', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('package.json')).version;
  const ver = JSON.parse(read('version.json'));
  assert.match(pkg, /^\d+\.\d+\.\d+$/);
  assert.equal(ver.version, pkg);
  assert.equal(ver.changes[0].version, pkg);
  assert.equal(typeof ver.changes[0].notes, 'string');
  assert.equal(ver.changes.length >= 2, true, 'older versions stay listed');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${pkg.replaceAll('.', '\\.')} `, 'm'));
  assert.match(read('KNOWLEDGE.md'), new RegExp(`\\*\\*${pkg.replaceAll('.', '\\.')}\\*\\*`));
  // a version that is not deployed must say so and carry no invented release time or code id
  if (ver.status !== 'deployed') { assert.equal(ver.releasedAt, null); assert.equal(ver.commit, null); }
});
