# Go-live: Moneypenny (Priority 1)

Plain words. Written for the owner (Rajat Agarwal) and for whoever carries out the steps.
Version of this plan: Moneypenny 0.2.0. Nothing in this file has been done: no deploy, no merge, no real payment.

## 1. The five facts you must know first

- **The chain.** Game -> `console.corporatetambola.com` -> Moneypenny -> IT Services (Cloudflare Pages + D1) -> Razorpay.
  - One payee: **IT Services**. One payment gateway: **Razorpay**. No other payee or gateway appears in any customer text.
  - Moneypenny never holds or moves money. It only keeps the count of credits (the "Credit $" ledger).
- **Today it is dark.** The live Worker (0.1.0) has no payment side wired. `buy_credits` answers `rail_not_configured` and makes no order. Nobody can be charged.
- **The two money flags are not in this repo.** `PAY_VIA_MONEYPENNY` and `PAY_VIA_CONSOLE` live in the game / console projects. I searched this repo and found neither name. I could not see those projects, so I cannot show you where they are set. Both must be OFF now and stay OFF until section 6 passes.
- **Three things are not built yet and block the Rs 1 test** (section 8): the IT Services adapter inside Moneypenny, the IT Services payment page and webhook, and the console's permanent order store. Until they exist and are audited, the Rs 1 test cannot run. This plan does not pretend otherwise.
- **Release rule that applies to every step marked "code":** one writer per repo, one push, two independent audits on the exact SHA, deploy only after two `AUDIT: PASS`. Version is bumped in the same PR (see `KNOWLEDGE.md`).

## 2. How one purchase travels (so you can check each hop)

1. Customer taps "buy credits" in the game. The game sends them to the console.
2. Console asks Moneypenny for the pack price (`GET /v1/quote`), then makes an order (`POST /v1/buy_credits`, product key, class `api`). Moneypenny answers with the order and the amount in paise.
3. Moneypenny asks IT Services to create the order (the "rail" call, repeated safely by order id). IT Services creates the Razorpay order and returns a pay link.
4. Customer pays on the Razorpay page. Razorpay tells IT Services (webhook).
5. IT Services checks Razorpay's signature itself, then tells Moneypenny `POST /v1/rail/confirm` (payment key, class `purchase`) with order id, payment id, amount, currency.
6. Moneypenny checks amount and currency match the order, then adds the credits once. The payment id is the repeat-protection key, so a second webhook adds nothing.
7. Customer spends credits: console calls `reserve_item`, `capture`, then the game's own grant step. If the game clearly refuses, the console returns the credits.

## 3. Secrets and settings: names only, never values

Never paste a value into chat, a ticket, a screenshot, a commit or a log. A person types each value into the secret box of the right project.

| Where | Name | What it is | Checked in this repo? |
|---|---|---|---|
| Worker `moneypenny` | `MNP_MASTER_SECRET` | Master secret, 32+ characters. Every key secret and the owner setup signature come from it. | Yes (`src/worker.js`, `src/api.js`) |
| Worker `moneypenny` | `MNP_STATUS_URL` | Plain variable: address of the Hub `status.json` (global off-switch). | Yes |
| Worker `moneypenny` | `MNP_STATUS_OPTIONAL` | Plain variable. Today `1` in `wrangler.toml`. **Must be removed before any payment side is connected.** | Yes |
| Console | Moneypenny `api` key id and secret | Lets the console call quote, buy_credits, reserve_item, capture, refund(order). | Role yes; the variable name is in the console repo |
| IT Services | Moneypenny `purchase` key id and secret | Lets IT Services call rail/confirm and payment_notice only. | Role yes; name is in the IT Services repo |
| IT Services | Razorpay key id, Razorpay key secret, Razorpay webhook secret | Creates Razorpay orders and checks webhook signatures. | No. Names are in the IT Services repo |
| Game / widget | Moneypenny `read` key id and secret | Shows a balance only. | Role yes |
| Owner only | Moneypenny `admin` key id and secret | Settings, price list, health, reconcile. | Yes |
| Whoever builds the adapter | A secret that proves Moneypenny to IT Services | Needed by the IT Services adapter (section 8, item 1). | Not defined yet |

