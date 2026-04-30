# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/).

This project tracks two streams in lockstep:
- **PRD versions** (`docs/01-product/latefyi-prd.md`) — spec evolution.
- **Implementation versions** (`package.json`) — code shipping.

---

## [Unreleased]

### Forgiving subject parser
- Colons and commas are now optional. The parser splits on keyword boundaries (`from` / `to` / `on` / `trip` / `channels`) and captures values lazily up to the next keyword, comma, or end of line. All of these work:
  - `From: Amsterdam, To: Berlin Ostbahnhof` (classic)
  - `from amsterdam to berlin ostbahnhof` (bare)
  - `from amsterdam to paris nord on 2026-05-06` (all bare, with date)
  - `From: Amsterdam to Berlin On: 2026-05-04` (mixed)
- 3 new tests; 237/237 pass.

### Operator metrics — daily snapshot + weekly digest
- `scripts/stats.sh` — daily cron job (00:05 UTC) appends one JSON line to `state/stats/daily.jsonl` with absolute counters: `users_total`, `trips_total`, `active_users`, `active_trips`, `events_total`. Idempotent (skips if today's row already written). Computed from existing state — no new retention. Privacy-safe: no per-user / per-trip detail.
- `scripts/stats-email.sh` — weekly cron (Mondays 00:07 UTC). Picks the latest snapshot from each of the last 4 ISO weeks (4 rows, not 30 daily) and emails a plain-text digest via the VPS postfix (DKIM-signed). Recipient via `LATEFYI_STATS_TO` (default `avoidaccess@gmail.com`).
- Cron entries land at `/etc/cron.d/latefyi-stats`. First snapshot recorded on production VPS; first weekly digest sent and confirmed delivered to Gmail.

### Implementation: 0.8.0 — privacy retention zero + disambiguation completion + open allowlist

**Privacy: delete on terminal (no retention).**
The `done/` archive is gone. When a trip ends — arrival, STOP, cancellation, tracking-lost — the record is `unlinkSync()`'d from `state/active/` with no copy left behind. `errors/` is also gone; malformed records are logged once and deleted (we couldn't extract a sender from them anyway). The `scrubSender()` helper is removed as dead code; `state/active/<msgid>.json` keeps plaintext sender only during active tracking, and that's the entire window the address is held. Operator-level metrics (total users, total trips) derive from `state/users/<hash>.json` counters and `logs/push.jsonl` (senderHash-keyed). Privacy claim is now literally true: **address and record are both deleted at trip end.**

**Disambiguation reply completion.**
When resolve returns `disambiguation_needed`, `server.js` now parks the partial parsed state at `state/pending-disambig/<our-msgid>.json` (24h TTL, lazy expiry). When the user replies — body is just a digit (`1`) or a station name — the parser returns `kind: 'reply'` and `handleDisambigReply` looks up by `In-Reply-To`, applies the answer via `resolveDisambiguation`, and resolves fresh. Out-of-range digits re-send the numbered list. Replies with unknown In-Reply-To are silently dropped.

**Reply-To threading.**
Outbound replies from `noreply@late.fyi` now carry `Reply-To: <TRAINNUM>@late.fyi` so the user's "Reply" routes back through the worker (which still drops `noreply@` defensively). Without this, replies to confirmation/disambig emails would never reach ingest.

**Parser fix.**
`parse.js` now treats any inbound with `In-Reply-To` and no recognized headers as `kind: 'reply'`, regardless of local-part. Previously a valid-trainnum local-part would short-circuit to fresh-track even on a reply to disambig.

**Allowlist opened.**
`ALLOWED_SENDERS=` (empty) on both VPS and Worker. Anyone can email `<TRAINNUM>@late.fyi`, subject to the rate/active limits (10/hr, 50/day, 20 active per sender) shipped earlier in this release.

234/234 tests pass.

### `missingContextReply` documents all subject options
- The "I don't know what you need" reply now surfaces the full subject grammar in a structured layout: pickup vs boarding modes, plus optional `On:`, `Trip:`, `Channels:` with a combined example. Previously only `From:` / `To:` were mentioned. This is the canonical teaching reply — when a sender is confused, they see the whole UX, not just half.

