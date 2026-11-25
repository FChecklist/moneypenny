# Changelog

Newest first. Dates are in IST. Version numbers are MAJOR.MINOR.PATCH. This product only started numbering versions on 21 Nov 2026; everything built before that sits under 0.1.0 (the number already in `package.json`) and is listed below as dated milestones taken from git history.

## 0.2.14 (prepared 2026-11-25; NOT deployed yet)

The central IT Services pay service as a payee gateway (F10 to F13). Dark behind `MNP_PAYEE_ACCOUNTS` and a second flag `MNP_CENTRAL_PAY`, both off. Not wired into the Worker or the signed routes yet. Money flag unchanged (OFF). 0.2.13 is left to the branch that carries the F1 to F9 fixes.

- F10: `src/gateways/itservices-central.js`, gateway `itservices_central`: open one order (`POST /api/pay/credit-order`, the Moneypenny order id is the idempotency key, amount and currency must be echoed), verify a checkout (`POST /api/pay/credit-verify`, facts only), liveness (`GET /api/pay/ping`). Site key in the `x-site-key` header, 3500 ms deadline, address from `MNP_CENTRAL_BASE_URL` (plain https origin of a public host). Errors carry no secret, key, address or remote text.
- F11: `src/payee-rail.js`: `payeeRail`, `selectRail`, `railCanServe`. An order whose own snapshot says central is opened at the central service; other orders go to the old rail unchanged. `src/gate.js`: `buyCredits` asks the rail whether it can serve the order before writing anything; `processRail` passes `{ ctx, order }` to the rail; a plain rail never opens a central payee's order.
- F12: `src/central-confirm.js`: credits only from the central service's facts (this order, this payment, the person named when the order was made), once, through `railConfirm`, with one chained audit row.
- F13: `src/central-health.js`: owner only; secret names present true or false, address accepted, service answering.
- Tests: `test/payee-central.test.js` with `test/fake-central.js` (a stand-in that copies the real validators and status codes). Fifteen guards in `scripts/guards-central.js`. Docs: `docs/OWNER-ASK-CENTRAL-PAY-SERVICE.md` (what the owner and IT Services must supply), `docs/PAYEE-CENTRAL-PAY-SERVICE.md`.

## 0.2.12 (prepared 2026-11-25; NOT deployed yet)

Round 6 fixes for payee accounts. Dark, not deployed. Money flag unchanged (OFF).

- `railConfirm` now does one guarded `UPDATE ... WHERE status != 'paid'` before crediting; zero changed rows means already paid (same payment id: repeat answer; other id: `order_already_paid`). Two concurrent events with different payment ids credit once.
- Webhook: a missing or malformed signature answers 401 before any HMAC, payee lookup or database write. Currency mismatch is a final refusal (200, stored once); an order already paid with another payment is final; a short amount and an order not yet awaiting payment stay 409 retry.
- Contract: owner operations list `rate_limited`, `bad_json`, `replayed`, `forbidden` (and `not_found`, `bad_transition`, `payee_gateway_taken` where they apply); the webhook entry documents 409 retry and 429. `openapi.json` regenerated.
- Tests: R6-1 to R6-6 in `test/payee-owner-webhook.test.js`; the F8 pending_rail test builds orders through `buyCredits`.

## 0.2.11 (prepared 2026-11-25; NOT deployed yet)

Payee accounts F8 (health) and F9 (owner console screen). Dark behind `MNP_PAYEE_ACCOUNTS`. Money flag unchanged (OFF). No money behaviour changed.

- F8: `src/payee-health.js` and owner route `GET /v1/owner/payees/{id}/health`. Shows gateway, mode, status, secret names with present true/false (never a value), last gateway event time, ignored event count, orders in `pending_rail` (count and oldest time). Owner only, read-only gate, writes no audit row.
- F9: `src/owner-page.js`, served at `GET /owner` only when the flag is on (404 otherwise). List, read, add draft, edit name and note, activate, pause, retire, set route, health, recent changes. Signs calls in the browser with the owner secret (never sent or stored). Refuses a secret-looking value before any call. Payee names on screen come from the record.
- Tests: `test/payee-health-console.test.js`. Contract file regenerated.

## 0.2.10 (prepared 2026-11-25; NOT deployed yet)

Round 5 fixes for payee accounts F5 to F7. Still dark and not deployed. No money behaviour changed.

