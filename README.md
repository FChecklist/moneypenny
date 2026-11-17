# Corporate Moneypenny

A small ledger that keeps **Moneypenny** for people: what they have, what they spent, what they earned.
The currency name, unit word and symbol are tenant settings (default "Moneypenny", "credits", "MC"). 100 credits = US$1 (also a setting). One balance on screen. Phase 0: runs on this laptop only. Nothing is live.

**Status:** local build. Not deployed. No payments, no cash-out, no real accounts.
The public name is one setting (`product_name`). The code name is MNP.

## What it does, in plain words

- **One balance, three piles underneath.** *Bought* (paid for with real money), *bonus* (free, small, capped), *commission* (earned from real paid sales). The piles never merge, so bought credit can never become cash.
- **Spending order:** bonus first, then commission, then bought.
- **Bonus is gentle:** it pays at most half of one order, only after the person's first real paid purchase, and only up to a lifetime limit (about $8).
- **Holds:** when an order starts, credits are set aside for about 15 minutes. Payment done: *capture*. Payment fails: *release*.
- **Refunds:** real money only for unspent *bought* credits, and only as a note to IT Services (this system never moves money). A cancelled paid order gives credits back to the pile they came from.
- **Earning rules** are settings in the database, per tenant. A plain site visit never earns credit.
- **Safe by design:** every write has an idempotency key; every call is signed and cannot be replayed; the ledger is append-only and hash-chained; every setting change is in an audit log.
- **Cash conversion is OFF.** A skeleton engine can calculate and record a request (hold, minimum, approval, TDS). Real money stays behind a payment-rail adapter; the only one shipped is a stub that moves nothing.
- **Complete register:** each entry records its kind, the exchange rate at that moment, real-money value, TDS/GST fields, status and the outside payment id. `npm run reconcile` shows the credits still owed.
- **The single gate.** Products price and spend only in credits and call only this service. A price list (catalogue) holds each item's price in credits; `reserve_item` takes the credits all-or-nothing (no cash part). To buy credits a product calls `buy_credits`; this service asks the payment rail (IT Services) for an order through an adapter, and credits arrive only when the rail confirms the payment. Rail calls wait in an outbox, retry with back-off, and become dead letters a person can requeue. `/health` shows db, rail, rates and queue counts. If the database cannot read lots, a recently seen balance is still served, marked `degraded`.
- **Daily exchange rates.** An append-only `fx_rate` table (rate per US$, fixed for each UTC day, margin per tenant, no approval gate; only a missing, zero, negative or non-number rate is rejected, the last good rate is kept and an alert is raised; last-good fallback with a maximum age). An order keeps the rate it was made at. Payment is only in INR or USD; other currencies are display-only. No network is used here: the rate source is a stub (`npm run fx -- refresh`).
- **Stands alone.** It knows only tenants, accounts, credits, buckets, rules and holds. Games and other products are just API clients; there is no end-user login or page.

## Try it (Node 22.5 or newer; one light process)

```bash
npm test          # runs all tests in memory, a few seconds
npm run seed      # makes .data/dev.sqlite and a 'demo' tenant; prints keys once
npm run reconcile # credits still owed, by bucket and tenant
npm run dev       # then open http://localhost:8787/admin and paste the admin key
```

## Folder map

| Path | What |
|---|---|
| `src/wallet.js` | balance, expiry, buying credit, earning events |
| `src/spend.js` | reserve / capture / release, refunds, chargeback |
| `src/gate.js`, `src/fx.js` | price list, buy credits, rail outbox, quotes; daily rates |
| `src/convert.js`, `src/rail.js` | conversion engine skeleton and the payment-rail stub |
| `src/reconcile.js` | credits-owed views |
| `src/ledger.js` | append-only hash-chained entries and integrity checks |
| `src/api.js`, `src/auth.js` | the signed HTTP surface |
| `src/admin.js`, `src/settings.js` | tenant settings, rules, audit |
| `packages/widget` | balance widget (one number, one optional line, skinnable) |
| `migrations/` | database schema (SQLite / D1) |
| `test/` | all tests |

Docs: [API.md](API.md), [RULES.md](RULES.md), [OWNER-DECISIONS.md](OWNER-DECISIONS.md).

## Deliberately not here yet

Live hosting, a real rail and a real rate source (adapters are stubs; rail calls run inside the database step, so a real rail must be idempotent by `order_id`), a degraded cache that survives a full database outage (signing in still needs the database), live hosting (the D1 atomic executor is a Phase 1 job, see `src/d1.js`), real payments, cash-out, e-mail verification (callers must only send verified e-mails), warning e-mails before credits end, the Partner Circle link, the IT Services link.

## Public repo note

No secrets in code. The signing master secret comes from the environment (`MNP_MASTER_SECRET`). All rules and numbers live in the database. Licence: all rights reserved (see LICENSE).

## Where the money code runs (Cloudflare)

Plain D1 has no interactive transactions, so the money code does **not** run on D1. It runs inside one SQLite-backed
**Durable Object** (`src/do.js`, `src/worker.js`): one writer, its own database next to the code, and every request
is all-or-nothing (Cloudflare documents that SQL run inside `ctx.storage.transaction()` is part of that transaction and
rolls back if the closure throws). Requests are also queued one at a time by our own lock, because a rail call inside a
transaction would otherwise let another request in. Run the whole suite on this adapter with `MNP_DB=do npm test`.

**What is not tested:** the adapter is tested against a stand-in for Cloudflare's storage (`test/do-storage.js`), not the
real runtime. Still to check once, on a real deploy: that a multi-statement migration runs through `sql.exec`, that
foreign keys are enforced, and that a thrown error rolls back. One Durable Object is one writer for everyone, which is
fine for Phase 0 volume; at higher volume split it per tenant.

## Payments are noted before they are used

The payment side calls `POST /v1/payment_notice` (purchase key) with the payment id, amount and currency. A product can
then capture the cash part of an order, or earn a commission, only against a payment noted there (or one that bought
credits). Payment ids are compared without regard to letter case.
