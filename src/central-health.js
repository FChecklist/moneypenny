// Health of a central payee (chunk F13). DARK: needs both flags. Owner only, read-only, writes nothing.
// Says, for one payee whose gateway is itservices_central: which of its three secret NAMES are present (true or false), whether the
// address variable is set and well formed (true or false), and whether the central service answers its liveness call.
// Never a secret value, never the address itself, never the answer text of the other side.
import { ApiError } from './util.js';
import { gate, requireOwner, secretPresence, view } from './payees.js';
import { gatewayFor } from './gateways/index.js';
import { GATEWAY_NAME, BASE_NAME, checkBaseUrl } from './gateways/itservices-central.js';
import { makeSecretReader } from './secrets.js';
import { centralPayEnabled } from './payee-rail.js';

export async function centralHealth(ctx, payeeId, { adapters } = {}) {
  await gate(ctx, undefined, true);
  requireOwner(ctx, 'see the health of the central payment side');
  if (!centralPayEnabled(ctx)) throw new ApiError(503, 'central_disabled', 'The central payment side is not turned on.');
  const row = await ctx.db.first('SELECT * FROM payee_account WHERE payee_id = ?', String(payeeId));
  if (!row) throw new ApiError(404, 'payee_not_found', 'No such payee.');
  if (row.gateway !== GATEWAY_NAME) throw new ApiError(409, 'not_central_payee', 'This payee does not use the central payment side.');
  const payee = view(row);
  const reader = makeSecretReader(ctx.secrets ?? ctx.env ?? {});
  const presence = secretPresence(ctx, payee.secret_names);
  let base_url_ok = true;
  try { checkBaseUrl(reader.get(BASE_NAME)); } catch { base_url_ok = false; }
  const configured = presence.ok && base_url_ok;
  let reachable = false;
  if (configured && typeof ctx.fetch === 'function') reachable = (await gatewayFor(payee, { reader, fetch: ctx.fetch, adapters }).health()).ok === true;
  return { payee_id: payee.payee_id, gateway: payee.gateway, status: payee.status, mode: payee.mode, secrets: presence.found, base_url_ok, configured, reachable };
}
