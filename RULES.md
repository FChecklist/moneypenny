# Rules

Every rule is a setting or a database row, per tenant. Nothing below is fixed in code.
Change them with `PUT /v1/admin/settings` or the local admin page. Every change is audited.

## Settings (generated from the code schema by `npm run rules-doc`)

| Setting | Starting value | Meaning |
|---|---|---|
| `product_name` | `"Corporate Moneypenny"` | Public product name shown to people. |
| `unit_name` | `"Credit $"` | Name of the credit unit. |
| `credits_per_usd` | `100` | Credits per US$1 (100 = one credit is one cent). |
| `inr_paise_per_usd` | `7000` | Paise per US$1 (7000 = Rs 70). Owner sets the real figure. |
| `bought_expiry_days` | `365` | Days a bought lot stays valid. 0 = no end. |
| `bonus_expiry_days` | `365` | Days a bonus lot stays valid. 0 = no end. |
| `commission_expiry_days` | `0` | Days a commission lot stays valid. 0 = no end (it is money owed). |
| `reinstate_min_days` | `30` | A returned lot is valid for at least this many days. |
| `bonus_max_order_pct` | `50` | Bonus may pay at most this percent of one order. |
| `bonus_lifetime_cap` | `800` | Most bonus credits one person can ever earn (800 = $8). |
| `bonus_needs_paid` | `1` | Bonus is spendable only after the first real paid purchase. |
| `commission_hold_days` | `7` | Days before commission credits can be spent. |
| `hold_minutes` | `15` | Minutes a reserve (hold) lasts. |
| `capture_grace_minutes` | `5` | Extra minutes a late payment may still capture a hold. |
| `min_cash_due_inr` | `100` | Smallest cash left to pay in paise (payment gateway minimum). 0 = none. |
| `min_cash_due_usd` | `0` | Smallest cash left to pay in cents. 0 = none. |
| `manual_bonus_max` | `500` | Largest single hand-given bonus (credits). |
| `conversion_enabled` | `0` | Commission-to-cash requests. OFF until owner switches it on. |
| `conversion_hold_days` | `7` | Days a commission lot must age before it counts as convertible. |
| `conversion_min_credits` | `1500` | Smallest conversion request (1500 = $15). |
| `tds_rate_bps` | `null` | TDS rate in basis points. Must be set (by the CA) before conversion can be used. |
| `refund_money_enabled` | `1` | Allow real-money refunds of unspent bought credits. |
| `blocked_email_domains` | `["mailinator.com","guerrillamail.com","10minutemail.com","tempmail.com","yopmail.com","trashmail.com"]` | Throw-away e-mail domains that earn nothing. |
| `account_events_per_day` | `20` | Earning events counted per person per 24 hours. |
| `new_accounts_per_hour` | `100` | New people created by earning events per hour. |
| `tenant_daily_bonus_cap` | `50000` | Most bonus credits given across the whole tenant per 24 hours. |
| `api_rate_per_minute` | `600` | Signed calls allowed per key per minute. |
| `wording_convert_line` | `"You can convert {amount}"` | Line under the balance. {amount} is filled in. |
| `wording_settling_line` | `"Settling soon: {amount}"` | Line for credits still settling. {amount} is filled in. |
| `theme_enabled` | `1` | Show the theme skin. Balances are identical with it off. |
| `theme_name` | `"office"` | Theme pack name. |
| `theme_accent` | `"#0b6b57"` | Accent colour for the balance widget. |

## Earning rules (`/v1/admin/rules`)

| Field | Meaning |
|---|---|
| `event_type` | the event name a product sends (letters, digits, underscore) |
| `bucket` | `bonus` or `commission` (`bought` only comes from a verified payment) |
| `amount_type` / `amount` | `fixed` credits, or `pct_cash_bps` (commission as basis points of **cash received**; 1000 = 10%) |
| `mode` | `once` per person, `capped` (needs `max_count`), or `every` (a bonus rule then needs a `lifetime_cap`) |
| `lifetime_cap` | most credits this rule can ever give one person |
| `expiry_days` | overrides the bucket's end date for this rule |
| `enabled` | off = pays nothing |

## Guards that stay in code (they protect money)

- Visits, page views and logins can never earn credit (rule creation is refused).
- Commission needs real cash: no cash, no commission. A referrer who is also the payer (after removing gmail dots and `+tags`) is refused.
- People are matched by a cleaned-up e-mail for abuse checks, so `a.b@gmail.com` and `ab+2@gmail.com` share one welcome bonus and one lifetime cap.
- Bought credit is never cashable; bonus and commission never come back as refund money.
- Spend order is bonus, then commission, then bought. Commission can be spent only after its hold.
- Rounding favours the person: credit value rounds up, and a sub-credit remainder on a fully covered order is waived.
