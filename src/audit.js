import { sha256Hex } from './util.js';

/** Hash-chained record of every admin/setting change. ctx.actor names who did it. */
export async function audit(ctx, action, detail = {}) {
  const last = await ctx.db.first('SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', ctx.tenantId);
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? 'GENESIS';
  const ts = ctx.now();
  const actor = ctx.actor || 'system';
  const d = JSON.stringify(detail);
  const hash = await sha256Hex(JSON.stringify([ctx.tenantId, seq, ts, actor, action, d, prev]));
  await ctx.db.run('INSERT INTO audit_log (tenant_id, seq, ts, actor, action, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)', ctx.tenantId, seq, ts, actor, action, d, prev, hash);
}

export async function verifyAudit(ctx) {
  const rows = await ctx.db.all('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq', ctx.tenantId);
  let prev = 'GENESIS';
  let n = 0;
  for (const r of rows) {
    n++;
    const h = await sha256Hex(JSON.stringify([r.tenant_id, r.seq, r.ts, r.actor, r.action, r.detail, prev]));
    if (r.seq !== n || r.prev_hash !== prev || r.hash !== h) return { ok: false, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, entries: n };
}
