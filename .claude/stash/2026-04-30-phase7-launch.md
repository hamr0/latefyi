# Stash — Phase 7 launch + open allowlist

**Date:** 2026-04-30
**Last commit:** `c7eb7a7` (feat: auto-detect bare dates as On:)
**Tests:** 240/240
**Version:** 0.8.0 in package.json, PRD 1.8.1
**Deployed:** VPS pulled + restarted; Worker `latefyi-ingest` redeployed via API

## What shipped this session (in order)

1. **Phase 7 deliverability** — SPF (added VPS IP), DKIM (selector `latefyi2026`, opendkim signing-table on VPS), DMARC (`p=none` monitoring). Verified via direct send to Gmail: SPF=PASS, DKIM=PASS, DMARC=PASS.
2. **Abuse limits** — `users.js` `checkRateLimit()` + `recordRequest()`. Defaults 10/hr, 50/day, 20 active per sender. Env-tunable. Failed resolves don't count against the budget. New replies: `rateLimitedReply`, `tooManyActiveReply`.
3. **`On: <date>` advance planning** — ISO + named-month, today-or-future, ≤90d. Threaded through resolve as `when: Date` to HAFAS. Records sit in `state/pending/` until T-30.
4. **Cloudflare Pages** — apex `late.fyi` serves `web/index.html`. CNAME-flattened apex (had to manually add CNAME after auto-attach skipped).
5. **`feedback@late.fyi`** — CF Email Routing custom rule → forward to `avoidaccess@gmail.com`.
6. **Worker NON_TRACKING_LOCALPARTS** — defense in depth: `feedback`/`postmaster`/`abuse`/`admin`/`noreply`/`no-reply`/etc. dropped before any processing.
7. **Footer redesign** — slimmed FOOTER to identity + feedback + privacy claim. Format help moved into `missingContextReply` (which now lists all subject options including `On:`).
8. **Privacy: zero retention** — `done/` and `errors/` directories removed. Terminal records `unlinkSync()`'d. `scrubSender()` deleted as dead code. push.jsonl uses senderHash only. Privacy claim is now literal.
9. **Disambiguation reply completion** — new `src/disambig.js` (park/read/remove at `state/pending-disambig/<our-msgid>.json`, 24h TTL lazy expiry). `handleDisambigReply` matches digit/name via `resolveDisambiguation`. Reply-To: `<TRAINNUM>@late.fyi` so user replies route through the worker (which still drops `noreply@`).
10. **Allowlist opened** — `ALLOWED_SENDERS=` empty on VPS + Worker. Public.
11. **Operator metrics** — `scripts/stats.sh` (daily 00:05 UTC) + `scripts/stats-email.sh` (weekly Mondays 00:07 UTC, 4-row digest of last 4 ISO weeks, DKIM-signed via VPS postfix to `avoidaccess@gmail.com`). Cron at `/etc/cron.d/latefyi-stats`. First run done; first digest delivered.
12. **Forgiving parser** — colons + commas optional. Bare ISO/named-month dates auto-prefixed with `on ` and re-extracted (two-pass).

## Operator infra references

- **VPS:** `155.94.144.191` (RackNerd, AlmaLinux 8, co-tenant with addypin.com)
- **Workers:** `latefyi-ingest` (Email, no HTTP route) + `latefyi` (Pages, custom domain `late.fyi`)
- **DNS records on `late.fyi`:** A `ingest.late.fyi` → VPS, MX → CF email routes, TXT SPF + Google verification + DKIM (`latefyi2026._domainkey`) + DMARC (`_dmarc`), CNAME apex → Pages worker, plus catch-all and feedback@ Email Routing rules
- **Pass paths:** `latefyi/{cloudflare_api, ingest_token, ingest_url, allowed_senders, ssh/{host,user,private_key}, dkim/{selector,private_key,dns_record_value}}`
- **CF API token scope:** Workers Scripts: Edit only. **DNS / Email Routing edits are dashboard-only** by design.

## Current open question (in-flight)

User reported: sending `from amsterdam to paris nord 2026-05-06` (bare date, no `on` keyword) to `EUR9316@late.fyi` returned "today or tomorrow" copy. Root cause was the bare date being swallowed into `to:`. Fixed in `c7eb7a7`. Awaiting user re-test:

- If still "no train found": HAFAS doesn't have EUR 9316 for 2026-05-06 — try a closer date or known-good train (e.g. ICE 145 Amsterdam → Berlin) to confirm pipeline works
- If tracking confirmation: feature is live end-to-end

## Outstanding (Phase 7 tail, not blocking)

- 30-day soak (passive)
- ntfy fail-streak → email fallback promotion (counter persists; promotion logic stubbed)

## Conventions / non-obvious

- File-based state: `state/{users, pending, active, pending-disambig}/`. **No `done/` or `errors/`** — terminal is delete.
- Reply-To: `<TRAINNUM>@late.fyi` on outbound so user's "Reply" routes through the worker (which drops `noreply@` defensively).
- Parser: keyword-based forgiving (`from`/`to`/`on`/`trip`/`channels` with or without `:`/`,`); two-pass injects `on ` before bare dates.
- `incrementTrainCount` bumps on schedule, not terminal — counts trains-attempted, not trips-completed.
- All API token operations: prefer direct CF API (curl + jq) over `wrangler` because wrangler needs additional scopes we don't grant.

## How to resume

1. Read `CLAUDE.md` for the orientation
2. `git log --oneline -10` to see recent commits in context
3. `npm test` should report 240/240
4. If user pings about EUR9316 / Eurostar: explain HAFAS schedule horizon; suggest swap with ICE 145 to verify pipeline