### Feedback channel + reply-footer redesign + worker hardening
- `feedback@late.fyi` is now forwarded to the operator's inbox via a Cloudflare Email Routing custom rule (verified destination + literal-match rule, ordered before the catch-all so it never reaches the Worker).
- `worker/index.js` now declares `NON_TRACKING_LOCALPARTS` (`feedback`, `postmaster`, `abuse`, `admin`, `hostmaster`, `webmaster`, `security`, `noreply`, `no-reply`, `mailer-daemon`) and silently drops mail to those before any allowlist check or ingest forward. Defense-in-depth: if a CF routing rule is missing or misordered, we don't reply with a "not a valid train number" error to legitimate non-tracking mail.
- Reply `FOOTER` slimmed to identity + feedback + privacy claim:
  ```
  — late.fyi
  feedback@late.fyi | we don't store your email past notifications or STOP
  ```
  Format help (subject syntax, optional headers, STOP variants) lives in `missingContextReply` where it actually teaches a confused user. Confirmation/update emails no longer carry instructions for users who already used the system correctly.
- Landing page (`web/index.html`) — added "Travelling later?" section showing the `On: <date>` form, plus `feedback@late.fyi` mailto link in the footer.
- Tests adjusted; 233/233 still pass.

### Phase 7: deliverability + abuse limits + advance planning
- **Deliverability** — SPF (added VPS IP `155.94.144.191`), DKIM (selector `latefyi2026`, opendkim signing-table entry, public key TXT at `latefyi2026._domainkey.late.fyi`), DMARC (`_dmarc.late.fyi`, `p=none` monitoring). Verified via direct send to Gmail: SPF=PASS, DKIM=PASS, DMARC=PASS.
- **Abuse limits** — `users.js` `checkRateLimit()` + `recordRequest()` (pure, with bounded 24h timestamp array per user), wired into `server.js handleTrack`. Defaults: 10 fresh requests/hour, 50/day, 20 active trains/sender. Two new reply templates: `rateLimitedReply` (with retry time), `tooManyActiveReply` (suggests STOP). Failed resolves don't count against the budget.
- **`On: <date>` advance planning** — `parseOnDate()` accepts ISO `2026-05-04`, `5 May 2026`, `5-May-2026`, `05-May-26` (rejects ambiguous `05/04/26`). Validation: must be today or future, max 90 days ahead. Threaded through resolve as a `when: Date` option to HAFAS departures/arrivals. Records sit in `state/pending/` until T-30 (existing wake-up mechanism, no new infra).
- 13 new tests; 233/233 pass.

### Privacy: scrub plaintext sender on terminal (no retention)
- New `scrubSender(rec)` in `src/users.js`: replaces `rec.sender` with `rec.senderHash`. Pure / no I/O.
- `src/server.js` `moveToDone()` now reads → scrubs → atomic-writes to `done/` → unlinks `active/`. Used by all STOP scopes (single / TRIP / ALL).
- `src/poll-runner.js` terminal-move path scrubs the same way. Also: `push.jsonl` event log now records `senderHash` instead of plaintext sender — long-lived log, no plaintext accumulation.
- Privacy claim updated on the landing page: "the moment the trip ends — arrival, STOP, or cancellation — your address is deleted." That's now literal.
- 5 new tests (3 in users.test.js for the helper, 1 in server.test.js for STOP scrub, 2 in poll-runner.test.js for terminal scrub + push.jsonl). 209/209 pass.

### Web: landing page (departure-board)
- `web/index.html` — single-file static landing for `late.fyi`. Departure-board aesthetic (amber on near-black), no JS, no external deps. Sample board with on-time/delayed/cancelled rows. "What we don't do" section states the privacy contract.
- Three variations were prototyped (minimal / email-mock / departure-board); v3 picked.
- Deploy plan: Cloudflare Pages connected to the GitHub repo, `web/` as build output, custom apex `late.fyi`.

