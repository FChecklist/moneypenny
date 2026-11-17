// AI safeguards. An AI key (class ai_read) can read, and it can ASK. An ask creates a pending approval for a
// person. Nothing that moves credits or money, or changes a price or a rate, is ever done by an AI key alone:
// only an admin key (a person) approves, and only then does the action run.
import { ApiError, newId, int, ref, str, HOUR } from './util.js';
import { getSettings, validate } from './settings.js';
import { emailOrThrow } from './accounts.js';
import { reserveItem, refund } from './spend.js';
import { convertRequest, conversionAction } from './convert.js';
import { setSettings } from './settings.js';
import { setCatalogue } from './gate.js';
import { audit } from './audit.js';
import { emit } from './outbox.js';

const RATE_KEYS = ['fx_margin_bps', 'inr_paise_per_usd'];
const bad = (m) => new ApiError(400, 'bad_ask', m);

/** What may be asked, how its parameters are checked, and what runs when a person approves. */
const ASKABLE = {
  credit_spend: {
    clean(p) {
      return { email: emailOrThrow(p.email), product: ref(p.product, 'product', 60), item: ref(p.item, 'item', 60), order_ref: ref(p.order_ref, 'order_ref') };
    },
    run: (ctx, p) => reserveItem(ctx, p),
  },
  conversion: {
    clean: (p) => ({ email: emailOrThrow(p.email), credits: int(p.credits, 'credits', { min: 1, max: 1000000000 }) }),
    run: (ctx, p) => convertRequest(ctx, p),
  },
  refund: {
    clean(p) {
      if (p.type !== 'order' && p.type !== 'purchase') throw bad("type must be 'order' or 'purchase'. Chargebacks come only from the payment system.");
      const o = { type: p.type };
      if (p.type === 'order') o.hold_id = ref(p.hold_id, 'hold_id', 100);
      else o.payment_ref = ref(p.payment_ref, 'payment_ref');
      if (p.credits != null) o.credits = int(p.credits, 'credits', { min: 1, max: 1000000000 });
      return o;
    },
    run: (ctx, p) => refund(ctx, p, p.type === 'order' ? 'api' : 'purchase'),
  },
  payout: {
    clean(p) {
      if (p.step !== 'approve' && p.step !== 'instruct') throw bad("step must be 'approve' or 'instruct'. Marking a payout paid is typed by a person.");
      return { conversion_id: ref(p.conversion_id, 'conversion_id', 100), step: p.step };
    },
    run: (ctx, p) => conversionAction(ctx, p.conversion_id, p.step, {}),
  },
  rate_change: {
    clean(p) {
      const set = p.settings;
      if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) throw bad('settings must be an object.');
      const out = {};
      for (const [k, v] of Object.entries(set)) {
        if (!RATE_KEYS.includes(k)) throw bad(`Only ${RATE_KEYS.join(' and ')} can be asked for here.`);
        out[k] = validate(k, v);
      }
      return { settings: out };
    },
    run: (ctx, p) => setSettings(ctx, p.settings).then(() => ({ changed: Object.keys(p.settings) })),
  },
  price_change: {
    clean: (p) => ({
      product: ref(p.product, 'product', 60), item: ref(p.item, 'item', 60), credits: int(p.credits, 'credits', { min: 1, max: 1000000000 }),
      ...(p.active === 0 || p.active === false ? { active: 0 } : {}),
    }),
    run: (ctx, p) => setCatalogue(ctx, p),
  },
};
export const ASKABLE_ACTIONS = Object.keys(ASKABLE);

