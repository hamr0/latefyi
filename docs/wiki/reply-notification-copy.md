---
title: Reply and Notification Copy
theme: reply-notification-copy
sources:
  - docs/archive/latefyi-prd.md
---

# Reply and Notification Copy

Wording and behavior of every reply and push: footer, STOP variants, error replies, event taxonomy, diff-based push and suppression.

## Reply principles

- Replies go to the original sender; all are short, actionable, no marketing, no signature beyond `— late.fyi` (docs/archive/latefyi-prd.md:262-262).
- The footer is email-only; ntfy push bodies stay short and skip it (docs/archive/latefyi-prd.md:266-266).
- In templates below, `[FOOTER]` is shorthand for the standard footer, appended from a single string constant in `reply.js` (docs/archive/latefyi-prd.md:275-275).

### Standard footer (every email reply)

Every outbound email (confirmations, errors, updates, disambiguation prompts, STOP confirmations) ends with the same footer. It teaches the format passively and lists the STOP variants so the user always has an exit (docs/archive/latefyi-prd.md:266-266).

```
— late.fyi
─────
Format: <TRAINNUM>@late.fyi   Subject: From: <station>, To: <station>   (or just To: for pickup)
Optional: Trip: <name>   ·   Stop via mailto: links in each email (or Subject: STOP / STOP TRIP <name> / STOP ALL to stop@late.fyi)   ·   Headers case-insensitive
```
(docs/archive/latefyi-prd.md:268-273)

### From addresses

`From:` is meaningful, with per-template routable local-parts (docs/archive/latefyi-prd.md:326-330):
- confirmations and per-train updates: `latefyi <<TRAINNUM>@late.fyi>`
- stop confirmations: `latefyi <stop@late.fyi>`
- config replies: `latefyi <config@late.fyi>`
- error / help / rate-limit / unauthorized: `latefyi <help@late.fyi>`

The display name `latefyi` keeps the inbox sender clean. `noreply@` is not used as From: because clients that ignore Reply-To (Gmail, others) reply to From: directly, and the Cloudflare worker drops `noreply@` via `NON_TRACKING_LOCALPARTS`. Routable locals make Reply-STOP work as a silent fallback on top of the canonical mailto path (docs/archive/latefyi-prd.md:332-332).

## STOP variants (canonical)

Stops are triggered by a fresh email to `stop@late.fyi` (or any `<TRAINNUM>@late.fyi`) with `STOP ...` in the subject. The canonical UX is the one-click `mailto:` link in every confirmation and update email, which opens a compose with the subject prefilled. Replying STOP to a confirmation is intentionally not parsed, because client-specific attribution lines and quoted-content boundaries make it unreliable (docs/archive/latefyi-prd.md:279-279).

| Email | Effect |
|---|---|
| `Subject: STOP <TRAINNUM>` to `stop@late.fyi` (or `<TRAINNUM>@late.fyi`) | Stops that train. The mailto link uses this form. |
| `Subject: STOP TRIP <name>` to `stop@late.fyi` | Stops every active tracking whose `trip` matches `<name>` (case-insensitive); one reply summarizes how many were cleared. |
| `Subject: STOP ALL` to `stop@late.fyi` | Stops every active tracking for the sender. |
| `Subject: STOP` to `<TRAINNUM>@late.fyi` | Bare STOP at a train-number address resolves to that train. |

(docs/archive/latefyi-prd.md:281-286)

## Confirmation replies

### Happy path (email; ntfy paused)

```
From: latefyi <RE19750@late.fyi>
Subject: Tracking RE19750 [paris-weekend] — Amiens → Lille Flanders — 2026-05-06

Tracking RE19750 (TER, SNCF), Amiens → Lille Flanders.
Scheduled: dep 14:02 Amiens, arr 14:38 Lille Flanders.
Departure platform: TBC    Arrival platform: TBC
Status: TBC
Updates by email starting T-30 at 13:32.

Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20RE19750&body=STOP%20RE19750

[FOOTER]
```
(docs/archive/latefyi-prd.md:290-304)

### Mode A (pickup, `To:` only)

A different shape: the user cares only about when the train arrives where they are meeting it (docs/archive/latefyi-prd.md:306-306).

```
From: latefyi <EUR9340@late.fyi>
Subject: Pickup EUR9340 — Paris Nord — Monday, 2026-05-04

Picking up EUR 9340 at Paris Nord.
Scheduled arrival: Monday, 2026-05-04 14:42 Paris Nord.
Arrival platform: TBC
Status: TBC
Updates by email starting T-30 at 14:12.

Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20EUR9340&body=STOP%20EUR9340

[FOOTER]
```
(docs/archive/latefyi-prd.md:308-322)

