// Event outbox. Events are written in the same transaction as the money change.
// A separate drain step delivers them (signed) to the tenant's webhook endpoints.
import { newId, hmacHex, ApiError, MIN } from './util.js';

export async function emit(ctx, type, payload) {
  const id = newId('evt');
  await ctx.db.run(
    'INSERT INTO outbox (id, tenant_id, type, payload, created_at, next_at) VALUES (?,?,?,?,?,?)',
    id, ctx.tenantId, type, JSON.stringify(payload), ctx.now(), ctx.now(),
  );
  return id;
}

export const webhookSecret = (master, endpointId) => hmacHex(master, `mnp-wh:${endpointId}`);

export async function addEndpoint(ctx, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ApiError(400, 'bad_url', 'Webhook address is not valid.');
  }
  if (u.username || u.password) throw new ApiError(400, 'bad_url', 'Webhook address must not carry a user name or password.');
  const h = u.hostname.replace(/\.+$/, '').toLowerCase(); // "example.com." is the same host as "example.com"
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new ApiError(400, 'bad_url', 'Webhook address must be https.');
  // never aim a server-side call at private or internal addresses (localhost http stays allowed for local development)
  // The sender that really makes the call must ALSO check the resolved IP address (a name can point inside).
  const blockedName = /(^|\.)(local|internal|lan|home|corp|intranet|private|localdomain|localhost)$/.test(h) || /^localhost(\.|$)/.test(h) || /(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|traefik\.me|vcap\.me|1u\.ms|metadata\.google\.internal)$/.test(h);
  if (!local && (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[') || h.includes(':') || blockedName || !h.includes('.'))) throw new ApiError(400, 'bad_url', 'Webhook address must be a public host name.');
  const id = newId('whk');
  await ctx.db.run('INSERT INTO webhook_endpoint (id, tenant_id, url, created_at) VALUES (?,?,?,?)', id, ctx.tenantId, url, ctx.now());
  return { id, secret: await webhookSecret(ctx.master, id) };
}

/** Sends due events. `send(url, {headers, body})` returns {status}. Retries with back-off, gives up after 10. */
export async function drain(ctx, send, { limit = 50 } = {}) {
  const due = await ctx.db.all("SELECT * FROM outbox WHERE tenant_id = ? AND status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT ?", ctx.tenantId, ctx.now(), limit);
  let sent = 0;
  for (const ev of due) {
    const eps = await ctx.db.all("SELECT * FROM webhook_endpoint WHERE tenant_id = ? AND status = 'active'", ev.tenant_id);
    if (!eps.length) continue; // nowhere to send yet; keep it
    const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.created_at, data: JSON.parse(ev.payload) });
    let ok = true;
    let err = null;
    for (const ep of eps) {
      const ts = String(ctx.now());
      const sig = await hmacHex(await webhookSecret(ctx.master, ep.id), `${ts}.${body}`);
      try {
        const r = await send(ep.url, { headers: { 'content-type': 'application/json', 'x-mnp-event-id': ev.id, 'x-mnp-timestamp': ts, 'x-mnp-signature': sig }, body });
        if (r.status < 200 || r.status >= 300) throw new Error(`status ${r.status}`);
      } catch (e) {
        ok = false;
        err = String(e.message).slice(0, 200);
      }
    }
    if (ok) {
      await ctx.db.run("UPDATE outbox SET status = 'sent', attempts = attempts + 1 WHERE id = ?", ev.id);
      sent++;
    } else {
      const attempts = ev.attempts + 1;
      await ctx.db.run('UPDATE outbox SET status = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?', attempts >= 10 ? 'failed' : 'pending', attempts, ctx.now() + Math.min(2 ** attempts, 360) * MIN, err, ev.id);
    }
  }
  return { sent, tried: due.length };
}
