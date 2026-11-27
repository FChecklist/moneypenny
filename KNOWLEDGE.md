# Knowledge

## FX rates (27 Nov 2026, v0.2.0)
- Rate = USD/INR taken at 00:00 GMT, valid for that UTC day. Older than 24 h (from `fetched_at`) = stale: new INR orders get 503 `rate_stale`; USD still works. A rate fetched at exactly 00:00 therefore has no "fallback" window: it is fresh until midnight, then stale after 24 h.
- An order keeps its rate for `rate_lock_minutes` (120) even across midnight. A late payment is credited at the new rate. Margin 5% (`fx_margin_bps` 500).
- Sources in order: `er-api` (open.er-api.com, needs the attribution text `RATE_ATTRIBUTION` shown with prices), then `fawaz` (jsDelivr currency-api). Each source rejects a bad answer itself so the chain falls back; refreshRates still applies the INR band (10 to 500) and the 50% move guard.
- A stub rate (source `stub`) never prices INR orders: 503 `rate_source_not_configured`. Only for tests: `allowStubRate`.
- Nothing in the Worker calls `refreshRates` yet (no cron/scheduled handler exists). Rates must be fed by `node scripts/fx.js refresh` or a scheduled job added later; until then INR stays refused in production.
- Tests use fake fetch functions only (`test/fx-sources.test.js`); never the network.
