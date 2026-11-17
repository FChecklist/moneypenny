// Append-only hash-chained ledger + helpers that keep it equal to the lots.
import { sha256Hex, newId } from './util.js';

const hashOf = (e) =>
  sha256Hex(JSON.stringify([e.tenant_id, e.seq, e.id, e.ts, e.account_id, e.bucket, e.delta, e.kind, e.ref, e.lot_id, e.idem, e.meta, e.prev_hash]));

export async function post(ctx, { accountId, bucket, delta, kind, ref = null, lotId = null, meta = null }) {
  const last = await ctx.db.first('SELECT seq, hash FROM entry WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', ctx.tenantId);
  const e = {
    tenant_id: ctx.tenantId,
    seq: (last?.seq ?? 0) + 1,
    id: newId('ent'),
    ts: ctx.now(),
    account_id: accountId,
    bucket,
    delta,
    kind,
    ref,
    lot_id: lotId,
    idem: ctx.idem ?? null,
    meta: meta ? JSON.stringify(meta) : null,
    prev_hash: last?.hash ?? 'GENESIS',
  };
  e.hash = await hashOf(e);
  await ctx.db.run(
    'INSERT INTO entry (tenant_id, seq, id, ts, account_id, bucket, delta, kind, ref, lot_id, idem, meta, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    e.tenant_id, e.seq, e.id, e.ts, e.account_id, e.bucket, e.delta, e.kind, e.ref, e.lot_id, e.idem, e.meta, e.prev_hash, e.hash,
  );
  return e;
}

/** Re-computes every hash. Any edit, removal or reorder shows up as broken_at. */
export async function verifyChain(ctx) {
  const rows = await ctx.db.all('SELECT * FROM entry WHERE tenant_id = ? ORDER BY seq', ctx.tenantId);
  let prev = 'GENESIS';
  let n = 0;
  for (const r of rows) {
    n++;
    if (r.seq !== n || r.prev_hash !== prev || r.hash !== (await hashOf(r))) return { ok: false, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, entries: n };
}

/** Ledger sum must equal lots (per account and bucket). Returns mismatches (empty = healthy). */
export async function verifyBalances(ctx) {
  const rows = await ctx.db.all(
    `SELECT a.account_id, a.bucket, a.s AS ledger, COALESCE(l.s, 0) AS lots FROM
       (SELECT account_id, bucket, SUM(delta) s FROM entry WHERE tenant_id = ? GROUP BY account_id, bucket) a
     LEFT JOIN (SELECT account_id, bucket, SUM(remaining) s FROM lot WHERE tenant_id = ? GROUP BY account_id, bucket) l
       ON l.account_id = a.account_id AND l.bucket = a.bucket
     WHERE a.s != COALESCE(l.s, 0)`,
    ctx.tenantId, ctx.tenantId,
  );
  return rows;
}
