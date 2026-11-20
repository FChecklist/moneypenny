# Moneypenny: state and handover (17 Nov 2026)

**One line:** Phase 0 is built and tested locally. Nothing is deployed, pushed or registered. Audit 5 (independent) was running when this was written; the final verdict is below once it is in.

## What is built
- Credit ledger (append-only, hash-chained), lots/buckets (bought, bonus, commission), holds, spend gate, `buy_credits` via a rail outbox (stub rail), payment notice, conversion requests (records only, no payout), reconcile views, FX table (daily, margin 5%, 120-minute order lock), AI-ready API (scoped keys, ask-only AI key, approvals, kill switch, Hub status file), OpenAPI contract in `contract/v1/openapi.json`, balance widget with built-in coin icon.
- Currency default: name "Moneypenny", label "moneypenny", symbol = built-in coin icon, `terms_url` setting. Display text never a bare symbol.
- Cloudflare executor: one SQLite-backed Durable Object (`src/do.js`, `src/worker.js`), not plain D1 (D1 has no interactive transactions).

## Tests
- 259 tests pass (`npm test`), also on the Durable Object adapter with `MNP_DB=do npm test`. The adapter is tested only against a stand-in for Cloudflare's storage.

## Audit rounds
| Round | Verdict | Notes |
|---|---|---|
| 1-3 | FAIL (each) | fixed and tested |
| 4 | FAIL, 20 findings | all fixed except the listed known limits |
| 5 | FAIL, 9 findings | fixed (refund then re-earn, refund flags conversions, held commission, wording tricks, signed Idempotency-Key, and more) |
| 6 | FAIL, 10 findings | fixed (refund debt at every reinstate point and at capture, payer required, stronger wording rules, admin page signing, atomic migrations, AI fail-closed without a switch) |
| 7 | FAIL, 7 findings (no minting; refund proportion, wording list, AI default) | fixed |
| 8 | FAIL, 6 findings (refund debt in re-issued lots, stale-rate conversions, AI status shape, wording) | fixed, plus random-sequence refund tests |
| 9 | FAIL (off-switch failed open on a Hub outage; Worker used stub rail; instruct had no timeout; chargeback skipped spent-commission debt; rounding; docs) | fixed |
| 10 | FAIL (off-switch open on cold start/unset URL; chargeback debt miscounted; no rate source in Worker; order return kept bonus unlock) | fixed |
| 11 | FAIL (INR purchase on default rate, malformed status shapes, no way to set up or set a rate on a fresh deploy, body size, AI full scans) | fixed: setup route, strict status, 6h max age |
| 12 | FAIL (empty status mode, quote priced INR without a rate, no key revoke/issue, setup replay/audit, body cap) | fixed |
| 13 | FAIL (buy_credits made orders with no payment side, wording $ in docs, setup not behind off-switch/atomic) | fixed |
| 14 | FAIL (refused owner setup call could be replayed; set_rate with no tenant; docs) | fixed |
| 15 | FAIL (approving an AI request skipped the Hub per-action switch-off; API.md wrong in 3 places; wording lines allowed currency signs) | fixed |
| 16 | PASS (ccd4f24) | no real defects |
| 17 | PASS (ccd4f24) | second PASS in a row |
| after 17 | first real-runtime check (local workerd) found src/db.js imported Node-only modules and failed to load in a Worker; fixed by moving migrate to src/migrate.js. Rollback on throw, migrations, hash chain and signed setup verified on workerd. Re-audit of this exact code: 18, 19 | |

A second independent PASS on the exact final code is still needed before reporting done.

## What is deployed
LIVE (19 Nov 2026): https://moneypenny.corporatetambola.com, Worker `moneypenny`, SQLite Durable Object, code 65b86c8. Public repo FChecklist/moneypenny. Rollback ids: previous version 8f26e747-dfa9-4251-928f-5fa17f1701e5 (no secret); current 5d8ac727-536d-4174-9fa3-52fe6dd96b06 (adds MNP_MASTER_SECRET). Master secret and tenant keys are in C:/Users/Dell/.moneypenny (outside the repo). Live smoke passed incl. rollback on a throw on the real runtime; one test purchase (1000 test credits, smoke@example.com) is in the live ledger. Purchase and AI keys were revoked after the smoke: issue new ones with the signed setup call when the payment side exists. INR is refused until an owner sets a rate. MNP_STATUS_OPTIONAL=1 is on until the Hub status URL is set.

## What waits on whom
- Steps 4-8 (public repo FChecklist/moneypenny after a secret scan, push, Cloudflare deploy, DNS Moneypenny.corporatetambola.com, live smoke, register code MNP) wait for the owner to confirm directly in the Moneypenny session. Relayed quotes through BOSS were not accepted as that confirmation.
- Real rail, real rate source, e-mail verification, warning e-mails, Partner Circle and IT Services links: not built.
- Terms document: being written by session local_eb9284d9; `terms_url` setting is ready for it.