Origin and `Departure platform` are omitted; the T-30 anchor is the arrival time at `To:`, not departure (docs/archive/latefyi-prd.md:324-324).

### TBC fields

Platform and Status use `TBC` when not yet known (always at confirmation for trips at least 1 day out). Operators assign platforms only about 30 min before departure and HAFAS doesn't surface real-time delay/status until the train is in service; TBC sets the expectation of what will be filled later (docs/archive/latefyi-prd.md:334-334).

### Subject inbox-grouping signals

Conditional, never always-on (docs/archive/latefyi-prd.md:336-339):
- `[trip]` prefix, between train and route, is rendered iff a `Trip:` tag was set. Brackets follow the mailing-list convention.
- ` — YYYY-MM-DD` suffix, at the end, is rendered iff the train date is not today or tomorrow. ISO format is unambiguous across locales.
- The same convention applies to per-event `pushReply` subjects, e.g. `ICE1255 +5min [austria] — 2026-05-06`.

### User opted in to ntfy

Same subject shape (`Tracking RE19750 — Amiens → Lille Flanders`) and body, but replaces the update line with `Push starts T-30 at 13:32 via ntfy.` and `Reply CHANNELS email to switch back.`, then `[FOOTER]` (docs/archive/latefyi-prd.md:343-352).

### ntfy opt-in reply (sent once, on `CHANNELS ntfy` or `both`)

Subject `ntfy enabled for late.fyi`. Body gives the topic URL (`https://ntfy.sh/latefyi-a3f9c2e1b4d8e7f2`), a three-step one-time setup (install ntfy from App Store, Play Store or F-Droid; open the app and tap +; scan the QR or paste the URL), and a note that every tracked train pushes to this one topic with no extra subscriptions. It ends with `Reply CHANNELS email to disable ntfy. Reply CHANNELS both to keep both channels active.` and `[FOOTER]` (docs/archive/latefyi-prd.md:356-376).

## Error and prompt replies

All end with `[FOOTER]`.

| Case | Subject | Body (condensed) |
|---|---|---|
| Missing context | `Need more info for RE19750` | "Got RE19750 but I don't know what you need." Reply `To: <station>` for a pickup, or `From: <station>` (optionally `To:`) for boarding. Example: `From: Amiens, To: Lille Flanders` (docs/archive/latefyi-prd.md:380-390) |
| Train not found | `Can't find train RE19750` | No train matching "RE19750" found today or tomorrow. Common confusions: TGV INOUI 4 digits; TER/RE 4-5 digits, often prefixed RE/TER; Eurostar prefixed EUR + 4 digits; ICE prefixed ICE + 3-4 digits; numbers reset daily. "Check your booking confirmation and resend." (docs/archive/latefyi-prd.md:394-409) |
| Station not on route | `Brussels not on RE19750's route` | Lists the route (`Amiens → Arras → Douai → Lille Flanders`), says "Brussels" isn't a stop, suggests the closest match, and asks for a corrected station (docs/archive/latefyi-prd.md:413-423) |
| Ambiguous station | `Which Lille for RE19750?` | Numbered options (1. Lille Flanders, 2. Lille Europe); "Reply with just the number (1 or 2), or the full name." Round-trip in §7a (docs/archive/latefyi-prd.md:427-439) |
| Train already passed | `RE19750 already arrived` | Arrived at Lille Flanders at 14:32 today, nothing left to track; if for tomorrow's train, resend after midnight since train numbers are per-day (docs/archive/latefyi-prd.md:443-452) |
| Unauthorized sender | `Sender not allowlisted` | "Email from <sender> isn't authorized for this latefyi instance. Add to config.json `allowed_senders` and redeploy." In single-tenant deployment this prevents the world from racking up your ntfy quota (docs/archive/latefyi-prd.md:456-465) |

## STOP confirmations

All end with `[FOOTER]`.

| Case | Subject | Body |
|---|---|---|
| Single train | `Stopped tracking RE19750` | `OK, no more updates for RE19750.` (docs/archive/latefyi-prd.md:469-475) |
| STOP TRIP | `Stopped trip "rome"` | `Cleared 3 trains from trip "rome":` then one line per train, e.g. `EUR 9316 (Amsterdam → Paris Nord)` (docs/archive/latefyi-prd.md:479-488) |
| STOP ALL | `Stopped all tracking` | `Cleared 5 active trains. No more updates until you start fresh.` (docs/archive/latefyi-prd.md:492-498) |

## Notification taxonomy (canonical, both modes)

What gets pushed falls into exactly four windows (docs/archive/latefyi-prd.md:654-654).

