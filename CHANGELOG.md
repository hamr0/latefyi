# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/).

This project tracks two streams in lockstep:
- **PRD versions** (`docs/01-product/latefyi-prd.md`) — spec evolution.
- **Implementation versions** (`package.json`) — code shipping.

---

## [Unreleased]

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