- Webhook intake: a retryable refusal (amount short, order not yet awaiting payment, unknown order inside a 10 minute grace window) answers 409 and the event id is NOT stored, so the retry is judged again. Permanent refusals (wrong payee, currency mismatch, draft payee with no snapshot or a live order, unknown order after the grace window, ambiguous order) are stored once as `ignored`.
- Order lookup by gateway order id is filtered by payee in the SQL.
- Bad signatures: at most one chained audit row per payee per minute (with the count of the minute before); 429 after 20 a minute per payee. Good calls are not counted.
- Owner calls: old nonces are pruned; 60 calls a minute for the owner key (429 after).
- The audit-order test checks an explicit newest-first list.
- Tests: `test/payee-owner-webhook.test.js` (R5-1 to R5-5).

## 0.2.9 (prepared 2026-11-25; NOT deployed yet)

Payee accounts, chunks F5, F6 and F7. Dark behind `MNP_PAYEE_ACCOUNTS` and not deployed. The money flag is unchanged (OFF).

- F5: `requireOwner` in `src/payees.js` is the one role check (used by every payee change and by `setRoute`). New owner-only `listPayeeAudit` (newest first, paged) and `verifyPayeeAudit` (walks the owner chain, says where it breaks).
- F6: `/v1/owner/...` routes (list, read, create, edit, activate, pause, retire, set route, secret presence, audit, audit verify). Signed with the master secret: `x-owner-ts`, `x-owner-nonce`, `x-owner-sig`. Each nonce works once. No tenant key class can call them. `createApp` takes `env`, `secrets` and `payees`; the Worker passes the flag and a secret reader that never gives out the master secret. Contract gained the owner and webhook entries (levels `owner` and `gateway`).
- F7: `src/webhooks-in.js` and `POST /v1/webhooks/payee/{id}`. Bad signature 401 (audit row, no body kept). Unknown payee 404 with no detail. Repeat event id: `duplicate`. Applied through `railConfirm` against the order's own payee. Unknown order, other payee, other event type, draft payee with a live order, and amount or currency mismatch are stored as `ignored` (200). Adapters gained `verifyWebhook` (Razorpay HMAC of the raw body, `x-razorpay-signature`, `x-razorpay-event-id`).
- Tests: `test/payee-owner-webhook.test.js`; `test/ai.test.js` allows the two new permission levels.

## 0.2.8 (prepared 2026-11-25; NOT deployed yet)

Payee accounts, chunks F3 and F4. Dark behind `MNP_PAYEE_ACCOUNTS` and not deployed. The money flag is unchanged.

- F3: `src/routes.js`. `resolvePayee` picks the payee for (tenant, product, currency): product route, else the `*` route, else `no_route` (503). A paused main payee uses the fallback if active; otherwise `payee_unavailable` (503). A payee that does not take the currency gives `currency_unsupported` (422).
- `buyCredits` takes an optional `product` and, with the flag on, writes product, payee id, route, payee version, mode and a snapshot on the order. They never change later. A repeat of the same order reference returns the first order. A paid order sets the payment record's payee from the order, never from today's route.
- A fallback use writes an audit row and an owner alert (`payee.fallback_used`). `setRoute` (owner only) refuses overlap (`route_overlap`) and a payee that is not active.
- F4: `src/gateways/` (registry, Razorpay adapter, fake adapter) and `src/secrets.js`. Create order, verify signature, refund. Secrets are read by NAME from the payee record through an injected reader. HTTP only through an injected `fetch`. Nothing calls the real gateway.
- Tests: `test/payee-routing.test.js`, including a proof that credits, lots and the ledger chain are the same under two payees.

## 0.2.7 (prepared 2026-11-25; NOT deployed yet)

Round 4 fixes after audit of the payee registry (F1 and F2). Still dark and not deployed. No money behaviour changed.

- Read-only calls (`getPayee`, `listPayees`, `checkPayeeSecrets`, `secretPresence`) are never blocked by the setup check. Changes and routing calls still are, and the `payee_setup_incomplete` text now names the payee.
- A stored `secret_names` that cannot be read counts as empty and is reported in the setup error; it no longer raises a raw error.
- First fill of secret names on a payee with orders: name rules and the clash check still run (a secret name may belong to one payee only, retired included). Only the order lock is skipped, and only when the current names are empty.
- New error `payee_gateway_taken` (409): a payee cannot be activated or resumed while another is active for the same gateway and mode. Pause or retire the first.
- Migration 0005: the two back-fill UPDATEs have `WHERE payee_id IS NULL`; the legacy payee insert and route insert have `WHERE NOT EXISTS`.
- `package-lock.json` removed (no dependencies; CI does not use it).
- Contract file regenerated.

