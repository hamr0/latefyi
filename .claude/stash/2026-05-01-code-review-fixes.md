# Stash: Code Review Fixes + Doc Release
**Date:** 2026-05-01
**Branch:** main
**HEAD:** ea11e37

---

## Session Summary

Ran a full code review via `quality-assurance` agent, then fixed all findings and updated docs.

---

## What Was Done

### Subject inbox-grouping (0.11.0 / PRD 1.11.0) — already shipped before this session's fixes
- `[trip]` prefix + ISO date suffix on confirmation and push-reply subjects (conditional)
- README, CHANGELOG, PRD updated; `package.json` bumped to 0.11.0

### Code review findings fixed (0.12.0 / PRD 1.12.0)

| ID | File | Fix |
|----|------|-----|
| C-1 (critical) | `src/poll-runner.js:160` | `run()` now accepts and forwards `transport`/`getUserChannel` to `tick()` — push notifications were **never delivered in production** |
| I-1 | `src/server.js:238` | `CHANNELS email` reply uses `latefyi <config@late.fyi>` From: and appends FOOTER |
| I-2 | `src/server.js:194` | bare `STOP` to `stop@` (scope='this', target=null) now treated as STOP ALL, not "Stopped tracking null" |
| I-3 | `scripts/stats.sh:50` | ACTIVE_USERS counts `.senderHash` not `.sender` — no plaintext email in shell pipeline |
| I-5 | `src/ingest-server.js:131`, `src/poll-runner.js:188` | HAFAS user-agent unified to `latefyi/0.11.0` |
| m-4 | `scripts/wake.sh`, `src/schedule.js` | dead `done/` pruning and mkdir removed |
| m-5 | `tests/poll-runner.test.js:86` | inconclusive `assert.ok(len===1\|\|len===0)` → `assert.equal(len, 1)` |

New tests added: `run()` forwards transport (C-1 regression), bare STOP → STOP ALL (I-2), FOOTER+From: on CHANNELS email (I-1).

**Test count: 251/251**

---

## Current State

- `package.json`: `0.12.0`
- PRD: `1.12.0`
- All fixes committed and pushed to `origin/main`
- No open work items from the code review (remaining minors noted below)

---

## Deferred / Not Fixed This Session

Reviewer items intentionally left as backlog:

- **m-1**: `state/users/<hash>.json` contains plaintext `sender_email` field — functionally fine, privacy policy covers it, but could be removed if the claim needs to be tighter.
- **m-2**: `pushReply` generates no `Message-ID` of its own — push update emails can't be replied-to for threading. Acceptable for current use case.
- **m-3**: `stations.js` alias score order (alias before exact-match substring) — cosmetic/logic order issue, not a bug.
- **m-6**: `subjectTags` uses wall-clock `new Date()` — edge case at 23:59 UTC for near-midnight trips; low impact.
- **I-4**: disambiguation reply uses reply's msgid as pending key (not original request's) — affects audit log trace only, not correctness.

---

## Architecture Reminder

```
*@late.fyi → CF Email Worker (worker/index.js)
  → POST /ingest → src/ingest-server.js
  → src/server.js handleInbound
  → parse / resolve / schedule → state/pending/<msgid>.json
  → scripts/wake.sh cron → state/active/
  → src/poll-runner.js tick() [transport now wired correctly]
  → diff → src/push.js → SMTP (postfix)
  → state/active/<msgid>.json unlinkSync'd on terminal
```

Key invariant: plaintext sender lives only in `state/active/` during tracking. Terminal → `unlinkSync`, no archive.

---

## Outstanding Soak

30-day soak in progress (started ~2026-04-29). No action needed until soak completes.
