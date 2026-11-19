// Console wallet: the one place an organizer buys and spends credits (design: ORGANIZER-CREDITS-DESIGN).
// Server-side only. It never sees card data, never moves money, never changes a game.
// `mnp` is a signed client with get/post returning { status, body } (production: signed fetch to Moneypenny).
// `games[product].entitle({ email, item, orderRef })` is the game's own existing step (server to server).
// `store` keeps console orders; production: the console database (unique id, durable, compare-and-set on status).
//
// Two factories on purpose: `createWallet` is what organizer-facing routes may reach (no purchase key).
// `createPaymentSide` is built only inside the IT Services webhook handler, with the purchase key client.
import { randomUUID } from 'node:crypto';

export function memoryStore() {
  const rows = new Map();
  return {
    get: (id) => rows.get(id) ?? null,
    put: (id, row) => { rows.set(id, { ...row }); },
    all: () => [...rows.values()].map((r) => ({ ...r })),
    byKey: (key) => [...rows.values()].find((r) => r.spendKey === key) ?? null,
  };
}

const fail = (code, status = 400, extra = {}) => ({ ok: false, status, code, ...extra });
const code = (r) => r?.body?.error?.code;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STALE_MS = 20 * 60 * 1000; // hold 15 min + grace 5 min

export function createWallet({ mnp, games = {}, store = memoryStore(), now = Date.now }) {
  const inFlight = new Set(); // one worker per order inside this process; the database does compare-and-set in production
  const game = (p) => (typeof p === 'string' && Object.hasOwn(games, p) ? games[p] : null);

  /** Prices come from Moneypenny settings (data), never from the page. */
  async function quote(credits) {
    if (!Number.isSafeInteger(credits) || credits <= 0) return fail('bad_request');
    const r = await mnp.get(`/v1/quote?credits=${credits}`);
    return r.status === 200 ? { ok: true, ...r.body } : fail('quote_failed', r.status);
  }

  /** Step 1 of a buy: create the Moneypenny order for a pack. Payment is taken by IT Services (Razorpay). */
  async function startBuy({ email, credits, currency = 'INR', buyId }) {
    if (!email || !ID.test(String(buyId ?? '')) || !Number.isSafeInteger(credits) || credits <= 0) return fail('bad_request');
    const orderRef = `BUY-${buyId}`;
    const r = await mnp.post('/v1/buy_credits', { email, credits, currency, order_ref: orderRef });
    if (r.status !== 200) return fail(code(r) ?? 'buy_failed', r.status);
    return { ok: true, orderRef, orderId: r.body.order_id, amountMinor: r.body.amount_minor, currency: r.body.currency, payUrl: r.body.pay_url ?? null };
  }

  const balance = async (email) => (await mnp.get(`/v1/balance?email=${encodeURIComponent(email)}`)).body;

  /**
   * Spend on a catalogue item. Order: record, reserve, record "entitling", game step, record "entitled", capture.
   * `spendKey` (from the console session, one per click) makes a repeat return the same order, never a second one.
   */
  async function spend({ email, product, item, spendKey = randomUUID() }) {
    const g = game(product);
    if (!g) return fail('unknown_product', 404);
    if (!email || typeof item !== 'string' || !ID.test(String(spendKey))) return fail('bad_request');
    const again = store.byKey(spendKey);
    if (again) return again.status === 'captured' ? { ok: true, orderRef: again.orderRef, credits: again.credits, repeat: true } : fail('order_in_progress', 409, { orderRef: again.orderRef, status: again.status });
    const id = randomUUID();
    const orderRef = `${product}-${id}`;
    const row = { id, orderRef, email, product, item, spendKey, status: 'new', tries: 0, at: now() };
    store.put(id, row);
    let r;
    try {
      r = await mnp.post('/v1/spend/reserve_item', { email, product, item, order_ref: orderRef });
    } catch {
      store.put(id, { ...row, status: 'needs_review', reason: 'reserve_unknown' }); // the hold may exist: owner or the job decides
      return fail('reserve_unknown', 502);
    }
    if (r.status !== 200) {
      store.put(id, { ...row, status: 'refused', reason: code(r) });
      return fail(code(r) ?? 'reserve_failed', r.status);
    }
    Object.assign(row, { status: 'entitling', holdId: r.body.hold_id, credits: r.body.credits, at: now() });
    store.put(id, row); // recorded BEFORE the game step: a crash leaves a row the job can see
    try {
      await g.entitle({ email, item, orderRef });
    } catch {
      return releaseOrder(row, 'game_step_failed');
    }
    Object.assign(row, { status: 'entitled', at: now() });
    store.put(id, row);
    return capture(row);
  }

  async function releaseOrder(row, why) {
    let ok = false;
    try { ok = (await mnp.post('/v1/spend/release', { hold_id: row.holdId })).status === 200; } catch { ok = false; }
    store.put(row.id, { ...row, status: ok ? 'released' : 'release_failed', reason: why, at: now() });
    return fail(why, 502);
  }

  async function capture(row) {
    if (inFlight.has(row.id)) return fail('order_in_progress', 409);
    inFlight.add(row.id);
    try {
      let c;
      try { c = await mnp.post('/v1/spend/capture', { hold_id: row.holdId }); } catch { c = { status: 0, body: {} }; }
      if (c.status === 200 || code(c) === 'hold_already_captured') {
        store.put(row.id, { ...row, status: 'captured', at: now() });
        return { ok: true, orderRef: row.orderRef, credits: row.credits };
      }
      // The game step is done. A lapsed hold (410) cannot be fixed by retrying: straight to the owner.
      const tries = row.tries + 1;
      const dead = c.status === 410 || tries >= 3;
      store.put(row.id, { ...row, tries, status: dead ? 'dead_letter' : 'capture_retry', reason: code(c) ?? 'capture_failed', at: now() });
      return fail('capture_pending', 202, { orderRef: row.orderRef });
    } finally {
      inFlight.delete(row.id);
    }
  }

  /**
   * The 30-minute job. Captures entitled orders and retries; releases failed releases;
   * rows stuck before the game step finished (crash) go to `needs_review` for the owner, never guessed.
   */
  async function retryStuck() {
    for (const row of store.all()) {
      if (row.status === 'entitled' || row.status === 'capture_retry') await capture(row);
      else if (row.status === 'release_failed') await releaseOrder(row, row.reason);
      else if ((row.status === 'entitling' || row.status === 'new') && now() - row.at > STALE_MS) store.put(row.id, { ...row, status: 'needs_review', reason: 'stuck_before_game_step' });
    }
    const rows = store.all();
    return { dead: rows.filter((r) => r.status === 'dead_letter').length, review: rows.filter((r) => r.status === 'needs_review').length };
  }

  return { quote, startBuy, balance, spend, retryStuck, store };
}

/** Built only in the IT Services webhook handler, after the Razorpay signature is checked there. */
export function createPaymentSide({ pay }) {
  async function paymentVerified({ orderId, paymentRef, paidMinor, currency }) {
    const r = await pay.post('/v1/rail/confirm', { order_id: orderId, payment_ref: paymentRef, paid_minor: paidMinor, currency });
    if (r.status !== 200) return fail(code(r) ?? 'confirm_failed', r.status);
    return { ok: true, credited: r.body.credited };
  }
  return { paymentVerified };
}
