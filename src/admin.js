// Tenant admin: settings, earning rules, webhooks, freeze, audit, health. Every change is audited.
import { ApiError, newId, int, str } from './util.js';
import { getSettings, setSettings, seedDefaults } from './settings.js';
import { audit, verifyAudit } from './audit.js';
import { verifyChain, verifyBalances } from './ledger.js';
import { setFrozen } from './accounts.js';
import { addEndpoint } from './outbox.js';
import { expireLots } from './wallet.js';
import { sweepHolds } from './spend.js';
import { createApiKey } from './auth.js';
import { isVisitLike } from './wallet.js';
import { reconcile } from './reconcile.js';
import { processRail, expireOrders, railHealth, fxHealth } from './gate.js';
import { expireApprovals } from './ai.js';

/** Owner/CLI use only (not an API route): makes a tenant with default settings and two keys. */
export async function createTenant(ctx, { id, name }) {
  const tid = id || newId('ten');
  await ctx.db.run('INSERT INTO tenant (id, name, created_at) VALUES (?,?,?)', tid, str(name, 'name', { max: 80 }), ctx.now());
  const c = { ...ctx, tenantId: tid, _settings: null };
  await seedDefaults(c);
  await audit({ ...c, actor: 'owner-cli', callerType: 'owner' }, 'tenant.create', { name });
  const sub = { ...c, actor: 'owner-cli', callerType: 'owner' };
  return {
    tenant_id: tid,
    api: await createApiKey(sub, { scope: 'api', label: 'product server (spend, events)' }),
    read: await createApiKey(sub, { scope: 'read', label: 'balance read-only' }),
    purchase: await createApiKey(sub, { scope: 'purchase', label: 'payment system (credit bought, money refunds)' }),
    admin: await createApiKey(sub, { scope: 'admin', label: 'tenant admin' }),
    ai_read: await createApiKey(sub, { scope: 'ai_read', label: 'AI assistant: reads and asks only' }),
  };
}

const BUCKETS = ['bonus', 'commission'];
const MODES = ['once', 'capped', 'every'];

function cleanRule(b, existing = null) {
  const r = { ...(existing || {}), ...b };
  if (typeof r.event_type !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(r.event_type)) throw new ApiError(400, 'bad_rule', 'event_type: lower-case letters, digits, underscore.');
  if (isVisitLike(r.event_type)) throw new ApiError(422, 'no_credit_for_visits', 'Plain visits, views, logins and clicks never earn credit.');
  if (!BUCKETS.includes(r.bucket)) throw new ApiError(400, 'bad_rule', "bucket must be 'bonus' or 'commission'.");
  r.amount_type = r.amount_type || 'fixed';
  if (!['fixed', 'pct_cash_bps'].includes(r.amount_type)) throw new ApiError(400, 'bad_rule', "amount_type must be 'fixed' or 'pct_cash_bps'.");
  if (r.bucket === 'commission' && r.amount_type !== 'pct_cash_bps') throw new ApiError(422, 'commission_needs_cash', 'Commission can only be a percent of cash received.');
  if (r.amount_type === 'pct_cash_bps') {
    if (r.bucket !== 'commission') throw new ApiError(400, 'bad_rule', 'Percent-of-cash rules pay commission only.');
    int(r.amount, 'amount', { min: 1, max: 10000 });
  } else {
    int(r.amount, 'amount', { min: 1, max: 1000000 });
  }
  if (!MODES.includes(r.mode)) throw new ApiError(400, 'bad_rule', 'mode must be once, capped or every.');
  r.max_count = r.max_count ?? null;
  r.lifetime_cap = r.lifetime_cap ?? null;
  r.expiry_days = r.expiry_days ?? null;
  if (r.mode === 'capped') int(r.max_count, 'max_count', { min: 1, max: 1000 });
  if (r.lifetime_cap != null) int(r.lifetime_cap, 'lifetime_cap', { min: 1, max: 100000000 });
  if (r.expiry_days != null) int(r.expiry_days, 'expiry_days', { min: 0, max: 3650 });
  // A free bonus that can repeat for ever is a hidden discount: a lifetime cap is compulsory.
  if (r.bucket === 'bonus' && r.mode === 'every' && r.lifetime_cap == null) throw new ApiError(422, 'cap_required', 'Unlimited-repeat bonus rules need a lifetime cap.');
  r.enabled = r.enabled === 0 || r.enabled === false ? 0 : 1;
  return r;
}