/** AI key: "please do this". Creates a pending approval. Does NOT do it. */
export async function ask(ctx, b) {
  const s = await getSettings(ctx);
  const spec = (Object.hasOwn(ASKABLE, b.action) ? ASKABLE[b.action] : null);
  if (!spec) throw new ApiError(400, 'action_not_askable', `action must be one of: ${ASKABLE_ACTIONS.join(', ')}.`);
  if (!b.params || typeof b.params !== 'object' || Array.isArray(b.params)) throw bad('params must be an object.');
  const params = spec.clean(b.params);
  const note = b.note == null ? null : str(b.note, 'note', { max: 300 });
  const pending = await ctx.db.first("SELECT COUNT(*) n FROM approval_request WHERE tenant_id = ? AND requested_by_key = ? AND status = 'pending'", ctx.tenantId, ctx.actor);
  if (pending.n >= s.ai_pending_max) throw new ApiError(429, 'too_many_pending', 'Too many requests are waiting for a person. Wait for them to be decided.');
  const id = newId('apr');
  const now = ctx.now();
  await ctx.db.run(
    'INSERT INTO approval_request (id, tenant_id, action, params, note, status, requested_by_key, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, ctx.tenantId, b.action, JSON.stringify(params), note, 'pending', ctx.actor, now, now + s.ai_approval_ttl_hours * HOUR,
  );
  await audit(ctx, 'approval.requested', { id, action: b.action });
  await emit(ctx, 'approval.requested', { id, action: b.action });
  return { approval_id: id, status: 'pending', action: b.action, note: 'Waiting for a person. Nothing has been done.', expires_at: now + s.ai_approval_ttl_hours * HOUR };
}

const view = (r, withParams) => ({
  id: r.id, action: r.action, status: r.status, note: r.note, created_at: r.created_at, expires_at: r.expires_at, decided_at: r.decided_at,
  ...(withParams ? { params: JSON.parse(r.params), result: r.result ? JSON.parse(r.result) : null } : {}),
});

/** An AI key sees only its own requests; an admin sees all. */
export async function listApprovals(ctx, status = null) {
  const own = ctx.scope === 'ai_read';
  const rows = await ctx.db.all(
    `SELECT * FROM approval_request WHERE tenant_id = ? ${own ? 'AND requested_by_key = ?' : ''} ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 100`,
    ctx.tenantId, ...(own ? [ctx.actor] : []), ...(status ? [status] : []),
  );
  return { approvals: rows.map((r) => view(r, true)) };
}

/** A person (admin key) approves or rejects. Approving runs the action, once, as that person. */
export async function decide(ctx, id, verb) {
  if (verb !== 'approve' && verb !== 'reject') throw new ApiError(400, 'bad_request', 'decision must be approve or reject.');
  const r = await ctx.db.first('SELECT * FROM approval_request WHERE tenant_id = ? AND id = ?', ctx.tenantId, id);
  if (!r) throw new ApiError(404, 'no_approval', 'No such request.');
  if (r.status !== 'pending') throw new ApiError(409, 'already_decided', `This request is already ${r.status}.`);
  if (verb === 'approve' && ctx.now() > r.expires_at) throw new ApiError(409, 'approval_expired', 'This request ran out of time. Ask again.');
  const won = await ctx.db.run("UPDATE approval_request SET status = ?, decided_by_key = ?, decided_at = ? WHERE id = ? AND status = 'pending'", verb === 'approve' ? 'approved' : 'rejected', ctx.actor, ctx.now(), id);
  if (won.changes !== 1) throw new ApiError(409, 'already_decided', 'This request was just decided.');
  let result = null;
  if (verb === 'approve') {
    // Runs with the person's own key. If it fails, the whole step is undone and the request stays pending.
    result = await ASKABLE[r.action].run(ctx, JSON.parse(r.params));
    await ctx.db.run('UPDATE approval_request SET result = ? WHERE id = ?', JSON.stringify(result), id);
  }
  await audit(ctx, `approval.${verb}`, { id, action: r.action, asked_by_key: r.requested_by_key });
  return { id, status: verb === 'approve' ? 'approved' : 'rejected', result };
}

export async function expireApprovals(ctx) {
  const r = await ctx.db.run("UPDATE approval_request SET status = 'expired' WHERE tenant_id = ? AND status = 'pending' AND expires_at < ?", ctx.tenantId, ctx.now());
  return { expired: r.changes };
}
