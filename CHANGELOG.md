# Changelog

Newest first. Dates are in IST. Version numbers are MAJOR.MINOR.PATCH. This product only started numbering versions on 21 Nov 2026; everything built before that sits under 0.1.0 (the number already in `package.json`) and is listed below as dated milestones taken from git history.

## 0.2.15 (prepared 2026-11-25; NOT deployed yet)

Round 9 part A: two bugs in the money path of the payee webhook (`src/webhooks-in.js`). Dark behind `MNP_PAYEE_ACCOUNTS`, not deployed. Money flag unchanged (OFF). Part B (docs, test hygiene, contract) is listed below.

- Early event, then the order exists: an event for an unknown order is stored as `pending_unmatched` and answered 409. When the order existed and the same event id was retried, the plain insert hit the primary key `(payee_id, event_id)` and answered 500; the order stayed `awaiting_payment` with no credits. The write is now an upsert that replaces only a `pending_unmatched` row (normal path, and the refused path). One credit, the rollback on failure and `duplicate` on a further repeat are unchanged. Test R9-1 (409, order appears, same event id gives `recorded` with one credit, repeat gives `duplicate`; the refused path ends as `ignored` with no credit).
- Late payment after the sweep: an order that `expireOrders` set to `failed` was refused with 409 `order_not_ready` and nothing stored, while the confirm route credited the same payment. A `failed` order with a gateway order id now goes through the same `railConfirm` code (amount and currency are checked there; a currency mismatch is final and ignored, a short amount is 409). The event row and the audit row are written, and a repeat answers `duplicate`. This matches `docs/GO-LIVE.md` and `src/gate.js` ("a late payment is still credited"). Test R9-2 (lock window passes, sweep runs, webhook credits 500 once, repeats are `duplicate`, wrong currency is refused).
- Part B, test hygiene: `GATEWAYS` in `src/payees.js` is now a frozen array. Test F2-f no longer pushes to and pops from it: it checks the identity lock on the other identity fields (name, currencies, secret names); the gateway field itself cannot be tried while only one adapter exists (the `bad_gateway` check comes first). R8-5 now checks the list is frozen. The two raw SQL inserts in `test/payees.test.js` use a made-up gateway name instead of a real one.
- Part B, contract: GET owner routes no longer list `bad_json` (a GET has no body). `contract/v1/openapi.json` regenerated; the `NOT_REACHED` entry for it is removed and the contract test now checks that `bad_json` is listed exactly on the routes that have a body.
- Part B, guards: label of `order-paid-once` now says what test R7-5 checks (a repeat confirm of a paid order is answered before its figures are judged). New guard `payee-gateway-frozen`; `payee-gateway-list` points at the frozen line. Each of the two new part A guards, the two gateway guards and `order-paid-once` was run alone and is caught by a test. Guards in all: 58.
- Part B, docs: guard count in `docs/GO-LIVE.md` (two places) and `KNOWLEDGE.md` is 58. The 0.2.14 gateway note and the replay notes (here and in `KNOWLEDGE.md`) list every ignored outcome.
- Tests: 415 pass, 0 fail in the final local run after part B (up from 413; part B added assertions to existing tests, not new tests). Guards: 58 in all, each watched by a test.

## 0.2.14 (prepared 2026-11-25; NOT deployed yet)

Round 8: closes the test gaps and the small findings from the round 7 audits of payee accounts. Dark behind `MNP_PAYEE_ACCOUNTS`, not deployed. Money flag unchanged (OFF). No credit is made differently.

- Test R7-4 (owner nonce keep time): step (d) now plants an owner nonce older than the time window but younger than the keep time, runs a tenant-key call, and checks it survives. A tenant cleanup in `src/auth.js` that is too short now fails the test (it did not before). R5-5 and R7-4 no longer have default values for `OWNER_NONCE_KEEP_MS` and `OWNER_WINDOW_MS`: a missing export fails the test.
- Contract test (`test/payee-contract.test.js`): the webhook case checks that a `recorded` answer has `order_id` and a `duplicate` answer has none, and checks the exact error code of each refusal (`webhook_no_event_id`, `webhook_bad_signature`, `payee_not_found`, `too_large`, `payees_disabled`, `payee_secret_missing`, `rate_limited`). New reverse check: every code in `x-error-codes` of a payee route must be given by a real call in the test or be on a short list (`NOT_REACHED`: `payee_forbidden`, `bad_json` on GET routes, `not_found` on the read route), each with its reason; a stale entry fails. To reach the codes, the cases now make more calls (bad mode, bad currencies, bank detail, pasted secret, identity lock, retired payee, gateway taken, route overlap and others) and every owner route is also tried unsigned, replayed, with the flag off, with a bad body and as the 61st call in a minute. The test header now says the scope: routes and answer shapes are one-way (contract to code), error codes are two-way. Open note: the contract lists `bad_json` for GET routes, which have no body; harmless, left as it is.
- Contract file: `Payee.secret_names` had `"required": []`, which OpenAPI 3.0.3 does not allow. `obj()` in `src/contract.js` now leaves `required` out when nothing is required; `openapi.json` regenerated (also the webhook text below). A new check fails on an empty `required` list anywhere in the file.
- Webhook, payee with its secret missing (`src/webhooks-in.js`): every well-formed call wrote a chained audit row and answered 500, and the per-source limit never counted it. It now goes through the same counter as bad signatures (`countFailure`): 500 for the first 20 calls a minute from one source, then 429, and at most one audit row per payee per minute (with the count of the minute before). Nothing else is written: no event row, no order change, no credit. Test R8-4 floods this path (326 calls) and checks the audit rows, the counters and the money state. A caller whose payee secret is missing and who retries fast from one address now gets 429 after 20 calls a minute instead of 500; the call fails either way.
- Gateways (`src/payees.js`): `GATEWAYS` is now built from the adapter list (`src/gateways/index.js`), so only `razorpay` can be stored, and no shipped file names another gateway (the tests in `test/` name them only to check for them; part B of round 9 builds the two raw SQL inserts there from a made-up name). The refusal (`bad_gateway`, 400) names no gateway. Tests R8-5 (two): a payee with a gateway that has no adapter is refused on create and on edit, nothing is stored or audited, and no shipped file names another gateway. Three older tests that used another gateway name as a stand-in were changed (a second active payee in the routing tests is switched on directly; the identity-lock test adds a made-up name to the list for that test only).
- Docs: `KNOWLEDGE.md` and the 0.2.13 text above no longer say the replay growth is solved or that rollback is "proven, not assumed". Only the payment-already-applied replay is closed. Ignored outcomes can still add one event row and one chained audit row per fresh event id when a captured signed body is replayed, with no money effect (accepted, open item). Rollback is shown on the local adapter and the Durable Object stand-in, not on real Cloudflare; the first-deploy check stays in `STATE.md`.
- Tests: 413, up from 408 (R8-4, two R8-5, the reverse check and the empty-`required` check). Guards: three added (`webhook-missing-secret-limit`, `tenant-nonce-cleanup-keep`, `payee-gateway-list`) and `webhook-bad-limit-answer` points at the new code: 55 in all.

