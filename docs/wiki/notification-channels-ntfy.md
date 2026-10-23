---
title: Notification channels and ntfy
theme: notification-channels-ntfy
sources:
  - docs/archive/latefyi-prd.md
---

# Notification channels and ntfy

Delivery channels: email as default, the paused ntfy opt-in, channel selection and fallback, ntfy setup.

## Current status: ntfy is paused

- As of v1.9.0, ntfy is paused in user-facing copy. The effective channel is `email` for all users. (docs/archive/latefyi-prd.md:190-190)
- `CHANNELS ntfy` / `both` requests are still accepted at `config@late.fyi`, but get a "paused" notice reply. (docs/archive/latefyi-prd.md:190-190)
- The rest of this page describes the designed-and-implemented behavior, retained for the re-enable. (docs/archive/latefyi-prd.md:190-190)

## Three lifetimes

Channels are configurable per user (lifetime preference) or per request (one-shot override). (docs/archive/latefyi-prd.md:192-192)

| Layer | Lifetime | Stored as |
|---|---|---|
| Per user | Forever, until the user changes it | `state/users/<sender_hash>.json`: channel preference, ntfy topic, allowlist entry |
| Per train | One trip (T-30 to arrival + grace) | `state/active/<msgid>.json`: poll schedule, diff history, push log |
| Per change | One delivery | one ntfy POST and/or one email send |

(docs/archive/latefyi-prd.md:196-202)

- Tracking two trains in tandem needs no extra setup: the per-user layer is set-and-forget (one topic, one channel preference). (docs/archive/latefyi-prd.md:204-204)
- The per-train layer is created by each tracking email and torn down on arrival, independent of other trains. (docs/archive/latefyi-prd.md:204-204)
- Updates from multiple trains converge only at the per-change layer and stream out through the user's single channel as discrete messages. (docs/archive/latefyi-prd.md:204-204)

## Channels

### `email` (default for all new users)

- Sent through the VPS's own postfix + opendkim (SMTP), from a routable per-template local-part (`<TRAINNUM>@`, `stop@`, `config@`, `help@`), not `noreply@`. (docs/archive/latefyi-prd.md:208-208)
- Subject is a short status (e.g. "RE19750 → Platform 7"); body has full detail: current platform, delay, scheduled times, route summary, last-update timestamp. (docs/archive/latefyi-prd.md:209-210)
- Threaded: all updates for one tracked train share the `In-Reply-To` of the original confirmation reply, so mail clients group them into one conversation. (docs/archive/latefyi-prd.md:211-211)
- Default because it needs zero setup. (docs/archive/latefyi-prd.md:212-212)

### `ntfy` (opt-in upgrade)

- POST to `https://ntfy.sh/<TOPIC>` or a self-hosted ntfy server. (docs/archive/latefyi-prd.md:216-216)
- One derived topic per user: `latefyi-<sha256(sender_email)[:16]>`, deterministic and stable for life. (docs/archive/latefyi-prd.md:217-217)
- All of a user's trains push to the same topic; simultaneous updates produce separate notifications, since ntfy does not merge or deduplicate. (docs/archive/latefyi-prd.md:218-218)
- Priority mapping (docs/archive/latefyi-prd.md:219-222):
  - Platform assigned, platform change, cancellation: `urgent` (5)
  - Delay change: `high` (4)
  - Status updates, arrivals: `default` (3)
- Title is short ("RE19750 → Platform 7"); body carries detail ("Amiens, on time, dep 14:02"). (docs/archive/latefyi-prd.md:223-223)
- Tags: `train`, `<operator>`, and `urgent` if applicable. No Click URL, because operator deep links are unreliable. (docs/archive/latefyi-prd.md:224-225)

### `both`

- Sends to ntfy and email simultaneously, with no de-duplication. (docs/archive/latefyi-prd.md:229-229)
- Recommended for cross-border trips, infrequent users, redundancy, and as the auto-fallback when ntfy delivery fails. (docs/archive/latefyi-prd.md:230-230)

## Channel selection logic

