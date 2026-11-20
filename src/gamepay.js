// Pay ONE specific game from credits. The console's game id is the order reference.
//
//   quote   what the game costs, what the organizer has, what is still to buy (nothing is written)
//   start   the organizer pays: credits enough -> reserve + capture in ONE step, game is PAID;
//           credits short -> a credit order for a listed pack is opened and the payment window details are returned
//   confirm the payment is done (the console passes what the payment window gave back; or IT Services pushes it):
//           credits are added, then the game is paid from them in the same transaction, then the game is told
//   status  poll by game id: a closed tab still ends with a paid game
//   link    a payee (host) pays real money as a credit purchase INTO THE ORGANIZER'S ACCOUNT, same game id, no login
//
// Rules this file keeps:
//  - A game is always paid IN FULL from credits. A shortfall means credits are bought first. Prices come from the catalogue
//    and the pack list (settings), never from this code.
//  - Reserve and capture happen inside one transaction, so a hold can never be left behind.
//  - Money in is never lost: if the credits arrived but the game could not be paid (price moved, account paused, a clashing
//    hold), the credits stay on the account and the game is flagged for review; a sweep tries again.
//  - Exactly once: by payment id (payment notice, order, lot) and by game id (one row, one captured hold, one event).
import { ApiError, HOUR, ref, int, canonEmail, normEmail, sha256Hex } from './util.js';
import { getSettings } from './settings.js';
import { findAccount, ensureAccount, emailOrThrow } from './accounts.js';
import { usableCredits, reserveItem, capture, release, sweepHolds } from './spend.js';
import { buyCredits, quote, processRail, railConfirm, withTimeout } from './gate.js';
import { getBalance, paymentNotice, payId } from './wallet.js';
import { emit } from './outbox.js';
import { audit } from './audit.js';

const holdRef = (gameRef) => `game:${gameRef}`;
export const gameRefOf = (v) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(v)) throw new ApiError(400, 'bad_request', 'order_ref (the game id) must be 1 to 40 letters, digits, - or _.');
  return v;
};
const loadGame = (ctx, r) => ctx.db.first('SELECT * FROM game_pay WHERE tenant_id = ? AND game_ref = ?', ctx.tenantId, r);
const accountOf = (ctx, id) => ctx.db.first('SELECT * FROM account WHERE id = ?', id);

async function catalogueItem(ctx, product, item) {
  const cat = await ctx.db.first('SELECT * FROM catalogue_item WHERE tenant_id = ? AND product = ? AND item = ? AND active = 1', ctx.tenantId, product, item);
  if (!cat) throw new ApiError(404, 'no_item', 'No such item on the price list.');
  return cat;
}