- Key secrets are **not stored** anywhere: they are worked out from `MNP_MASTER_SECRET` and the key id. So changing the master secret **kills every key at once** and the setup call. Do not change it unless it leaked. If it leaked: change it, then issue all keys again (step C1).
- The master secret for the live Worker is already set (STATE.md). Keep the owner's copy outside the repo.

## 4. The flags (they stay OFF until section 6 passes)

- Names: `PAY_VIA_MONEYPENNY`, `PAY_VIA_CONSOLE`. Owner: the game and console projects.
- **Rule: OFF means no customer can reach any payment. Both OFF until the owner's own Rs 1 payment passes every check in step D3.**
- Proof that they are OFF: before every phase, open the setting in each project and write the two readings (name, value, date) in the release note. A screenshot of the setting page is fine; it must not show any secret.
- Moneypenny has its own brakes that do not depend on those flags (use any of them to stop money at once, see section 7):
  - No payment side wired = `buy_credits` refuses.
  - Hub status switch: any `mode` other than `on` stops all changes (and the unreadable switch also stops changes).
  - Tenant `kill_switch` setting (admin key): everything stops except admin.
  - Revoking a key (owner setup call `revoke_key`) works even while everything else is off.

## 5. Ordered steps

### Phase A: build and audit (nothing is turned on)

- A1. **Code, IT Services adapter inside Moneypenny** (section 8, item 1). Must pass `railContract` (see `src/rail.js`) against a Razorpay test-mode setup (test keys, no real money). Wire it into `src/worker.js` in place of `unconfiguredRail`. Own PR, two audits.
- A2. **IT Services side** (Pages function + D1): create the Razorpay order once per Moneypenny order id, check the Razorpay webhook signature, then call `rail/confirm`. Own PR in that repo, two audits.
- A3. **Console side:** permanent order store that passes `storeContract` (see `packages/console-wallet/index.js`); run `retryStuck` every 2 minutes; owner alert connected to a real channel.
- A4. **Hub status file** reachable at an https address, with `mode: "on"`.
- A5. This PR merged only after two `AUDIT: PASS` on its exact SHA.

### Phase B: deploy dark (flags still OFF)

- B1. Read both flags in game and console. Both OFF. Write the readings down.
- B2. In `wrangler.toml`: set `MNP_STATUS_URL`, **delete** `MNP_STATUS_OPTIONAL`. (Code change, so it goes in a PR.)
- B3. Deploy Worker 0.2.0 (`wrangler deploy`). The database migrates itself on start. Migration 0004 only adds a column with a default, so the old code still runs on it (this is what makes rollback safe).
- B4. Dark smoke test (reads only, no money):
  - `GET /health` -> `ok: true`.
  - `GET /v1/admin/health` (admin key) -> ledger chain and audit chain `ok`, no mismatch.
  - Switch check: with the Hub file set to anything but `on`, a write is refused (`paused_global`); set it back to `on`.
- B5. Write down the numbers you will compare later: entries count and credits owed from `GET /v1/admin/reconcile`.

### Phase C: prepare the test (flags still OFF)

- C1. Issue the keys with the owner setup call (`node scripts/setup.js <url> '{"action":"issue_key","scope":"api","label":"console"}'`, then `purchase`, `read`, `admin`). The secret is shown once; the person doing it puts each straight into the right project's secret box. Old purchase and AI keys were revoked after the first smoke (STATE.md), so new ones are needed.
- C2. With the admin key, set a **temporary test pack** and test item:
  - `inr_packs` = `{"1": 100}` (1 credit costs 100 paise = Rs 1.00; inside the 40 to 160 paise band).
  - `buy_min_credits` = `1` (default is 100).
  - Price list: product = the product code the console uses for the game, item `rs1_test`, `credits` = 1.
  - These numbers are rehearsed in `test/rs1-chain.test.js`.
  - Razorpay's smallest order is normally Rs 1.00. Confirm for your account in the Razorpay dashboard before the test.
