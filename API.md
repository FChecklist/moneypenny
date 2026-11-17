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
- Two key types: `api` (the routes below) and `admin` (admin routes). They cannot swap.
- Every POST/PUT/DELETE also needs `Idempotency-Key` (up to 120 characters). Same key and same request returns the first answer (`idempotent-replay: true`). Same key and a different request gives 409. A failed call leaves no trace, so its key can be reused.
- Callers must send only **verified** e-mail addresses. Identity is the lower-cased e-mail.

## Money units

Credits are whole numbers (100 credits = US$1). `*_minor` fields are paise (INR) or cents (USD). Currency is `INR` or `USD`.

## Routes (api key)

| Call | Body / query | Answer |
|---|---|---|
| `GET /v1/balance?email=&details=1` | | `balance`, `can_convert`, `settling`, `next_expiry`, `display{label, amount, convert_line, settling_line, theme}`. `buckets` only with `details=1` (for backends). |
| `POST /v1/credit` | **bought:** `email, bucket:"bought", amount, paid_minor, currency, payment_ref` (the verified payment id; credits cannot exceed what the payment covers). **bonus (hand-given):** `email, bucket:"bonus", amount, ref` | `credited` or `granted` |
| `POST /v1/event` | `email, event_type, event_key`; for commission also `payer_email, cash_minor, currency` | `granted`, `reason` (`granted`, `no_rule`, `already_earned`, `limit_reached`, `cap_reached`, `self_referral`, `blocked_domain`, `too_many_events`, `no_cash_no_commission`, `no_credit_for_visits`, `account_frozen`). The same `event_key` never pays twice. |
| `POST /v1/spend/reserve` | `email, order_ref, amount_minor, currency` | `hold_id`, `credit_applied`, `credit_value_minor`, `cash_due_minor`, `expires_at`. With nothing to use: `hold_id:null` and the full cash due. |
| `POST /v1/spend/capture` | `hold_id`; if cash is due also `payment_ref, cash_paid_minor` | `status:"captured"`. Later than the grace window: 410. |
| `POST /v1/spend/release` | `hold_id` | `status:"released"` (safe to repeat) |
| `POST /v1/refund` | `type:"order", hold_id, credits?` returns credits to their piles. `type:"purchase", payment_ref, credits?` is a real-money refund note for unspent bought credits (`money_due_minor`; this system pays nothing). `type:"chargeback", payment_ref` removes what is left of that purchase and pauses the account. | |
| `GET /v1/history?email=&limit=&before_seq=` | | newest first; `next_before_seq` to page |
| `POST /v1/convert_request` | `email, credits` | Records a request only. 403 `conversion_off` unless the tenant switched it on. Needs `tds_rate_bps`, the hold and the minimum. **No payout is ever made here.** |

## Admin routes (admin key)

| Call | What |
|---|---|
| `GET/PUT /v1/admin/settings` | read / change settings (every change is audited) |
| `GET/POST /v1/admin/rules`, `PUT/DELETE /v1/admin/rules/:id` | earning rules (DELETE only switches a rule off) |
| `GET /v1/admin/audit?limit=` | change log |
| `GET /v1/admin/health` | ledger chain, audit chain, ledger-versus-balance check |
| `POST /v1/admin/sweep` | release stale holds, end expired lots |
| `POST /v1/admin/freeze` | `{email, frozen:true|false}` |
| `POST /v1/admin/webhooks` | `{url}` (https, or http on localhost); the secret is shown once |

Tenants and keys are made by the owner's local script only, never by the API.

## Webhooks (outbox)

Events are written in the same step as the money change, then delivered signed:
headers `x-mnp-event-id`, `x-mnp-timestamp`, `x-mnp-signature = HMAC(webhookSecret, timestamp + "." + body)`.
Types: `credit.added`, `spend.captured`, `refund.money_due`, `refund.credits_returned`, `account.frozen`, `conversion.requested`.
Events carry the opaque account id, never an e-mail. A failed send retries with back-off, up to 10 times.