## 0.2.6 (prepared 2026-11-25; NOT deployed yet)

Round 3 fixes after audit of the payee registry (F1 and F2). Still dark and not deployed. No money behaviour changed.

- The secret names of a retired payee stay reserved for ever: a new or edited payee cannot use any of them (`payee_exists`), whatever its gateway or mode.
- While `MNP_PAYEE_ACCOUNTS` is on, every call is refused with `payee_setup_incomplete` (409) if any active payee has empty secret names. The legacy payee ships that way. An owner must fill in the secret names first: an owner edit that sets only `secret_names` on that payee is allowed (and is not blocked by the order lock, since no name is changing).
- Test proves a payee change and its audit row share one transaction (a failed audit write, or a failed business write, leaves neither).
- Digit rule: 9 to 18 digits is refused everywhere, except in `address_lines`, `number_prefix` and `receipt_text`, where exactly 6 (PIN) or exactly 10 (phone) digits are allowed. Any other run of 9 or more digits is still refused there, and so is a run of 6 or more digits near the words account, a/c, ifsc, iban.
- Contract file regenerated (`payee_setup_incomplete`).

## 0.2.5 (prepared 2026-11-25T04:00:00 IST; NOT deployed yet)

Round 2 fixes after two more audits of the payee registry (F1 and F2). Still dark and not deployed. No money behaviour changed.

- Bank details are never stored: free text in `invoice`, `checkout`, `note` and `display_name` is refused (`bank_detail_refused`) if it holds a run of 9 or more digits (spaces or dashes allowed, so account and card numbers), an IFSC code, or an IBAN. `invoice.bank_name` must be letters only.
- `payee_audit.detail` now holds only the names of the fields that changed, never the text.
- The identity lock now also holds when `verified_payment.payee_id` or `payee_route` (payee or fallback) points at the payee.
- The long-run text screen applies only to values with no spaces, dots or slashes, so long hostnames and addresses pass. Hex runs and the `rzp_`, `sk_`, `pk_`, `rk_`, `whsec_` prefixes are still refused everywhere.
- Audit `seq` clash: retried once in a fresh transaction, then `audit_conflict` (409) and the change is rolled back.

## 0.2.4 (prepared 2026-11-25T03:00:00 IST; NOT deployed yet)

Fix round after two audits of 0.2.3 (payee accounts F1 and F2). Still dark and not deployed. No money behaviour changed.

- Audit rows: create, edit, activate, pause, resume and retire each write one `payee_audit` row (who, action, before and after, secret NAMES only) in the same transaction. A failed change leaves none.
- Owner only: every change needs `ctx.callerType === 'owner'` and a real actor name. Others get `payee_forbidden` (403, added to the contract). Reads stay open.
- Free text in `checkout`, `invoice`, `note` and `display_name` is screened for pasted secrets (`rzp_` text, long hex, long base64-like runs, `sk_`/`whsec_` style). Refused with `secret_value_refused`; the text is never echoed.
- `secretPresence`: when `ctx.secrets` is present it replaces `ctx.env`. Now written in the code and tested.
- Contract file `contract/v1/openapi.json` was out of date; it is regenerated now and a test fails if it drifts.
- OWNER CHECK before migration 0005 runs on production: (1) the old tables have no test or demo marker, so every old order and payment stays mode `live`; check there is no test-mode order or payment in production. (2) The Razorpay secret names are in the IT Services repo, not here, so the legacy payee keeps no secret names; pause then activate on it fails with `payee_secret_missing` until the owner sets the three names. Both are written in the migration header.

## 0.2.3 (prepared 2026-11-25T02:25:12 IST; NOT deployed yet)

Payee accounts, chunks F1 and F2 of the payee design. Dark: nothing calls the new code and the flag `MNP_PAYEE_ACCOUNTS` is off by default. Live code is still 0.1.0. No money behaviour changed, no flag changed, nothing deployed.

