import { sha256Hex } from './util.js';

/** Hash-chained record of every admin/setting change. ctx.actor names who did it. */
export async function audit(ctx, action, detail = {}) {
  const last = await ctx.db.first('SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', ctx.tenantId);
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? 'GENESIS';
  const ts = ctx.now();
  const actor = ctx.actor || 'system';
  const d = JSON.stringify(detail);
  const caller = ctx.callerType || 'system'; // ai, product, payment, human, owner or system
  const keyId = ctx.keyId || null;
  const hash = await sha256Hex(JSON.stringify([ctx.tenantId, seq, ts, actor, action, d, prev, caller, keyId]));
  await ctx.db.run('INSERT INTO audit_log (tenant_id, seq, ts, actor, action, detail, prev_hash, hash, caller_type, key_id) VALUES (?,?,?,?,?,?,?,?,?,?)', ctx.tenantId, seq, ts, actor, action, d, prev, hash, caller, keyId);
}

export async function verifyAudit(ctx) {
  const rows = await ctx.db.all('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq', ctx.tenantId);
  let prev = 'GENESIS';
  let n = 0;
  for (const r of rows) {
    n++;
    const h = await sha256Hex(JSON.stringify([r.tenant_id, r.seq, r.ts, r.actor, r.action, r.detail, prev, r.caller_type, r.key_id]));
    if (r.seq !== n || r.prev_hash !== prev || r.hash !== h) return { ok: false, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, entries: n };
}