### Implementation: 0.6.0 — Phase 6 (ntfy opt-in, partial)
- `src/ntfy-transport.js` — real ntfy POST adapter. `createNtfyTransport({ baseUrl, fetch? })` returns `{ sendNtfy({ topic, title, message, priority?, tags? }) }` matching the payload shape `push.js` already builds. Title/Priority/Tags map to ntfy headers. Throws on non-2xx. 7 new tests (POST URL composition, header serialization, error mapping, missing-fetch guard, missing-topic guard, default base URL).
- `src/poll-runner.js` CLI — composes SMTP + ntfy transports and wires `getUserChannel` from `users.js`. Now actually delivers events instead of only logging to `push.jsonl`.
- `src/reply.js` — `ntfyOptInReply` reworked. Removed the QR-code stub (proportional-font mail clients render ASCII QR poorly, and the QR helps only in laptop-opt-in cases). Replaced with `ntfy://subscribe/<topic>` deep link (one-tap subscribe on phones with the ntfy app installed) plus the plain `https://ntfy.sh/<topic>` URL as fallback. Setup steps streamlined.
- 1 new test added in `tests/reply.test.js` covering deep-link presence.
- 204/204 tests pass.
- **Deferred to Phase 7**: ntfy fail-streak → email fallback promotion (counter is already persisted across polls; the promotion + one-time notice will land alongside abuse limits).

### Live: first real-world tracking request (2026-04-29)
- Confirmed end-to-end with a real email from an Outlook inbox: `To: ICE145@late.fyi`, `Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof`. Cloudflare Email Routing → Worker → VPS ingest → resolve (ÖBB HAFAS) → schedule → confirmation reply delivered to sender within seconds. Reply correctly threaded, scheduled departure/arrival times rendered, T-30 wake time shown, footer rendered.
- Catch-all `*@late.fyi` switched from Drop → Worker via dashboard (the API token used for Worker upload didn't include `Email Routing Rules: Edit`, by design — least-privilege).
- PRD bumped to **1.4.0** (out of draft).

### Deployed to production (2026-04-29)
- First production deployment at `late.fyi`. RackNerd VPS (AlmaLinux 8.10) at `155.94.144.191` already running `addypin.com` — latefyi added alongside without disturbing the existing site.
- Provisioned: dedicated `latefyi` system user, `/opt/latefyi` clone, `npm install --omit=dev`, `/etc/latefyi.env` with INGEST_TOKEN/ALLOWED_SENDERS/SMTP creds, two systemd units (`latefyi-ingest`, `latefyi-poller`) with hardening (NoNewPrivileges, ProtectSystem=strict, ReadWritePaths, ProtectHome, PrivateTmp), cron for `wake.sh`.
- nginx vhost `ingest.late.fyi` co-located with addypin's vhost. TLS via certbot webroot mode (matches addypin's convention). HTTP→HTTPS redirect, ACME path open for renewals, per-IP connection limit, 1MB body cap matching `ingest-server.js`.
- DNS in Cloudflare: A record `ingest.late.fyi` → VPS IP (DNS only, gray cloud). Email Routing enabled.
- Worker `latefyi-ingest` deployed via direct CF API (bypassing `wrangler` and its required Account → User Details: Read scope). Three secrets set: ALLOWED_SENDERS, LATEFYI_INGEST_URL, LATEFYI_INGEST_TOKEN.
- Email Routing catch-all switched from Drop → Worker.
- VPS-side end-to-end test passed: synthetic POST to `/ingest` produced a pending record + confirmation reply delivered to Outlook (`status=sent ... 250 2.6.0 Queued mail for delivery`).
- **Outbound deliverability todo (Phase 7):** SPF needs the VPS IP added; DKIM signing for `noreply@late.fyi` (opendkim already on the box for addypin, just needs a signing-table entry); PTR; same-domain enforcement on receiver junk filters.

### Code: localhost-only ingest bind (2026-04-29)
- `src/ingest-server.js` now binds to `127.0.0.1` by default; override via `INGEST_HOST=0.0.0.0`. Reverse proxy is always co-located, so binding to all interfaces just widened the attack surface for nothing. firewalld already blocked external access on the deployed VPS, but defense-in-depth: localhost-only from the start. 196/196 tests still pass.