/** The smallest listed pack that covers `short`, or null. Pack sizes are data (setting inr_packs). */
function packFor(s, short) {
  const sizes = Object.keys(s.inr_packs ?? {}).map(Number).filter((n) => Number.isSafeInteger(n) && n >= short).sort((a, b) => a - b);
  return sizes[0] ?? null;
}
const fmtMoney = (cur, minor) => (cur === 'INR' ? `Rs ${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : `US$${(minor / 100).toFixed(2)}`);

// ---------- the answer shape ----------
async function latestOrder(ctx, gameRef) {
  return ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND game_ref = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', ctx.tenantId, gameRef);
}
async function view(ctx, g) {
  if (!g) return { status: 'unknown', paid: false };
  const o = g.order_id ? await ctx.db.first('SELECT * FROM purchase_order WHERE id = ?', g.order_id) : null;
  const ev = g.event_id ? await ctx.db.first('SELECT status FROM outbox WHERE id = ?', g.event_id) : null;
  const waiting = o && ['pending_rail', 'awaiting_payment'].includes(o.status);
  return {
    order_ref: g.game_ref,
    status: g.status === 'open' && waiting ? 'awaiting_payment' : g.status,
    paid: g.status === 'paid',
    product: g.product, item: g.item, credits: g.credits,
    reason: g.reason ?? null, source: g.source, paid_at: g.paid_at ?? null, hold_id: g.hold_id ?? null,
    event: g.event_id ? { id: g.event_id, state: ev?.status ?? 'pending' } : null,
    order: o ? { order_id: o.id, status: o.status, credits: o.credits, currency: o.currency, amount_minor: o.amount_minor, ...(o.payframe && waiting ? { payframe: JSON.parse(o.payframe) } : {}) } : null,
  };
}

// ---------- settle: pay the game from the credits ----------
async function toReview(ctx, g, reason) {
  await ctx.db.run("UPDATE game_pay SET status = 'review', reason = ?, updated_at = ? WHERE tenant_id = ? AND game_ref = ? AND status <> 'paid'", reason, ctx.now(), ctx.tenantId, g.game_ref);
  if (g.status !== 'review' || g.reason !== reason) await emit(ctx, 'game_pay.needs_review', { game_ref: g.game_ref, product: g.product, reason });
  return { paid: false, review: true, reason };
}
async function stayOpen(ctx, g, reason, extra = {}) {
  await ctx.db.run("UPDATE game_pay SET status = 'open', reason = ?, updated_at = ? WHERE tenant_id = ? AND game_ref = ? AND status <> 'paid'", reason, ctx.now(), ctx.tenantId, g.game_ref);
  return { paid: false, reason, ...extra };
}
async function markPaid(ctx, g, holdId, { paymentRef = null, source = null } = {}) {
  const now = ctx.now();
  const eventId = await emit(ctx, 'game.paid', { game_ref: g.game_ref, product: g.product, item: g.item, credits: g.credits, hold_id: holdId, account_id: g.account_id, source: source ?? g.source, paid_at: now });
  const r = await ctx.db.run("UPDATE game_pay SET status = 'paid', reason = NULL, hold_id = ?, payment_ref = ?, source = ?, event_id = ?, paid_at = ?, updated_at = ? WHERE tenant_id = ? AND game_ref = ? AND status <> 'paid'", holdId, paymentRef, source ?? g.source, eventId, now, now, ctx.tenantId, g.game_ref);
  if (r.changes !== 1) throw new ApiError(409, 'already_paid', 'This game was already paid.'); // rolls the whole step back: never a second event
  return { paid: true, hold_id: holdId };
}

/**
 * Pays the game from the organizer's credits, now: reserve then capture inside this one transaction.
 * Returns {paid:true} or {paid:false, reason, ...}. Never throws for a business reason, so credits that just arrived stay.
 */
export async function trySettle(ctx, g0, { source = null, paymentRef = null } = {}) {
  const g = (await loadGame(ctx, g0.game_ref)) ?? g0;
  if (g.status === 'paid') return { paid: true, already: true, hold_id: g.hold_id };
  const acc = await accountOf(ctx, g.account_id);
  if (acc.status === 'frozen') return toReview(ctx, g, 'account_frozen');
  await sweepHolds(ctx); // a hold nobody captured in time is given back first
  const cat = await ctx.db.first('SELECT * FROM catalogue_item WHERE tenant_id = ? AND product = ? AND item = ? AND active = 1', ctx.tenantId, g.product, g.item);
  if (!cat) return toReview(ctx, g, 'no_item');
  // Never charge a price the person was not shown: if the list moved, the credits wait on the account and the console re-quotes.
  if (cat.credits !== g.credits) return stayOpen(ctx, g, 'price_changed', { price_credits: cat.credits });
  let held;
  try {
    held = await reserveItem(ctx, { email: acc.email_norm, product: g.product, item: g.item, order_ref: holdRef(g.game_ref), credits: g.credits });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === 'insufficient_credits') return stayOpen(ctx, g, 'insufficient_credits', { short_by: e.extra.short_by });
    if (e.code === 'order_already_paid_with_credits') { // a hold of this game was captured some other way: the game is paid, tell it once
      const done = await ctx.db.first("SELECT id FROM hold WHERE tenant_id = ? AND order_ref = ? AND status = 'captured'", ctx.tenantId, holdRef(g.game_ref));
      return markPaid(ctx, g, done?.id ?? null, { paymentRef, source });
    }
    return toReview(ctx, g, e.code);
  }
  try {
    await capture(ctx, { hold_id: held.hold_id });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await release(ctx, { hold_id: held.hold_id }).catch(() => {}); // capture refused before it wrote anything: give the credits back at once
    return toReview(ctx, g, e.code);
  }
  return markPaid(ctx, g, held.hold_id, { paymentRef, source });
}

/** Called by the gate right after an order for a game has been credited. */
export async function settleForOrder(ctx, order) {
  const g = await loadGame(ctx, order.game_ref);
  if (!g) return null;
  if (g.status === 'paid') return { order_ref: g.game_ref, paid: true, already_paid: true }; // a second payment: its credits stay on the account, the game is never charged twice
  const r = await trySettle(ctx, g, { source: order.payer_email ? 'paylink' : 'console', paymentRef: order.payment_ref ?? null });
  return { order_ref: g.game_ref, paid: r.paid, ...(r.reason ? { reason: r.reason } : {}) };
}

/** The sweep: games whose credits arrived but which are not paid yet get another try (capped per run). */
export async function settleOpen(ctx, { limit = 50 } = {}) {
  const rows = await ctx.db.all(
    "SELECT g.* FROM game_pay g WHERE g.tenant_id = ? AND g.status IN ('open','review') AND EXISTS (SELECT 1 FROM purchase_order o WHERE o.tenant_id = g.tenant_id AND o.game_ref = g.game_ref AND o.status = 'paid') ORDER BY g.updated_at LIMIT ?",
    ctx.tenantId, limit,
  );
  let paid = 0;
  for (const g of rows) if ((await trySettle(ctx, g)).paid) paid++;
  return { tried: rows.length, paid };
}

// ---------- buying the missing credits ----------
/** Opens (or returns) the credit order for the shortfall. `payer` is set only when someone other than the organizer pays. */
async function openOrder(ctx, g, acc, { currency = null, payer = null } = {}) {
  const s = await getSettings(ctx);
  const cur = currency ?? s.base_currency;
  if (cur !== 'INR' && cur !== 'USD') throw new ApiError(400, 'bad_currency', 'Payment is in INR or USD only.');
  const { have } = await usableCredits(ctx, s, acc, g.credits);
  const short = g.credits - have;
  if (short <= 0) return null;
  const pack = packFor(s, short);
  if (!pack) throw new ApiError(422, 'no_pack_covers', 'No credit pack covers what is missing.', { short_by: short });
  const payerNorm = payer ? emailOrThrow(payer, 'payer_email') : null;
  const selfPay = payerNorm && canonEmail(payerNorm) === canonEmail(acc.email_norm) ? null : payerNorm;
  const prior = await latestOrder(ctx, g.game_ref);
  const attempts = (await ctx.db.first('SELECT COUNT(*) n FROM purchase_order WHERE tenant_id = ? AND game_ref = ?', ctx.tenantId, g.game_ref)).n;
  let order = null;
  if (prior && ['pending_rail', 'awaiting_payment'].includes(prior.status) && prior.credits === pack && prior.currency === cur && (prior.payer_email ?? null) === selfPay) {
    try {
      order = await buyCredits(ctx, { email: acc.email_norm, credits: pack, currency: cur, order_ref: prior.order_ref }, { gameRef: g.game_ref, payerEmail: selfPay });
      if (order.status === 'pending_rail') { await processRail(ctx, ctx.rail, { orderId: order.order_id }); order = await ctx.db.first('SELECT * FROM purchase_order WHERE id = ?', order.order_id).then(orderRow); }
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'price_changed') throw e; // the pack price moved: a fresh order below
    }
  }
  if (!order) order = await buyCredits(ctx, { email: acc.email_norm, credits: pack, currency: cur, order_ref: `gp:${g.game_ref}:${attempts + 1}` }, { gameRef: g.game_ref, payerEmail: selfPay });
  await ctx.db.run('UPDATE game_pay SET order_id = ?, updated_at = ? WHERE tenant_id = ? AND game_ref = ?', order.order_id, ctx.now(), ctx.tenantId, g.game_ref);
  return order;
}
const orderRow = (o) => ({ order_id: o.id, order_ref: o.order_ref, status: o.status, credits: o.credits, currency: o.currency, amount_minor: o.amount_minor });

// ---------- quote ----------
export async function gameQuote(ctx, q) {
  const gameRef = gameRefOf(q.get('order_ref'));
  const g = await loadGame(ctx, gameRef);
  const email = g ? (await accountOf(ctx, g.account_id)).email_norm : emailOrThrow(q.get('email'));
  const product = g?.product ?? ref(q.get('product'), 'product', 60);
  const item = g?.item ?? ref(q.get('item'), 'item', 60);
  if (g && ((q.get('email') && canonEmail(emailOrThrow(q.get('email'))) !== canonEmail(email)) || (q.get('product') && q.get('product') !== g.product) || (q.get('item') && q.get('item') !== g.item))) throw new ApiError(409, 'game_ref_used', 'That game id belongs to a different person or item.');
  const s = await getSettings(ctx);
  const cat = await catalogueItem(ctx, product, item);
  const acc = await findAccount(ctx, email);
  const { have } = await usableCredits(ctx, s, acc, cat.credits);
  const short = g?.status === 'paid' ? 0 : cat.credits - have;
  const price = await quote(ctx, cat.credits);
  const bal = await getBalance(ctx, email);
  const cur = s.base_currency;
  const pack = short > 0 ? packFor(s, short) : null;
  const packPriceMinor = pack ? (await quote(ctx, pack)) : null;
  return {
    ...(await view(ctx, g)),
    order_ref: gameRef, product, item,
    cost_credits: cat.credits, cost_text: price.display_text, cost_usd: price.usd, cost_inr_minor: price.inr_minor,
    balance: bal.balance, balance_text: bal.display.text,
    short_by: Math.max(0, short),
    to_buy: pack ? { credits: pack, currency: cur, amount_minor: cur === 'INR' ? packPriceMinor.inr_minor : packPriceMinor.usd_minor, text: packPriceMinor.display_text, in: ['INR', 'USD'] } : null,
    can_pay_now: short <= 0 && g?.status !== 'paid',
  };
}

// ---------- start ----------
export async function gameStart(ctx, b) {
  const gameRef = gameRefOf(b.order_ref);
  const product = ref(b.product, 'product', 60);
  const item = ref(b.item, 'item', 60);
  const email = emailOrThrow(b.email);
  const cat = await catalogueItem(ctx, product, item);
  if (b.credits != null && b.credits !== cat.credits) throw new ApiError(409, 'price_changed', 'The price has changed.', { price_credits: cat.credits });
  let g = await loadGame(ctx, gameRef);
  const known = await findAccount(ctx, email);
  if (known && known.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const acc = known ?? (await ensureAccount(ctx, email, { velocity: true }));
  if (g) {
    if (g.account_id !== acc.id || g.product !== product || g.item !== item) throw new ApiError(409, 'game_ref_used', 'That game id belongs to a different person or item.');
    if (g.status === 'paid') return view(ctx, g); // asking again never charges again
    if (g.credits !== cat.credits) { await ctx.db.run('UPDATE game_pay SET credits = ?, updated_at = ? WHERE tenant_id = ? AND game_ref = ?', cat.credits, ctx.now(), ctx.tenantId, gameRef); g = await loadGame(ctx, gameRef); } // this click accepts the price just shown
  } else {
    const now = ctx.now();
    await ctx.db.run("INSERT INTO game_pay (tenant_id, game_ref, account_id, product, item, credits, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,'open','console',?,?)", ctx.tenantId, gameRef, acc.id, product, item, cat.credits, now, now);
    g = await loadGame(ctx, gameRef);
  }
  const r = await trySettle(ctx, g, { source: 'console' });
  if (!r.paid && r.reason === 'insufficient_credits') {
    await openOrder(ctx, g, acc, { currency: b.currency ?? null });
  }
  return view(ctx, await loadGame(ctx, gameRef));
}

// ---------- confirm ----------
/**
 * Money is in. Checks WHO paid, notes the payment, credits the lot, pays the game. All in one step: any failure undoes the whole step,
 * so the payment side simply sends it again (the payment id makes every part idempotent).
 */
async function confirmCore(ctx, o, { payment_ref, paid_minor, currency, payer_email }) {
  const acc = await accountOf(ctx, o.account_id);
  const expected = o.payer_email ?? acc.email_norm;
  const said = emailOrThrow(payer_email, 'payer_email');
  if (canonEmail(said) !== canonEmail(expected)) throw new ApiError(409, 'payer_mismatch', 'That payment was made by someone else.'); // no credit, nothing noted
  await paymentNotice(ctx, { payment_ref, paid_minor, currency, payer_email: expected });
  const out = await railConfirm(ctx, { order_id: o.id, payment_ref, paid_minor, currency });
  const g = o.game_ref ? await loadGame(ctx, o.game_ref) : null;
  return { ...(await view(ctx, g)), credited: out.credited, payment: { already: !!out.already, ...(out.overpaid_minor ? { overpaid_minor: out.overpaid_minor } : {}) } };
}

/** The payment side (purchase key) says: this payment is captured. Used by the IT Services push (webhook backup). */
export async function paymentConfirmed(ctx, b) {
  const payRef = payId(b.payment_ref);
  const o = b.order_id
    ? await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND id = ?', ctx.tenantId, ref(b.order_id, 'order_id'))
    : await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND order_ref = ?', ctx.tenantId, ref(b.order_ref, 'order_ref'));
  if (!o) throw new ApiError(404, 'no_order', 'No such order.');
  return confirmCore(ctx, o, { payment_ref: payRef, paid_minor: int(b.paid_minor, 'paid_minor', { min: 1 }), currency: b.currency, payer_email: b.payer_email });
}

/** The console (spend key) passes on what the payment window gave back. Moneypenny asks the payment side what really happened. */
export async function gameConfirm(ctx, b) {
  const gameRef = gameRefOf(b.order_ref);
  const g = await loadGame(ctx, gameRef);
  if (!g) throw new ApiError(404, 'no_game', 'No such game.');
  const o = b.order_id ? await ctx.db.first('SELECT * FROM purchase_order WHERE tenant_id = ? AND id = ? AND game_ref = ?', ctx.tenantId, ref(b.order_id, 'order_id'), gameRef) : await latestOrder(ctx, gameRef);
  if (!o) throw new ApiError(404, 'no_order', 'No payment was started for this game.');
  if (o.status === 'paid') return { ...(await view(ctx, g)), payment: { already: true } };
  if (!ctx.rail || typeof ctx.rail.verify !== 'function') throw new ApiError(503, 'rail_not_configured', 'Payments are not switched on yet.');
  let v;
  try {
    v = await withTimeout(ctx.rail.verify({ order_id: o.id, rail_order_id: o.rail_order_id, razorpay_order_id: b.razorpay_order_id, razorpay_payment_id: b.razorpay_payment_id, razorpay_signature: b.razorpay_signature }), 4000);
  } catch {
    throw new ApiError(502, 'rail_unavailable', 'The payment side did not answer. If you paid, your game will be marked paid shortly.'); // nothing changed; the push path completes it
  }
  if (!v || v.paid !== true) return { ...(await view(ctx, g)), paid: false, payment: { verified: false } };
  if (v.rail_order_id !== o.rail_order_id) throw new ApiError(409, 'order_mismatch', 'That payment belongs to another order.');
  return confirmCore(ctx, o, { payment_ref: payId(v.payment_ref), paid_minor: int(v.amount_minor, 'paid_minor', { min: 1 }), currency: v.currency, payer_email: v.payer_email });
}

export async function gameStatus(ctx, q) {
  const gameRef = gameRefOf(q.get('order_ref'));
  return view(ctx, await loadGame(ctx, gameRef));
}

// ---------- pay link ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const hashToken = (t) => sha256Hex(`mnp-paylink:${t}`);

async function linkOf(ctx, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new ApiError(404, 'no_link', 'This link is not valid.');
  const l = await ctx.db.first('SELECT * FROM game_pay_link WHERE tenant_id = ? AND token_hash = ?', ctx.tenantId, await hashToken(token));
  if (!l || l.status !== 'active') throw new ApiError(404, 'no_link', 'This link is not valid.');
  if (ctx.now() > l.expires_at) throw new ApiError(410, 'link_expired', 'This link has run out.');
  return l;
}

/** The organizer (or the console for them) makes a link for one game. Only the hash is kept; the token is shown once. */
export async function createLink(ctx, b) {
  const gameRef = gameRefOf(b.order_ref);
  const product = ref(b.product, 'product', 60);
  const item = ref(b.item, 'item', 60);
  const email = emailOrThrow(b.email);
  const cat = await catalogueItem(ctx, product, item);
  const known = await findAccount(ctx, email);
  if (known && known.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const acc = known ?? (await ensureAccount(ctx, email, { velocity: true }));
  let g = await loadGame(ctx, gameRef);
  if (g) {
    if (g.account_id !== acc.id || g.product !== product || g.item !== item) throw new ApiError(409, 'game_ref_used', 'That game id belongs to a different person or item.');
    if (g.status === 'paid') throw new ApiError(409, 'already_paid', 'This game is already paid.');
  } else {
    const now = ctx.now();
    await ctx.db.run("INSERT INTO game_pay (tenant_id, game_ref, account_id, product, item, credits, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,'open','paylink',?,?)", ctx.tenantId, gameRef, acc.id, product, item, cat.credits, now, now);
  }
  const s = await getSettings(ctx);
  await ctx.db.run("UPDATE game_pay_link SET status = 'revoked' WHERE tenant_id = ? AND game_ref = ? AND status = 'active'", ctx.tenantId, gameRef); // one live link per game
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = ctx.now() + s.paylink_hours * HOUR;
  await ctx.db.run('INSERT INTO game_pay_link (token_hash, tenant_id, game_ref, status, expires_at, created_at) VALUES (?,?,?,?,?,?)', await hashToken(token), ctx.tenantId, gameRef, 'active', expires, ctx.now());
  return { order_ref: gameRef, token, expires_at: expires };
}

/** What the payee's page shows: the game's name and ONE amount due. Never a balance, never credits. */
export async function linkInfo(ctx, q) {
  const l = await linkOf(ctx, q.get('token'));
  const g = await loadGame(ctx, l.game_ref);
  if (g.status === 'paid') return { status: 'paid', order_ref: g.game_ref, product: g.product, item: g.item };
  const s = await getSettings(ctx);
  const cur = q.get('currency') ?? s.base_currency;
  if (cur !== 'INR' && cur !== 'USD') throw new ApiError(400, 'bad_currency', 'Payment is in INR or USD only.');
  const acc = await accountOf(ctx, g.account_id);
  const cat = await catalogueItem(ctx, g.product, g.item);
  if (cat.credits !== g.credits) return { status: 'price_changed', order_ref: g.game_ref, product: g.product, item: g.item };
  const { have } = await usableCredits(ctx, s, acc, g.credits);
  const short = g.credits - have;
  if (short <= 0) return { status: 'nothing_due', order_ref: g.game_ref, product: g.product, item: g.item };
  const pack = packFor(s, short);
  if (!pack) throw new ApiError(422, 'no_pack_covers', 'No credit pack covers what is missing.');
  const p = await quote(ctx, pack);
  const amount = cur === 'INR' ? p.inr_minor : p.usd_minor;
  if (amount == null) throw new ApiError(503, 'rate_stale', 'The exchange rate is out of date. Try again shortly or pay in USD.');
  return { status: 'open', order_ref: g.game_ref, product: g.product, item: g.item, amount_minor: amount, currency: cur, amount_text: fmtMoney(cur, amount), expires_at: l.expires_at };
}

/** The payee starts paying. The credits will go to the organizer's account; the payee's e-mail is only what the payment is matched to. */
export async function linkStart(ctx, b) {
  const l = await linkOf(ctx, b.token);
  const g = await loadGame(ctx, l.game_ref);
  if (g.status === 'paid') throw new ApiError(409, 'already_paid', 'This game is already paid.');
  const payer = normEmail(b.payer_email);
  if (!payer) throw new ApiError(400, 'bad_email', 'payer_email is not a valid e-mail address.');
  const acc = await accountOf(ctx, g.account_id);
  if (acc.status === 'frozen') throw new ApiError(403, 'account_frozen', 'This account is paused.');
  const cat = await catalogueItem(ctx, g.product, g.item);
  if (cat.credits !== g.credits) throw new ApiError(409, 'price_changed', 'The price has changed.');
  const order = await openOrder(ctx, g, acc, { currency: b.currency ?? null, payer });
  if (!order) throw new ApiError(409, 'nothing_due', 'Nothing is due for this game.');
  await audit(ctx, 'game_pay.link_start', { game_ref: g.game_ref, order_id: order.order_id });
  const v = await view(ctx, await loadGame(ctx, g.game_ref));
  // the payee gets the amount and the payment window details only
  return { order_ref: v.order_ref, status: v.status, order: v.order && { order_id: v.order.order_id, status: v.order.status, currency: v.order.currency, amount_minor: v.order.amount_minor, payframe: v.order.payframe ?? null } };
}

