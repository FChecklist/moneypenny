# Changelog

Newest first. Dates are in IST. Version numbers are MAJOR.MINOR.PATCH. This product only started numbering versions on 21 Nov 2026; everything built before that sits under 0.1.0 (the number already in `package.json`) and is listed below as dated milestones taken from git history.

## Not yet deployed (in the repo, not live)

These changes are after the deployed code (65b86c8). They need fresh independent audit passes before a deploy, and a version bump (see KNOWLEDGE.md) when they go live.

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