## Known limits (README "Known limits")
Rail call inside the transaction in `buy_credits`; no cron or webhook sender; first rate row only band-checked; webhook address check is name-based. Real-runtime checks still needed on first deploy: multi-statement `sql.exec`, foreign keys, rollback on throw, `changes()`.

## Next steps
1. Audit 5 verdict; fix; repeat until two PASS in a row on the final code.
2. Tell the API Hub builder (local_d1354695) the contract is stable.
3. On the owner's direct go-ahead: secret scan, then steps 4-8.
4. Separate modules (own sessions, API-only): organizer feedback box, and the "Moneypenny" assistant (original illustrated character, not a film likeness; ask-only AI key).

## Change after the audited deploy (19 Nov 2026, NOT deployed)
F1 fix: setting `inr_packs` gives a listed INR pack a fixed price (no margin, no daily-rate change); `purchase_order.fixed_price` (migration 0004) stops a late payment being re-priced. Code differs from the audited 65b86c8: needs two fresh independent PASSes before any redeploy.

## Game pay chain (20 Nov 2026, NOT deployed, branch claude/game-pay-chain-085185)
Owner order: console -> Moneypenny -> IT Services -> Razorpay. Organizer/host/payee never leave console.corporatetambola.com; Moneypenny, IT Services and Razorpay are API only.
**Commit to audit (Moneypenny): see `git log -1` of the branch tip; code commit 55c17ed + this STATE note. IT Services branch `feat/credit-order-moneypenny`, commit ba539e9.**
**Audit request: two independent PASS audits are required (none yet). No self-certification.**

Routes (all in contract/v1/openapi.json): GET /v1/game_pay/quote, POST /start, POST /confirm, POST /payment_confirmed (purchase key, IT Services only), GET /status, POST+GET /link, POST /link/start.
- quote: cost in credits (from the catalogue, never hard-coded) + US$/Rs display, balance, credits still to buy.
- start: if short, buys the smallest listed pack that covers the gap (same game ref) and returns `order.payframe` {key, order_id, amount, currency} for the console overlay.
- confirm / payment_confirmed: credits the lot, then reserve+capture the game in ONE transaction (no stuck hold), emits signed idempotent `game.paid`. Status endpoint by game ref for a closed tab.
- Payer is fixed at order time; anyone else's payment is refused (`payer_mismatch`). Price change leaves the game open (`price_changed`). Credits arrive but game cannot be paid -> credits stay, game goes to `review`, sweep retries.
- Pay link: token shown once, only its hash stored; page shows only the amount; payee pays into the ORGANIZER account for that game. Setting `paylink_hours` (default 72).
- Migration 0005. Tests: 26 new (gamepay.test.js); whole suite 325 pass, 0 fail, on both node and MNP_DB=do. IT Services: 17 new, 77 pass + 1 old failure (retention test, not ours).
- Falsifiability (break, see fail, restore): payer check removed -> GB6 (+GB7, GL2) fail; gate payer check removed -> GB6 fails; IT Services Moneypenny-only check removed -> access test fails; outbox "once per payment" removed -> duplicate test fails. Honest gap: the three "already paid" guards are layered; removing all of them is caught only by GL1, so exactly-once leans on reserve idempotency plus these guards. Auditors: please probe this.

### Needs owner (nothing here was done)
1. Deploy go for IT Services branch + migration 0015 (adds Moneypenny site row, inactive), and for Moneypenny + migration 0005.
2. Issue Moneypenny's IT Services site key and set that site row active=1. Issue a Moneypenny purchase key; set MNP_BASE_URL / MNP_KEY_ID / MNP_KEY_SECRET on IT Services; ITS_BASE_URL / ITS_SITE / ITS_SITE_KEY on the Moneypenny Worker.
3. Confirm the DEPLOYED payframe allow-list and CSP include console.corporatetambola.com (the source does; deployed copy unchecked).
4. Hook the scheduler to POST /api/pay/credit-outbox-run (every 30 min, with reconcile).
5. Rs 1 live test payment; confirm rate and pack list; Razorpay written confirmation.
6. Register the game server's webhook endpoint for `game.paid`.
### Known gaps
- Spend keys are tenant-wide, not product-bound (design 13/14; hard gate before console phase).
- All webhook endpoints receive all events (game filters on data.product / game_ref).
- Payee e-mail is unverified; used only to match order to payment.

suiteRulesVersion: 1.1 (docs/SUITE_RULES.md)