### Docs (2026-04-29)
- New: `docs/cloudflare-setup.md` — complete deployment runbook with the 16 actual steps used for late.fyi (DNS → bootstrap → env → systemd → cron → nginx HTTP → certbot → nginx HTTPS → smoke test → CF token → Worker upload → secrets → catch-all rule → real test → outbound hardening notes → recovery table).
- README rewritten to be **user-facing**: how to send the email, optional headers (Trip:, Channels:), STOP variants, what gets pushed (the four windows), coverage, limitations. Developer info moved out into links to PRD / CHANGELOG / cloudflare-setup.
- PRD §21 expanded into the canonical reference for the deployment runbook (kept synchronized with `docs/cloudflare-setup.md`).

### Docs: deployment runbook (2026-04-29)
- PRD §21 expanded into a complete VPS-existing-runbook: where each component lives, systemd unit files for `latefyi-ingest` + `latefyi-poller`, Caddy reverse-proxy block, env-file template, DNS A record + cron + Worker secrets — top-to-bottom-copy-pasteable.
- README architecture diagram redrawn to show the Cloudflare ↔ VPS split clearly. Added "Deploy to your own VPS" 8-step summary linking out to PRD §21.
- Why two pieces explicitly addressed: Workers can't run the polling loop or hold state. Could move to Workers + KV + DOs + Cron Triggers but it'd need a paid plan and rewrite Phases 2–3. Bare-suite VPS path is the deliberate choice (PRD §22 decisions 5, 13).

### Implementation: 0.5.0 — Phase 5 (2026-04-29)
- `worker/index.js` — Cloudflare Email Worker. Allowlist enforcement at the edge (silent drop, no backscatter), then forwards a JSON payload (subject + body + headers + msgid) to the VPS ingest server with a Bearer token. Stateless. ~50 LOC.
- `worker/wrangler.toml` — minimal Worker config; `account_id` to fill in at deploy.
- `worker/README.md` — deployment runbook (wrangler login → secrets → deploy → wire Email Routing).
- `src/ingest-server.js` — Node HTTP server. `GET /health` (unauthenticated liveness probe) and `POST /ingest` (Bearer-token-authed). Calls `handleInbound` and dispatches the reply through an injected transport. Caps payloads at 1 MB. CLI entry wires real hafas-clients + SMTP transport from environment. 13 new tests covering auth, allowlist, transport-failure tolerance, payload limits, malformed JSON.
- `src/smtp-transport.js` — `nodemailer`-based adapter exposing the `{ sendEmail, sendNtfy }` interface push.js expects. Threading headers preserved (In-Reply-To, References, Message-ID). `sendNtfy` throws — Phase 6 wires that.
- `nodemailer` added as a dependency. AGENT_RULES external-dep checklist passes (security-critical SMTP, established, lightweight). Not loaded by tests; only by the production CLI entry.
- PRD §14 secret names updated from `TRAINME_INGEST_*` to `LATEFYI_INGEST_*` to match deployed worker.
- 13 new tests; **196/196 passing total.**

### Implementation: 0.4.0 — Phase 4 (2026-04-29)
- `src/reply.js` — pure templating. Single FOOTER constant (PRD §7) appended to every reply. Functions for confirmation (channel-aware), missing-context, train-not-found, station-not-on-route (with route + suggestion), ambiguous-station (numbered list per §7a), train-already-passed, unauthorized-sender, STOP/STOP TRIP/STOP ALL confirmations, ntfy opt-in (URL + setup), threaded push reply for tracked-train events, generic error.
- `src/push.js` — notification dispatcher. Channel-preference routing (email / ntfy / both). Critical-event override per §6 (cancellation, terminating-short, etc. always go to all channels). ntfy payload mapping (priority + tags + topic from sender hash). Rolling failure-streak counter for §6 ntfy fallback. Transport injected (sendEmail / sendNtfy).
- `src/server.js` — inbound-email orchestrator: parse → route by kind → resolve+schedule+confirm | stop | config | help | error reply. Allowlist enforcement at the edge (silent drop, no backscatter). Generates outbound Message-IDs and stores them on the pending record so subsequent updates thread correctly.
- `src/schedule.js` extended with optional `confirmationMsgid` field on the record (so the poller threads update emails into the original confirmation conversation).
- `src/poll-runner.js` extended with optional `transport` + `getUserChannel` parameters: when provided, events are dispatched via push.dispatch in addition to the audit log. When absent, falls back to log-only behavior (preserves prior tests).
- `src/resolve.js` errors now carry `field` and `userText` for cleaner downstream reply construction.
- 48 new tests (reply 25, push 12, server 11). **183/183 passing total.**

