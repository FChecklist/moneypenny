// Guard check (a "mutation" check). For each safety guard below it makes a throw-away copy of the repo, removes
// ONLY that guard, runs the whole test suite, and demands that at least one test fails.
// A guard that can be removed without any test noticing is a hole: this script then exits with an error.
// It never changes your working tree: all edits happen in a temporary copy.
//
// Usage:  npm run guards            (all guards, about two minutes)
//         node scripts/guard-check.js money-idem-required   (one guard by id)
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CENTRAL_GUARDS } from './guards-central.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// [id, what the guard does, file, exact text to find (must occur exactly once), replacement]
export const GUARDS = [
  // --- idempotency of every money write
  ['idem-required', 'every write needs an Idempotency-Key', 'src/api.js', "if (route[3] && (!idem || idem.length > 120)) throw", 'if (false) throw'],
  ['idem-replay', 'same key and same request returns the first answer, never a second write', 'src/api.js', 'return { status: prior.status, text: prior.response, replay: true };', 'void 0;'],
  ['idem-conflict', 'same key with a different request is refused (409)', 'src/api.js', 'if (prior.req_hash !== reqHash) throw', 'if (false) throw'],
  ['idem-pay-namespace', 'keys starting "pay:" belong to payment ids only', 'src/api.js', "if (idem && idem.startsWith('pay:') && !(", "if (false && idem && idem.startsWith('pay:') && !("],
  ['idem-signed', 'the Idempotency-Key header is part of the signature', 'src/auth.js', 'bodyHash, idem].join', 'bodyHash].join'],
  ['payment-once', 'one payment id is used once (purchase, order cash)', 'src/wallet.js', "if (isUniqueError(e)) throw new ApiError(409, kind === 'order'", "if (false) throw new ApiError(409, kind === 'order'"],
  ['payment-claim', 'a purchase claims its payment id', 'src/wallet.js', "await claimPaymentRef(ctx, payRef, 'purchase');", ''],
  ['order-repeat', 'buy_credits with the same order_ref returns the same order', 'src/gate.js', 'if (prior) {', 'if (false) {'],
  ['order-paid-once', 'an order paid once cannot be paid again with another payment', 'src/gate.js', "if (o.status === 'paid') {", "if (false) {"],
  ['capture-once', 'a hold is captured once', 'src/spend.js', "if (h.status === 'captured') throw new ApiError(409, 'hold_already_captured', 'This hold was already captured.');\n  if (h.status === 'released')", "if (false) throw new ApiError(409, 'hold_already_captured', 'This hold was already captured.');\n  if (h.status === 'released')"],
  ['reserve-repeat', 'a repeated reserve_item returns the same hold', 'src/spend.js', 'if (open && acc && open.account_id === acc.id && open.product === product', 'if (false && open && acc && open.account_id === acc.id && open.product === product'],
  ['reserve-paid-order', 'a completed order cannot be reserved again (cash reserve)', 'src/spend.js', "return none('account_frozen');\n  const open = await ctx.db.first(\"SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'held'\", ctx.tenantId, orderRef);\n  if (open) throw new ApiError(409, 'order_has_open_hold', 'This order already has a hold. Capture or release it first.');\n  const done = await ctx.db.first(\"SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'\", ctx.tenantId, orderRef);\n  if (done) throw", "return none('account_frozen');\n  const open = await ctx.db.first(\"SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'held'\", ctx.tenantId, orderRef);\n  if (open) throw new ApiError(409, 'order_has_open_hold', 'This order already has a hold. Capture or release it first.');\n  const done = await ctx.db.first(\"SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'\", ctx.tenantId, orderRef);\n  if (false) throw"],
  ['reserve-item-paid-order', 'a completed order cannot be reserved again (credit item)', 'src/spend.js', "  }\n  if (open) throw new ApiError(409, 'order_has_open_hold', 'This order already has a hold. Capture or release it first.');\n  const done = await ctx.db.first(\"SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'\", ctx.tenantId, orderRef);\n  if (done) throw", "  }\n  if (open) throw new ApiError(409, 'order_has_open_hold', 'This order already has a hold. Capture or release it first.');\n  const done = await ctx.db.first(\"SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'\", ctx.tenantId, orderRef);\n  if (false) throw"],
  // --- whole numbers only, no float
  ['int-only', 'money fields must be whole numbers', 'src/util.js', 'if (!Number.isInteger(v) || v < min || v > max)', 'if (v < min || v > max)'],
  ['int-max', 'money fields have an upper limit', 'src/util.js', 'if (!Number.isInteger(v) || v < min || v > max)', 'if (!Number.isInteger(v) || v < min)'],
  ['pack-ints', 'pack prices are whole numbers', 'src/settings.js', 'Number.isSafeInteger(value[k]) && value[k] >= 100', 'value[k] >= 100'],
  // --- amounts must match
  ['pay-underpaid', 'a payment below the order amount is refused', 'src/gate.js', 'if (paid < o.amount_minor) throw', 'if (false) throw'],
  ['pay-currency', 'a payment in another currency is refused', 'src/gate.js', 'if (b.currency !== o.currency) throw', 'if (false) throw'],
  ['pay-exceeds', 'no more credits than the payment covers', 'src/wallet.js', 'if (!fixedPrice && creditsFromMinor(s, currency, paidMinor) < amount) throw', 'if (false) throw'],
  ['pay-reversed', 'a charged-back payment cannot buy credits', 'src/wallet.js', "if (await ctx.db.first('SELECT 1 x FROM charged_back WHERE tenant_id = ? AND payment_ref = ?', ctx.tenantId, payRef)) throw new ApiError(409, 'payment_reversed', 'That payment was taken back.');\n  if (!fixedPrice", "if (!fixedPrice"],
  ['capture-underpaid', 'cash paid on a capture must cover the cash due', 'src/spend.js', "if (int(b.cash_paid_minor, 'cash_paid_minor', { min: 1 }) < h.cash_due_minor) throw", 'if (false) throw'],
  // --- ledger: append-only and hash-chained
  ['chain-link', 'the chain check compares each link and hash', 'src/ledger.js', 'if (r.seq !== n || r.prev_hash !== prev || r.hash !== (await hashOf(r)))', 'if (false)'],
  ['chain-covers-delta', 'the entry hash covers the amount', 'src/ledger.js', 'e.bucket, e.delta, e.kind, e.ref, e.lot_id, e.idem, e.meta,\n      e.rate_cpu', 'e.bucket, e.kind, e.ref, e.lot_id, e.idem, e.meta,\n      e.rate_cpu'],
  ['ledger-append-only', 'ledger rows cannot be updated or deleted', 'migrations/0001_init.sql', "CREATE TRIGGER entry_no_update BEFORE UPDATE ON entry BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;", ''],
  ['ledger-no-delete', 'ledger rows cannot be deleted', 'migrations/0001_init.sql', "CREATE TRIGGER entry_no_delete BEFORE DELETE ON entry BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;", ''],
  // --- replay protection and signing
  ['replay-nonce', 'a signed request works once (nonce)', 'src/auth.js', "await ctx.db.run('INSERT INTO nonce (key_id, nonce, ts) VALUES (?,?,?)', keyId, nonce, t);", ''],
  ['replay-window', 'a signed request is only good for 5 minutes', 'src/auth.js', 'Math.abs(ctx.now() - t) > MAX_SKEW', 'false'],
  ['sig-precheck', 'forged calls are refused before they reach the single writer', 'src/api.js', 'await precheckSignature(master, request.headers, method, pathQuery, raw);', ''],
  ['sig-precheck-compare', 'the pre-check compares the signature', 'src/auth.js', 'if (!safeEqual(expect, sig)) throw new ApiError(401, \'bad_signature\', \'Signature not accepted.\');\n}', '}'],
  ['key-revoked', 'a revoked key stops working', 'src/auth.js', "!row || row.status !== 'active' || row.tstatus !== 'active' ||", '!row ||'],
  ['key-class', 'a key can only use the routes of its own class', 'src/api.js', 'if (!route[2].includes(auth.scope)) throw', 'if (false) throw'],
  ['setup-replay', 'the owner setup call works once', 'src/api.js', "if (!fresh) return json(403,", "if (false) return json(403,"],
  // --- rate limits and size
  ['rate-limit', 'a key has a calls-per-minute limit', 'src/auth.js', 'if (r.n > limit) return { limited: true };', ''],
  ['rate-limit-answer', 'a limited call gets 429', 'src/api.js', "if (auth.limited) throw", 'if (false) throw'],
  ['body-cap', 'a huge body is cut off', 'src/api.js', 'if (n > cap) {', 'if (false) {'],
  ['health-rail-cache', 'the open /health asks the rail at most once in 30 seconds', 'src/api.js', 'if (!railSeen ||', 'if (true ||'],
  // --- off-switches
  ['kill-switch', 'the tenant kill switch stops everything but admin', 'src/api.js', "if (set.kill_switch && auth.scope !== 'admin') throw", 'if (false) throw'],
  ['hub-switch', 'the Hub off-switch is checked on every call', 'src/api.js', 'const stop = checkStatus(await app.status().catch(() => null), { op, method, scope: auth.scope });', 'const stop = null;'],
  ['rail-not-configured', 'with no payment side, buy_credits refuses', 'src/gate.js', "if (!ctx.rail || ctx.rail.name === 'not_configured') throw", 'if (false) throw'],
  ['reserve-item-expiry', 'reserve_item (the game path) never spends expired credits', 'src/spend.js', "AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?) AND eligible_at <= ?', ctx.tenantId, acc.id, now, now)\n    : [];\n  const canUseBonus", "AND remaining > 0 AND eligible_at <= ?', ctx.tenantId, acc.id, now)\n    : [];\n  const canUseBonus"],
  ['refund-money-switch', 'the money-refund off-switch refuses a purchase refund', 'src/spend.js', "if (!s.refund_money_enabled) throw", 'if (false) throw'],
  // --- no secrets in logs
  ['log-redact-cut', 'the log text is cut to a safe length before it is scanned', 'src/util.js', '    .slice(0, 2000)\n', ''],
  ['log-redact', 'error logs never carry e-mails or long secrets', 'src/api.js', "console.error('internal error', redact(e && e.message));", "console.error('internal error', e && e.message);"],
  // --- console wallet
  ['wallet-price', 'the console checks the order price equals the quoted pack price', 'packages/console-wallet/index.js', "if (r.body.fixed_price !== true || r.body.amount_minor !== q.body.inr_minor || r.body.credits !== credits) return fail('price_mismatch', 409);", ''],
  ['wallet-spend-key', 'every spend click needs its own key', 'packages/console-wallet/index.js', "typeof spendKey !== 'string' || !ID.test(spendKey)", 'false'],
  ['wallet-capture-first', 'credits are captured before the game step', 'packages/console-wallet/index.js', "else if (row.status === 'captured') next = await stepGrant(row);", "else if (row.status === 'captured') next = 'stop';"],
  ...CENTRAL_GUARDS, // F10 to F13, see scripts/guards-central.js
];

