// The global off-switch. The API Hub publishes a small status.json; this reads it and decides whether a call may go on.
// Shape used (the Hub's own): { hub:{mode}, products:{ mnp:{ mode, reads_allowed, writes_allowed, disabled_actions:[operationIds] } } }
// A missing or broken status file never stops people (fail open) EXCEPT for AI keys (fail closed): an AI key is
// refused when the switch cannot be read.
export const PRODUCT_CODE = 'mnp';

/** Returns null when the call may go on, or { code, message } when it must stop. */
export function checkStatus(st, { op, method, scope }) {
  if (scope === 'admin' && method === 'GET') return null; // a person can always look
  if (st == null) return scope === 'ai_read' ? { code: 'status_unknown', message: 'The off-switch could not be read, so AI access is paused.' } : null;
  const p = st.products && st.products[PRODUCT_CODE];
  if (scope === 'ai_read' && !(st.hub && st.hub.mode) && !(p && p.mode)) return { code: 'status_unknown', message: 'The off-switch file has no mode, so AI access is paused.' };
  if ((st.hub && st.hub.mode && st.hub.mode !== 'on') || (p && p.mode && p.mode !== 'on')) return { code: 'paused_global', message: (p && p.reason) || 'This service is switched off for now.' };
  if (p) {
    if (p.reads_allowed === false && method === 'GET') return { code: 'paused_global', message: 'Reading is switched off for now.' };
    if (p.writes_allowed === false && method !== 'GET') return { code: 'paused_global', message: 'Changes are switched off for now.' };
    if (op && Array.isArray(p.disabled_actions) && p.disabled_actions.includes(op.id)) return { code: 'action_disabled', message: 'This action is switched off for now.' };
  }
  return null;
}

/** A status source that reads a file (local use). */
export function fileStatus(path, readFileSync) {
  return async () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };
}

/** A status source that fetches a URL and remembers the answer for `ttlMs` (Worker use). */
export function urlStatus(url, { ttlMs = 30000, now = Date.now, fetchFn = fetch } = {}) {
  let at = 0;
  let last = null;
  return async () => {
    if (now() - at < ttlMs) return last;
    try {
      const r = await fetchFn(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(3000) });
      last = r.ok ? await r.json() : null;
    } catch {
      last = null;
    }
    at = now();
    return last;
  };
}
