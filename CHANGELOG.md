# Changelog

Newest first. Dates are in IST. Version numbers are MAJOR.MINOR.PATCH. This product only started numbering versions on 21 Nov 2026; everything built before that sits under 0.1.0 (the number `package.json` carried until 0.2.0 was started) and is listed below as dated milestones taken from git history.

## 0.2.0 - 2026-11-27 (Moneypenny step 2, not deployed)
- Real exchange-rate sources: Exchange Rate API (`er-api`) with the fawaz currency API (`fawaz`) as fallback (`src/fx-sources.js`). The source name is stored in `fx_rate.source`. `RATE_ATTRIBUTION` text exported. Sanity band and the 50% move guard unchanged.
- `fx_max_age_hours` default 24 (was 72). Migration 0005 moves tenants that still hold 72 to 24; other values are kept.
- INR orders (`buy_credits`) are refused with 503 `rate_source_not_configured` while the active rate came from the stub. USD unaffected. Tests can allow the stub with `createApp({ allowStubRate: true })`.
- `GET /v1/quote` and `buy_credits` answers add `rate_source`, `rate_as_of`, `rate_attribution` (real source only), `rate_lock_minutes`, `price_note_en`. No existing field renamed.
- `scripts/fx.js refresh` uses the real chain (set `MNP_FX_SOURCE=stub` for the offline stub).

## Also not deployed, before 0.2.0 (no separate version number)

These changes came after the deployed code (65b86c8) and are part of what goes live with 0.2.0. They need fresh independent audit passes before a deploy, and the version files updated (see KNOWLEDGE.md) when they go live.

- 20 Nov 2026, 00:11: Console wallet: the failure count restarts after each successful step.
- 20 Nov 2026, 00:06 to 00:08: Console wallet: any unfinished order reaches the owner after 2 hours; a reopened click restarts its clock.
- 19 Nov 2026, 22:48 to 23:44: Console wallet module (test mode): buy a fixed-price pack, then spend on a game item with reserve, game step and capture. Reworked after audit findings: capture first then grant, refund on a clear refusal, repeat requests return the same result. `reserve_item` can now be repeated safely and an order can carry a fixed price. API contract regenerated.
- 19 Nov 2026, 15:11 to 19:28: A credit pack in INR can have one fixed price (setting `inr_packs`), so a late payment is never re-priced. Price band of 40 to 160 paise per credit. Migration 0004 added.

## 0.1.0 (live since 19 Nov 2026, IST)

Released code: 65b86c8. Worker `moneypenny` at moneypenny.corporatetambola.com, no money flowing (no payment side, no rate source).

Milestones that make up 0.1.0:

- 19 Nov 2026, 09:03: Worker made loadable on the real Cloudflare runtime (migrations moved to `src/migrate.js`), Cloudflare config with custom domain, checked on a local Workers runtime. Deployed that day; audits 18 and 19 passed.
- 17 Nov 2026, 18:37: Audit 16 and 17 passed on this code (Hub per-action switch-off also covers approved AI requests, wording and docs fixes).
- 17 Nov 2026, 15:55 to 18:24: Audit rounds 5 to 14 fixes: refund and chargeback debt handling, stronger wording rules, signed setup call for the owner, off-switch that stays closed unless known good, strict status file, AI shut by default, body size limits, INR purchase guards. Tests run on Node 22 in CI (CI never deploys).
- 17 Nov 2026, 11:00 to 13:27: AI-ready layer (scoped keys, ask-only AI key, approvals, kill switch), currency renamed to plain Moneypenny with a coin icon, SQLite Durable Object executor, payment notice, commission and capture checks.
- 17 Nov 2026, 10:26 to 10:36: Single gate with price list and rail outbox, daily FX table (5 percent margin, 120-minute order lock), versioned API contract folder with a contract test.
- 17 Nov 2026, 09:46 to 10:02: Phase 0 build: credit ledger (append-only, hash-chained), three credit piles (bought, bonus, commission), holds, spend gate, refunds, conversion skeleton (records only), reconcile views. First audit fixes.
