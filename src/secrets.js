// Secret reader (chunk F4). A payee record holds only the NAMES of platform secrets. This reads the value
// from an injected store (the Worker env) at the moment of use. The value is never logged, stored or returned.
import { ApiError } from './util.js';

/** reader.get(name) -> string or undefined. Only names that look like secret names are read. */
export function makeSecretReader(store) {
  return {
    get(name) {
      if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) return undefined;
      const v = typeof store?.get === 'function' ? store.get(name) : store?.[name];
      return typeof v === 'string' && v.length ? v : undefined;
    },
  };
}
/** Resolve the three secrets of a payee by NAME. A missing one is an error that names the secret NAME only. */
export function resolveSecrets(reader, names) {
  const out = {};
  for (const k of ['key_id', 'key_secret', 'webhook_secret']) {
    const v = reader?.get?.(names?.[k]);
    if (!v) throw new ApiError(503, 'payee_secret_missing', `A secret is not in the platform store: ${names?.[k] ?? k}.`);
    out[k] = v;
  }
  return out;
}
