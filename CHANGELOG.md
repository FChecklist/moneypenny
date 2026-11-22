# Changelog

Newest first. Dates are in IST. Version numbers are MAJOR.MINOR.PATCH. This product only started numbering versions on 21 Nov 2026; everything built before that sits under 0.1.0 (the number already in `package.json`) and is listed below as dated milestones taken from git history.

## 0.2.1 (prepared 22 Nov 2026, 05:30 IST; NOT deployed yet)

Fix round after two independent audits of 0.2.0 (both said FAIL, on the go-live plan). Live code is still 0.1.0. Nothing is turned on, no money flag changed, nothing deployed.

In plain words:

- The go-live plan had a contradiction. It said the money flags stay OFF, but also told the owner to turn them ON for the Rs 1 test. Now there is one rule: no customer can reach payment until the test passes, and the test runs only through an owner-only gate. Before the test, a second, non-owner account must be shown to be refused (checked again after the payment).
- The plan now lists a known risk: when a customer buys credits, Moneypenny calls IT Services while its one-at-a-time database lock is held. A slow IT Services (up to 4 seconds) freezes every other call, including people who already paid. The fix (call after the lock is released, using the outbox) is a gate before customers; the same goes for the webhook address check.
- The rollback step for "customer paid but has no credits" was wrong for this plan (it would answer `rate_stale`). It now says to repeat `rail/confirm` with the order id and the same payment id.
- The plan now says that any pause (kill switch or Hub off) also refuses payment confirmations, so IT Services must keep retrying and the counts must be checked afterwards.
- Smaller plan fixes: master secret must be in the shell when issuing keys; the Hub switch does not exist on the live Worker until step B2; `/health` says not-OK on code without the adapter; a test pack left behind must be removed even if the test is abandoned; version ids and a local folder path removed from the docs; payment id is unique per tenant; wording about forged calls and log cleaning made accurate.
- Three more safety rules are now watched by tests (46 listed guards; "watched" means the listed guards only, not every check in the code): expiry of credits on the game's spend path, the money-refund off-switch, and the length cut in the log cleaner.
- Code change (small): the log cleaner looks at the first 2000 characters only, so a very long input can no longer make it slow (it took about 5 seconds for 100,000 characters). A test fails without it.
- 3 new tests (G19 to G21). Test e-mail changed to an example.com address.
- Not changed: the IT Services adapter, IT Services side, console store, scheduling, Moneypenny Chat remain open (`docs/GO-LIVE.md`, section 8).

## 0.2.0 (prepared 21 Nov 2026, 22:50 IST; NOT deployed yet)

Live code is still 0.1.0. This number goes live only after two independent audit passes on the exact code, and `version.json` then gets its release time and code id.

In plain words:

- New plan for going live: `docs/GO-LIVE.md`. Ordered steps, which secrets to set (names only), the owner's own Rs 1 test through the whole chain (game, console, Moneypenny, IT Services, Razorpay), the two money flags that stay OFF until that test passes, and how to roll back.
- Forged or unsigned calls are now turned away before they can join the single queue that all payments use, and they cannot use up a real key's per-minute allowance.
- If something breaks inside the service, the log line no longer contains e-mail addresses or long secret-looking text.
- The public health page asks the payment side at most once every 30 seconds, so nobody can use it to hammer IT Services.
- New check (`railContract`) that any real payment-side connection must pass, including "a repeated order id gives the same order, never a second one".
- New `npm run guards`: removes each safety rule one at a time in a throw-away copy and fails if no test notices (it covers the listed rules only). Covers repeat-safe money writes, whole numbers only, the append-only hash-chained ledger, replay protection, rate limits, off-switches and log redaction.
- 19 new tests (including a rehearsal of the Rs 1 test with stand-ins). No real payment, no real service, only example.com addresses.
- Not changed: no money flag, no deploy setting, no database change. Still open: the IT Services connection inside Moneypenny, the IT Services pay page, the console's permanent order store, scheduling of housekeeping and event sending, and Moneypenny Chat (nothing of it exists in this repo). See `docs/GO-LIVE.md`, section 8.
- Included in this release (in the repo since 19 Nov, never deployed): the console wallet module, the fixed INR pack price, and the version files first proposed in PR 1 (which this branch contains).

## Not yet deployed (in the repo, not live) - now rolled into 0.2.0 and then 0.2.1 above

These changes are after the deployed code (65b86c8). They are part of 0.2.0 (and so of 0.2.1) and need fresh independent audit passes before a deploy.

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