### Implementation: 0.3.0 — Phase 3 (2026-04-29)
- `src/diff.js` — pure `(prev, curr) → PushEvent[]` implementing PRD §9 + the unified taxonomy. Mode-aware anchor (dep for B, arr for A). 22 tests covering all event types and suppression boundaries.
- `src/poll.js` — single-train poll cycle: builds `TrainState` from a hafas-client trip, runs `diff`, returns updated record. Exports `computePhase`, `pollIntervalMs`, `shouldPollNow`, `isTerminal` for the runner. Handles 6-consecutive-failure tracking-lost semantics. 19 tests.
- `src/poll-runner.js` — daemon driver. `tick()` (one-pass, testable) + `run()` (loop forever) + CLI entry. Reads `state/active/*.json`, polls each at the right cadence, atomic-writes back, appends events to `logs/push.jsonl`, moves terminal records to `state/done/`. Malformed JSON → `state/errors/`. Dependency-injected client. 8 tests.
- `tests/integration-pipeline.test.js` extended: end-to-end email → parse → resolve → schedule → activate → **tick** → push.jsonl, all in one test. The full Phase 1+2+3 chain now closes.
- 51 new tests; **135/135 passing total**.

### PRD 1.3.0-draft
- **§5 Modes** — Mode A event coverage clarified to match Mode B (platform changes, terminating short, rerouting now apply to pickup mode too, anchored on the arrival station).
- **§9 Diff table** — added a "Modes" column making per-mode applicability explicit. Replaced ambiguous "platform" with anchor-aware language.
- **§9 Notification taxonomy** — new subsection introducing four canonical windows (tracking start / pre-anchor / in-transit-or-approach / tracking end) consolidating what gets pushed and when. Same windows apply to both modes.
- Status note bumped to "Phases 1 & 2 implemented and validated live against ICE 145."

### Implementation
- Live overnight tracking POC against ICE 145 Amsterdam → Berlin, departed on time at 10:00 CEST 2026-04-29 from platform 8b. 0 poll errors over 135 polls.
- 83/83 tests passing across all phases.

---

## 0.2.0 — Phase 2 (2026-04-29)

### Added
- `src/users.js` — per-user record CRUD at `state/users/<sender_hash>.json`. Deterministic `sha256(email)[:16]` → ntfy topic. Tracks first-time ntfy opt-in for triggering the §7 QR reply only once.
- `src/schedule.js` — writes `state/pending/<msgid>.json` per PRD §12 with computed `poll_start_time` (T-30 default, T-45 for large terminals) and `poll_end_time` (scheduled arrival + grace). Atomic writes via tmp+rename, idempotent on msgid.
- `scripts/wake.sh` — cron-driven activator. Promotes due files from `pending/` → `active/`, prunes `done/` older than 30 days, ensures the (Phase 3) poll-runner stays alive. Survives malformed JSON.
- `tests/integration-pipeline.test.js` — proves parse → resolve → schedule → activate composes end-to-end with correct T-30 timestamps.
- 25 new tests (users 11, schedule 12, wake.sh 2, pipeline 1). Total: **83/83 passing**.

---

## 0.1.0 — Phase 1 (2026-04-29)

