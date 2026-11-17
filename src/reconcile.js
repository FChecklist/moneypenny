// Reconcile: what credits are still owed (liability), and where conversions stand.
import { verifyChain, verifyBalances } from './ledger.js';

const zero = () => ({ bought: 0, bonus: 0, commission: 0 });

export async function reconcile(ctx) {
  const now = ctx.now();
  const out = { tenant_id: ctx.tenantId, outstanding: zero(), held_in_orders: zero(), expired_not_yet_swept: zero(), in_conversion: 0, conversions: {} };
  for (const r of await ctx.db.all('SELECT bucket, remaining, expires_at FROM lot WHERE tenant_id = ? AND remaining > 0', ctx.tenantId)) {
    if (r.expires_at != null && r.expires_at <= now) out.expired_not_yet_swept[r.bucket] += r.remaining;
    else out.outstanding[r.bucket] += r.remaining;
  }
  for (const r of await ctx.db.all("SELECT p.bucket, SUM(p.amount) c FROM hold h JOIN hold_part p ON p.hold_id = h.id WHERE h.tenant_id = ? AND h.status = 'held' GROUP BY p.bucket", ctx.tenantId)) out.held_in_orders[r.bucket] = r.c;
  for (const r of await ctx.db.all('SELECT status, COUNT(*) n, SUM(credits) credits, SUM(gross_minor) gross_minor, SUM(tds_minor) tds_minor, SUM(net_minor) net_minor, currency FROM conversion_request WHERE tenant_id = ? GROUP BY status, currency', ctx.tenantId)) {
    out.conversions[`${r.status}:${r.currency}`] = { n: r.n, credits: r.credits, gross_minor: r.gross_minor, tds_minor: r.tds_minor, net_minor: r.net_minor, currency: r.currency };
    if (['requested', 'approved', 'instructed'].includes(r.status)) out.in_conversion += r.credits;
  }
  const sum = (o) => o.bought + o.bonus + o.commission;
  // Credits we still owe in kind or in cash: usable now + parked in orders + queued for conversion.
  out.liability_credits = sum(out.outstanding) + sum(out.held_in_orders) + out.in_conversion;
  // a full ledger scan is for people (admin health); an AI key gets the numbers only
  out.ledger = ctx.scope === 'ai_read' ? { skipped: 'full check is for people' } : { chain: await verifyChain(ctx), mismatches: await verifyBalances(ctx) };
  return out;
}

/** Owner view across every tenant. */
export async function reconcileAll(db, now = Date.now) {
  const tenants = await db.all('SELECT id FROM tenant ORDER BY id');
  const per = [];
  for (const t of tenants) per.push(await reconcile({ db, now, tenantId: t.id }));
  const total = { outstanding: zero(), held_in_orders: zero(), in_conversion: 0, conversions: {}, liability_credits: 0 };
  for (const p of per) {
    for (const b of Object.keys(total.outstanding)) {
      total.outstanding[b] += p.outstanding[b];
      total.held_in_orders[b] += p.held_in_orders[b];
    }
    total.liability_credits += p.liability_credits;
    total.in_conversion += p.in_conversion;
    for (const [k, v] of Object.entries(p.conversions)) {
      const t = (total.conversions[k] ||= { n: 0, credits: 0, gross_minor: 0, tds_minor: 0, net_minor: 0, currency: v.currency });
      for (const f of ['n', 'credits', 'gross_minor', 'tds_minor', 'net_minor']) t[f] += v[f];
    }
  }
  return { by_tenant: per, total };
}