## 0.2.13 (prepared 2026-11-25; NOT deployed yet)

Round 7 fixes for payee accounts. Dark behind `MNP_PAYEE_ACCOUNTS`, not deployed. Money flag unchanged (OFF). No credit is made differently: these changes decide what is answered and stored, and prove what was already true.

The brief for this round named the base as 0.2.11 and the new number as 0.2.12. The branch already carried 0.2.12 (round 6), so this round is 0.2.13.

- Rollback shown by test, no code change (test R7-1): when `creditPurchase` throws after the guarded paid update, both the confirm route and the webhook leave the order unpaid, with no credit, payment claim, event row or audit row, and the retry credits once. A control in the same test shows that the same fault, without a transaction around it, would leave the order paid with no credit. This is shown on the local database adapter and on the Durable Object stand-in (`MNP_DB=do`), not on real Cloudflare. The first-deploy check "rollback on throw" stays in `STATE.md` (Known limits) and must be run on the real runtime.
- Webhook: a payment id already applied to its order (another event for the same payment, the same signed body sent again with a new event id, or the confirm route got there first) now answers `duplicate` and writes nothing. It answered `recorded` and wrote an event row and an audit row each time. No second credit was ever made. **Only this replay is closed.** The event id header is not signed, so a captured signed body can be sent again with a fresh event id. For the ignored outcomes (`not_applicable`, `draft_payee`, `ambiguous_order`, `unmatched`, `wrong_payee` (which also adds one outbox row, the `payee.webhook_wrong_payee` event), `currency_mismatch`, `order_already_paid`) that can still add one event row and one chained audit row per fresh event id. It has no money effect (no credit, no order change). This is accepted and kept as an open item (see `KNOWLEDGE.md`).
- Webhook bad signatures: the 20-a-minute budget that ends in 429 is now kept per source and payee, not per payee. The source is the `cf-connecting-ip` header that Cloudflare sets, folded into 64 counters per payee; the address is never stored, and without the header all calls share one counter as before. The audit row is still one per payee per minute, with the count of the minute before. A good signature was never counted or refused (tested). Before, one flooding source used up the budget of every other source.
- Owner calls: a used nonce is kept for the 5 minute window plus 5 minutes of clock margin (10 minutes, counted from the time the call claims), not for exactly the window. Before, a replay could pass if a clock was read behind the machine that had cleaned up. Past-dated and future-dated boundaries and the keep boundary are tested, and a tenant call's own cleanup cannot remove an owner nonce early.
- Contract: every payee operation documents its answer (OpenAPI `components.schemas`, a `schema` on the answer, path parameters, `limit` and `before_seq` on the owner audit list). The edit route now lists the 8 refusal codes it really gives. The two check routes (`secrets` and `payee_audit/verify`) answer HTTP 200 with `ok` false and no error object when the check fails; this is written down and tested, not changed. `openapi.json` regenerated; the 40 other operations are unchanged.
- Tests: 408, up from 390. New: `test/payee-contract.test.js` (13: every documented payee route exists and answers with the documented shape), R7-1 to R7-5 in `test/payee-owner-webhook.test.js`. The F7 repeat-event test and R5-5 were changed for the new rules. (Round 8, 0.2.14, closes gaps in some of these tests.)
- Guards: at the start of this round `npm run guards` reported one unwatched guard (`order-paid-once`): round 6 made the early paid check redundant for outcomes, so no test noticed its removal. Test R7-5 now watches it. Six guards were added (`order-paid-transition`, `tx-rollback`, `owner-nonce-keep`, `webhook-repeat-payment`, `webhook-source-limit`, `webhook-bad-limit-answer`): 52 in all at that time. The script now prints progress. A full run takes about 7 minutes on 4 cores (one full test run per guard); before, it printed nothing until the end.

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
