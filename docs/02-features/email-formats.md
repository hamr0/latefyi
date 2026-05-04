# Email formats — every message late.fyi exchanges

This doc enumerates every email the system reads or writes, with the trigger that produces it and a real, code-generated sample (subject + body).

> **Regenerate after touching `src/reply.js` or `src/diff.js`:**
> `node scripts/dump-email-samples.js > /tmp/samples.txt` and re-paste the relevant blocks below.

All times shown are **station-local** — the time you'd read off the platform clock at the named station. The station name appears next to the time on every line, so no UTC label is needed.

---

## Table of contents

1. [Inbound (user → late.fyi)](#1-inbound-user--latefyi)
2. [Outbound — synchronous replies](#2-outbound--synchronous-replies)
3. [Outbound — push notifications (poll-runner)](#3-outbound--push-notifications-poll-runner)
4. [Operator alerts](#4-operator-alerts)
5. [Footer](#5-footer)

---

## 1. Inbound (user → late.fyi)

Routing key is the **local-part of the To: address**. Body and subject are parsed for additional headers (`From:`, `To:`, `On:`, `Trip:`, `Channels:`).

| To address                  | Trigger                                              | Effect (parser kind)              |
| --------------------------- | ---------------------------------------------------- | --------------------------------- |
| `<TRAINNUM>@late.fyi`       | Any `[A-Z]{0,4}\d{2,5}` local-part (EUR9340, ICE145) | `track` — see headers below       |
| `stop@late.fyi`             | `STOP <TRAIN>` / `STOP TRIP <name>` / `STOP ALL`     | `stop`                            |
| `list@late.fyi`             | Any subject/body                                     | `list` — return active trains     |
| `config@late.fyi`           | `CHANNELS email` / `CHANNELS ntfy` / `CHANNELS both` | `config`                          |
| `help@late.fyi`             | Any subject/body                                     | `help`                            |
| `feedback@late.fyi`         | Any subject/body                                     | Forwarded to operator; no auto-reply |
| Reply to a prior outbound   | `In-Reply-To` header set                             | `reply` — answer disambiguation, etc. |
| `noreply@`, `postmaster@`, `abuse@`, `admin@` | Reserved local-parts caught by Cloudflare worker | Dropped before ingest |

### Headers recognised in the subject (or first non-empty body line)

Comma-separated, case-insensitive:

```
From: <station>      Departure station name (substring match against route)
To: <station>        Arrival station / destination
On: 2026-05-04       Travel date — ISO or named-month ("5 May 2026"); up to 90 days ahead
Trip: <tag>          Group label; STOP TRIP <tag> tears the chain down
Channels: email|ntfy|both
```

### Mode resolution

- `From:` and `To:` both set → **mode B (boarding)**, anchor on departure.
- `From:` only → **mode B**, anchor at the train's terminus.
- `To:` only → **mode A (pickup)**, anchor on arrival.

### Examples

| Subject                                          | Body | Resolved as                                              |
| ------------------------------------------------ | ---- | -------------------------------------------------------- |
| (any) → `EUR9340@late.fyi`                       | empty | error: missing context (need From: / To:)              |
| `From: Amsterdam, To: Paris` → `EUR9340@late.fyi` | empty | track EUR9340 boarding Amsterdam, alighting Paris       |
| `To: Berlin Ostbahnhof` → `ICE145@late.fyi`      | empty | track ICE145 picking up at Berlin Ostbahnhof           |
| `From: Amsterdam, On: 2026-05-10, Trip: berlin` → `ICE145@late.fyi` | empty | track ICE145 on 2026-05-10, trip-tagged "berlin" |
| `STOP EUR9340` → `stop@late.fyi`                 | "STOP EUR9340" | stop tracking EUR9340                       |
| `STOP TRIP berlin` → `stop@late.fyi`             | "STOP TRIP berlin" | stop all trains tagged berlin            |
| `STOP ALL` → `stop@late.fyi`                     | "STOP ALL" | stop everything                                    |
| `CHANNELS ntfy` → `config@late.fyi`              | "CHANNELS ntfy" | switch to ntfy push delivery                  |
| (any) → `list@late.fyi`                          | (any) | reply with currently active trains                       |
| (any) → `help@late.fyi`                          | (any) | reply with help text                                     |

---

## 2. Outbound — synchronous replies

These are sent immediately by the ingest server in response to an inbound email. The `From:` local-part is chosen so that the user's "Reply" button lands somewhere routable (mailto'd back to the right handler), since `noreply@late.fyi` is dropped by the Cloudflare worker.

### confirmation (happy path)

**Trigger:** valid `track` request resolved successfully.

**From:** `latefyi <EUR9340@late.fyi>`
**Subject:** `Tracking EUR 9340 — Amsterdam Centraal → Paris Nord — Monday, 2026-05-04`

```
Tracking EUR 9340, Amsterdam Centraal → Paris Nord.
Scheduled: dep Monday, 2026-05-04 11:10 Amsterdam Centraal, arr Monday, 2026-05-04 14:42 Paris Nord.
Departure platform: 15a    Arrival platform: TBC
Status: TBC
Updates by email starting T-30 at 10:40.

Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20EUR9340&body=STOP%20EUR9340
```

### missing context

**Trigger:** `track` request without recognisable `From:`/`To:` or with invalid train number format.

**From:** `latefyi <help@late.fyi>`
**Subject:** `Need more info for EUR9340`

```
Got EUR9340 but I don't know what you need. Resend with one of:

Picking someone up:
  Subject: To: <station>

Boarding:
  Subject: From: <station>, To: <station>
  (just From: works too — we'll track to the train's terminus)

Optional headers (combine freely, comma-separated, in subject):
  On: 2026-05-04         travelling later (ISO date or "5 May 2026", up to 90 days ahead)
  Trip: <name>           tag for grouping; STOP TRIP <name> tears the chain down

Example:
  Subject: From: Amsterdam, To: Berlin Ostbahnhof, On: 2026-05-04, Trip: berlin-weekend

Headers are case-insensitive and can also go in the body's first non-empty line.
```

### train not found

**Trigger:** HAFAS returned no trip for the resolved train number on the requested date.

**From:** `latefyi <EUR9340@late.fyi>`
**Subject:** `Can't find train EUR9340`

```
No train matching "EUR9340" found on 2026-05-04.

Common confusions:
- TGV INOUI: 4 digits (e.g. 9876)
- TER/RE: 4-5 digits, often prefixed RE/TER
- Eurostar: prefixed EUR + 4 digits
- ICE: prefixed ICE + 3-4 digits
- Numbers reset daily — train numbers can also vary by day-of-week

Tip: if the date is more than a few weeks out, HAFAS may not have published that day's schedule yet — try again closer to the date.

Check your booking confirmation and resend.
```

### station not on route

**Trigger:** user's `From:` or `To:` doesn't match any stop on the resolved trip.

**From:** `latefyi <EUR9340@late.fyi>`
**Subject:** `Lyon not on EUR 9340's route`

```
EUR 9340 runs: Amsterdam → Brussels → Paris.
"Lyon" isn't a stop. Closest match: Brussels.

Reply with corrected station.
```

### ambiguous station (disambiguation)

**Trigger:** user's station name matches multiple stops (e.g. "paris" → Paris Nord, Paris Est).

**From:** `latefyi <EUR9340@late.fyi>` (Reply-To `EUR9340@late.fyi` so a numeric reply round-trips correctly)
**Subject:** `Which paris for EUR 9340?`

```
"paris" matches multiple stops on EUR 9340's route:
  1. Paris Nord
  2. Paris Est

Reply with just the number (1 or 2), or the full name.
```

### already arrived

**Trigger:** user requested a train whose anchor (departure or arrival) is in the past today.

**From:** `latefyi <EUR9340@late.fyi>`
**Subject:** `EUR 9340 already arrived 2026-05-04`

```
EUR 9340 arrived at Paris Nord on Monday, 2026-05-04 14:42. Nothing left to track.

If you meant a different day's EUR9340, resend with an explicit date (e.g. `On: 2026-05-05` for the next day's service). Train numbers are per-day, not unique across days.
```

### rate-limited

**Trigger:** sender exceeded hourly (10) or daily (50) `track` quota.

**From:** `latefyi <help@late.fyi>`
**Subject:** `Too many tracking requests`

```
You've sent too many fresh tracking requests in the last hour.
Try again after Monday, 2026-05-04 12:00.

Already-tracked trains keep updating — this only blocks new ones.
```

### too many active trips

**Trigger:** sender already at the active-trip limit (20) when requesting a new one.

**From:** `latefyi <stop@late.fyi>`
**Subject:** `Too many active trains`

```
You're already tracking 20 trains, which is the per-sender limit (20).

Reply STOP <TRAINNUM> on any of them, or STOP ALL to clear everything, then resend this request.
```

### unauthorized sender

**Trigger:** the sender's email address is not in the operator's allowlist. **Currently dormant**: production runs with `ALLOWED_SENDERS=` (empty) in `/etc/latefyi.env`, which the ingest server treats as "no allowlist — open to everyone" (`src/ingest-server.js:119`). This template only fires if the operator populates the env var with a comma-separated list of permitted addresses (e.g. `ALLOWED_SENDERS=alice@example.com,bob@example.com`) and restarts `latefyi-ingest`.

**From:** `latefyi <help@late.fyi>`
**Subject:** `Sender not allowlisted`

```
Email from you@example.com isn't authorized for this late.fyi instance.
If you think this is a mistake, contact the operator (feedback@late.fyi).
```

### STOP confirmation (single train)

**Trigger:** `STOP <TRAIN>` recognised, train was active, now untracked.

**From:** `latefyi <stop@late.fyi>`
**Subject:** `Stopped tracking EUR9340`

```
OK, no more updates for EUR9340.
```

### STOP confirmation (ALL or TRIP)

**Trigger:** `STOP ALL` or `STOP TRIP <tag>`. Body lists the cleared trains.

**From:** `latefyi <stop@late.fyi>`
**Subject:** `Stopped all tracking`

```
Cleared 2 active trains:
  - EUR 9340 (Amsterdam → Paris), dep Monday, 2026-05-04 11:10
  - ICE 145 (Amsterdam → Berlin), dep Tuesday, 2026-05-05 08:00

No more updates until you start fresh.
```

### ntfy opt-in

**Trigger:** sender sent `CHANNELS ntfy` or `CHANNELS both` to `config@late.fyi`. Sent once per channel switch.

**From:** `latefyi <config@late.fyi>`
**Subject:** `ntfy enabled for late.fyi`

```
Install ntfy (App Store, Play Store, or F-Droid), then open this on your phone:

   ntfy://subscribe/latefyi-abc123

Or open in any browser to subscribe manually:

   https://ntfy.sh/latefyi-abc123

From now on, every train you track will push here. Multiple trains in tandem all flow through this one topic — no extra setup, ever.

Reply CHANNELS email to disable ntfy. Reply CHANNELS both to keep both channels active.
```

### generic error (resolver fallback)

**Trigger:** resolver crashed or returned an unexpected error code (HAFAS 5xx, timeout, etc.). Fallback when no specific template fits.

**From:** `latefyi <EUR9340@late.fyi>`
**Subject:** `Couldn't track EUR9340`

```
Got your request for EUR9340, but ran into a problem: HAFAS endpoint timed out twice

(Internal code: resolve_failed)
```

### list active trains

**Trigger:** any email to `list@late.fyi`.

**From:** `latefyi <list@late.fyi>`
**Subject:** `Your active trains`

```
2 trains currently tracked:

EUR 9340 — Amsterdam → Paris
  Dep Monday, 2026-05-04 11:10
  Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20EUR9340&body=STOP%20EUR9340

ICE 145 — Amsterdam → Berlin
  Dep Tuesday, 2026-05-05 08:00
  Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20ICE145&body=STOP%20ICE145
```

### list (empty)

```
No trains currently being tracked.

Send a new request: <trainnum>@late.fyi
```

---

## 3. Outbound — push notifications (poll-runner)

Sent by `latefyi-poller` between `poll_start_time` (T-30) and the trip's terminal moment. Each event is built by `src/diff.js` (title + body) and wrapped by `pushReply()` (From: `<TRAINNUM>@late.fyi`, threading headers, mailto STOP link, footer).

**All change-event bodies share the same shape**: trip header, schedule line, platform line. Rows that **changed** since the last snapshot are prefixed with `> `. Inline annotations: `(+5min)` next to a delayed time, `(was 15a)` next to a re-platformed train.

| Event                          | Priority | Trigger                                                              |
| ------------------------------ | -------- | -------------------------------------------------------------------- |
| `tracking_started`             | default  | First poll succeeds (T-30)                                           |
| `platform_assigned`            | urgent   | Anchor platform was null/TBC, now known                              |
| `platform_changed`             | urgent   | Anchor platform changed value                                        |
| `delay_change`                 | high     | Anchor delay shifted by ≥2min pre-anchor / ≥5min in-transit          |
| `arrival_platform_assigned`    | urgent   | (Mode B post-departure) arrival platform now known                   |
| `arrival_platform_changed`     | urgent   | (Mode B post-departure) arrival platform changed value               |
| `arrival_delay_change`         | high     | (Mode B post-departure) arrival delay shifted ≥5min                  |
| `cancelled`                    | urgent   | `trip.cancelled` true OR anchor stop cancelled                       |
| `replaced`                     | urgent   | `trip.replaced` true                                                 |
| `terminating_short`            | urgent   | User's destination stop is now cancelled                             |
| `departed` (Mode B only)       | default  | `hasDeparted` flipped true                                           |
| `arrived`                      | default  | `hasArrived` flipped true (terminal)                                 |
| `tracking_lost`                | urgent   | `MAX_CONSECUTIVE_FAILURES` (6) consecutive HAFAS errors (synthesised by `poll.js`, not `diff.js`) |

### tracking_started (T-30)

**Subject:** `Tracking EUR 9340 — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Scheduled: dep Monday, 2026-05-04 11:10 Amsterdam Centraal, arr Monday, 2026-05-04 14:42 Paris Nord.
Departure platform: 15a    Arrival platform: TBC
```

### platform_changed

**Subject:** `EUR 9340 platform CHANGED → 16b — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Scheduled: dep Monday, 2026-05-04 11:10 Amsterdam Centraal, arr Monday, 2026-05-04 14:42 Paris Nord.
> Departure platform: 16b (was 15a)    Arrival platform: TBC
```

### delay_change

**Subject:** `EUR 9340 +5min — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
> Scheduled: dep Monday, 2026-05-04 11:10 Amsterdam Centraal (+5min), arr Monday, 2026-05-04 14:42 Paris Nord.
Departure platform: 15a    Arrival platform: TBC
```

### arrival_platform_assigned

**Subject:** `EUR 9340 → arrival Platform 7 — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Scheduled: dep Monday, 2026-05-04 11:10 Amsterdam Centraal, arr Monday, 2026-05-04 14:42 Paris Nord.
Departure platform: 15a    > Arrival platform: 7
```

### arrival_delay_change

**Subject:** `EUR 9340 arrival +8min — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
> Scheduled: dep Monday, 2026-05-04 11:10 Amsterdam Centraal, arr Monday, 2026-05-04 14:42 Paris Nord (+8min).
Departure platform: 15a    Arrival platform: TBC
```

### cancelled

**Subject:** `EUR 9340 CANCELLED — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
This service is cancelled.
```

### replaced

**Subject:** `EUR 9340 replacement service — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Replaced — check operator app for the substitute service.
```

### terminating_short

**Subject:** `EUR 9340 TERMINATING before Paris Nord — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Train will not reach Paris Nord. Check operator app for onward connection.
```

### departed (Mode B)

**Subject:** `EUR 9340 departed Amsterdam Centraal — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Left at ~11:10, +0min.
```

### arrived (terminal)

**Subject:** `EUR 9340 arrived Paris Nord — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
Arrived ~14:42, platform –. Tracking ended.
```

After `arrived`, the active record is `unlinkSync`'d and the user's plaintext address is dropped from disk. `push.jsonl` keeps the audit row using `senderHash` only.

### tracking_lost

**Subject:** `Lost tracking for EUR 9340 — Monday, 2026-05-04`

```
EUR 9340, Amsterdam Centraal → Paris Nord.
6 consecutive poll failures. Last error: HAFAS 502 Bad Gateway
```

---

## 4. Operator alerts

A single channel that pages the operator (env var `OPERATOR_EMAIL`) **only when something needs human attention**. Quiet inbox = healthy system.

### dropped event (final delivery failure)

**Trigger:** the same user-facing event has failed delivery `MAX_DELIVERY_ATTEMPTS` (10) times in a row across ~5 minutes of retries. After this, the event is removed from the per-record `pendingDeliveries` queue and never sent.

**From:** `latefyi <noreply@late.fyi>`
**To:** `<OPERATOR_EMAIL>`
**Subject:** `[late.fyi] dropped <event_type> for <trainNum>`

```
[2026-05-04T08:42:00.123Z] GAVE UP after 10 attempts trainNum=EUR9340 senderHash=e6a52079606e9287 type=tracking_started channels=email lastError=ECONNREFUSED 127.0.0.1:25

User event was dropped after 10 retries.
Check logs/delivery-errors.log and journalctl -u latefyi-poller.
```

If `OPERATOR_EMAIL` itself is unreachable (because SMTP is the broken thing), the failure is still recorded in `logs/delivery-errors.log` and the systemd journal — those are the local-only sources of truth.

---

## 5. Footer

Every outbound email ends with this single-source-of-truth footer (defined in `src/reply.js` `FOOTER`):

```
-- 
late.fyi | list@late.fyi (your active trains) | feedback@late.fyi | we don't store your email past notifications or STOP
```

`-- ` (dash-dash-space) is the standard signature delimiter — most clients render the line below in muted grey.
