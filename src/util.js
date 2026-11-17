// Small shared helpers. Uses only Web Crypto so it runs in Workers and Node alike.
export const DAY = 86400000;
export const MIN = 60000;
const enc = new TextEncoder();

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

/** Lower-case, trimmed e-mail, or null when it does not look like one. Identity = this string. */
export function normEmail(e) {
  if (typeof e !== 'string') return null;
  const s = e.trim().toLowerCase();
  if (s.length < 5 || s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

/** Abuse-check form only: strips +tags, gmail dots, googlemail alias. Never used as identity. */
export function canonEmail(norm) {
  let [local, domain] = norm.split('@');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export function isUniqueError(e) {
  return /UNIQUE|constraint/i.test(String(e && e.message));
}

export function int(v, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(v) || v < min || v > max) throw new ApiError(400, 'bad_request', `${name} must be a whole number from ${min} to ${max}`);
  return v;
}

export function str(v, name, { max = 200, optional = false } = {}) {
  if (v == null && optional) return null;
  if (typeof v !== 'string' || !v.length || v.length > max) throw new ApiError(400, 'bad_request', `${name} is required (max ${max} characters)`);
  return v;
}
