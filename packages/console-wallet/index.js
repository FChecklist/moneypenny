// Console wallet: the one place an organizer buys and spends credits (design: ORGANIZER-CREDITS-DESIGN).
// Server-side only. It never sees card data, never moves money, never changes a game.
// `mnp` is { api, pay }: signed clients with get/post returning { status, body } (production: signed fetch to Moneypenny).
// `games[product].entitle({ email, item, orderRef })` is the game's own existing step (server to server).
// `store` keeps console orders (one unique id each); production: the console database.

export function memoryStore() {
  const rows = new Map();
  let n = 0;
  return {
    next: () => `${++n}`,
    get: (id) => rows.get(id) ?? null,
    put: (id, row) => { rows.set(id, { ...row }); },
    all: () => [...rows.values()],
  };
}

const fail = (code, status = 400, extra = {}) => ({ ok: false, status, code, ...extra });

export function createWallet({ mnp, games = {}, store = memoryStore() }) {
  /** Packs and prices come from Moneypenny settings (data), never from the page. */
  async function quote(credits) {
    const r = await mnp.api.get(`/v1/quote?credits=${Number(credits)}`);
    return r.status === 200 ? { ok: true, ...r.body } : fail('quote_failed', r.status);
  }

  /** Step 1 of a buy: create the Moneypenny order for a pack. Payment is taken by IT Services (Razorpay). */
  async function startBuy({ email, credits, currency = 'INR', buyId }) {
    if (!email || !buyId || !Number.isSafeInteger(credits) || credits <= 0) return fail('bad_request');
    const orderRef = `BUY-${buyId}`; // the console makes the id; the same id gives the same order
    const r = await mnp.api.post('/v1/buy_credits', { email, credits, currency, order_ref: orderRef });
    if (r.status !== 200) return fail(r.body?.error?.code ?? 'buy_failed', r.status);
    return { ok: true, orderRef, orderId: r.body.order_id, amountMinor: r.body.amount_minor, currency: r.body.currency, payUrl: r.body.pay_url ?? null };
  }

  /** Step 2: IT Services has VERIFIED the payment (signature checked there). Only then are credits added. */
  async function paymentVerified({ orderId, paymentRef, paidMinor, currency }) {
    const r = await mnp.pay.post('/v1/rail/confirm', { order_id: orderId, payment_ref: paymentRef, paid_minor: paidMinor, currency });
    if (r.status !== 200) return fail(r.body?.error?.code ?? 'confirm_failed', r.status);
    return { ok: true, credited: r.body.credited };
  }

  const balance = async (email) => (await mnp.api.get(`/v1/balance?email=${encodeURIComponent(email)}`)).body;

  /** Spend on a catalogue item. Order: reserve, game step, capture. A failure before capture releases the hold. */
  async function spend({ email, product, item }) {
    const game = games[product];
    if (!game) return fail('unknown_product', 404);
    const id = store.next();
    const orderRef = `${product}-${id}`;
    const row = { id, orderRef, email, product, item, status: 'new', tries: 0 };
    store.put(id, row);
    const r = await mnp.api.post('/v1/spend/reserve_item', { email, product, item, order_ref: orderRef });
    if (r.status !== 200) {
      store.put(id, { ...row, status: 'refused', reason: r.body?.error?.code });
      return fail(r.body?.error?.code ?? 'reserve_failed', r.status);
    }
    Object.assign(row, { status: 'reserved', holdId: r.body.hold_id, credits: r.body.credits });
    store.put(id, row);
    try {
      await game.entitle({ email, item, orderRef });
    } catch {
      await mnp.api.post('/v1/spend/release', { hold_id: row.holdId });
      store.put(id, { ...row, status: 'released' });
      return fail('game_step_failed', 502);
    }
    row.status = 'entitled';
    store.put(id, row);
    return capture(row);
  }

  async function capture(row) {
    const c = await mnp.api.post('/v1/spend/capture', { hold_id: row.holdId });
    if (c.status === 200) {
      store.put(row.id, { ...row, status: 'captured' });
      return { ok: true, orderRef: row.orderRef, credits: row.credits };
    }
    // The game step was already done, so keep the order for retry, then for the owner (dead letter).
    const tries = row.tries + 1;
    store.put(row.id, { ...row, tries, status: tries >= 3 ? 'dead_letter' : 'capture_retry', reason: c.body?.error?.code });
    return fail('capture_pending', 202, { orderRef: row.orderRef });
  }

  /** The 30-minute job: retry stuck captures; what is still stuck after 3 tries is for the owner. */
  async function retryStuck() {
    for (const row of store.all()) if (row.status === 'capture_retry') await capture(row);
    return { dead: store.all().filter((r) => r.status === 'dead_letter').length };
  }

  return { quote, startBuy, paymentVerified, balance, spend, retryStuck, store };
}