export async function listRules(ctx) {
  return { rules: await ctx.db.all('SELECT * FROM earning_rule WHERE tenant_id = ? ORDER BY created_at, event_type', ctx.tenantId) };
}

export async function createRule(ctx, b) {
  const r = cleanRule(b);
  const id = newId('rule');
  try {
    await ctx.db.run(
      'INSERT INTO earning_rule (id, tenant_id, event_type, bucket, amount_type, amount, mode, max_count, lifetime_cap, expiry_days, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, r.event_type, r.bucket, r.amount_type, r.amount, r.mode, r.max_count, r.lifetime_cap, r.expiry_days, r.enabled, ctx.now(), ctx.now(),
    );
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new ApiError(409, 'rule_exists', 'A rule for this event already exists. Edit it instead.');
    throw e;
  }
  await audit(ctx, 'rule.create', { id, ...r });
  return { id };
}

export async function updateRule(ctx, id, b) {
  const old = await ctx.db.first('SELECT * FROM earning_rule WHERE tenant_id = ? AND id = ?', ctx.tenantId, id);
  if (!old) throw new ApiError(404, 'no_rule', 'No such rule.');
  const r = cleanRule({ ...b, event_type: old.event_type }, old);
  await ctx.db.run(
    'UPDATE earning_rule SET bucket=?, amount_type=?, amount=?, mode=?, max_count=?, lifetime_cap=?, expiry_days=?, enabled=?, updated_at=? WHERE id = ? AND tenant_id = ?',
    r.bucket, r.amount_type, r.amount, r.mode, r.max_count, r.lifetime_cap, r.expiry_days, r.enabled, ctx.now(), id, ctx.tenantId,
  );
  await audit(ctx, 'rule.update', { id, from: old, to: r });
  return { id };
}

export async function disableRule(ctx, id) {
  const r = await ctx.db.run('UPDATE earning_rule SET enabled = 0, updated_at = ? WHERE id = ? AND tenant_id = ?', ctx.now(), id, ctx.tenantId);
  if (r.changes !== 1) throw new ApiError(404, 'no_rule', 'No such rule.');
  await audit(ctx, 'rule.disable', { id });
  return { id, enabled: 0 };
}

export async function freeze(ctx, b) {
  const frozen = b.frozen !== false;
  const acc = await setFrozen(ctx, b.email, frozen);
  await audit(ctx, frozen ? 'account.freeze' : 'account.unfreeze', { account_id: acc.id });
  return { account_id: acc.id, status: frozen ? 'frozen' : 'active' };
}

export async function addWebhook(ctx, b) {
  const w = await addEndpoint(ctx, str(b.url, 'url', { max: 300 }));
  let host = '?';
  try { host = new URL(b.url).hostname; } catch {}
  await audit(ctx, 'webhook.add', { id: w.id, host });
  return w; // secret shown once
}

export async function health(ctx) {
  return { chain: await verifyChain(ctx), audit: await verifyAudit(ctx), balance_mismatches: await verifyBalances(ctx), rail: await railHealth(ctx), fx: await fxHealth(ctx), dead_letters: (await ctx.db.first("SELECT COUNT(*) n FROM rail_outbox WHERE tenant_id = ? AND status = 'dead'", ctx.tenantId)).n };
}

export async function sweep(ctx) {
  const holds = await sweepHolds(ctx);
  const lots = await expireLots(ctx);
  const rail = await processRail(ctx, ctx.rail);
  const orders = await expireOrders(ctx);
  const approvals = await expireApprovals(ctx);
  await ctx.db.run('DELETE FROM idempotency WHERE tenant_id = ? AND created_at < ?', ctx.tenantId, ctx.now() - 30 * 86400000);
  await audit(ctx, 'sweep', { holds, lots, rail, orders, approvals });
  return { holds, lots, rail, orders, approvals };
}

export { reconcile };

export async function auditList(ctx, limit = 100) {
  return { entries: await ctx.db.all('SELECT seq, ts, actor, caller_type, key_id, action, detail FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?', ctx.tenantId, Math.min(Math.max(limit | 0, 1), 500)) };
}

export { getSettings, setSettings };