- C3. Use the owner's own e-mail, already verified by the console. Never a test address that someone else can read.
- C4. Check the console rejects any other pack price (the test pack must be the only INR pack open, and only the owner may see it; see section 8, item 3).

### Phase D: the owner's own Rs 1 payment (the only real payment in this plan)

- D1. Quiet time. Only the owner is online. Turn the flags ON **only as far as the owner-only gate allows** (section 8, item 3). If there is no owner-only gate, build it first; do not open real payments to customers for the test.
- D2. Owner opens the game, taps buy, lands on `console.corporatetambola.com`, pays Rs 1 on the Razorpay page with their own UPI or card.
- D3. **Every one of these must be true** (any "no" means stop and go to section 7):
  1. Razorpay dashboard: exactly one payment of Rs 1.00, captured, on the IT Services account.
  2. IT Services D1: one order, status paid, same payment id.
  3. Moneypenny `GET /v1/history?email=<owner e-mail>` (api key): one `purchase` entry of +1 credit with that payment id.
  4. Balance is 1. Credits owed in reconcile went up by exactly 1.
  5. In Razorpay, press "resend webhook" once. Balance stays 1.
  6. Owner spends the 1 credit on `rs1_test`. The game grants it once. Balance is 0. History shows `hold -1` then `capture`.
  7. `GET /v1/admin/health`: chain `ok`, no mismatch.
  8. No customer text anywhere names any payee other than IT Services or any gateway other than Razorpay.
  9. Look at the Worker logs for the test window: no e-mail, no key, no signature (the code redacts, but look).
- D4. Also try once without paying: start a buy and close the Razorpay page. Result must be an unpaid order and no credits.

### Phase E: after a pass

- E1. Turn the flags OFF again if they were only on for the test.
- E2. Remove the test pack, restore `buy_min_credits` to 100, switch `rs1_test` off in the price list.
- E3. Write the result in `STATE.md` (date, SHA, which checks passed). Never write the payment id in full.
- E4. Real packs and real prices: owner decision, set with the admin key.
- E5. Turn on **one** flag, wait 24 hours, check section 9 daily items, then the other. Owner approves each flip.

### Phase F: watch for the first week

- Section 9 checks, every day.

## 6. When the flags may leave OFF

Only when D3 items 1 to 9 and D4 are all true on the same run, and the two audits of the exact deployed SHA were `AUDIT: PASS`. A partial pass is a fail.

## 7. Rollback (fastest first)

1. **Both flags OFF.** Seconds. Customers stop reaching any payment.
2. **Moneypenny stops changes:** set the Hub status `mode` to anything but `on`, or set `kill_switch` to `1` with the admin key. Admin read-only view keeps working.
3. **Cut a caller:** owner setup call `revoke_key` for the console `api` key or the IT Services `purchase` key. Works even while switched off.
4. **Roll the code back:** Cloudflare dashboard, Worker `moneypenny`, Deployments, pick the previous version (or `wrangler rollback`).
   - Known ids from `STATE.md`: current 0.1.0 `5d8ac727-536d-4174-9fa3-52fe6dd96b06` (has the master secret). Do **not** go to `8f26e747-dfa9-4251-928f-5fa17f1701e5`: it has no secret and will not start.
   - The database stays as it is. Migrations are forward-only and additive, so older code keeps running on it.
5. **Money already moved (customer paid, credits wrong):** the ledger cannot be edited (it is append-only and hash-chained, by design). Fix by a new entry:
   - Credits missing: IT Services calls `credit_purchase` with the real payment id (works once per id).
   - Credits that should not exist: `refund` (type `purchase` or `chargeback`) with the purchase key. This returns credits to a "money due" note. **This system never pays money.** The cash refund is made by IT Services in Razorpay.
