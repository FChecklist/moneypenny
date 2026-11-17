# API

JSON in and out. Every response has `"ok": true|false`.
Errors look like `{"ok":false,"error":{"code":"...","message":"..."}}`.

## Signing (every call)

Headers: `x-mnp-key`, `x-mnp-timestamp` (milliseconds), `x-mnp-nonce` (new every call), `x-mnp-signature`.

```
signature = hex( HMAC-SHA256( secret, [timestamp, nonce, METHOD, pathWithQuery, sha256hex(body), idempotencyKeyOrEmpty].join("\n") ) )
```

- The timestamp must be within 5 minutes. A nonce works once per key (a replay gets 401).
- The secret is shown once when a key is made. It is derived from the master secret, so no secret sits in the database.
- Four key types, least power each: `read` (balance only), `api` (a product's server: spend, events, hand-given bonus, order returns), `purchase` (the payment system: credit bought, money refunds, chargebacks) and `admin`. A key cannot use another type's routes.
- Every POST/PUT/DELETE also needs `Idempotency-Key` (up to 120 characters); for `credit_purchase` the payment id is used when the header is left out. Same key and same request returns the first answer (`idempotent-replay: true`). Same key and a different request gives 409. A failed call leaves no trace, so its key can be reused.
- Callers must send only **verified** e-mail addresses. Identity is the lower-cased e-mail.

`GET /health` (open): `ok, db, rail{name,ok}, fx{state,as_of}, outbox{rail_pending, rail_dead, webhooks_pending}`. No tenant data.
Idempotency keys starting `pay:` are reserved for the payment routes and must equal `pay:<payment_ref>`.

## Money units

Credits are whole numbers (100 credits = US$1). `*_minor` fields are paise (INR) or cents (USD). Currency is `INR` or `USD`.
This service knows only tenants, accounts, credits, buckets, rules and holds. Any other product (a game, an HR tool) is just an API client.

## The flow

1. IT Services sells credits. After it verifies the payment, its server calls `POST /v1/credit_purchase` with the payment id (purchase key).
2. A product page shows the balance: the product's server calls `GET /v1/balance` (read key). People never visit this service.
3. To pay: the product calls `reserve`, takes the cash due through IT Services, then `capture` (or `release`).

## Routes

| Call (key) | Body / query | Answer |
|---|---|---|
| `GET /v1/balance?email=` (read, api) | `details=1` adds bucket amounts for `api` keys only | `balance`, `can_convert`, `settling`, `next_expiry`, `fx_stale`, `display{label, symbol, unit, credits, amount, usd, convert_line, settling_line, theme}`. `label` is the tenant's currency name; no response forces a product brand. If the database cannot read lots, a balance seen within `read_cache_max_age_seconds` is returned with `degraded:true, as_of`. |
| `GET /v1/quote?credits=&currency=` (read, api) | optional `currency` is a display-only code such as EUR | `credits, usd, usd_minor, inr_minor` (whole rupee if set), `pay_in:[INR,USD]`, `rate_state`, `rate_as_of`, `local{currency, amount, display_only:true}` |
| `GET /v1/catalogue?product=` (read, api) | | active `items[{product,item,credits}]` |
| `POST /v1/spend/reserve_item` (api) | `email, product, item, order_ref, credits?` (if sent it must equal the price) | `hold_id, credits, expires_at`. 402 `insufficient_credits` with `price_credits, usable_credits, short_by`; 409 `price_changed`; 404 `no_item`. Then `capture` / `release` as usual. |
| `POST /v1/buy_credits` (api) | `email, credits, order_ref, currency?` (INR or USD; default is the tenant base currency) | `order_id, status (pending_rail, awaiting_payment, paid, failed), amount_minor, currency, pay_url`. Repeating the same `order_ref` returns the same order. 503 `rate_stale` for INR when the rate is too old. |
| `POST /v1/rail/confirm` (purchase) | `order_id` or `order_ref`, `payment_ref, paid_minor, currency` | `credited`. Amount and currency must match the order. Within the order's rate lock (`rate_lock_minutes`, default 120) credits use the rate the order was made at. A later INR payment is still credited, re-priced at the then-current rate (`repriced:true`). The payment id is the idempotency key. |
| `POST /v1/credit_purchase` (purchase) | `email, amount, paid_minor, currency, payment_ref` (the verified payment id; credits cannot exceed what the payment covers; one payment id works once) | `credited` |
| `POST /v1/credit` (api) | hand-given bonus: `email, bucket:"bonus", amount, ref` (same caps as rules; audited) | `granted` |
| `POST /v1/event` (api) | `email, event_type, event_key`; for commission also `payer_email, cash_minor, currency, sale_ref` (the real payment id of the sale; one sale pays commission once per tenant) | `granted`, `reason` (`granted`, `no_rule`, `already_earned`, `limit_reached`, `cap_reached`, `self_referral`, `payer_required`, `blocked_domain`, `too_many_events`, `sale_ref_required`, `sale_already_used`, `over_event_limit`, `daily_cap_reached`, `no_cash_no_commission`, `no_credit_for_visits`, `account_frozen`, `rule_invalid`). The same `event_key` never pays twice. |
| `POST /v1/spend/reserve` (api) | `email, order_ref, amount_minor, currency` | `hold_id`, `credit_applied`, `credit_value_minor`, `cash_due_minor`, `expires_at`. Nothing to use: `hold_id:null` and the full cash due. |
| `POST /v1/spend/capture` (api) | `hold_id`; if cash is due also `payment_ref, cash_paid_minor` | `status:"captured"`. Later than the grace window: 410. A reversed (charged-back) payment behind the hold: 409 `payment_reversed`. |
| `POST /v1/spend/release` (api) | `hold_id` | `status:"released"` (safe to repeat) |
| `POST /v1/refund` | `type:"order", hold_id, credits?` (api key) returns credits to their piles. `type:"purchase", payment_ref, credits?` (purchase key) is a money-refund note for unspent bought credits. `type:"chargeback", payment_ref` (purchase key) removes everything that came from that payment, including held or returned credits (a credit purchase also pauses the account; a commission sale removes the commission only). | `returned_credits`, `money_due_minor` (this system pays nothing) |
| `GET /v1/history?email=&limit=&before_seq=` (api) | | newest first. Each entry has `kind, delta, bucket, money_minor, currency, tds_minor, gst_minor, status, ext_ref` and the `rate_cpu` / `rate_inr` in force when it was written. |
| `POST /v1/convert_request` (api) | `email, credits` | Records a request and its calculation (gross, TDS, net). 403 `conversion_off` unless switched on. **No payout is ever made here.** |

Ledger entry kinds: `purchase, bonus, commission, hold, capture, release, release_timeout, reinstate, refund, expire, reversal, conversion_request, payout, collection`.

## Admin routes (admin key)

| Call | What |
|---|---|
| `GET/PUT /v1/admin/settings` | read / change settings (audited). `credits_per_usd` locks once credits exist; the INR rate moves at most 10% per change. |
| `GET/POST /v1/admin/rules`, `PUT/DELETE /v1/admin/rules/:id` | earning rules (DELETE only switches a rule off) |
| `GET /v1/admin/audit?limit=` | change log |
| `GET /v1/admin/health` | ledger chain, audit chain, ledger-versus-balance check |
| `GET /v1/admin/reconcile` | credits owed by bucket (usable, held in orders, ended-but-unswept, in conversion), conversions by status |
| `GET /v1/admin/conversions?status=` | conversion requests |
| `POST /v1/admin/conversions/:id/(approve, instruct, mark_paid, reject)` | conversion engine steps (below) |
| `POST /v1/admin/sweep` | release stale holds, end expired lots, send waiting rail calls, time out unpaid orders, clean old idempotency records |
| `GET/PUT /v1/admin/catalogue` | price list in credits `{product,item,credits,active}` (audited) |
| `GET /v1/admin/dead_letters`, `POST /v1/admin/dead_letters/requeue {id}` | rail calls that failed 8 times; requeue after the rail is fixed |
| `POST /v1/admin/rail/process` | send due rail calls now |
| `POST /v1/admin/freeze` | `{email, frozen:true or false}` |
| `POST /v1/admin/webhooks` | `{url}` (public https host; http only for localhost); the secret is shown once |

Tenants and keys are made by the owner's local script only, never by the API.
`npm run reconcile` prints the same liability view across every tenant (read-only).

## Conversion engine (off by default)

`requested -> approved -> instructed -> paid`, or `rejected` (credits come back, still convertible).
- It only calculates (rate, hold, minimum, TDS, net) and records instructions.
- `instruct` hands the approved instruction to a **payment rail adapter**. The default is a stub that moves nothing. No real rail is connected.
- `mark_paid` is typed by a person with the real payment id (for example a bank reference); it writes a `payout` entry. A payout reference works once.
- Needs `conversion_enabled`, a `tds_rate_bps`, and (by default) a person's approval.

## Webhooks (outbox)

Events are written in the same step as the money change, then delivered signed:
headers `x-mnp-event-id`, `x-mnp-timestamp`, `x-mnp-signature = HMAC(webhookSecret, timestamp + "." + body)`.
Types: `fx.fetch_failed`, `fx.rate_rejected`, `rail.dead_letter`, `commission.reversed`, `credit.added`, `spend.captured`, `refund.money_due`, `refund.credits_returned`, `account.frozen`, `conversion.requested`, `conversion.paid`.
Events carry the opaque account id, never an e-mail (references with `@` or spaces are refused). A failed send retries with back-off, up to 10 times.

## Payment notice (purchase key)

`POST /v1/payment_notice` `{ payment_ref, paid_minor, currency, payer_email? }`: the payment side says a real payment
happened. Same id, same figures: no-op. Same id, other figures: `409 payment_conflict`. Captures of the cash part of an
order and commission events must name a payment noted here (`402 payment_not_verified`, or the event outcome
`payment_not_verified`, `cash_exceeds_payment`, `sale_reversed`).

## Key classes and AI safeguards

Keys: `read`, `spend` (stored as `api`), `purchase`, `admin`, `ai_read`. An `ai_read` key may only read and `POST /v1/ai/ask`,
which creates a pending request for a person (admin key) to approve; it never spends, converts, pays out, refunds or changes
a rate or price by itself. Switches: tenant `kill_switch` / `ai_enabled` settings, and the Hub `status.json`. The full
machine-readable contract is `contract/v1/openapi.json`.

## Currency display

Default name `Moneypenny`, label `moneypenny`, symbol `coin` (a built-in icon). Text is never a bare symbol:
`150 Moneypenny = US$1.50 (about Rs X)`. A `terms_url` setting links the terms.
