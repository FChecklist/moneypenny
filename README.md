# Corporate Moneypenny

A small ledger that keeps **Credit $** for people: what they have, what they spent, what they earned.
100 credits = US$1. One balance on screen. Phase 0: runs on this laptop only. Nothing is live.

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
- **Cash conversion is OFF.** The code can record a request (after a hold, a minimum and a tax setting). It never pays anyone.

## Try it (Node 22.5 or newer; one light process)

```bash
npm test          # runs all tests in memory, a few seconds
npm run seed      # makes .data/dev.sqlite and a 'demo' tenant; prints keys once
npm run dev       # then open http://localhost:8787/admin and paste the admin key
```

## Folder map

| Path | What |
|---|---|
| `src/wallet.js` | balance, expiry, buying credit, earning events |
| `src/spend.js` | reserve / capture / release, refunds, conversion request |
| `src/ledger.js` | append-only hash-chained entries and integrity checks |
| `src/api.js`, `src/auth.js` | the signed HTTP surface |
| `src/admin.js`, `src/settings.js` | tenant settings, rules, audit |
| `packages/widget` | balance widget (one number, one optional line, skinnable) |
| `migrations/` | database schema (SQLite / D1) |
| `test/` | all tests |

Docs: [API.md](API.md), [RULES.md](RULES.md), [OWNER-DECISIONS.md](OWNER-DECISIONS.md).

## Deliberately not here yet

Live hosting (the D1 atomic executor is a Phase 1 job, see `src/d1.js`), real payments, cash-out, e-mail verification (callers must only send verified e-mails), warning e-mails before credits end, the Partner Circle link, the IT Services link.

## Public repo note

No secrets in code. The signing master secret comes from the environment (`MNP_MASTER_SECRET`). All rules and numbers live in the database. Licence: all rights reserved (see LICENSE).
