// Signed calls. Header set: x-mnp-key, x-mnp-timestamp (ms), x-mnp-nonce, x-mnp-signature.
// signature = HMAC-SHA256(secret, [ts, nonce, METHOD, path+query, sha256(body)].join("\n")), hex.
// secret = HMAC-SHA256(MNP_MASTER_SECRET, "mnp-key:" + key_id). Never stored anywhere.
import { ApiError, hmacHex, sha256Hex, safeEqual, newId, MIN } from './util.js';

export const keySecret = (master, keyId) => hmacHex(master, `mnp-key:${keyId}`);
export const signString = (ts, nonce, method, pathQuery, bodyHash) => [ts, nonce, method.toUpperCase(), pathQuery, bodyHash].join('\n');

export async function createApiKey(ctx, { scope, label = null }) {
  const keyId = newId('mk').slice(0, 21);
  await ctx.db.run('INSERT INTO api_key (key_id, tenant_id, scope, label, created_at) VALUES (?,?,?,?,?)', keyId, ctx.tenantId, scope, label, ctx.now());
  return { key_id: keyId, secret: await keySecret(ctx.master, keyId), scope };
}

const MAX_SKEW = 5 * MIN;

/** Returns {tenantId, scope, keyId}. Writes the nonce and rate counter, so call it in its own transaction. */
export async function authenticate(ctx, headers, method, pathQuery, rawBody, rateLimitFor) {
  const keyId = headers.get('x-mnp-key');
  const ts = headers.get('x-mnp-timestamp');
  const nonce = headers.get('x-mnp-nonce');
  const sig = headers.get('x-mnp-signature');
  if (!keyId || !ts || !nonce || !sig || nonce.length > 100) throw new ApiError(401, 'unsigned', 'Signed headers are missing.');
  const row = await ctx.db.first('SELECT k.*, t.status tstatus FROM api_key k JOIN tenant t ON t.id = k.tenant_id WHERE k.key_id = ?', keyId);
  const secret = await keySecret(ctx.master, keyId);
  const expect = await hmacHex(secret, signString(ts, nonce, method, pathQuery, await sha256Hex(rawBody)));
  // Same answer for unknown key and bad signature.
  if (!row || row.status !== 'active' || row.tstatus !== 'active' || !safeEqual(expect, sig)) throw new ApiError(401, 'bad_signature', 'Signature not accepted.');
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(ctx.now() - t) > MAX_SKEW) throw new ApiError(401, 'stale_timestamp', 'Timestamp is too old or too new.');
  try {
    await ctx.db.run('INSERT INTO nonce (key_id, nonce, ts) VALUES (?,?,?)', keyId, nonce, t);
  } catch {
    throw new ApiError(401, 'replayed', 'This request was already used.');
  }
  await ctx.db.run('DELETE FROM nonce WHERE ts < ?', ctx.now() - 2 * MAX_SKEW);
  const win = Math.floor(ctx.now() / MIN);
  await ctx.db.run('INSERT INTO rate_limit (key_id, window, n) VALUES (?,?,1) ON CONFLICT(key_id, window) DO UPDATE SET n = n + 1', keyId, win);
  await ctx.db.run('DELETE FROM rate_limit WHERE window < ?', win - 5);
  const r = await ctx.db.first('SELECT n FROM rate_limit WHERE key_id = ? AND window = ?', keyId, win);
  const limit = await rateLimitFor(row.tenant_id);
  if (r.n > limit) return { limited: true }; // returned (not thrown) so the counter is kept
  return { tenantId: row.tenant_id, scope: row.scope, keyId };
}
