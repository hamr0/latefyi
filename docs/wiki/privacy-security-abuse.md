---
title: Privacy, Security and Abuse Controls
theme: privacy-security-abuse
sources:
  - docs/archive/latefyi-prd.md
---

# Privacy, Security and Abuse Controls

Sender allowlist and authentication, what is stored, and the storage schema that holds it.

## Sender allowlist and authentication

- **Sender allowlist**: when `ALLOWED_SENDERS` is set, only listed senders' emails are processed and everything else is dropped silently at the Worker. In production it is empty, which means open to anyone. (docs/archive/latefyi-prd.md:1319-1319)
- **Anti-spoofing (1.15.0)**: every per-user action trusts `From`, so a forged sender could STOP/delete another user's tracking. The Worker and `handleInbound` both drop mail whose `Authentication-Results` shows an explicit `dmarc=fail` (`src/auth-results.js`). (docs/archive/latefyi-prd.md:1320-1320)
  - Conservative policy: reject only on `dmarc=fail`. Absent header, `dmarc=none` or temperror pass through, so legitimate mail from no-DMARC domains isn't bounced. (docs/archive/latefyi-prd.md:1320-1320)
  - "Fail anywhere rejects", so a forged `dmarc=pass` can't override CF's real verdict. (docs/archive/latefyi-prd.md:1320-1320)
- **Published DMARC enforcement (1.17.0)**: `_dmarc.late.fyi` was raised from `p=none` to `p=quarantine` (explicit `sp=quarantine`). This protects `late.fyi` from being spoofed at receivers, which is distinct from the inbound `dmarc=fail` drop that protects per-user actions. (docs/archive/latefyi-prd.md:1321-1321)
  - Safe because outbound is fully aligned: SPF lists VPS `155.94.144.191`; DKIM selectors are `latefyi2026` (opendkim) and `cf2024-1` (CF Email Routing). (docs/archive/latefyi-prd.md:1321-1321)
  - Rollout: soak `rua` reports at `postmaster@late.fyi` for about 2 weeks, then `p=reject`. No `ruf=`, because forensic samples breach the privacy posture. DNS-only, dashboard-managed by least privilege. (docs/archive/latefyi-prd.md:1321-1321)
- **Security contact (1.17.0)**: `web/.well-known/security.txt` (RFC 9116) publishes `security@late.fyi`. It needs a CF Email Routing rule to deliver; the local-part is also in the Worker's `NON_TRACKING_LOCALPARTS` drop-list as defense in depth. (docs/archive/latefyi-prd.md:1322-1322)
- **Ingest auth**: Worker to VPS uses a bearer token over HTTPS, rotated by setting a new secret in Wrangler. (docs/archive/latefyi-prd.md:1323-1323)

## Abuse limits

- **Per-sender action limit (1.15.0)**: a broad ceiling of 60 inbound commands/hr/sender across all kinds (track/stop/list/config/reply), separate from the tighter track budget (10/hr, 50/day). Over the cap means a silent drop. This caps backscatter amplification and repeated state scans. (docs/archive/latefyi-prd.md:1325-1325)
- Pending/active files are keyed `<senderHash>-<msgid>.json`, so a crafted Message-ID can't overwrite another sender's record and lookups scope to the sender. (docs/archive/latefyi-prd.md:1325-1325)

## Data minimisation and telemetry

- **No PII beyond email + train number**: state files hold sender email and train metadata only. No location tracking, payment info or booking references. (docs/archive/latefyi-prd.md:1324-1324)
- **No telemetry, no analytics, no remote sinks.** All logs are local. (docs/archive/latefyi-prd.md:1327-1327)
- **Audit log** (`logs/audit.jsonl`): specified in the original PRD but not implemented; `logs/push.jsonl` (senderHash only) is the event log. (docs/archive/latefyi-prd.md:1328-1328)
- **Outbound traffic** is limited to HAFAS endpoints and outbound mail through the VPS's own postfix + opendkim; to be documented in the README for transparency. (docs/archive/latefyi-prd.md:1329-1329)
- **Token storage**: secrets live in environment variables, never in committed files; `.env` is in `.gitignore`. (docs/archive/latefyi-prd.md:1330-1330)

## Storage schema

### `pending/<msgid>.json` and `active/<msgid>.json`

A single JSON record per request holds: `msgid`, `received_at`, `sender`, `request` (`trainNum`, `mode`, `from`, `to`), `resolved` (`endpoint`, `trainId`, `scheduledDeparture`, `scheduledArrivalAtTo`, `route`), `schedule` (`poll_start_time`, `poll_end_time`), `state` (`phase`, `lastPolledAt`, `lastPushedSnapshot`, `consecutivePollFailures`, `endpointInUse`) and `pushes`. A new record starts at `phase: "PRE_DEPARTURE"` with no polls and an empty `pushes` list. (docs/archive/latefyi-prd.md:863-897)

### No `done/` archive

On a terminal event (arrival, STOP, cancellation, tracking-lost) the `active/<msgid>.json` record is deleted with `unlinkSync()`; nothing is copied or retained. Plaintext sender exists only in `active/` during tracking.

### `state/users/<sender_hash>.json` (per-user, lifetime)

- One file per allowlisted sender, created lazily on first email. The hash is `sha256(sender_email)[:16]`. (docs/archive/latefyi-prd.md:903-905)
- Fields: `sender_hash`, `sender_email`, `first_seen_at`, `last_seen_at`, `trains_tracked_count`, `trains_completed_count`, plus the rate-limit windows. Records written before 0.19.0 may still carry `channel`, `ntfy_topic` and `ntfy_opt_in_sent_at` (ntfy was removed in 0.19.0); they are ignored and never rewritten. (docs/archive/latefyi-prd.md:907-919)
- `trains_tracked_count` counts trips ever scheduled (bumped on each track request). `trains_completed_count` counts trips that ran to a terminal end (arrival / STOP / cancellation / tracking-lost), bumped by the poll-runner at both delete sites as the active record is unlinked. The pair feeds the weekly digest's growth metrics; see §21 Observability. (docs/archive/latefyi-prd.md:921-921)

### Why files, not a database

- Bare-suite aesthetic: zero deps, debuggable with `cat` and `ls`. (docs/archive/latefyi-prd.md:934-934)
- Modest scale: a handful of users, dozens of concurrent active trains at most. (docs/archive/latefyi-prd.md:935-935)
- Crash-safe: filesystem rename is atomic. (docs/archive/latefyi-prd.md:936-936)
- Backup: `tar czf backup.tgz state/`. (docs/archive/latefyi-prd.md:937-937)
- Per-user files separate cleanly from per-train files, with independent lifetimes and storage. (docs/archive/latefyi-prd.md:938-938)
