# Stash — STOP UX overhaul + routable From: + ntfy defer

**Date:** 2026-05-01
**Last commit:** `af8c673` (subject [trip] prefix + ISO date suffix)
**Tests:** 249/249
**Version:** 0.10.0 in package.json, PRD 1.10.0
**Deployed:** VPS pulled to `fc605d2`, both `latefyi-ingest` + `latefyi-poller` `active`. CF Pages auto-deploys from main.

## What shipped this session

In commit order:

1. **Defer ntfy** (`4a864e5`) — strip ntfy/CHANNELS from `confirmationReply` + `missingContextReply`; `config@` short-circuits `CHANNELS ntfy|both` with a "paused" reply. PRD 1.8.1 → 1.9.0 with deferred banner. Code paths intact for re-enable.
2. **Force email at dispatch site** (`da0129f`) — `poll-runner.js` overrides `userChannel='email'` so existing records with `channel:'ntfy'` don't fall into a silent void. One-line revert when un-paused.
3. **Mailto stop links** (`6616782`) — `stopLinks()` helper builds `mailto:stop@late.fyi?subject=STOP%20<TRAIN>&body=STOP%20<TRAIN>` (subject AND body for client compat — Outlook.com web silently drops `?subject=`). Embedded in `confirmationReply` + `pushReply`. Trip-tagged trains get a second link.
4. **PRD + README + landing page reflect mailto UX** (`33f18ce`).
5. **Fix mailto body= for Outlook.com** (`774578a`).
6. **Re-add temp inbound trace log** (`684cce9`) — used to diagnose, removed later.
7. **Real bug: `tryParseStop` multi-line regex** (`da9de27`). Regex `/^STOP\b\s*(.*)$/i` failed on any input with a newline (subject + body folded together). Symptom: `STOP EUR9316` with a `-- Ciao` signature returned `stop_unrecognized`. Fix: parse first non-empty line only.
8. **Re-enable reply-STOP as silent fallback** (`e3e0ed6`) — `tryParseStop(headerSrc) || tryParseStop(firstNonEmptyLine(body))`. Mailto remains the only advertised path; reply works for top-posted STOP / STOP <TRAIN> / STOP TRIP / STOP ALL.
9. **Per-inbound trace logger** (`101d6ec`) — temporary debug, captured the From: noreply problem.
10. **Routable From: + display name** (`24d44c0`) — **the actual root cause of "reply STOP doesn't work"**: outbound From: was `noreply@late.fyi`, Cloudflare worker drops `noreply` via `NON_TRACKING_LOCALPARTS`, replies disappeared with no log on our side. Fix: `latefyi <<routable-local>@late.fyi>` per template — train numbers, `stop@`, `config@`, `help@`. Reply-To kept as belt-and-suspenders. Confirmation now shows `Departure platform: TBC / Arrival platform: TBC / Status: TBC` to set expectations.
11. **SMTP transport respects per-message From** (`f5284fb`) — transport was force-overriding `msg.from` with the configured default, which made step 10 invisible. Flip precedence so `msg.from` wins.
12. **Docs 1.10.0** (`909dcdc`) — CHANGELOG, PRD, README updated.
13. **Landing page format** (`eeb08c5`) — `web/index.html` reply example matches real email format.
14. **Pluralize STOP ALL** (`fc605d2`) — `1 active train` not `1 active trains`.
15. **Subject inbox-grouping** (`af8c673`) — `Tracking ICE 1255 [austria] — Amsterdam → Stuttgart — 2026-05-06`. Trip in brackets before route (only if set); ISO date after route (only if not today/tomorrow). Helper `subjectTags({ trip, scheduledIso })` returns `{ prefix, suffix }`. Same convention threads through `pushReply` via `poll-runner` → `push.dispatch` → `pushReply` (added `trip`, `scheduledIso` params).

## Verified by user (Gmail + Thunderbird, msn.com + gmail.com)

- ✅ Mailto link (one-click stop)
- ✅ Reply `STOP` to confirmation (single train via local-part)
- ✅ Reply `STOP ALL`
- ✅ Reply `STOP TRIP <name>`

## Operator-side cleanups done

- Both user records (`12b31ace79d0e69f.json`, `e6a52079606e9287.json`) migrated `channel: 'ntfy' → 'email'`.
- `state/active/deploy-smoke-1@example.com.json` deleted.
- `/tmp/latefyi-vps-key` shredded after each session.

## Conventions / non-obvious

- **From: per template, never noreply@.** `confirmationReply`/`pushReply` use `<TRAINNUM>@`; `stopReply` and `tooManyActiveReply` use `stop@`; `ntfyOptInReply` and config replies use `config@`; `missingContext`/`trainNotFound`/`rateLimited`/`unauthorized` use `help@`. Display name is always `latefyi`.
- **`smtp-transport.js`: `msg.from || fromAddress`** — per-message wins. Don't flip back.
- **`tryParseStop` operates on first non-empty line only.** Don't restore the multi-line regex.
- **Reply-STOP is a silent fallback, never advertised.** Mailto is the canonical UX in PRD §7 and all copy.
- **Platform/Status default to "TBC".** Real values come from polling at T-30 (`diff.js` events fire `platform_assigned`, `delay_change`, etc.).
- **Worker `NON_TRACKING_LOCALPARTS`** (in worker, not VPS): drops `noreply`/`postmaster`/`abuse`/`admin`/`no-reply`/`feedback`/etc. before forwarding. Anything that's a routable target for replies must NOT be in this list.

## Outstanding (not blocking)

- 30-day soak (passive).
- ntfy push notifications: paused. Un-pause path documented in PRD deferred banner — needs hosted PWA or first-party web push to fix the `ntfy://` deep-link onboarding friction.
- §6 (Notification Channels) section in PRD still describes ntfy in detail behind the deferred banner — left intact for clean re-enable.

## How to resume

1. Read `CLAUDE.md` for orientation.
2. `git log --oneline -15` to see this session's arc.
3. `npm test` should report 246/246.
4. SSH key staging: `pass latefyi/ssh/private_key | sed -n '2p' | sed 's/^username: //'` → reconstruct PEM with `-----BEGIN/END OPENSSH PRIVATE KEY-----`. Service control: `systemctl restart latefyi-ingest latefyi-poller`. Health: `curl -sS https://ingest.late.fyi/health`. Inbound trace can be re-added at `src/server.js:270` if a new mystery surfaces.