- Migration `0005_payee_accounts.sql`: tables `payee_account`, `payee_route`, `payee_change`, `payee_audit`, `payee_event`, `reconcile_run`; new columns on `purchase_order` and `verified_payment`. Back-fill: every old order and payment points at `pay_legacy_itservices`, and every tenant gets a `*` route to it. The `lot` and `entry` tables are untouched.
- `src/payees.js`: create, edit, state machine, identity lock, validators, secret-name check. Only secret NAMES are stored; a pasted value is refused and never echoed.
- `contract/v1/openapi.json`: new error codes (this file was not actually regenerated in 0.2.3; fixed in 0.2.4).
- Not in this step: routing, order snapshot, adapters, owner key, audit writes for payee changes, health (F3 to F9).

## 0.2.2 (prepared 2026-11-22T16:25:21 IST; NOT deployed yet)

Second fix round on the go-live plan, after audit 1 of 0.2.1 said FAIL (one Medium, docs only; audit 2 passed). Live code is still 0.1.0. Nothing is turned on, no money flag changed, nothing deployed, no source code changed.

In plain words:

- The plan still had two flag rules. Section 6 said the flags stay OFF until the Rs 1 test passes, while the test step turns them ON. Section 6, `STATE.md` and the pull request now say the same one rule as section 4: no customer can reach payment until D3 items 1 to 10 and D4 pass on the same run; during D1 to D3 the flags are ON only behind the audited owner-only gate. Step D1 now also says where the gate sits: in front of the flag, so the owner is let through and everyone else is refused.
- Two safety checks are still not watched by any test (`src/spend.js` lines 262 and 224). They are listed honestly in the plan (section 10) and in `KNOWLEDGE.md`. No extra money can leave, because later checks stop it.
- The plan said the database freeze is "up to 4 seconds". The admin sweep can chain up to 25 such calls, so the worst case there is about 100 seconds. Wording corrected, and the gate now asks for a test that no payment-side call happens inside the transaction.
- `preparedAt` in `version.json` and in this file is now the real time of the commit (it was a round number).
- Test G21 (log cleaner length cut) no longer depends on how fast the computer is. It now checks how long the text is when each pattern runs.
- Same 46 listed guards, 319 tests.

## 0.2.1 (prepared 22 Nov 2026, 10:28 UTC / 15:58 IST; NOT deployed yet)

Fix round after two independent audits of 0.2.0 (both said FAIL, on the go-live plan). Live code is still 0.1.0. Nothing is turned on, no money flag changed, nothing deployed.

In plain words:

- The go-live plan had a contradiction. It said the money flags stay OFF, but also told the owner to turn them ON for the Rs 1 test. Now there is one rule: no customer can reach payment until the test passes, and the test runs only through an owner-only gate. Before the test, a second, non-owner account must be shown to be refused (checked again after the payment).
- The plan now lists a known risk: when a customer buys credits, Moneypenny calls IT Services while its one-at-a-time database lock is held. A slow IT Services (up to 4 seconds) freezes every other call, including people who already paid. The fix (call after the lock is released, using the outbox) is a gate before customers; the same goes for the webhook address check.
- The rollback step for "customer paid but has no credits" was wrong for this plan (it would answer `rate_stale`). It now says to repeat `rail/confirm` with the order id and the same payment id.
- The plan now says that any pause (kill switch or Hub off) also refuses payment confirmations, so IT Services must keep retrying and the counts must be checked afterwards.
- Smaller plan fixes: master secret must be in the shell when issuing keys; the Hub switch does not exist on the live Worker until step B2; `/health` says not-OK on code without the adapter; a test pack left behind must be removed even if the test is abandoned; version ids and a local folder path removed from the docs; payment id is unique per tenant; wording about forged calls and log cleaning made accurate.
- Three more safety rules are now watched by tests (46 listed guards; "watched" means the listed guards only, not every check in the code): expiry of credits on the game's spend path, the money-refund off-switch, and the length cut in the log cleaner.
- Code change (small): the log cleaner looks at the first 2000 characters only, so a very long input can no longer make it slow (it took about 5 seconds for 100,000 characters). A test fails without it.
- 3 new tests (G19 to G21). Test e-mail changed to an example.com address.
- Not changed: the IT Services adapter, IT Services side, console store, scheduling, Moneypenny Chat remain open (`docs/GO-LIVE.md`, section 8).

## 0.2.0 (prepared 21 Nov 2026, 22:50 IST; NOT deployed yet)