const testFiles = (dir) => readdirSync(join(dir, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => join('test', f));

export function main(only) {
  const dir = mkdtempSync(join(tmpdir(), 'mnp-guards-'));
  cpSync(root, dir, { recursive: true, filter: (p) => !/(^|[\\/])(\.git|node_modules|\.data)([\\/]|$)/.test(p.slice(root.length)) });
  const files = testFiles(dir);
  const base = spawnSync(process.execPath, ['--test', ...files], { cwd: dir, encoding: 'utf8' });
  if (base.status !== 0) { console.error('The untouched copy already fails its tests. Fix that first.'); rmSync(dir, { recursive: true, force: true }); return 2; }
  let survived = 0;
  const rows = [];
  for (const [id, what, file, find, repl] of GUARDS) {
    if (only && id !== only) continue;
    const path = join(dir, file);
    const original = readFileSync(path, 'utf8');
    const n = original.split(find).length - 1;
    if (n !== 1) { rows.push(`BAD   ${id}: the text to remove occurs ${n} times in ${file} (must be exactly 1)`); survived++; continue; }
    writeFileSync(path, original.replace(find, () => repl));
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: dir, encoding: 'utf8' });
    writeFileSync(path, original);
    const failed = [...(r.stdout || '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
    if (r.status === 0) { survived++; rows.push(`HOLE  ${id}: ${what}  <- removed, and every test still passed`); }
    else rows.push(`ok    ${id}: ${what}  (caught by: ${failed.slice(0, 2).map((x) => x.slice(0, 70)).join(' | ') || 'a test file that no longer loads'}${failed.length > 2 ? ` +${failed.length - 2} more` : ''})`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(rows.join('\n'));
  console.log(`\n${rows.length - survived} of ${rows.length} guards are watched by a test. ${survived ? `${survived} NOT watched.` : 'None are unwatched.'}`);
  return survived ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv[2]));
