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

Other numbers I had to pick (please confirm or change):
- INR rate: 7,000 paise per US$1 (Rs 70). The real rate is unknown. (`inr_paise_per_usd`)
- Bought credit lasts 365 days; bonus 365 days; commission never ends; returned credits last at least 30 days.
- Hold: 15 minutes, plus 5 minutes of grace for a late payment.
- Smallest cash left to pay after credits: Rs 1 (100 paise). USD: none.
- Demo welcome rules: account 100, first game created 200, first game paid 200, first game completed 200 (700 in all, under the 800 cap).

Open risks that need a person, not code: the CA questions in section 7 of the assessment, Razorpay's view on selling credits, the trademark check on the name, tax on bonus credits.
