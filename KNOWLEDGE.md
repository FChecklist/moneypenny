# Knowledge: Corporate Moneypenny

For what the product is and how it is built, see README.md. For the live state and handover notes see STATE.md. For owner decisions see OWNER-DECISIONS.md.

## Version

- Current version: **0.1.0** (live since 19 Nov 2026 IST, code 65b86c8). `package.json` is ahead at 0.2.0 (FX step 2, not deployed). `version.json` moves to 0.2.0 only in the PR that deploys it.
- Where the version lives: `version.json` at the repo root (product, version, releasedAt, releasedAtIST, commit, and a `changes` list). This product has no static site; the Worker serves the API only, so `version.json` is not served. Version history in words: `CHANGELOG.md`.
- Not yet deployed: 0.2.0 (real FX sources) plus the INR fixed pack price and the console wallet module are in the repo but not live. They go live under the version chosen in the deploy PR.

### How to bump (mandatory for every deployed change)

1. Choose the new number: MAJOR.MINOR.PATCH. PATCH for a fix, MINOR for a new feature, MAJOR for a change that breaks existing callers of the API.
2. In the same pull request, update all of these:
   - `package.json` `version`
   - `version.json`: new `version`, `releasedAt` (UTC), `releasedAtIST`, `commit`, and a new entry at the top of `changes`
   - `CHANGELOG.md`: new entry at the top, in plain words, dated in IST
   - this Version section
3. Never deploy without the bump. Version notes live only in this repo's own git.

## FX rates (27 Nov 2026, v0.2.0)
- Rate = USD/INR taken at 00:00 GMT, valid for that UTC day. Older than 24 h (from `fetched_at`) = stale: new INR orders get 503 `rate_stale`; USD still works. A rate fetched at exactly 00:00 therefore has no "fallback" window: it is fresh until midnight, then stale after 24 h.
- An order keeps its rate for `rate_lock_minutes` (120) even across midnight. A late payment is credited at the new rate. Margin 5% (`fx_margin_bps` 500).
- Sources in order: `er-api` (open.er-api.com, needs the attribution text `RATE_ATTRIBUTION` shown with prices), then `fawaz` (jsDelivr currency-api). Each source rejects a bad answer itself so the chain falls back; refreshRates still applies the INR band (10 to 500) and the 50% move guard.
- A stub rate (source `stub`) never prices INR orders: 503 `rate_source_not_configured`. Only for tests: `allowStubRate`.
- Nothing in the Worker calls `refreshRates` yet (no cron/scheduled handler exists). Rates must be fed by `node scripts/fx.js refresh` or a scheduled job added later; until then INR stays refused in production.
- Tests use fake fetch functions only (`test/fx-sources.test.js`); never the network.
