# Moneypenny: state and handover (17 Nov 2026)

**One line:** Phase 0 is built and tested locally. Nothing is deployed, pushed or registered. Audit 5 (independent) was running when this was written; the final verdict is below once it is in.

## What is built
- Credit ledger (append-only, hash-chained), lots/buckets (bought, bonus, commission), holds, spend gate, `buy_credits` via a rail outbox (stub rail), payment notice, conversion requests (records only, no payout), reconcile views, FX table (daily, margin 5%, 120-minute order lock), AI-ready API (scoped keys, ask-only AI key, approvals, kill switch, Hub status file), OpenAPI contract in `contract/v1/openapi.json`, balance widget with built-in coin icon.
- Currency default: name "Moneypenny", label "moneypenny", symbol = built-in coin icon, `terms_url` setting. Display text never a bare symbol.
- Cloudflare executor: one SQLite-backed Durable Object (`src/do.js`, `src/worker.js`), not plain D1 (D1 has no interactive transactions).

## Tests
- 249 tests pass (`npm test`), also on the Durable Object adapter with `MNP_DB=do npm test`. The adapter is tested only against a stand-in for Cloudflare's storage.

## Audit rounds
| Round | Verdict | Notes |
|---|---|---|
| 1-3 | FAIL (each) | fixed and tested |
| 4 | FAIL, 20 findings | all fixed except the listed known limits |
| 5 | FAIL, 9 findings | fixed (refund then re-earn, refund flags conversions, held commission, wording tricks, signed Idempotency-Key, and more) |
| 6 | FAIL, 10 findings | fixed (refund debt at every reinstate point and at capture, payer required, stronger wording rules, admin page signing, atomic migrations, AI fail-closed without a switch) |
| 7 | FAIL, 7 findings (no minting; refund proportion, wording list, AI default) | fixed |
| 8 | FAIL, 6 findings (refund debt in re-issued lots, stale-rate conversions, AI status shape, wording) | fixed, plus random-sequence refund tests |
| 9 | FAIL (off-switch failed open on a Hub outage; Worker used stub rail; instruct had no timeout; chargeback skipped spent-commission debt; rounding; docs) | fixed |
| 10 | pending | fresh independent auditor on the final code |

A second independent PASS on the exact final code is still needed before reporting done.

## What is deployed
Nothing. No GitHub repo, no push, no Cloudflare resources, no DNS, no live D1/Razorpay/IT Services. No rollback id exists yet.

## What waits on whom
- Steps 4-8 (public repo FChecklist/moneypenny after a secret scan, push, Cloudflare deploy, DNS Moneypenny.corporatetambola.com, live smoke, register code MNP) wait for the owner to confirm directly in the Moneypenny session. Relayed quotes through BOSS were not accepted as that confirmation.
- Real rail, real rate source, e-mail verification, warning e-mails, Partner Circle and IT Services links: not built.
- Terms document: being written by session local_eb9284d9; `terms_url` setting is ready for it.

## Known limits (README "Known limits")
Rail call inside the transaction in `buy_credits`; no cron or webhook sender; first rate row only band-checked; webhook address check is name-based. Real-runtime checks still needed on first deploy: multi-statement `sql.exec`, foreign keys, rollback on throw, `changes()`.

## Next steps
1. Audit 5 verdict; fix; repeat until two PASS in a row on the final code.
2. Tell the API Hub builder (local_d1354695) the contract is stable.
3. On the owner's direct go-ahead: secret scan, then steps 4-8.
4. Separate modules (own sessions, API-only): organizer feedback box, and the "Moneypenny" assistant (original illustrated character, not a film likeness; ask-only AI key).
