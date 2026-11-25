// Payee health (chunk F8): a read-only view per payee. DARK behind the payee flag (read-only gate, so it works while setup is incomplete).
// Shows the payee's gateway and mode, whether each secret NAME is present (true/false only, never a value),
// when the last gateway event was seen, how many events were ignored, and how many orders wait in pending_rail.
// It writes nothing, not even an audit row. No gateway is called.
import { gate, requireOwner, secretPresence, SECRET_KEYS } from './payees.js';
import { ApiError } from './util.js';

export async function payeeHealth(ctx, id) {
  await gate(ctx, undefined, true);
  requireOwner(ctx, 'see payee health');
  const p = await ctx.db.first('SELECT payee_id, display_name, gateway, mode, status, secret_names FROM payee_account WHERE payee_id = ?', id);
  if (!p) throw new ApiError(404, 'payee_not_found', 'No such payee.');
  let names = {};
  try { const v = JSON.parse(p.secret_names || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) names = v; } catch { /* unreadable counts as none */ }
  const pres = secretPresence(ctx, names);
  const secrets = Object.fromEntries(SECRET_KEYS.map((k) => [k, { name: names[k] ?? null, present: pres.found[k] === true }]));
  const ev = await ctx.db.first("SELECT MAX(received_at) last_seen, SUM(CASE WHEN outcome = 'ignored' THEN 1 ELSE 0 END) ignored FROM payee_event WHERE payee_id = ?", id);
  const st = await ctx.db.first("SELECT COUNT(*) n, MIN(created_at) oldest FROM purchase_order WHERE payee_id = ? AND status = 'pending_rail'", id);
  return {
    payee_id: p.payee_id, display_name: p.display_name, gateway: p.gateway, mode: p.mode, status: p.status,
    secrets, secrets_ok: pres.ok && SECRET_KEYS.every((k) => names[k]),
    last_webhook_at: ev?.last_seen ?? null, ignored_events: Number(ev?.ignored ?? 0),
    pending_rail_orders: Number(st?.n ?? 0), oldest_pending_rail_at: st?.oldest ?? null,
  };
}
