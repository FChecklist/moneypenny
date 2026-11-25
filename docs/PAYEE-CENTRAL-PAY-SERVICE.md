# Central IT Services pay service as a payee gateway (F10 to F13)

Version 0.2.16, prepared, not deployed. Dark: nothing here runs unless `MNP_PAYEE_ACCOUNTS=1` **and** `MNP_CENTRAL_PAY=1` (both default off) and the Worker is wired as in section 6. The owner-facing list of what must be supplied is `docs/OWNER-ASK-CENTRAL-PAY-SERVICE.md`. The design document `PAYEE-ACCOUNTS-DESIGN.md` was not found; the split below is a reading of the task text, to be confirmed.

This is the "IT Services adapter inside Moneypenny" that `docs/GO-LIVE.md` section 8 lists as not built yet, for the payee-registry path. The older single-rail path (`rail:` in `src/worker.js`) is unchanged.

## 1. Modules

| Chunk | File | Job |
|---|---|---|
| F10 | `src/gateways/itservices-central.js` | Adapter: `createOrder`, `verifyCheckout`, `health`. Registered in `src/gateways/index.js`; `itservices_central` is a known gateway name in `src/payees.js`. |
| F11 | `src/payee-rail.js` | `payeeRail(base, {fetch, store})` wraps the old rail. `selectRail(env, base, {fetch})` returns the old rail itself unless both flags are `1` and a `fetch` exists. `railCanServe` and `isCentralOrder` are used by `src/gate.js`. |
| F12 | `src/central-confirm.js` | `confirmCentralPayment(ctx, {order_id, razorpay_*})`: asks the central service for the facts, checks them against the order, then `railConfirm` and one chained audit row in one transaction. |
| F13 | `src/central-health.js` | `centralHealth(ctx, payeeId)`: owner only; secret names present true or false, address accepted true or false, service answering true or false. |

`src/gate.js` changes are three small additive lines: `buyCredits` asks `railCanServe(ctx.rail, pc)` before writing anything; `processRail` passes `{ ctx, order }` as a second argument to `rail.createOrder`; and a plain rail never opens a central payee's order (it waits and dead-letters like any rail failure, with `last_error = central_rail_off`).

## 2. The contract used

Read from the repository `itservices-site`, branch `feat/credit-order-moneypenny`, commit `7d3d0b0`: `functions/api/pay/credit-order.js`, `credit-verify.js`, `functions/_lib.js` (`authSite`, `MNP_HOST`), `docs/CENTRAL_PAYMENT_SERVICE.md`, `docs/REFUNDS.md`.

| Call | Auth | Body | Answer used |
|---|---|---|---|
| `POST /api/pay/credit-order` | header `x-site-key` | `site`, `payment_ref` (the Moneypenny order id, the idempotency key), `credits`, `amount_minor`, `currency` (INR or USD), `payer_email` | `orderId`, `amount_minor`, `currency` (must equal what was asked), `keyId`, `txn_id`, `repeat` |
| `POST /api/pay/credit-verify` | header `x-site-key` | `site`, `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature` | `paid`, `status`, `razorpay_order_id`, `razorpay_payment_id`, `amount_minor`, `currency`, `payment_ref`, `order_payer_email` |
| `GET /api/pay/ping` | none | none | HTTP status only |

The three secret names of the payee mean, for this gateway only: `key_id` = site name (public, checked as a plain host name), `key_secret` = the site key, `webhook_secret` = reserved and unused (the registry requires three). The address of the central service is the plain variable `MNP_CENTRAL_BASE_URL`, checked with the same rules as webhook addresses.

Status mapping (adapter): 401 or 403 `central_key_refused`; 503 `central_not_ready`; 409 `central_conflict`; 408, 429, 5xx or no answer `central_unreachable`; 400 on verify `central_proof_refused`; 404 on verify `central_order_unknown`; anything else `central_refused`; a good status with an answer that does not match `central_bad_answer`. None of these carries a secret, the key, the address or the other side's text. Every call has a 3500 ms deadline (under the 4000 ms the order step allows).

## 3. The flow

1. `buy_credits` picks the payee (F3) and copies a snapshot onto the order. If the snapshot's gateway is `itservices_central`, `processRail` hands the order to `payeeRail`, which loads the payee row, refuses a retired payee, and calls `createOrder` with the person's e-mail from the account. The order becomes `awaiting_payment` with `rail_order_id` = the central order id and no `pay_url` (the central payment window already knows the order).
2. The person pays in the window. Two ways in, both safe together, the payment credits once:
   - the fast path: the browser reports `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`; `confirmCentralPayment` asks the central service (before any transaction opens) and credits only from its facts;
   - the push: the central service calls `POST /v1/rail/confirm` with the purchase key (see the push path question in the owner document).
