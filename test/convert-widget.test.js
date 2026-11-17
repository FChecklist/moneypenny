import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bal, event, DAY } from './helpers.js';
import { renderBalance } from '../packages/widget/index.js';
import { scan } from '../scripts/scan-words.js';
import { verifyBalances } from '../src/ledger.js';

const earn = (api, email = 'a@x.com') => event(api, email, 'referral_sale_paid', { payer_email: 'b@y.com', cash_minor: 20000, currency: 'USD' }); // 2000 credits
const conv = (api, credits) => api.post('/v1/convert_request', { email: 'a@x.com', credits });

test('conversion is OFF by default: nothing is recorded', async () => {
  const s = await setup();
  await earn(s.api);
  s.clock.t += 30 * DAY;
  const r = await conv(s.api, 2000);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'conversion_off');
  assert.equal((await s.db.all('SELECT * FROM conversion_request')).length, 0);
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.can_convert, 0);
  assert.equal(b.display.convert_line, null);
});

test('when switched on it needs the tax setting first', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true });
  await earn(s.api);
  s.clock.t += 30 * DAY;
  assert.equal((await conv(s.api, 2000)).body.error.code, 'conversion_not_configured');
});

test('hold, minimum and amount rules; request only records, never pays', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000, conversion_hold_days: 14 });
  await earn(s.api);
  assert.equal((await bal(s.api, 'a@x.com')).can_convert, 0); // still settling
  s.clock.t += 8 * DAY; // spendable, but conversion hold (14 days) not over
  assert.equal((await bal(s.api, 'a@x.com')).can_convert, 0);
  assert.equal((await conv(s.api, 2000)).body.error.code, 'more_than_convertible');
  s.clock.t += 7 * DAY;
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.can_convert, 2000);
  assert.equal(b.display.convert_line, 'You can convert 2,000 Moneypenny = US$20.00');
  assert.equal((await conv(s.api, 1000)).body.error.code, 'below_minimum'); // min 1500
  assert.equal((await conv(s.api, 2500)).body.error.code, 'more_than_convertible');
  const ok = await conv(s.api, 1600);
  assert.equal(ok.body.status, 'requested');
  assert.match(ok.body.note, /No payout/);
  const after = await bal(s.api, 'a@x.com');
  assert.equal(after.can_convert, 0); // 400 left is under the 1,500 minimum
  assert.equal((await conv(s.api, 1500)).body.error.code, 'more_than_convertible'); // cannot request the same credits twice
  const terms = JSON.parse((await s.db.all('SELECT terms FROM conversion_request'))[0].terms);
  assert.equal(terms.tds_rate_bps, 1000);
  const tables = (await s.db.all("SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
  assert.ok(!tables.some((n) => /payout/.test(n)));
  assert.deepEqual(await verifyBalances(s.ctx()), []);
});

test('bought and bonus credits can never be converted', async () => {
  const s = await setup();
  await s.admin.put('/v1/admin/settings', { conversion_enabled: true, tds_rate_bps: 1000, conversion_min_credits: 10 });
  await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 9000, paid_minor: 9000, currency: 'USD', payment_ref: 'p' });
  await event(s.api, 'a@x.com', 'account_created');
  s.clock.t += 30 * DAY;
  const b = await bal(s.api, 'a@x.com');
  assert.equal(b.can_convert, 0);
  assert.equal((await conv(s.api, 100)).body.error.code, 'more_than_convertible');
});

// ---------- widget / theme ----------
test('widget shows one number and an optional convert line, and escapes everything', async () => {
  const s = await setup();
  const b = await bal(s.api, 'a@x.com');
  const html = renderBalance(b.display);
  assert.match(html, /Moneypenny/);
  assert.match(html, /<svg /); // the built-in coin icon
  assert.match(html, /<\/span> 0</);
  assert.ok(!html.includes('mnp-line'));
  const evil = renderBalance({ label: '<script>x</script>', amount: '1', convert_line: '"><img src=x>', theme: { name: 'office', accent: 'red' } });
  assert.ok(!evil.includes('<script>') && !evil.includes('<img'));
  assert.match(evil, /--mnp-accent:#0b6b57/); // bad colour falls back
});

test('theme off gives identical balances; the skin only changes the look', async () => {
  const s = await setup();
  await s.api.pay.post('/v1/credit_purchase', { email: 'a@x.com', bucket: 'bought', amount: 1240, paid_minor: 1240, currency: 'USD', payment_ref: 'p' });
  const on = await bal(s.api, 'a@x.com');
  await s.admin.put('/v1/admin/settings', { theme_enabled: false });
  const off = await bal(s.api, 'a@x.com');
  assert.equal(on.balance, off.balance);
  assert.equal(on.display.amount, off.display.amount);
  assert.ok(on.display.theme && off.display.theme === null);
  assert.ok(renderBalance(on.display).includes('data-theme="classic"'));
  assert.ok(!renderBalance(off.display).includes('data-theme'));
});

test('product name is one setting', async () => {
  const s = await setup();
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.product_name, 'Corporate Moneypenny');
  await s.admin.put('/v1/admin/settings', { product_name: 'Acme Points' });
  assert.equal((await s.admin.get('/v1/admin/settings')).body.settings.product_name, 'Acme Points');
});

test('no forbidden words (other brands, wrong wording) in any shipped file', () => {
  assert.deepEqual(scan('.'), []);
});

test('no secrets or keys committed: no long hex/base64 strings in source', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const bad = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (['node_modules', '.git', '.data'].includes(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|json|toml|md|sql)$/.test(n) && /[0-9a-f]{40,}|AKIA[0-9A-Z]{12,}|rzp_(live|test)_[A-Za-z0-9]{8,}/.test(readFileSync(p, 'utf8'))) bad.push(p);
    }
  };
  walk('.');
  assert.deepEqual(bad, []);
});