6. **Unpaid orders stuck:** `GET /v1/admin/dead_letters`, fix the cause, then `POST /v1/admin/dead_letters/requeue`.
7. After any rollback: run `GET /v1/admin/health`; chain and balances must be `ok` before flags go back.

What cannot be rolled back: ledger entries (by design) and Razorpay payments (refund them in Razorpay).

## 8. Open items (not done in this PR)

1. **IT Services adapter in Moneypenny: not built.** The Worker uses `unconfiguredRail`. The adapter must: create the order on IT Services once per `order_id` (a repeat returns the same order), return `{ rail_order_id, pay_url }` with an https `pay_url`, answer `health()` as `{ ok }`, and finish within 4 seconds. `railContract` in `src/rail.js` checks these. I did not write it because the IT Services interface is not visible to me and I will not invent it.
2. **IT Services Pages + D1 side: not visible, not audited here.** It must check Razorpay's signature, tolerate repeated webhooks, and call `rail/confirm` with the exact paid amount in paise.
3. **Owner-only gate for the test, and where the two flags live: not visible.** If the flags are all-or-nothing, the test needs a small gate (owner e-mail only) built and audited first.
4. **Console permanent store and 2-minute job: not built here.** `createWallet` ships with an in-memory store for tests only.
5. **Nothing schedules Moneypenny's housekeeping** (`POST /v1/admin/sweep`: lapsed holds, unpaid orders, waiting rail calls) and **nothing sends its webhook events** (`rail.dead_letter`, `payment.overpaid`, `refund.money_due`). So alerts do not reach anyone. Until a cron and a sender exist, check section 9 by hand. Money safety does not depend on them: a late payment is still credited and holds also lapse when the next reserve runs.
6. **Hub status file address (`MNP_STATUS_URL`):** owner of the Hub must confirm it.
7. **Moneypenny Chat: not wired.** There is no chat code, route or document for it in this repo (searched). STATE.md lists "the Moneypenny assistant" as a separate module in its own session, ask-only AI key. Open.
8. **Owner decisions still open** (OWNER-DECISIONS.md): Razorpay's view on selling credits, terms page (`terms_url`), CA questions, tax on bonus credits, name check. Settle before real customers, not before the Rs 1 test.
9. **USD packs** are not offered by the console (`currencies = ['INR']`).
10. **Idempotency records are kept 30 days.** After that, a repeated request with the same key is treated as new. Payments stay safe because the payment id is unique forever; other writes are protected by the signature time window (5 minutes) and nonce.
11. **One Durable Object is one writer** for everyone. Fine at start; split per tenant later.

## 9. Daily checks for the first week

- `GET /v1/admin/health`: chain `ok`, audit `ok`, no mismatch.
- `GET /v1/admin/reconcile`: credits owed equals what you expect.
- `GET /v1/admin/dead_letters`: empty.
- Console: count of orders in `needs_review`: zero, or each one looked at by the owner the same day.
- Razorpay: payments captured equals paid orders in IT Services D1 equals `purchase` entries in Moneypenny (same count, same total in paise).
- Any customer report of a wrong amount or a missing grant: stop the flags first, then investigate.

## 10. What this PR changed in the code (all dark, no behaviour change for valid calls)

- A forged or unsigned call is refused before it can queue on the single writer; it also cannot use up a real key's per-minute budget.
- Internal-error logs never carry e-mails, long secrets or request data.
- Open `/health` asks the payment rail at most once every 30 seconds.
- `railContract`: a check every real payment rail adapter must pass.
- `npm run guards` (about two minutes): removes each safety guard one at a time in a throw-away copy and demands that a test fails. 43 guards are watched (idempotency of money writes, whole numbers only, hash-chained append-only ledger, replay window and nonce, per-key rate limit, off-switches, console wallet price and key checks, log redaction, rail not configured).
- New tests: `test/golive.test.js`, `test/rs1-chain.test.js`.
