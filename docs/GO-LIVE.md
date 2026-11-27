# Go-live: Moneypenny (Priority 1)

Plain words. Written for the owner (Rajat Agarwal) and for whoever carries out the steps.
Version of this plan: Moneypenny 0.3.0 (the go-live preparation, numbered 0.2.0 to 0.2.2 while it was on its own branch, joined with master's exchange-rate step). Nothing in this file has been done: no deploy, no merge, no real payment.

## 1. The five facts you must know first

- **The chain.** Game -> `console.corporatetambola.com` -> Moneypenny -> IT Services (Cloudflare Pages + D1) -> Razorpay.
  - One payee: **IT Services**. One payment gateway: **Razorpay**. No other payee or gateway appears in any customer text.
  - Moneypenny never holds or moves money. It only keeps the count of credits (the "Credit $" ledger).
- **Today it is dark.** The live Worker (0.1.0) has no payment side wired. `buy_credits` answers `rail_not_configured` and makes no order. Nobody can be charged.
- **The two money flags are not in this repo.** `PAY_VIA_MONEYPENNY` and `PAY_VIA_CONSOLE` live in the game / console projects. I searched this repo and found neither name. I could not see those projects, so I cannot show you where they are set. Both must be OFF now. The customer-facing meaning of OFF and the one narrow exception for the owner's own test are in section 4.
- **Four things are not built yet and block the Rs 1 test** (section 8): the IT Services adapter inside Moneypenny, the IT Services payment page and webhook, the console's permanent order store, and an owner-only gate. Until they exist and are audited, the Rs 1 test cannot run. This plan does not pretend otherwise.
- **Two known limits block opening payments to customers (step E5), even after the Rs 1 test passes** (section 8, items 1a and 1b): Moneypenny calls IT Services inside its one-at-a-time database transaction (up to 4 seconds of everything frozen for each call; the admin sweep can make up to 25 such calls in one transaction), and the webhook address check looks at names only, not at the real address behind the name.
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

## 4. The flags (no customer reaches payment until section 6 passes)

- Names: `PAY_VIA_MONEYPENNY`, `PAY_VIA_CONSOLE`. Owner: the game and console projects.
- **Rule (one rule, no exception for customers):** no customer can reach any payment until the owner's own Rs 1 payment passes every check in step D3, and the gates in section 8 (items 1a, 1b) are closed.
  - The flags are all-or-nothing switches. The Rs 1 test therefore may **not** be run by turning a flag ON for everyone. It runs only through an **owner-only gate** (section 8, item 3) that has been built and has had two audits. If that gate does not exist, the test does not run.
  - The Moneypenny test pack (`inr_packs` = `{"1": 100}`, `buy_min_credits` = 1, step C2) is set for the whole tenant. If a customer can reach the flag, a customer can buy 1 credit for Re 1. That is why the gate check in D1 comes before anything else.
- Proof that they are OFF: before every phase, open the setting in each project and write the two readings (name, value, date) in the release note. A screenshot of the setting page is fine; it must not show any secret.
- Moneypenny has its own brakes that do not depend on those flags (use any of them to stop money at once, see section 7):
  - No payment side wired = `buy_credits` refuses.
  - Hub status switch: any `mode` other than `on` stops all changes (and the unreadable switch also stops changes). **Today the live Worker has `MNP_STATUS_OPTIONAL=1`, which means "always on" and no global switch at all. This brake exists only after step B2.**
  - Tenant `kill_switch` setting (admin key): everything stops except admin.
  - Revoking a key (owner setup call `revoke_key`) works even while everything else is off.
  - A pause also refuses payment confirmations (section 7, step 2). A customer who already paid is then not credited until the pause ends.

## 5. Ordered steps

### Phase A: build and audit (nothing is turned on)

- A1. **Code, IT Services adapter inside Moneypenny** (section 8, item 1). Must pass `railContract` (see `src/rail.js`) against a Razorpay test-mode setup (test keys, no real money). Wire it into `src/worker.js` in place of `unconfiguredRail`. Own PR, two audits.
  - **Also in A1, or the first real-traffic gate stays shut:** move the IT Services call out of the database transaction (use the existing outbox: save the order, finish the transaction, then call IT Services), so a slow IT Services never freezes other calls. Section 8, item 1a explains the risk. The Rs 1 test alone may run with the call still inside, because only the owner is online; customer traffic (E5) may not.
  - Also give the open `/health` rail check its own timeout (section 8, item 12).
- A2. **IT Services side** (Pages function + D1): create the Razorpay order once per Moneypenny order id, check the Razorpay webhook signature, then call `rail/confirm`. Own PR in that repo, two audits.
- A3. **Console side:** permanent order store that passes `storeContract` (see `packages/console-wallet/index.js`); run `retryStuck` every 2 minutes; owner alert connected to a real channel.
- A3b. **Owner-only gate** for the test (section 8, item 3), built and audited. It must refuse every e-mail except the owner's.
- A4. **Hub status file** reachable at an https address, with `mode: "on"`.
- A5. This PR merged only after two `AUDIT: PASS` on its exact SHA.

### Phase B: deploy dark (flags still OFF)

- B1. Read both flags in game and console. Both OFF. Write the readings down.
- B2. In `wrangler.toml`: set `MNP_STATUS_URL`, **delete** `MNP_STATUS_OPTIONAL`. (Code change, so it goes in a PR.)
- B3. Deploy Worker 0.3.0 (`wrangler deploy`). The database migrates itself on start. Migration 0004 only adds a column with a default, so the old code still runs on it (this is what makes rollback safe).
- B4. Dark smoke test (reads only, no money):
  - `GET /health` -> `ok: true`. **This is true only once the adapter (A1) is wired.** On code that still has `unconfiguredRail`, `GET /health` answers `ok: false`; that is expected and not an alarm, but it also means you must not deploy 0.2.1 on its own and then expect step B4 to pass.
  - `GET /v1/admin/health` (admin key) -> ledger chain and audit chain `ok`, no mismatch.
  - Switch check: with the Hub file set to anything but `on`, a write is refused (`paused_global`); set it back to `on`.
- B5. Write down the numbers you will compare later: entries count and credits owed from `GET /v1/admin/reconcile`.

### Phase C: prepare the test (flags still OFF)

- C1. Issue the keys with the owner setup call. `scripts/setup.js` signs the call with the master secret, so `MNP_MASTER_SECRET` must be present in the environment of that one shell (set it in the current shell only, never in a file, a history line shared with others, or a ticket; close the shell afterwards): `node scripts/setup.js <url> '{"action":"issue_key","scope":"api","label":"console"}'`, then `purchase`, `read`, `admin`. Without the variable the script stops with an error. The secret is shown once; the person doing it puts each straight into the right project's secret box. Old purchase and AI keys were revoked after the first smoke (STATE.md), so new ones are needed.
- C2. With the admin key, set a **temporary test pack** and test item:
  - `inr_packs` = `{"1": 100}` (1 credit costs 100 paise = Rs 1.00; inside the 40 to 160 paise band).
  - `buy_min_credits` = `1` (default is 100).
  - Price list: product = the product code the console uses for the game, item `rs1_test`, `credits` = 1.
  - These numbers are rehearsed in `test/rs1-chain.test.js`.
  - **Exchange-rate rule from master (step 2):** an INR order is refused with 503 `rate_source_not_configured` while the active rate came from the **stub** source. With no rate stored at all, or a rate set by the owner (`set_rate`, source `manual`), or a real source (`er-api`, `fawaz`), the Rs 1 fixed pack works. So: do **not** run the rate refresh with the offline stub (`MNP_FX_SOURCE=stub`) on the live data. Nothing in the Worker refreshes rates yet (no scheduled job), so fixed packs are the only INR path in this plan. This is checked in `test/rs1-chain.test.js` (R1 and R2).
  - Razorpay's smallest order is normally Rs 1.00. Confirm for your account in the Razorpay dashboard before the test.
- C3. Use the owner's own e-mail, already verified by the console. Never a test address that someone else can read.
- C4. Check the console rejects any other pack price (the test pack must be the only INR pack open, and only the owner may see it; see section 8, item 3).
- C5. If the test is abandoned at any point after C2, do step E2 anyway (remove the test pack and the `rs1_test` item, restore `buy_min_credits` to 100). Do not leave a Re 1 pack set tenant-wide.

### Phase D: the owner's own Rs 1 payment (the only real payment in this plan)

- D1. Quiet time. Only the owner is online. **Check the gate before anything else:**
  1. The owner-only gate (section 8, item 3) is built and has two `AUDIT: PASS`. If not, stop: the test does not run.
  2. With the gate in place and before any payment, a **second, non-owner account** (a test account you control, not a customer) tries to buy. It must be refused, and no order must be created in Moneypenny. Write the result down. If that account can reach payment, turn the flag OFF at once and go to section 7.
  3. Only then turn the flags ON, and only behind the gate. The gate sits **in front of the flag**: a customer's click must reach the gate first, and only the owner's e-mail is let through to where the flag is read. So while the flags are ON, every other person still gets "refused" and cannot reach payment. Never turn a flag ON for everyone for this test, and never rely on the flag alone.
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
  10. A second, non-owner account is still refused payment (the D1 check, repeated while the flags are ON and after the payment). No other order exists in Moneypenny except the owner's.
- D4. Also try once without paying: start a buy and close the Razorpay page. Result must be an unpaid order and no credits.

### Phase E: after a pass

- E1. Turn the flags OFF again if they were only on for the test (this is a fresh decision by the owner, not a default).
- E2. Remove the test pack, restore `buy_min_credits` to 100, switch `rs1_test` off in the price list.
- E3. Write the result in `STATE.md` (date, SHA, which checks passed). Never write the payment id in full.
- E4. Real packs and real prices: owner decision, set with the admin key.
- E5. **First check the two customer-traffic gates (section 8, items 1a and 1b) are closed: the IT Services call is out of the transaction, and the real event sender checks the resolved address.** If either is open, stop here. Then turn on **one** flag, wait 24 hours, check section 9 daily items, then the other. Owner approves each flip.

### Phase F: watch for the first week

- Section 9 checks, every day.

## 6. When any customer may reach payment

No customer can reach payment until D3 items 1 to 10 and D4 pass on the same run. During D1 to D3 the flags are ON only behind the audited owner-only gate. The two audits of the exact deployed SHA must both be `AUDIT: PASS`. A partial pass is a fail. Passing the Rs 1 test is not enough for customers: the section 8 gates (items 1a and 1b) must also be closed before E5.

## 7. Rollback (fastest first)

1. **Both flags OFF.** Seconds. Customers stop reaching any payment.
2. **Moneypenny stops changes:** set the Hub status `mode` to anything but `on`, or set `kill_switch` to `1` with the admin key. Admin read-only view keeps working.
   - **A pause also refuses payment confirmations.** `rail/confirm`, `credit_purchase` and `payment_notice` answer 503 (`paused` for the kill switch, `paused_global` when the Hub is off, `status_unknown` when the Hub file cannot be read). A customer who already paid in Razorpay gets no credits until the switch is back on.
   - IT Services must keep retrying a 503 and must not give up. After any pause, check the section 9 count (Razorpay = IT Services D1 = Moneypenny) and fix any gap by repeating `rail/confirm` (step 5).
3. **Cut a caller:** owner setup call `revoke_key` for the console `api` key or the IT Services `purchase` key. Works even while switched off.
4. **Roll the code back:** Cloudflare dashboard, Worker `moneypenny`, Deployments, pick the previous version (or `wrangler rollback`).
   - Pick the version from the Cloudflare dashboard list. Go to the 0.1.0 version that has the master secret; do **not** pick the older version that has no secret (it will not start). The version ids are in `STATE.md`; they are not repeated here.
   - The database stays as it is. Migrations are forward-only and additive, so older code keeps running on it.
5. **Money already moved (customer paid, credits wrong):** the ledger cannot be edited (it is append-only and hash-chained, by design). Fix by a new entry:
   - Credits missing: repeat `POST /v1/rail/confirm` with the order id and the same payment id (credits once; a repeat adds nothing). This path uses the order's fixed price, so it works while no INR rate is set, which is the state of this plan (fixed packs only, no `set_rate` step). `credit_purchase` for an INR payment also needs a current INR rate and answers 503 `rate_stale` without one, so do not use it in this plan.
   - Credits that should not exist: `refund` (type `purchase` or `chargeback`) with the purchase key. This returns credits to a "money due" note. **This system never pays money.** The cash refund is made by IT Services in Razorpay.
6. **Unpaid orders stuck:** `GET /v1/admin/dead_letters`, fix the cause, then `POST /v1/admin/dead_letters/requeue`.
7. After any rollback: run `GET /v1/admin/health`; chain and balances must be `ok` before flags go back.

What cannot be rolled back: ledger entries (by design) and Razorpay payments (refund them in Razorpay).

## 8. Open items (not done in this PR)

1. **IT Services adapter in Moneypenny: not built.** The Worker uses `unconfiguredRail`. The adapter must: create the order on IT Services once per `order_id` (a repeat returns the same order), return `{ rail_order_id, pay_url }` with an https `pay_url`, answer `health()` as `{ ok }`, and finish within 4 seconds. `railContract` in `src/rail.js` checks these. I did not write it because the IT Services interface is not visible to me and I will not invent it.
1a. **GATE before E5: the call to IT Services runs inside the database transaction.** When a customer buys credits, Moneypenny asks IT Services to create the order while the one-at-a-time database transaction is open (`src/gate.js`, inside `db.tx` in `src/api.js`). Every request waits behind that one lock (`src/do.js`).
   - **Risk:** a slow IT Services holds the lock for up to the 4-second limit **per call**. The admin sweep (`POST /v1/admin/sweep`, `POST /v1/admin/rail/process`) runs up to 25 waiting rail calls one after another inside one transaction, so the worst case there is about 100 seconds. For that time every other call waits: `rail/confirm` for people who already paid, spending, balances. Anyone who can create orders can repeat this, because each new `order_ref` is a new order. It is harmless for the owner's own Rs 1 test (only the owner is online), which is why the test may pass with it open.
   - **Mitigation:** move the call after the commit with the outbox that already exists (save the order, end the transaction, then call IT Services, retry on failure), and add a test that fails if any rail call (`create`, `instruct`, sweep, `rail/process`) is made inside the transaction. Until that is done, real traffic waits (E5 stays shut). A stop-gap, if the owner insists on earlier traffic, is a Cloudflare rate limit in front on `buy_credits`; it reduces but does not remove the risk.
   - `README.md` ("Known limits") already says this must be fixed before real traffic; the same applies to the rail `instruct` call, which is also inside the transaction.
1b. **GATE before E5: the webhook address check is name-based.** The check on webhook addresses looks at the name only. The real event sender must also check the address the name resolves to, so a name cannot point at an internal address. Build that into the sender when it is built (item 5).
2. **IT Services Pages + D1 side: not visible, not audited here.** It must check Razorpay's signature, tolerate repeated webhooks, and call `rail/confirm` with the exact paid amount in paise.
3. **Owner-only gate for the test, and where the two flags live: not visible.** The flags are treated as all-or-nothing, so the test needs a small gate (owner e-mail only) built and audited first. Nothing in this repo proves that such a gate works. Proof is required in D1 (a second, non-owner account is refused) and repeated in D3 item 10. No gate, no test.
4. **Console permanent store and 2-minute job: not built here.** `createWallet` ships with an in-memory store for tests only.
5. **Nothing schedules Moneypenny's housekeeping** (`POST /v1/admin/sweep`: lapsed holds, unpaid orders, waiting rail calls) and **nothing sends its webhook events** (`rail.dead_letter`, `payment.overpaid`, `refund.money_due`). So alerts do not reach anyone. Until a cron and a sender exist, check section 9 by hand. Money safety does not depend on them: a late payment is still credited and holds also lapse when the next reserve runs.
6. **Hub status file address (`MNP_STATUS_URL`):** owner of the Hub must confirm it.
7. **Moneypenny Chat: not wired.** There is no chat code, route or document for it in this repo (searched). STATE.md lists "the Moneypenny assistant" as a separate module in its own session, ask-only AI key. Open.
8. **Owner decisions still open** (OWNER-DECISIONS.md): Razorpay's view on selling credits, terms page (`terms_url`), CA questions, tax on bonus credits, name check. Settle before real customers, not before the Rs 1 test.
9. **USD packs** are not offered by the console (`currencies = ['INR']`).
10. **Idempotency records are kept 30 days.** After that, a repeated request with the same key is treated as new. Payments stay safe because the payment id is unique forever **within one tenant** (the same payment id would be accepted in a second tenant; only one tenant is live today, so there is no effect now); other writes are protected by the signature time window (5 minutes) and nonce.
11. **One Durable Object is one writer** for everyone. Fine at start; split per tenant later.
12. **Open `/health` has no timeout of its own on the rail call.** It is asked at most once every 30 seconds, but a hung adapter would hang that one call. `railContract` enforces the 4-second limit on the adapter; add the same limit around the health call when the adapter is built (A1).
13. **Rate-based prices use floating-point arithmetic once** (`src/fx.js`, `src/settings.js`) and round to a whole number. Fixed packs (the Rs 1 path) skip it. So "whole numbers only" is true for what is stored and checked, not for every step of working out a rate-based price. This is old code and unchanged here.

## 9. Daily checks for the first week

- After any pause (section 7, step 2): confirm that every payment made during the pause was credited once IT Services retried.
- `GET /v1/admin/health`: chain `ok`, audit `ok`, no mismatch.
- `GET /v1/admin/reconcile`: credits owed equals what you expect.
- `GET /v1/admin/dead_letters`: empty.
- Console: count of orders in `needs_review`: zero, or each one looked at by the owner the same day.
- Razorpay: payments captured equals paid orders in IT Services D1 equals `purchase` entries in Moneypenny (same count, same total in paise).
- Any customer report of a wrong amount or a missing grant: stop the flags first, then investigate.

## 10. What this PR changed in the code (all dark, no behaviour change for valid calls)

- A forged or unsigned call is refused before it can queue on the single writer, so it does not wait behind (or slow) real payments in the queue. It still costs a little work inside the same Durable Object, so put Cloudflare rate limiting in front for a flood (`README.md`). A valid, captured request replayed within its 5-minute window still queues once before the repeat is caught. A forged call never used a real key's per-minute budget, before or after this change.
- Internal-error logs go through `redact`: it removes e-mail addresses, hex of 24 or more characters and token-like text of 32 or more characters, drops line breaks, and looks at the first 2000 characters only. It is a best effort. It does not catch a short hex string, a JWT with short parts, a secret with punctuation, or a card number. Only library error text reaches it, and the 500 answer to the caller is always the same generic text.
- Open `/health` asks the payment rail at most once every 30 seconds.
- `railContract`: a check every real payment rail adapter must pass.
- `npm run guards` (about two minutes): removes each safety guard one at a time in a throw-away copy and demands that a test fails. **46 listed guards** are watched. It proves the listed guards only, not every check in the code. They cover: idempotency of money writes, whole numbers only, hash-chained append-only ledger, replay window and nonce, per-key rate limit, off-switches, console wallet price and key checks, log redaction, rail not configured, expiry on `reserve_item`, the money-refund off-switch.
- **Known unwatched (two guards):** `src/spend.js` line 262 (`want > left`, a refund asks for more than is left on the hold) and line 224 (a captured hold cannot be released). If either is removed, no test fails. No extra money can leave: the later checks stop it (the `refunded + give <= amount` update at line 272, and the `status = 'held'` update at line 225). With line 262 removed, `hold.refunded_credits` could end above `credits`, which is a bookkeeping error only. They are not on the 46 listed guards and `npm run guards` does not check them.
- New tests: `test/golive.test.js`, `test/rs1-chain.test.js`.
- 0.2.1: docs only except one small code change, `redact` now looks at the first 2000 characters only (a test fails without it). Three more guards are listed and watched; no money behaviour changed.
- 0.2.2 (this fix round): docs and one test only, no source code change. Section 6 now says the same one rule as section 4; D1 step 3 says where the gate sits; the two unwatched guards are listed above; the lock-freeze wording now covers the admin sweep (about 100 seconds worst case).
- 0.3.0 (this round): master moved on (exchange-rate step 2, called 0.2.0 on master), so this branch was joined with it and renumbered 0.3.0. The only code merge was `src/api.js` (the pre-check, redact and the 30-second health cache sit beside master's rate-age change). Master's rule that INR orders are refused on a stub rate is explained in step C2 and tested (R2). No other go-live step changed. Tests: 327 pass.