1. New senders default to `email` only. (docs/archive/latefyi-prd.md:234-234)
2. Opt in to ntfy by emailing `config@late.fyi` with subject `CHANNELS ntfy` or `CHANNELS both`. (docs/archive/latefyi-prd.md:235-235)
3. The server replies once with the user's personal ntfy topic URL plus QR code. This is the only time a topic link appears in any communication. (docs/archive/latefyi-prd.md:236-236)
4. Persistent change: email `config@late.fyi` with `CHANNELS <email|ntfy|both>`; the server confirms and persists to `state/users/<sender_hash>.json`. (docs/archive/latefyi-prd.md:237-237)
5. Per-request override: a `Channels: both` (or `ntfy` / `email`) header in a tracking email applies only to that train. (docs/archive/latefyi-prd.md:238-238)
6. Critical events (cancellation, full route disruption, early termination, replacement bus) always send via every available channel regardless of preference. (docs/archive/latefyi-prd.md:239-239)

## Fallback behavior

- If an ntfy POST returns non-2xx three times in a row for a user during one tracked train, that request is promoted to `both` for the rest of the trip. The next email says: "ntfy delivery failing for this trip — also sending by email." (docs/archive/latefyi-prd.md:243-243)
- Fallback is per-request, not persistent; the next request starts fresh on the stored preference. (docs/archive/latefyi-prd.md:244-244)
- Users on `email` only never have ntfy attempted. (docs/archive/latefyi-prd.md:245-245)

## Multi-train example

Amr is on `CHANNELS both`, tracking RE19750 (his ride, Amiens to Lille), TGV 9876 (picking up his sister at Lille Europe) and ICE 104 (a friend arriving at Brussels). (docs/archive/latefyi-prd.md:249-252)

- When all update together he gets three ntfy notifications titled by train number and three threaded emails, each in its own conversation. (docs/archive/latefyi-prd.md:254-254)
- Trains are independent per-train and converge only at delivery, staying distinct because each notification leads with the train number. (docs/archive/latefyi-prd.md:254-254)
- No collision, no per-train configuration, and only one channel carrying everything. (docs/archive/latefyi-prd.md:256-256)

## ntfy setup

ntfy is opt-in per user. The operator need not set it up if no users want it; email works for everyone out of the box. (docs/archive/latefyi-prd.md:1180-1180)

### How a user opts in

1. User emails `config@late.fyi` with subject `CHANNELS ntfy` or `CHANNELS both`. (docs/archive/latefyi-prd.md:1184-1184)
2. `users.js` updates `state/users/<sender_hash>.json`, sets `channel`, and on first time triggers an opt-in reply email containing the personal topic URL (`latefyi-<sha256(email)[:16]>`), an HTML-body QR code for one-tap subscription, and brief setup instructions. (docs/archive/latefyi-prd.md:1185-1188)
3. User installs the ntfy app and scans the QR or pastes the URL. (docs/archive/latefyi-prd.md:1189-1189)
4. From then on every tracked train pushes to that topic, for life, with no further setup. (docs/archive/latefyi-prd.md:1190-1190)

### Server-side options

**Option A: public ntfy.sh (zero operator infra)** (docs/archive/latefyi-prd.md:1194-1198)
- POST directly to `https://ntfy.sh/<topic>`.
- Topics are unguessable (16 hex chars from sha256), so effectively private.
- Free and rate-limited; use this unless there is a privacy reason not to.

**Option B: self-hosted ntfy (full control)** (docs/archive/latefyi-prd.md:1200-1205)
- Run `ntfy serve` on the VPS (single Go binary, no deps).
- Set `ntfy.base_url` in `config.json` to the self-hosted domain.
- Use access tokens via `ntfy.auth_token` for true privacy.
- The same ntfy app supports custom servers; users subscribe via QR/URL identically.
- Adds one process to operate but removes the external dependency.

Recommendation: start with Option A; migrate to B if usage grows or privacy demands it. (docs/archive/latefyi-prd.md:1207-1207)

### `setup-ntfy.sh` (operator's own use)

```bash
./scripts/setup-ntfy.sh amr@example.com
# → Topic: latefyi-a3f9c2e1b4d8e7f2
# → Subscribe URL: https://ntfy.sh/latefyi-a3f9c2e1b4d8e7f2
# → QR code printed to terminal
```
(docs/archive/latefyi-prd.md:1211-1216)

- Bypasses the email opt-in flow for the operator's own setup; equivalent to emailing yourself `CHANNELS ntfy` and reading the reply. It is useful during initial deployment when outbound email may not work yet. (docs/archive/latefyi-prd.md:1218-1218)
- The topic is `sha256(sender_email)[:16]`, reproducible without stored state, so re-running gives the same topic. (docs/archive/latefyi-prd.md:1220-1220)