**Window 1 - Tracking start** (docs/archive/latefyi-prd.md:656-658)
- Confirmation reply: sent within seconds, one threaded email, not subject to suppression.
- T-30 mandatory push: fired at the first poll after T-30 regardless of change, to reassure the user tracking is live.

**Window 2 - Pre-anchor** (T-30 to scheduled departure for Mode B, or scheduled arrival for Mode A) (docs/archive/latefyi-prd.md:660-665):
- Platform assigned (null to value): urgent
- Platform changed: urgent
- Delay change of at least 2 min at the anchor: high
- Cancellation: urgent
- Replacement service: urgent

**Window 3 - In-transit / approach** (after departure for B, or pre-arrival for A) (docs/archive/latefyi-prd.md:667-674):
- Arrival platform assigned at `To:`: urgent
- Arrival platform changed at `To:`: urgent
- Downstream delay propagating to `To:` of at least 5 min: high
- Train terminating before `To:` ("shorter than booked"): urgent
- Rerouting / splitting affecting `To:`: urgent
- Cancellation: urgent
- Replacement service: urgent

**Window 4 - Tracking end** (docs/archive/latefyi-prd.md:676-678)
- Arrival at `To:` (or the anchor for Mode A): terminal default-priority push, ends tracking.
- Past arrival grace with no data: terminal "tracking lost" push.

**Mode applicability.** Windows 1, 3 and 4 apply to both modes. Window 2 differs only in which station "platform"/"delay" refers to: the user's `From:` in Mode B, the user's `To:` in Mode A. Thresholds and priorities are identical (docs/archive/latefyi-prd.md:680-680).

**Body shape per mode (1.14.5).** Push event bodies mirror the confirmation shape for their mode (docs/archive/latefyi-prd.md:682-682):
- Mode B keeps the boarding layout: `Tracking <line>, <from> → <to>.` headline, `Scheduled: dep ... arr ...`, dep and arr platforms.
- Mode A collapses to pickup form: `Picking up <line> at <to>.` (T-30 push), `<line> arrival platform: <p>, at <to>.` (platform events), `<line> arrival +Nmin, at <to>.` (delays); a `Scheduled arrival: <time> <to>` line and arrival-platform field only, with no origin, dep line or dep-platform field.
- Terminal events (`terminating_short`, `arrived`) drop the route tail in Mode A to avoid the tautological `<verb> X, at X` reading.
- The push subject's date suffix anchors on arrival for Mode A so it tracks the confirmation.

**Critical-event override (§6).** Cancellation, full route disruption, terminating short and replacement bus are always sent via every available channel regardless of stored preference (docs/archive/latefyi-prd.md:684-684).

**Suppression by default.** Silence is the norm; the vast majority of polls produce no push (docs/archive/latefyi-prd.md:686-686).

## Diff-based push

Every poll produces a `TrainState` snapshot with fields `trainId`, `scheduledDeparture`, `actualDeparture`, `delayMinutes`, `platform`, `platformScheduled`, `status` (`on_time | delayed | cancelled | replaced | departed | arrived`), `route` (per station: `scheduledArr`, `actualArr`, `scheduledDep`, `actualDep`, `platform`), `endpoint` and `pollTimestamp` (docs/archive/latefyi-prd.md:690-709).

A push fires when diffing previous against current snapshot reveals one of (docs/archive/latefyi-prd.md:711-725):

| Change | Threshold | Priority | Modes |
|---|---|---|---|
| Platform null → value at anchor (`From:` for B, `To:` for A) | any | urgent | A, B |
| Platform value → different value at anchor | any | urgent | A, B |
| `delayMinutes` change at anchor | ≥2 min pre-anchor, ≥5 min in-transit | high | A, B |
| `status` → cancelled | any | urgent | A, B |
| `status` → replaced | any | urgent | A, B |
| `status` → arrived (terminal) | terminal | default | A, B |
| Arrival platform at `To:` null → value (Mode B post-departure) | any | urgent | B |
| Arrival platform at `To:` changed (Mode B post-departure) | any | urgent | B |
| Downstream delay propagating to `To:` arrival | ≥5 min | high | B |
| Train terminating before `To:` (or before anchor for Mode A) | any | urgent | A, B |
| Rerouting / mid-route split affecting `To:` | any | urgent | A, B |

## Suppression

(docs/archive/latefyi-prd.md:729-732)
- No push for unchanged state (avoids every-30s spam).
- No push for delay oscillation within ±1 min of the last pushed value (debounce).
- Mandatory push at start of polling (T-30) regardless of changes, confirming tracking is live.
- Mandatory push at terminal state, confirming tracking ended cleanly.
