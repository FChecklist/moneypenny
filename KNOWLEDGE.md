# Knowledge: Corporate Moneypenny

For what the product is and how it is built, see README.md. For the live state and handover notes see STATE.md. For owner decisions see OWNER-DECISIONS.md.

## Version

- Current version: **0.1.0** (live since 19 Nov 2026 IST, code 65b86c8). The same number is in `package.json`.
- Where the version lives: `version.json` at the repo root (product, version, releasedAt, releasedAtIST, commit, and a `changes` list). This product has no static site; the Worker serves the API only, so `version.json` is not served. Version history in words: `CHANGELOG.md`.
- Not yet deployed: the INR fixed pack price and the console wallet module are in the repo but not live. They get their own version when they are deployed.

### How to bump (mandatory for every deployed change)

1. Choose the new number: MAJOR.MINOR.PATCH. PATCH for a fix, MINOR for a new feature, MAJOR for a change that breaks existing callers of the API.
2. In the same pull request, update all of these:
   - `package.json` `version`
   - `version.json`: new `version`, `releasedAt` (UTC), `releasedAtIST`, `commit`, and a new entry at the top of `changes`
   - `CHANGELOG.md`: new entry at the top, in plain words, dated in IST
   - this Version section
3. Never deploy without the bump. Version notes live only in this repo's own git.
