# API

JSON in and out. Every response has `"ok": true|false`.
Errors look like `{"ok":false,"error":{"code":"...","message":"..."}}`.

## Signing (every call)

Headers: `x-mnp-key`, `x-mnp-timestamp` (milliseconds), `x-mnp-nonce` (new every call), `x-mnp-signature`.

```
signature = hex( HMAC-SHA256( secret, [timestamp, nonce, METHOD, pathWithQuery, sha256hex(body)].join("\n") ) )
```

- The timestamp must be within 5 minutes. A nonce works once per key (a replay gets 401).
- The secret is shown once when a key is made. It is derived from the master secret, so no secret sits in the database.
- Four key types, least power each: `read` (balance only), `api` (a product's server: spend, events, hand-given bonus, order returns), `purchase` (the payment system: credit bought, money refunds, chargebacks) and `admin`. A key cannot use another type's routes.
- Every POST/PUT/DELETE also needs `Idempotency-Key` (up to 120 characters); for `credit_purchase` the payment id is used when the header is left out. Same key and same request returns the first answer (`idempotent-replay: true`). Same key and a different request gives 409. A failed call leaves no trace, so its key can be reused.
- Callers must send only **verified** e-mail addresses. Identity is the lower-cased e-mail.

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
| `GET /v1/balance?email=` (read, api) | `details=1` adds bucket amounts for `api` keys only | `balance`, `can_convert`, `settling`, `next_expiry`, `display{label, amount, convert_line, settling_line, theme}` |
| `POST /v1/credit_purchase` (purchase) | `email, amount, paid_minor, currency, payment_ref` (the verified payment id; credits cannot exceed what the payment covers; one payment id works once) | `credited` |
| `POST /v1/credit` (api) | hand-given bonus: `email, bucket:"bonus", amount, ref` (same caps as rules; audited) | `granted` |
| `POST /v1/event` (api) | `email, event_type, event_key`; for commission also `payer_email, cash_minor, currency` | `granted`, `reason` (`granted`, `no_rule`, `already_earned`, `limit_reached`, `cap_reached`, `self_referral`, `payer_required`, `blocked_domain`, `too_many_events`, `no_cash_no_commission`, `no_credit_for_visits`, `account_frozen`, `rule_invalid`). The same `event_key` never pays twice. |
| `POST /v1/spend/reserve` (api) | `email, order_ref, amount_minor, currency` | `hold_id`, `credit_applied`, `credit_value_minor`, `cash_due_minor`, `expires_at`. Nothing to use: `hold_id:null` and the full cash due. |
| `POST /v1/spend/capture` (api) | `hold_id`; if cash is due also `payment_ref, cash_paid_minor` | `status:"captured"`. Later than the grace window: 410. A reversed (charged-back) payment behind the hold: 409 `payment_reversed`. |
| `POST /v1/spend/release` (api) | `hold_id` | `status:"released"` (safe to repeat) |
| `POST /v1/refund` | `type:"order", hold_id, credits?` (api key) returns credits to their piles. `type:"purchase", payment_ref, credits?` (purchase key) is a money-refund note for unspent bought credits. `type:"chargeback", payment_ref` (purchase key) removes everything that came from that payment, including held or returned credits, and pauses the account. | `returned_credits`, `money_due_minor` (this system pays nothing) |
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
| `POST /v1/admin/sweep` | release stale holds, end expired lots, clean old idempotency records |
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
Types: `credit.added`, `spend.captured`, `refund.money_due`, `refund.credits_returned`, `account.frozen`, `conversion.requested`, `conversion.paid`.
Events carry the opaque account id, never an e-mail (references with `@` or spaces are refused). A failed send retries with back-off, up to 10 times.
