# Changelog

## 0.2.0 - 2026-11-27 (Moneypenny step 2, not deployed)
- Real exchange-rate sources: Exchange Rate API (`er-api`) with the fawaz currency API (`fawaz`) as fallback (`src/fx-sources.js`). The source name is stored in `fx_rate.source`. `RATE_ATTRIBUTION` text exported. Sanity band and the 50% move guard unchanged.
- `fx_max_age_hours` default 24 (was 72). Migration 0005 moves tenants that still hold 72 to 24; other values are kept.
- INR orders (`buy_credits`) are refused with 503 `rate_source_not_configured` while the active rate came from the stub. USD unaffected. Tests can allow the stub with `createApp({ allowStubRate: true })`.
- `GET /v1/quote` and `buy_credits` answers add `rate_source`, `rate_as_of`, `rate_attribution` (real source only), `rate_lock_minutes`, `price_note_en`. No existing field renamed.
- `scripts/fx.js refresh` uses the real chain (set `MNP_FX_SOURCE=stub` for the offline stub).

## 0.1.0
- Phase 0 build (local, audited deploy 19 Nov 2026).
