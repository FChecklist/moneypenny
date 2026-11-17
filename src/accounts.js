import { ApiError, DAY, newId, normEmail, canonEmail, MIN } from './util.js';
import { getSettings } from './settings.js';

export function emailOrThrow(v, name = 'email') {
  const n = normEmail(v);
  if (!n) throw new ApiError(400, 'bad_email', `${name} is not a valid e-mail address.`);
  return n;
}

export async function findAccount(ctx, email) {
  return ctx.db.first('SELECT * FROM account WHERE tenant_id = ? AND email_norm = ?', ctx.tenantId, emailOrThrow(email));
}

/** Creates the account on first use. `velocity` applies the new-people-per-hour limit. */
export async function ensureAccount(ctx, email, { velocity = false } = {}) {
  const norm = emailOrThrow(email);
  const found = await ctx.db.first('SELECT * FROM account WHERE tenant_id = ? AND email_norm = ?', ctx.tenantId, norm);
  if (found) return found;
  if (velocity) {
    const s = await getSettings(ctx);
    const r = await ctx.db.first('SELECT COUNT(*) n FROM account WHERE tenant_id = ? AND created_at > ?', ctx.tenantId, ctx.now() - 60 * MIN);
    if (r.n >= s.new_accounts_per_hour) throw new ApiError(429, 'too_many_new_accounts', 'Too many new people this hour. Try again later.');
  }
  const acc = { id: newId('acc'), tenant_id: ctx.tenantId, email_norm: norm, email_canon: canonEmail(norm), status: 'active', first_paid_at: null, created_at: ctx.now() };
  await ctx.db.run('INSERT INTO account (id, tenant_id, email_norm, email_canon, status, first_paid_at, created_at) VALUES (?,?,?,?,?,?,?)', acc.id, acc.tenant_id, acc.email_norm, acc.email_canon, acc.status, null, acc.created_at);
  return acc;
}

/** Real paid value on record (credits), net of refunds and chargebacks. Bonus unlocks on this. */
export async function addPaid(ctx, accountId, credits) {
  await ctx.db.run(
    'UPDATE account SET paid_credits = MAX(0, paid_credits + ?), first_paid_at = COALESCE(first_paid_at, ?) WHERE id = ? AND tenant_id = ?',
    credits, ctx.now(), accountId, ctx.tenantId,
  );
}

export async function setFrozen(ctx, email, frozen) {
  const acc = await findAccount(ctx, email);
  if (!acc) throw new ApiError(404, 'no_account', 'No such person.');
  await ctx.db.run('UPDATE account SET status = ? WHERE id = ?', frozen ? 'frozen' : 'active', acc.id);
  return acc;
}

export { DAY };