3. Checks before any credit: the order is a central order (from its own snapshot, never today's route); the proof names this order's central order id; the facts name this order id (`payment_ref`), this payment and the person who was named when the order was made; amount and currency are judged by `railConfirm` (short payment refused, currency mismatch refused, overpayment credits the order only and raises `payment.overpaid`).
4. Payment ids are kept in lower case by `railConfirm`; the repeat check compares case-insensitively.

## 4. What the tests prove (`test/payee-central.test.js`, with `test/fake-central.js`)

The fake copies the real validators and status codes of the two routes, but it cannot prove the live service behaves the same. Only the owner's Rs 1 test can.

Dark with flags off; the exact call sent; safe repeat; amount, currency and order id echoed or refused; every failure code; bad setup refused before any call; address rules; verify facts; the order snapshot decides after a re-route; a plain rail never opens a central order; retired and paused payees; confirm happy path, repeat, mixed-case payment ids, authorized and failed payments; wrong proof, wrong order, not a central order; facts that name another order, payment, person, amount or currency; overpayment; the push path credits the same way; credits, lots, entries and the chain are identical for a central and a legacy payment (B.1 proof); health; no secret or address in any error, order, audit row or outbox row.

Fifteen safety rules are listed in `scripts/guards-central.js` and run by `npm run guards`; each was removed on purpose and a test failed.

## 5. Limits and findings

- **Not reachable over HTTP yet.** The signed-route context in `src/api.js` carries no payee flag, `env`, `secrets` or `fetch`, so `POST /v1/spend/buy_credits` over HTTP never routes by payee (true for F3 in general, not only for this change). Until that is wired, the central path is reached only by code that builds a context with those fields, as the tests do.
- **Payment attribution.** `verified_payment.payee_id` is filled by `railConfirm` only when a payment notice came first. Neither the F7 webhook intake nor F12 sends a notice, and the central push does not either, so the order carries the payee (`purchase_order.payee_id`, `payment_ref`) and that is where reports should read it.
- **A draft payee and the confirm path.** Confirm does not repeat the webhook's draft rule, on purpose: a route can point only to an active payee (`payee_not_active`, `test/payee-routing.test.js`) and a payee can never move back to draft, so a draft payee never owns an order. The webhook needs the rule because its events come from outside.
- **The payer e-mail.** Confirm compares the e-mail in the central service's facts with the account's e-mail now. An account is found by that e-mail and no code changes it, so it cannot differ from the one sent when the order was made. If a later change lets an account e-mail change, the order must store the e-mail it used and confirm must compare with that.
- **Error codes in the contract.** `contract/v1/openapi.json` lists every `ApiError` code in `src/`, built by `scripts/gen-contract.js` (a test keeps the file equal to its output). So `central_disabled`, `central_facts_mismatch`, `central_payee_retired`, `not_central_order`, `not_central_payee`, `order_mismatch` and `payee_changed` appear in the catalogue although no route returns them until the central side is mounted (section 6).
- **Rail call inside the transaction.** `processRail` calls the rail inside the database transaction with a 4000 ms limit (the known gate E5 in `docs/GO-LIVE.md`). The central call has its own 3500 ms deadline, but it does not remove that limit.
- **Refunds and disputes** are recorded by the central service and never pushed. A person refunds in the gateway; the `refund` method of this gateway refuses with `refund_by_central_service`.
- **Third secret.** The registry requires three different secret names; this gateway needs two. The third must exist with any value (owner question 5).
- **Push path.** The central service pushes to `/v1/game_pay/payment_confirmed`, which this lineage does not have. `/v1/rail/confirm` takes the same facts (the payer e-mail is ignored there).
- **Version.** First written as 0.2.14 on top of 0.2.12. The branch with the F1 to F9 fixes then took 0.2.13 to 0.2.15 (merged as PR 4), so this branch was merged on top of 0.2.15 and now carries 0.2.16. The `GATEWAYS` list is now the keys of the adapter registry (`src/gateways/index.js`), so `itservices_central` is in it because its adapter is registered there.

## 6. Wiring still to do (developer, not part of this change)

1. `src/worker.js`: pass `rail: selectRail(env, unconfiguredRail, { fetch })` instead of `rail: unconfiguredRail` (returns the old rail unless both flags are `1`).
2. `src/api.js`: put `env` (or a secret reader that never gives out the master secret), `payees`, `central` and `fetch` on the context of the signed routes, so `buyCredits` routes by payee and `processRail` can reach the adapter.
3. Mount two routes: a purchase-key route that calls `confirmCentralPayment` (needs a plain database context, so the central call happens before the transaction opens), and an owner route for `centralHealth`. Add them to `src/contract.js` and regenerate the contract files.
4. Create the payee, activate it, set the route, turn on both flags, run the Rs 1 test.
