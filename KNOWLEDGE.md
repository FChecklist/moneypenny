# Knowledge: Corporate Moneypenny

For going live (steps, secret names, the Rs 1 test, flags, rollback) see `docs/GO-LIVE.md`. For what the product is and how it is built, see README.md. For the live state and handover notes see STATE.md. For owner decisions see OWNER-DECISIONS.md.

## Version

- Live version: **0.1.0** (live since 19 Nov 2026 IST, code 65b86c8).
- Prepared, not deployed: **0.2.7** (25 Nov 2026 UTC; adds dark payee accounts F1 and F2 with four audit-fix rounds (audit rows, owner-only, value and bank-detail screening); it supersedes 0.2.0 to 0.2.6, which were prepared and never deployed). `package.json` and `version.json` say 0.2.7; `preparedAt` is the time of the commit that carries it; `version.json` has `status: "prepared, not deployed"`, `releasedAt: null` and `commit: null` until the deployer fills them in at deploy time (and sets `status` to `deployed`).
- Where the version lives: `version.json` at the repo root (product, version, releasedAt, releasedAtIST, commit, and a `changes` list). This product has no static site; the Worker serves the API only, so `version.json` is not served. Version history in words: `CHANGELOG.md`.
- Not yet deployed: everything since 65b86c8 (INR fixed pack price, console wallet module, the go-live hardening below). All of it is in 0.2.2.

### How to bump (mandatory for every deployed change)

1. Choose the new number: MAJOR.MINOR.PATCH. PATCH for a fix, MINOR for a new feature, MAJOR for a change that breaks existing callers of the API.
2. In the same pull request, update all of these:
   - `package.json` `version`
   - `version.json`: new `version`, `releasedAt` (UTC), `releasedAtIST`, `commit`, and a new entry at the top of `changes`
   - `CHANGELOG.md`: new entry at the top, in plain words, dated in IST
   - this Version section
3. Never deploy without the bump. Version notes live only in this repo's own git.

## Go-live knowledge (0.2.2)

- Payment chain: game -> `console.corporatetambola.com` -> Moneypenny -> IT Services (Pages + D1) -> Razorpay. One payee (IT Services), one gateway (Razorpay) in every text. Moneypenny never moves money.
- The live Worker has no payment side (`unconfiguredRail` in `src/worker.js`): `buy_credits` refuses. Connecting IT Services means a new adapter that passes `railContract` (`src/rail.js`), shipped as its own release with two audits.
- Flags `PAY_VIA_MONEYPENNY` and `PAY_VIA_CONSOLE` live in the game and console projects, not here. No customer can reach payment until D3 items 1 to 10 and D4 pass on the same run (`docs/GO-LIVE.md`). During D1 to D3 the flags are ON only behind the audited owner-only gate, which sits in front of the flag. The test runs only through that gate, and D1 must first show a non-owner account is refused. The flags are never turned ON for everyone for the test.
- Two known limits are gates before customer traffic (E5), not before the owner's test: the IT Services call inside the database transaction (freezes the lock for up to 4 s per call, and the admin sweep can chain 25 such calls, about 100 s; move it to the outbox after commit) and the name-only webhook address check (`docs/GO-LIVE.md` section 8, items 1a, 1b).
- Rollback for "paid, no credits": repeat `rail/confirm` with the order id and payment id. `credit_purchase` for INR needs a current rate and answers `rate_stale` without one. A pause also refuses payment confirmations (503), so IT Services retries. Moneypenny's own brakes: no rail wired, Hub status switch, tenant `kill_switch`, key revoke.
- Key secrets are derived from `MNP_MASTER_SECRET`: changing it kills every key. Names of secrets only, never values, in docs, tickets, chat and logs.
- Safety rules that are watched by tests: run `npm run guards` (about two minutes). It must say "None are unwatched." This covers the 46 listed guards only, not every check in the code. **Known unwatched, on purpose:** `src/spend.js` line 262 (`want > left`) and line 224 (release of a captured hold). Removing either breaks no test, but no extra money can leave because the later checks at lines 272 and 225 stop it (line 262 removed would only let `hold.refunded_credits` exceed `credits`, bookkeeping only). When you add a guard, add a test that fails without it.
- A forged call is refused before it reaches the single writer (`precheckSignature` in `src/auth.js`). Logs go through `redact` (`src/util.js`), best effort, first 2000 characters only.
- Open: IT Services adapter and Pages/D1 side, owner-only gate for the test, console permanent store and 2-minute job, scheduling of sweep and event sending, Moneypenny Chat (does not exist in this repo), owner decisions in `OWNER-DECISIONS.md`.
- Test fixtures use `example.com` addresses only for new tests; older tests use `x.com` placeholders that never leave the test run.
