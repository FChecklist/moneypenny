# Open decisions (section 11 of the assessment) and what Phase 0 assumed

Nothing here is final. Every default is a setting and can change without code.

| # | Decision | Default used in Phase 0 | Where to change |
|---|---|---|---|
| 1 | Name and code | Public: **Corporate Moneypenny** (one setting). Code MNP. No trademark check done. Home `Moneypenny.corporatetambola.com` is not set up. Whether IT Services gets code KSH or MNP is open. | `product_name` |
| 2 | Public repo | Not created. Code is written to be public: no secrets, rules in the database, all-rights-reserved LICENSE. | owner |
| 3 | Real price plus credit balance (no "was/now" price) | Yes: the API only ever deals in the real order amount and the credit applied. | product copy |
| 4a | Welcome bonus | **Once only** per person | rule `mode: once` |
| 4b | Lifetime bonus cap per person | **800 credits ($8)** (assessment said about $7 to $10) | `bonus_lifetime_cap` |
| 4c | Bonus pays at most | **50%** of one order | `bonus_max_order_pct` |
| 4d | Bonus spendable | only after the first real paid purchase | `bonus_needs_paid` |
| 5 | Commission base | **Cash received only.** A fully credit-paid order earns none. Orders paid from *bought* credits are still open: the calling product decides whether to send the event and with what `cash_minor`. | rule `pct_cash_bps` |
| 6 | Partner Circle as the commission engine | Not connected. A demo commission rule exists (10%, placeholder). | rule |
| 7 | Conversion policy | **OFF.** If switched on: 7-day spend hold, 7-day convert hold, minimum 1,500 credits ($15), tax rate must be set first. No payout code exists. | `conversion_*`, `tds_rate_bps` |
| 8 | Start Phase 0 | Done (this build). The CA letter is not sent by this build. | owner |

Design rules from the owner (17 Nov): Moneypenny is a separate product, linked to games and other products by API only, with no end-user login or page. It is the complete credit register (rates locked per entry, real-money value, TDS/GST fields, outside payment id). Conversion is a calculating skeleton behind a stub payment rail, off by default. Payments reach it only through IT Services' `purchase` key.

Added 17 Nov (gate and rates), all settings:
- Currency name "Moneypenny" (tenant setting; no $ sign as the unit). The word is visible to end users, so the trademark check applies to it.
- Daily rate: fixed per UTC day. **No approval gate on jumps** (owner ruling 17 Nov): a big but valid move is accepted and only noted. A rate that is missing, zero, negative or not a number is rejected, yesterday's rate is kept and an alert (`fx.rate_rejected`) is raised. The last good rate is used up to 72 hours (`fx_max_age_hours`), then new INR orders pause (USD still works).
- FX margin default **5%** (`fx_margin_bps` 500, a tenant setting). INR prices round up to the whole rupee.
- Order lock: **120 minutes** (`rate_lock_minutes`). Inside it an order keeps its rate and credits. After it an unpaid order is marked failed, but a payment that still arrives is credited, re-priced at the then-current rate (money is never kept without credits).
- Commission needs the sale's payment id, pays once per sale, and has caps: `commission_max_per_event` (50,000 credits = $500) and `commission_daily_cap` (500,000 = $5,000 a day per tenant).
- Not done: chargeback of a payment that paid an order's cash part; money refunds for credits returned to a lot after an order cancel.

Other numbers I had to pick (please confirm or change):
- INR rate: 7,000 paise per US$1 (Rs 70). The real rate is unknown. (`inr_paise_per_usd`)
- Bought credit lasts 365 days; bonus 365 days; commission never ends; returned credits last at least 30 days.
- Hold: 15 minutes, plus 5 minutes of grace for a late payment.
- Smallest cash left to pay after credits: Rs 1 (100 paise). USD: none.
- Demo welcome rules: account 100, first game created 200, first game paid 200, first game completed 200 (700 in all, under the 800 cap).

Open risks that need a person, not code: the CA questions in section 7 of the assessment, Razorpay's view on selling credits, the trademark check on the name, tax on bonus credits.
- Bonus unlocks once a person has real paid value of $1 (100 credits) on record, net of refunds and chargebacks. (`bonus_unlock_min_credits`)
- Conversion calculates in INR by default, needs a person's approval, and TDS is rounded up.

- FX: no approval gate on rate jumps (owner ruling holds). Only a technical sanity check: INR must be 10 to 500 per US$ and within 50% of the last good rate, otherwise the feed is treated as bad, the last good rate is kept and an alert is raised. A person can fix a bad day with `node scripts/fx.js override INR 70.5 "reason"` (history is kept).