### Added
- `src/parse.js` — pure email parser. Returns a discriminated union: `track` | `stop` | `config` | `reply` | `help` | `error`. Implements §4 grammar (Trip tag, case-insensitive headers, reserved local-parts, no auto-pick on missing context) and §13.1 logic.
- `src/stations.js` — fuzzy station matcher. Two-layer disambiguation per §7a: auto-resolve when route narrows to one match, numbered reply otherwise. Levenshtein + alias table + token-level matching for typos on multi-word stops. Forgiving disambiguation reply parser (digit OR fuzzy name).
- `src/resolve.js` — train resolver. ÖBB primary + PKP fallback per §13.2. Anchors at `From:` (Mode B) or `To:` (Mode A), searches departures/arrivals, matches by `fahrtNr` or trailing digits of `line.name`, fetches full trip, validates against route. Returns `resolved` | `disambiguation_needed` | `error`.
- `config/aliases.json` — seed alias table for common ambiguous European station names (Paris, Brussels, Lille, Munich, etc.).
- 58 behavior tests using `node:test` (parse 27, stations 20, resolve 11). Dependency-injected fake hafas-client per Testing Standards — no monkey-patching.

---

## PRD 1.2.0-draft (2026-04-28)

### Added
- **§4 grammar** — `Trip:` optional header (alphanumeric + `-`/`_`, ≤32 chars, case-insensitive). Hard rule: bare emails always trigger §7 missing-context reply, never auto-pick `From:`/`To:` from train route.
- **§7 standard footer** — single canonical footer block referenced as `[FOOTER]` in all reply templates. Compact format/STOP variants reminder. Implementation note: one constant in `reply.js`.
- **§7 STOP variants table** — `STOP`, `STOP <TRAINNUM>`, `STOP TRIP <name>`, `STOP ALL` with confirmation templates.
- **§13.1 parse.js** — restructured to return discriminated-union output. Added reserved local-parts (`config`, `stop`, `help`), explicit STOP variant parsing, `Trip:` validation.
- **§18 edge cases** — `STOP TRIP` empty-trip handling.
- **§22 decisions** — rows 26 (one train per email, no multi-leg parsing), 27 (always require From/To), 28 (standard footer rationale).

---

## PRD 1.1.0-draft (2026-04-28)

### Added (POC findings driven)
- **§7 ambiguous-station reply** — numbered format, accepts name or number.
- **§7a (new)** — full disambiguation flow: auto-resolve from route context, numbered reply only when truly ambiguous, forgiving parser (digit or fuzzy name), `In-Reply-To` correlation, 24h or T-poll-start-minus-5 timeout, 3-retry cap.
- **§22 decisions** — rows 24 (single primary endpoint with PKP fallback) and 25 (two-layer station disambiguation).

### Changed (POC findings driven)
- **§8 endpoint strategy** — rewritten end-to-end. POC verified that of the seven national HAFAS profiles the original spec relied on, only ÖBB is alive. Replaced the per-country endpoint table with `primary: oebb, fallback: pkp`. Added "POC findings" subsection documenting the verification, "durability risk" subsection acknowledging single-vendor data dependency.
- **§10 state machine** — added `AWAITING_DISAMBIGUATION` node and timeout transition.
- **§13.2 resolve.js** — rewritten to drop operator routing; resolves via station-departures search on ÖBB then PKP.

### Validated by POC
- ÖBB returns live data for stations across NL/DE/FR/AT/IT/BE/CH/UK/LU. Every product family the system needs (TER/IC/EUR/TGV/ICE/RJ/NJ/regional/suburban) surfaces with line name, fahrtNr, product, direction, planned/actual times, and platforms.
- PKP confirmed as a working fallback with comparable cross-border coverage.

---

## PRD 1.0.0-draft (2026-04-20)

### Initial product spec
- Email-driven European train tracker. Email `<TRAIN>@<domain>` → real-time platform/delay/cancellation notifications.
- Two modes: A (pickup), B (boarding).
- Three notification channels: email (default, opt-out), ntfy (opt-in), both.
- Bare-suite architecture: Cloudflare Email Worker + Node.js process + cron + filesystem state.
- 25 sections covering grammar, replies, modes, polling, state machine, components, edge cases, security, deployment.
