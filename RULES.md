| Setting | Starting value | Meaning |
|---|---|---|
| `product_name` | `"Corporate Moneypenny"` | Public product name shown to people. |
| `currency_name` | `"Moneypenny"` | Name of the currency shown to people (a tenant can rename it). |
| `unit_label` | `"moneypenny"` | Word used after a number (lower case). |
| `unit_symbol` | `"coin"` | Symbol. 'coin' shows the built-in coin icon; any other text is shown as is. Never a bare dollar sign. |
| `terms_url` | `null` | Link to the terms (an artificial in-product currency for these websites only). Shown next to the balance. |
| `credits_per_usd` | `100` | Credits per US$1 (100 = one credit is one cent). |
| `inr_paise_per_usd` | `7000` | Paise per US$1 (7000 = Rs 70). Used only until the daily rate table has a rate; after that the table (plus fx_margin_bps) is used. |
| `base_currency` | `"INR"` | Currency a person pays in by default (INR or USD; nothing else can be paid in). |
| `display_currency` | `null` | Optional third currency shown next to prices for information only (for example EUR). Never charged. |
| `fx_margin_bps` | `500` | Margin added to the daily INR rate for this tenant, in basis points (500 = 5%). |
| `fx_max_age_hours` | `72` | How old the last good exchange rate may be before new INR orders are paused. |
| `inr_packs` | `{}` | Fixed INR list price per credit pack, as {"credits": paise}, for example {"3400": 239900}. A pack is charged exactly this: no margin and no daily-rate change. Other sizes still use the daily rate. |
| `inr_round_to_rupee` | `1` | Round INR prices for credit orders up to a whole rupee. |
| `buy_min_credits` | `100` | Smallest credit order (100 = US$1). |
| `buy_max_credits` | `500000` | Largest single credit order (500000 = US$5,000). |
| `rate_lock_minutes` | `120` | Minutes a credit order keeps the exchange rate it was made at. A payment that arrives later is still credited, re-priced at the then-current rate. |
| `read_cache_max_age_seconds` | `300` | If the database fails, a balance seen this recently may still be shown (marked degraded). 0 = never. |
| `bought_expiry_days` | `365` | Days a bought lot stays valid. 0 = no end. |
| `bonus_expiry_days` | `365` | Days a bonus lot stays valid. 0 = no end. |
| `commission_expiry_days` | `0` | Days a commission lot stays valid. 0 = no end (it is money owed). |
| `reinstate_min_days` | `30` | A returned lot is valid for at least this many days. |
| `bonus_max_order_pct` | `50` | Bonus may pay at most this percent of one order. |
| `bonus_lifetime_cap` | `800` | Most bonus credits one person can ever earn (800 = US$8). |
| `bonus_needs_paid` | `1` | Bonus is spendable only once the person has real paid value on record (net of refunds and chargebacks). |
| `bonus_unlock_min_credits` | `100` | Real paid value (in credits) needed before bonus can be spent (100 = US$1). |
| `commission_hold_days` | `7` | Days before commission credits can be spent. |
| `hold_minutes` | `15` | Minutes a reserve (hold) lasts. |
| `capture_grace_minutes` | `5` | Extra minutes a late payment may still capture a hold. |
| `min_cash_due_inr` | `100` | Smallest cash left to pay in paise (payment gateway minimum). 0 = none. |
| `min_cash_due_usd` | `0` | Smallest cash left to pay in cents. 0 = none. |
| `commission_max_per_event` | `50000` | Largest commission one sale can pay (50000 = US$500). |
| `commission_daily_cap` | `500000` | Most commission credits paid across the whole tenant per 24 hours. |
| `manual_bonus_max` | `500` | Largest single hand-given bonus (credits). |
| `conversion_enabled` | `0` | Commission-to-cash requests. OFF until owner switches it on. |
| `conversion_hold_days` | `7` | Days a commission lot must age before it counts as convertible. |
| `conversion_min_credits` | `1500` | Smallest conversion request (1500 = US$15). |
| `conversion_approval_required` | `1` | A person must approve each conversion request before it can be sent to a payment rail. |
| `conversion_currency` | `"INR"` | Currency a conversion is calculated in (INR or USD). |
| `gst_rate_bps` | `null` | GST rate on conversions in basis points. Recorded on entries; unset = none. |
| `tds_rate_bps` | `null` | TDS rate in basis points. Must be set (by the CA) before conversion can be used. |
| `refund_money_enabled` | `1` | Allow refunds of the money paid for unspent bought credits. |
| `blocked_email_domains` | `["mailinator.com","guerrillamail.com","10minutemail.com","tempmail.com","yopmail.com","trashmail.com"]` | Throw-away e-mail domains that earn nothing. |
| `account_events_per_day` | `20` | Earning events counted per person per 24 hours. |
| `new_accounts_per_hour` | `100` | New people created by earning events per hour. |
| `tenant_daily_bonus_cap` | `50000` | Most bonus credits given across the whole tenant per 24 hours. |
| `kill_switch` | `0` | Tenant off-switch. When 1 every call except admin keys is refused (503 paused). |
| `ai_enabled` | `1` | When 0 every AI key is refused (403 ai_off). |
| `ai_rate_per_minute` | `60` | Signed calls an AI key may make per minute. |
| `ai_pending_max` | `20` | Most requests one AI key may have waiting for a person. |
| `ai_approval_ttl_hours` | `24` | Hours a request from an AI key waits for a person before it runs out. |
| `api_rate_per_minute` | `600` | Signed calls allowed per key per minute. |
| `wording_convert_line` | `"You can convert {amount}"` | Line under the balance. {amount} is filled in with credits and their US$ value. |
| `wording_settling_line` | `"Settling soon: {amount}"` | Line for credits still settling. {amount} is filled in. |
| `theme_enabled` | `1` | Show the theme skin. Balances are identical with it off. |
| `theme_name` | `"classic"` | Theme pack name. |
| `theme_accent` | `"#0b6b57"` | Accent colour for the balance widget. |
