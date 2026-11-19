// Console wallet: the one place an organizer buys and spends credits (design: ORGANIZER-CREDITS-DESIGN).
// Server-side only. It never sees card data, never moves money, never changes a game.
// `mnp` is a signed client with get/post returning { status, body } (production: signed fetch to Moneypenny).
// `games[product].entitle({ email, item, orderRef })` is the game's own existing step (server to server).
// CONTRACT for each game: entitle is all-or-nothing and idempotent by orderRef (a repeat gives the same result, never a second grant).
// It throws an error with `definite: true` only when it is SURE nothing was granted (a refusal). Any other failure is treated as unknown.
// RUN `retryStuck` EVERY 2 MINUTES (the hold lasts 15 minutes); the 30-minute job is the reconcile, not this one.
// `store` keeps console orders; production: the console database with a unique spend_key and a real compare-and-set.
//
// Every status change is a compare-and-set from the status the caller expects. A caller that loses the race stops.
// Two factories on purpose: `createWallet` is what organizer-facing routes may reach (no purchase key).
// `createPaymentSide` is built only inside the IT Services webhook handler, with the purchase key client.
import { randomUUID, createHash } from 'node:crypto';

export function memoryStore() {
  const rows = new Map();
  return {
    get: (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    all: () => [...rows.values()].map((r) => ({ ...r })),
    // production: unique constraint on spend_key; returns the existing row instead of inserting
    putNew: (id, row) => { const old = [...rows.values()].find((r) => r.spendKey === row.spendKey); if (old) return { ...old }; rows.set(id, { ...row }); return null; },
    // compare and set on status; true when this caller won
    cas: (id, from, patch) => { const r = rows.get(id); if (!r || !from.includes(r.status)) return false; rows.set(id, { ...r, ...patch }); return true; },
    // tests only: plant a row
    plant: (id, row) => { rows.set(id, { ...row }); },
  };
}

const fail = (code, status = 400, extra = {}) => ({ ok: false, status, code, ...extra });
const code = (r) => r?.body?.error?.code;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLAIM_MS = 2 * 60 * 1000; // a worker that has not finished in 2 minutes is presumed dead
const REENTITLE_UNTIL_MS = 12 * 60 * 1000; // the hold lasts 15 minutes: repeat the game step only while it is surely open
const short = (s) => createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex').slice(0, 16);

export function createWallet({ mnp, games = {}, store = memoryStore(), now = Date.now, currencies = ['INR'], alert = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const game = (p) => (typeof p === 'string' && Object.hasOwn(games, p) ? games[p] : null);
  // Owner alert the moment an order needs a person (dead letter, review, failed release): the hold may lapse soon.
  const OWNER_STATES = ['dead_letter', 'needs_review'];
  const move = (id, from, patch) => {
    const ok = store.cas(id, from, { ...patch, at: now() });
    if (ok && OWNER_STATES.includes(patch.status)) { try { alert({ ...store.get(id) }); } catch { /* an alert failure must not stop the flow */ } }
    return ok;
  };

  /** Prices come from Moneypenny settings (data), never from the page. */
  async function quote(credits) {
    if (!Number.isSafeInteger(credits) || credits <= 0) return fail('bad_request');
    const r = await mnp.get(`/v1/quote?credits=${credits}`);
    return r.status === 200 ? { ok: true, ...r.body } : fail('quote_failed', r.status);
  }

  /** Step 1 of a buy: create the Moneypenny order for a listed pack. Payment is taken by IT Services (Razorpay). */
  async function startBuy({ email, credits, currency = 'INR', buyId }) {
    if (!email || !ID.test(String(buyId ?? '')) || !Number.isSafeInteger(credits) || credits <= 0) return fail('bad_request');
    if (!currencies.includes(currency)) return fail('currency_not_offered'); // USD packs are an open owner decision
    const q = await mnp.get(`/v1/quote?credits=${credits}`);
    if (q.status !== 200 || q.body.inr_fixed !== true) return fail('not_a_pack'); // sell listed packs only
    const orderRef = `BUY-${short(email)}-${buyId}`;
    const quoted = q.body.inr_minor; // scoped to the person: nobody else can take this id
    const r = await mnp.post('/v1/buy_credits', { email, credits, currency, order_ref: orderRef });
    if (r.status !== 200) return fail(code(r) ?? 'buy_failed', r.status);
    if (r.body.amount_minor !== quoted) return fail('price_mismatch', 409); // the order must carry the listed pack price
    return { ok: true, orderRef, orderId: r.body.order_id, amountMinor: r.body.amount_minor, currency: r.body.currency, payUrl: r.body.pay_url ?? null };
  }

  const balance = async (email) => (await mnp.get(`/v1/balance?email=${encodeURIComponent(email)}`)).body;

  /**
   * Spend on a catalogue item. Order: record, reserve, record "entitling", game step, record "entitled", capture.
   * `spendKey` (one per click) makes a repeat return the same order, never a second one. It is scoped to the person.
   */
  async function spend({ email, product, item, spendKey = randomUUID() }) {
    const g = game(product);
    if (!g) return fail('unknown_product', 404);
    if (!email || typeof item !== 'string' || !ID.test(String(spendKey))) return fail('bad_request');
    const id = randomUUID();
    const scoped = `${short(email)}:${spendKey}`;
    const orderRef = `${product}-${short(scoped)}`; // from the click's key: a retried reserve meets the same order, not a second one
    const row = { id, orderRef, email, product, item, spendKey: scoped, status: 'new', tries: 0, at: now() };
    const again = store.putNew(id, row); // atomic: one row per scoped key
    if (again) {
      if (again.product !== product || again.item !== item) return fail('key_conflict', 409);
      if (again.status === 'captured') return { ok: true, orderRef: again.orderRef, credits: again.credits, repeat: true };
      if (again.status === 'refused') return fail(again.reason ?? 'refused', 409, { repeat: true });
      if (again.status === 'released') return fail('game_step_failed', 502, { repeat: true });
      if (['dead_letter', 'needs_review', 'release_failed'].includes(again.status)) return fail('with_owner', 409, { orderRef: again.orderRef, status: again.status });
      return fail('order_in_progress', 409, { orderRef: again.orderRef, status: again.status });
    }
    let r;
    try {
      r = await mnp.post('/v1/spend/reserve_item', { email, product, item, order_ref: orderRef });
    } catch {
      // The hold may exist, but no game step was run, so nothing was given: the hold lapses by itself (15 min). Flag it.
      move(id, ['new'], { status: 'needs_review', reason: 'reserve_unknown' });
      return fail('reserve_unknown', 502);
    }
    if (r.status !== 200) {
      move(id, ['new'], { status: 'refused', reason: code(r) });
      return fail(code(r) ?? 'reserve_failed', r.status);
    }
    // recorded BEFORE the game step: a crash leaves a row the job can see
    if (!move(id, ['new'], { status: 'entitling', holdId: r.body.hold_id, credits: r.body.credits })) {
      try { await mnp.post('/v1/spend/release', { hold_id: r.body.hold_id }); } catch { /* the hold lapses by itself */ }
      return fail('order_in_progress', 409);
    }
    try {
      await g.entitle({ email, item, orderRef });
    } catch (e) {
      // Only a DEFINITE refusal (error.definite === true) proves nothing was given. Anything else (timeout, network)
      // is unknown: never release; the job repeats the idempotent step, then captures, or sends it to the owner.
      if (e?.definite === true) return releaseOrder(id, ['entitling'], 'game_step_failed');
      return fail('game_step_unknown', 202, { orderRef });
    }
    if (!move(id, ['entitling'], { status: 'entitled' })) return fail('order_in_progress', 409);
    for (let i = 0; i < 3; i++) { // the hold is short: retry at once, with a short back-off, before leaving it to the job
      const out = await capture(id);
      if (out.ok || store.get(id)?.status === 'dead_letter') return out;
      await sleep(i * 200);
    }
    return fail('capture_pending', 202, { orderRef });
  }

  async function releaseOrder(id, from, why) {
    const cur = store.get(id);
    if (!cur || !from.includes(cur.status)) return fail('order_in_progress', 409);
    let st = 0;
    try { st = (await mnp.post('/v1/spend/release', { hold_id: cur.holdId })).status; } catch { st = 0; }
    const tries = (cur.tries ?? 0) + 1;
    // 200 = released. 409 = the hold is already closed (nothing to retry): the owner looks at it.
    const status = st === 200 ? 'released' : st === 409 || tries >= 3 ? 'needs_review' : 'release_failed';
    move(id, from, { status, tries, reason: why });
    return fail(why, 502);
  }

  async function capture(id) {
    // claim: only one worker holds an order in 'capturing'
    if (!move(id, ['entitled', 'capture_retry'], { status: 'capturing' })) return fail('order_in_progress', 409);
    const row = store.get(id);
    let c;
    try { c = await mnp.post('/v1/spend/capture', { hold_id: row.holdId }); } catch { c = { status: 0, body: {} }; }
    if (c.status === 200 || code(c) === 'hold_already_captured') {
      move(id, ['capturing'], { status: 'captured' });
      return { ok: true, orderRef: row.orderRef, credits: row.credits };
    }
    // The game step is done. A lapsed hold (410) cannot be fixed by retrying: straight to the owner.
    const tries = (store.get(id)?.tries ?? 0) + 1;
    const dead = c.status === 410 || tries >= 5; // 3 quick tries in spend, then the job
    move(id, ['capturing'], { tries, status: dead ? 'dead_letter' : 'capture_retry', reason: code(c) ?? 'capture_failed' });
    return fail('capture_pending', 202, { orderRef: row.orderRef });
  }

  /**
   * The 30-minute job (safe to run twice at once: every step is claimed first).
   * Captures entitled orders; repeats a crashed game step (idempotent by orderRef) while the hold is open;
   * everything else that is stuck goes to `needs_review` for the owner, never guessed.
   */
  async function retryStuck() {
    for (const row of store.all()) {
      const age = now() - row.at;
      if (row.status === 'entitled' || row.status === 'capture_retry') await capture(row.id);
      else if (row.status === 'capturing' && age > CLAIM_MS) { if (move(row.id, ['capturing'], { status: 'capture_retry' })) await capture(row.id); }
      else if (row.status === 'release_failed') await releaseOrder(row.id, ['release_failed'], row.reason);
      else if (row.status === 'entitling' && age > CLAIM_MS && age < REENTITLE_UNTIL_MS) {
        if (!move(row.id, ['entitling'], { status: 'reentitling' })) continue; // another run has it
        try {
          await games[row.product].entitle({ email: row.email, item: row.item, orderRef: row.orderRef });
          if (move(row.id, ['reentitling'], { status: 'entitled' })) await capture(row.id);
        } catch (e) {
          if (e?.definite === true) await releaseOrder(row.id, ['reentitling'], 'game_step_failed');
          else store.cas(row.id, ['reentitling'], { status: 'entitling', at: row.at }); // still unknown: keep `at`, it ages to the owner
        }
      } else if (['entitling', 'new', 'reentitling'].includes(row.status) && age >= REENTITLE_UNTIL_MS) move(row.id, [row.status], { status: 'needs_review', reason: 'stuck_before_game_step' });
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