Live code is still 0.1.0. This number goes live only after two independent audit passes on the exact code, and `version.json` then gets its release time and code id.

In plain words:

- New plan for going live: `docs/GO-LIVE.md`. Ordered steps, which secrets to set (names only), the owner's own Rs 1 test through the whole chain (game, console, Moneypenny, IT Services, Razorpay), the two money flags that stay OFF until that test passes, and how to roll back.
- Forged or unsigned calls are now turned away before they can join the single queue that all payments use, and they cannot use up a real key's per-minute allowance.
- If something breaks inside the service, the log line no longer contains e-mail addresses or long secret-looking text.
- The public health page asks the payment side at most once every 30 seconds, so nobody can use it to hammer IT Services.
- New check (`railContract`) that any real payment-side connection must pass, including "a repeated order id gives the same order, never a second one".
- New `npm run guards`: removes each safety rule one at a time in a throw-away copy and fails if no test notices (it covers the listed rules only). Covers repeat-safe money writes, whole numbers only, the append-only hash-chained ledger, replay protection, rate limits, off-switches and log redaction.
- 19 new tests (including a rehearsal of the Rs 1 test with stand-ins). No real payment, no real service, only example.com addresses.
- Not changed: no money flag, no deploy setting, no database change. Still open: the IT Services connection inside Moneypenny, the IT Services pay page, the console's permanent order store, scheduling of housekeeping and event sending, and Moneypenny Chat (nothing of it exists in this repo). See `docs/GO-LIVE.md`, section 8.
- Included in this release (in the repo since 19 Nov, never deployed): the console wallet module, the fixed INR pack price, and the version files first proposed in PR 1 (which this branch contains).

## Not yet deployed (in the repo, not live) - now rolled into 0.2.0 and then 0.2.1 above

These changes are after the deployed code (65b86c8). They are part of 0.2.0 (and so of 0.2.1) and need fresh independent audit passes before a deploy.

- 20 Nov 2026, 00:11: Console wallet: the failure count restarts after each successful step.
- 20 Nov 2026, 00:06 to 00:08: Console wallet: any unfinished order reaches the owner after 2 hours; a reopened click restarts its clock.
- 19 Nov 2026, 22:48 to 23:44: Console wallet module (test mode): buy a fixed-price pack, then spend on a game item with reserve, game step and capture. Reworked after audit findings: capture first then grant, refund on a clear refusal, repeat requests return the same result. `reserve_item` can now be repeated safely and an order can carry a fixed price. API contract regenerated.
- 19 Nov 2026, 15:11 to 19:28: A credit pack in INR can have one fixed price (setting `inr_packs`), so a late payment is never re-priced. Price band of 40 to 160 paise per credit. Migration 0004 added.

## 0.1.0 (live since 19 Nov 2026, IST)

Released code: 65b86c8. Worker `moneypenny` at moneypenny.corporatetambola.com, no money flowing (no payment side, no rate source).

Milestones that make up 0.1.0:

- 19 Nov 2026, 09:03: Worker made loadable on the real Cloudflare runtime (migrations moved to `src/migrate.js`), Cloudflare config with custom domain, checked on a local Workers runtime. Deployed that day; audits 18 and 19 passed.
- 17 Nov 2026, 18:37: Audit 16 and 17 passed on this code (Hub per-action switch-off also covers approved AI requests, wording and docs fixes).
- 17 Nov 2026, 15:55 to 18:24: Audit rounds 5 to 14 fixes: refund and chargeback debt handling, stronger wording rules, signed setup call for the owner, off-switch that stays closed unless known good, strict status file, AI shut by default, body size limits, INR purchase guards. Tests run on Node 22 in CI (CI never deploys).
- 17 Nov 2026, 11:00 to 13:27: AI-ready layer (scoped keys, ask-only AI key, approvals, kill switch), currency renamed to plain Moneypenny with a coin icon, SQLite Durable Object executor, payment notice, commission and capture checks.
- 17 Nov 2026, 10:26 to 10:36: Single gate with price list and rail outbox, daily FX table (5 percent margin, 120-minute order lock), versioned API contract folder with a contract test.
- 17 Nov 2026, 09:46 to 10:02: Phase 0 build: credit ledger (append-only, hash-chained), three credit piles (bought, bonus, commission), holds, spend gate, refunds, conversion skeleton (records only), reconcile views. First audit fixes.
