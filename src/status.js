// The global off-switch. The API Hub publishes a small status.json; this reads it and decides whether a call may go on.
// Shape used (the Hub's own): { hub:{mode}, products:{ mnp:{ mode, reads_allowed, writes_allowed, disabled_actions:[operationIds] } } }
// If the switch cannot be read (never read yet, or a file with no mode), every change is refused (fail closed); a person can still look.
// The last good answer is kept through an outage.
export const PRODUCT_CODE = 'mnp';

/** Returns null when the call may go on, or { code, message } when it must stop. */
export function checkStatus(st, { op, method, scope }) {
  if (scope === 'admin' && method === 'GET') return null; // a person can always look
  const unknown = { code: 'status_unknown', message: 'The off-switch could not be read, so changes are paused.' };
  if (st == null || typeof st !== 'object') return scope === 'ai_read' || method !== 'GET' ? unknown : null;
  const p = st.products && st.products[PRODUCT_CODE];
  if (!(st.hub && st.hub.mode) && !(p && p.mode)) return scope === 'ai_read' || method !== 'GET' ? unknown : null;
  if ((st.hub && st.hub.mode && st.hub.mode !== 'on') || (p && p.mode && p.mode !== 'on')) return { code: 'paused_global', message: (p && p.reason) || 'This service is switched off for now.' };
  if (p) {
    if (p.reads_allowed !== undefined && p.reads_allowed !== true && method === 'GET') return { code: 'paused_global', message: 'Reading is switched off for now.' };
    if (p.writes_allowed !== undefined && p.writes_allowed !== true && method !== 'GET') return { code: 'paused_global', message: 'Changes are switched off for now.' };
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
export function urlStatus(url, { ttlMs = 30000, now = Date.now, fetchFn = fetch, store = null } = {}) {
  let at = 0;
  let last = null;
  let loaded = false;
  return async () => {
    if (!loaded && store) { loaded = true; try { last = (await store.get()) ?? null; } catch { /* none kept yet */ } }
    if (at && now() - at < ttlMs) return last;
    try {
      const r = await fetchFn(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j === 'object' && !Array.isArray(j)) { last = j; if (store) await store.set(j).catch(() => {}); }
      } // an outage never replaces the last good answer (an "off" stays off)
    } catch {
      /* keep the last good answer */
    }
    at = now();
    return last;
  };
}
