# latefyi — Product Requirements Document

**Version:** 1.2.0-draft
**Status:** Implementation-ready (post-POC: §8 endpoint strategy revised, §7a disambiguation flow added, §4 `Trip:` tag added, §7 standard footer added, multi-leg policy locked to one-email-per-train)
**Owner:** Amr
**Intended developer:** Claude (Sonnet 4.6+ recommended for implementation)

---

## 1. Purpose

`latefyi` is a small, self-hosted, email-driven train-tracking notifier for European rail. It eliminates the pain of refreshing operator websites and station boards in unfamiliar languages by accepting a one-shot email per train and sending real-time updates (platform assignment, delays, cancellations, route changes) back to the user — by default via email, optionally via ntfy push for users who opt in.

The user emails `<TRAINNUM>@late.fyi`, optionally with `From:` / `To:` headers to disambiguate intent, and receives notifications from T-30 minutes through arrival/destination.

**Email is the default channel** because it works for everyone with no app install, no setup, no account. ntfy is offered as an opt-in upgrade for users who want faster, quieter, app-style push notifications. Both can run together (`both`) for redundancy.

---

## 2. What it is / What it is not

### What it is
- A single-purpose, email-in / notification-out tracker for European trains
- Email-first: works for any user with just an email account
- Self-hosted: one Cloudflare Worker + one Node.js process on a small VPS or home server
- Multi-recipient: any allowlisted email address can use it independently with no extra setup
- Zero telemetry, zero accounts, zero web UI
- Operator-agnostic where HAFAS endpoints exist (SNCF, DB, SBB, ÖBB, NS, SNCB, Trenitalia, Eurostar)
- Forgiving: parses missing/malformed input and replies with a concrete fix
- ntfy-optional: users can opt in to push notifications; never required

### What it is not
- A ticketing or booking system
- A journey planner (no "find me a route from X to Y")
- A public SaaS (single instance, allowlisted senders only — but multiple users can share one instance freely)
- A web app (no dashboard, no admin UI)
- A replacement for operator apps (those still own ticketing, seat selection, refunds)
- A general-purpose notification platform (one purpose: trains)
- An aggregator/scraper of operator websites (only uses HAFAS protocol via `hafas-client`)
- ntfy-required (ntfy is optional; email is always available)

---

## 3. User Experience

### Primary flow (Mode B — boarding, default email channel)

1. User books an SNCF ticket: RE19750, Amiens → Lille Flanders, departing 14:02
2. User emails `RE19750@late.fyi` with `From: Amiens, To: Lille Flanders` from their allowlisted email address
3. System replies within seconds: "Tracking RE19750, Amiens → Lille Flanders, scheduled 14:02. Updates will arrive by email starting T-30 at 13:32. Reply STOP to cancel."
4. At 13:32, polling begins. Email update: "RE19750 — no platform yet, on time"
5. At 13:48, platform announced. Email update (subject: "RE19750 → Platform 7"): "Platform 7 at Amiens. On time."
6. At 13:55, delay detected. Email update: "RE19750 delayed +6min. New departure 14:08, Platform 7."
7. After departure, polling continues. If downstream delay/disruption: email. Otherwise silent until arrival window.
8. At Lille arrival: "RE19750 arrived at Lille Flanders, Platform 4." Tracking ends.

All update emails for one tracked train share an `In-Reply-To` header so they thread together in the user's mail client — one collapsed conversation per tracked train, not a dozen scattered messages.

### Secondary flow (Mode A — pickup)

1. User picking up a friend on TGV 9876 arriving at Lille Flanders 16:48
2. User emails `9876@late.fyi` with `To: Lille Flanders`
3. System replies: "Tracking TGV 9876 arriving Lille Flanders 16:48. Updates by email starting T-30 at 16:18."
4. Email updates: arrival platform when assigned, delays as announced, cancellation if it happens
5. On arrival: "TGV 9876 arrived Lille Flanders, Platform 2." Tracking ends.

### Optional flow (ntfy opt-in)

A user who wants faster, app-style push notifications instead of (or in addition to) email:

1. User emails `config@late.fyi` with subject `CHANNELS ntfy` (or `CHANNELS both`)
2. System replies once with their personal ntfy topic URL + a QR code:
   > Your ntfy topic: `https://ntfy.sh/latefyi-a3f9c2e1b4d8e7f2`
   >
   > Install the ntfy app (App Store / Play Store / F-Droid), tap +, scan the QR or paste the URL. Done.
   >
   > From now on, all your tracked trains will push here. Reply `CHANNELS email` to switch back.
3. User scans QR once on their phone → ntfy app subscribes
4. From this point forward, every tracked train for this user delivers via ntfy (or both, depending on choice). No further setup, no per-train links — one topic, all trains, lifetime.

### Operator setup flow (one time, when standing up the system)

1. Operator buys domain (~$10/yr at any registrar, or Cloudflare Registrar at-cost)
2. Points domain nameservers at Cloudflare
3. Enables Email Routing in Cloudflare dashboard
4. Deploys Worker (`wrangler deploy`)
5. Sets up SMTP credentials (or Cloudflare Email send) for outbound replies
6. Allowlists permitted sender email addresses in `config.json`
7. (Optional) Runs `setup-ntfy.sh` for own personal use
8. Sends test email from allowlisted address; receives confirmation reply

---

## 4. Email Grammar (final)

```
<TRAINNUM>@late.fyi                                → need more info, reply asking
<TRAINNUM>@late.fyi  To: <STATION>                 → Mode A: pickup at STATION
<TRAINNUM>@late.fyi  From: <STATION>               → Mode B: board STATION, ride to terminus
<TRAINNUM>@late.fyi  From: <X>, To: <Y>            → Mode B: board X, ride to Y
<TRAINNUM>@late.fyi  From: <X>, To: <Y>, Trip: <T> → as above, grouped under trip "T"
```

### Rules

- Local part is the train number. Required. Uppercase, alphanumeric, no whitespace. Examples: `RE19750`, `9876`, `ICE104`, `ES9114`, `TGV6201`
- `From:`, `To:`, and `Trip:` may appear in the **email subject line** (preferred) or in the **email body's first non-empty line**. Headers are key-colon-value, comma-separated.
- **Header keys are case-insensitive.** `From:`, `from:`, `FROM:`, `tO:` all parse identically. Values are normalized for matching but preserved verbatim for replies.
- Station names are matched case-insensitively against the resolved train's stop sequence using fuzzy match (Levenshtein ≤ 2 against canonical names + known aliases).
- `Trip:` is an optional free-text tag (alphanumeric + dash/underscore, ≤32 chars) that groups multiple per-train tracking requests for batch operations like `STOP TRIP <name>`. Trips are not validated against any list — any string the user picks works. See §7 for STOP semantics.
- Unknown headers are ignored silently. Extra body content is ignored.
- **One train per email.** Multi-train journeys = multiple emails. The system never parses a multi-leg itinerary from a single message. Rationale: parsing booking confirmations / itinerary blobs is a maintenance black hole, and the user's *first train* is the load-bearing event for the whole chain. See §22 decision 26.
- **Bare emails always trigger the §7 "missing context" reply.** Even if `<TRAINNUM>` resolves to exactly one train and one route, the system does not auto-pick `From:` or `To:`. Forcing explicit headers is intentional — it builds the muscle and avoids silent wrong assumptions. See §22 decision 27.

### Examples

```
To: tgv9876@late.fyi
Subject: To: Lille Flanders
Body: (empty)
→ Mode A, pickup at Lille Flanders
```

```
To: RE19750@late.fyi
Subject: From: Amiens, To: Lille Flanders
Body: (empty)
→ Mode B, board Amiens → Lille Flanders
```

```
To: ICE104@late.fyi
Subject: (empty)
Body: From: Frankfurt Hbf
→ Mode B, board Frankfurt Hbf → terminus
```

---

## 5. Operational Modes

### Mode A — Pickup (`To:` only)

- **Trigger:** `To:` present, `From:` absent
- **Watching:** arrival board at `To:` station for the specified train
- **Push events:** arrival platform assigned, ETA changes ≥2 min, cancellation, replacement service
- **Polling window:** T-30 (scheduled arrival) to actual arrival or +30 min grace
- **Terminal state:** train arrives, train cancelled, or +30 min past last known ETA with no data

### Mode B — Boarding (`From:` present)

- **Trigger:** `From:` present (with or without `To:`)
- **Watching:** departure board at `From:` station + downstream stops on the train's route until `To:` (or terminus if `To:` absent)
- **Push events:**
  - Departure platform assigned at `From:` (loud)
  - Departure delay change ≥2 min
  - Platform change (loud — user may already be on the wrong platform)
  - Cancellation or replacement bus (loudest)
  - Post-departure: downstream delay change ≥5 min affecting `To:` arrival
  - Mid-route disruption: train terminating early, rerouted, splitting
  - Arrival at `To:` (terminal push, ends tracking)
- **Polling window:** T-30 (scheduled departure at `From:`) until arrival at `To:` (or terminus) +5 min grace
- **Terminal state:** arrival at `To:`, cancellation, or train passes `To:` station per live data

### Polling cadence by phase

| Phase | Window | Frequency |
|---|---|---|
| Pre-T-30 | from email receipt to T-30 | Not polled (scheduler waits) |
| Pre-departure | T-30 to scheduled departure (Mode B) or scheduled arrival (Mode A) | Every 30s |
| In-transit (Mode B only) | scheduled departure to scheduled arrival at `To:` | Every 60s |
| Arrival window | T-5 to actual arrival | Every 30s |
| Grace | actual arrival or +30min cutoff | Stop |

Exception: large terminal stations (Paris-Nord, Gare de Lyon, Frankfurt Hbf, Roma Termini, etc. — list in `config.json`) extend pre-departure window to T-45 because they often announce later.

---

## 6. Notification Channels

Three channels, configurable per-user (lifetime preference) or per-request (one-shot override).

### Architecture: three lifetimes

The notification system layers three independent lifetimes:

| Layer | Lifetime | Stored as |
|---|---|---|
| **Per user** | Forever (until user changes it) | `state/users/<sender_hash>.json`: channel preference, ntfy topic, allowlist entry |
| **Per train** | One trip (T-30 to arrival + grace) | `state/active/<msgid>.json`: poll schedule, diff history, push log |
| **Per change** | One delivery | one ntfy POST and/or one email send |

This is why "track two trains in tandem" requires zero extra setup. The per-user layer is set-and-forget — one ntfy topic, one channel preference. The per-train layer is created by each tracking email and torn down on arrival, independent of every other train. The per-change layer is the actual notifications, where multiple trains' updates converge and stream out through the user's single configured channel as discrete messages.

### Channel: `email` (default for all new users)

- Sent from `noreply@late.fyi` via Cloudflare Email Workers `send_email` binding (or SMTP relay)
- Subject: short status ("RE19750 → Platform 7")
- Body: full detail (current platform, delay, scheduled times, route summary, last-update timestamp)
- Threaded: all updates for one tracked train share `In-Reply-To` of the original confirmation reply, so the user's mail client groups them into one collapsed conversation
- Why default: requires zero setup from the user. Anyone with email gets full functionality immediately.

### Channel: `ntfy` (opt-in upgrade)

- POST to `https://ntfy.sh/<TOPIC>` (or self-hosted ntfy server)
- One topic per user, derived: `latefyi-<sha256(sender_email)[:16]>` — deterministic, stable for life
- All trains for that user push to the same topic. Two trains updating simultaneously = two POSTs = two separate notifications on the phone, interleaved by time. ntfy does not merge or deduplicate.
- Priority mapping:
  - Platform assigned, platform change, cancellation → `urgent` (priority 5)
  - Delay change → `high` (priority 4)
  - Status updates, arrivals → `default` (priority 3)
- Title: short ("RE19750 → Platform 7"), body: detail ("Amiens, on time, dep 14:02")
- Tags for filtering/emoji: `train`, `<operator>`, `urgent` if applicable
- No Click URL (no useful destination; operator deep links are unreliable)

### Channel: `both`

- Send to ntfy AND email simultaneously, no de-duplication
- Recommended for: cross-border trips, infrequent users, redundancy paranoia, and as the auto-fallback when ntfy delivery fails

### Channel selection logic

1. **Default for new sender**: `email` only — works immediately, no setup
2. **Opt in to ntfy**: user emails `config@late.fyi` with subject `CHANNELS ntfy` or `CHANNELS both`
3. **Opt-in reply**: server replies once with the user's personal ntfy topic URL + QR code. This is the **only** time a topic link appears in any communication. After scanning into the ntfy app, the user never sees the URL again — every train just works.
4. **Persistent preference**: user emails `config@late.fyi` with `CHANNELS <email|ntfy|both>` to change at any time. Server confirms the change, persists to `state/users/<sender_hash>.json`.
5. **Per-request override**: include `Channels: both` (or `ntfy` / `email`) header in a tracking request email — applies only to that train.
6. **Critical events override to `both`**: cancellation, full route disruption, train terminating early, replacement bus — these always send via every available channel regardless of preference. User safety beats user preference.

### Fallback behavior

- If ntfy POST returns non-2xx **three times in a row** for a user during one tracked train, automatically promote that request to `both` for the remainder of the trip and include in the next email: "ntfy delivery failing for this trip — also sending by email."
- Fallback is per-request, not persistent. Next email starts fresh on the user's stored preference.
- If user is on `email` only, ntfy failures are irrelevant — never attempted.

### Multi-train delivery (clarifying example)

Suppose Amr is on `CHANNELS both` and tracking three trains simultaneously:
- RE19750 (his own ride, Amiens → Lille)
- TGV 9876 (picking up his sister at Lille Europe)
- ICE 104 (a friend arriving at Brussels)

When all three update around the same time, his phone gets three ntfy notifications (titled by train number) AND three threaded emails (each in its own conversation). The trains are independent at the per-train layer; they converge only at delivery, where they remain visually distinct because each notification leads with the train number.

Zero collision. Zero per-train configuration. Zero risk of ntfy "running out of channels" — there's only one channel, and it carries everything.

---

## 7. Reply Behaviors

The system replies from `noreply@late.fyi` to the original sender. All replies are short, actionable, no marketing, no signature beyond `— late.fyi`.

### Standard footer (every email reply)

Every outbound email — confirmations, errors, updates, disambiguation prompts, STOP confirmations — ends with the same compact footer. Two purposes: it teaches the format passively over time, and it lists the STOP variants so the user always has an exit. The footer is **email-only**; ntfy push bodies stay short and skip it.

```
— late.fyi
─────
Format: <TRAINNUM>@late.fyi   Subject: From: <station>, To: <station>   (or just To: for pickup)
Optional: Trip: <name>   ·   Reply STOP / STOP TRIP <name> / STOP ALL   ·   Headers case-insensitive
```

For the rest of this section, `[FOOTER]` in templates is shorthand for this block. Implementation: append from a single string constant in `reply.js` so it's edited in one place.

### STOP variants (canonical)

| Reply | Effect |
|---|---|
| `STOP` | Stops the tracking the reply is threaded to (via `In-Reply-To`). If the reply is unthreaded, replies asking "Which train? Send `STOP <TRAINNUM>` or `STOP ALL`." |
| `STOP <TRAINNUM>` | Stops that specific train's tracking, regardless of threading. |
| `STOP TRIP <name>` | Stops every active tracking whose `trip` field matches `<name>` (case-insensitive). One reply summarizes how many were cleared. |
| `STOP ALL` | Stops every active tracking for the sender. |

### Confirmation (happy path, default email channel)

```
Subject: Tracking RE19750 — Amiens → Lille Flanders

Tracking RE19750 (TER, SNCF), Amiens → Lille Flanders.
Scheduled: dep 14:02 Amiens, arr 14:38 Lille Flanders.
Updates by email starting T-30 at 13:32.
Reply CHANNELS ntfy or CHANNELS both to switch delivery.

[FOOTER]
```

### Confirmation (user opted in to ntfy)

```
Subject: Tracking RE19750 — Amiens → Lille Flanders

Tracking RE19750 (TER, SNCF), Amiens → Lille Flanders.
Scheduled: dep 14:02 Amiens, arr 14:38 Lille Flanders.
Push starts T-30 at 13:32 via ntfy.
Reply CHANNELS email to switch back.

[FOOTER]
```

### ntfy opt-in reply (sent once, when user emails CHANNELS ntfy or both)

```
Subject: ntfy enabled for late.fyi

Your ntfy topic: https://ntfy.sh/latefyi-a3f9c2e1b4d8e7f2

Setup (one time):
1. Install ntfy from App Store, Play Store, or F-Droid
2. Open the app, tap +
3. Scan the QR below or paste the URL above

[QR code]

From now on, every train you track will push here. Multiple trains
in tandem? They all flow through this one topic — no extra setup,
no extra subscriptions, ever.

Reply CHANNELS email to disable ntfy. Reply CHANNELS both to keep
both channels active.

[FOOTER]
```

### Missing context

```
Subject: Need more info for RE19750

Got RE19750 but I don't know what you need.
- Reply with `To: <station>` if you're picking someone up at that station.
- Reply with `From: <station>` (and optionally `To: <station>`) if you're boarding.

Example: From: Amiens, To: Lille Flanders

[FOOTER]
```

### Train not found

```
Subject: Can't find train RE19750

No train matching "RE19750" found today or tomorrow.

Common confusions:
- TGV INOUI: 4 digits (e.g. 9876)
- TER/RE: 4-5 digits, often prefixed RE/TER
- Eurostar: prefixed EUR + 4 digits
- ICE: prefixed ICE + 3-4 digits
- Numbers reset daily — yesterday's RE19750 may not exist today

Check your booking confirmation and resend.

[FOOTER]
```

### Station not on route

```
Subject: Brussels not on RE19750's route

RE19750 runs: Amiens → Arras → Douai → Lille Flanders.
"Brussels" isn't a stop. Did you mean a different train, or did you mean
Lille Flanders (closest match)?

Reply with corrected station.

[FOOTER]
```

### Ambiguous station

```
Subject: Which Lille for RE19750?

"Lille" matches multiple stops on RE19750's route:
  1. Lille Flanders
  2. Lille Europe

Reply with just the number (1 or 2), or the full name.

[FOOTER]
```

See §7a for how the reply round-trip works.

### Train already passed

```
Subject: RE19750 already arrived

RE19750 arrived at Lille Flanders at 14:32 today. Nothing left to track.

If this is for tomorrow's RE19750, resend after midnight (train numbers
are per-day, not unique across days).

[FOOTER]
```

### Unauthorized sender

```
Subject: Sender not allowlisted

Email from <sender> isn't authorized for this latefyi instance.
Add to config.json `allowed_senders` and redeploy.

[FOOTER]
```

(In single-tenant deployment, this prevents the world from racking up your ntfy quota.)

### STOP confirmation (single train)

```
Subject: Stopped tracking RE19750

OK, no more updates for RE19750.

[FOOTER]
```

### STOP TRIP confirmation

```
Subject: Stopped trip "rome"

Cleared 3 trains from trip "rome":
  - EUR 9316 (Amsterdam → Paris Nord)
  - TGV 9523 (Paris → Milano Centrale)
  - FR 9681 (Milano Centrale → Roma Termini)

[FOOTER]
```

### STOP ALL confirmation

```
Subject: Stopped all tracking

Cleared 5 active trains. No more updates until you start fresh.

[FOOTER]
```

---

## 7a. Disambiguation Flow

Station names are commonly ambiguous ("Paris", "Brussels", "Lille", "Frankfurt"). The system handles this in two layers — first by trying to auto-resolve from context, and only falling back to a user round-trip when context isn't enough.

### Layer 1 — auto-resolve from context

When a user-typed station name fuzzy-matches multiple canonical stations, but **only one of those candidates appears on the resolved train's stop sequence**, take that one silently. Mention it in the confirmation reply so the user can correct it if wrong.

Example:
- User emails `EUR9310@late.fyi` with `From: Paris, To: Amsterdam`
- Eurostar EUR9310 only stops at **Paris Nord** in the Paris area
- System auto-resolves `Paris → Paris Nord` and confirms: "Tracking EUR9310, **Paris Nord** → Amsterdam Centraal. Reply with `STATION Paris Est` (etc.) within 24h to correct."

This eliminates the round-trip for the common case where the train constrains the answer.

### Layer 2 — numbered reply when truly ambiguous

When the user's text matches **more than one stop on the train's route**, reply asking them to pick. Format:

```
Subject: Which Paris for TGV6611?

"Paris" matches multiple stops on TGV6611's route:
  1. Paris Gare de Lyon
  2. Paris Bercy

Reply with just the number (1 or 2), or the full name.
— late.fyi
```

### Reply parsing (forgiving)

The user's reply is matched against `state.choices` in this order:
1. **Pure digit** (`1`, `2`, …) → index into `state.choices`. Out-of-range → re-ask.
2. **Fuzzy station name** (Levenshtein ≤ 2 against each `state.choices[i]`) → unique match wins.
3. **Still ambiguous** (e.g., user replied "Paris" again) → re-ask the same numbered list, increment a retry counter; after 3 retries, cancel and reply asking for a fresh email.
4. **No match at all** → reply with the numbered list plus a note that the answer wasn't recognized.

### State correlation (no tokens in body)

- Original tracking request stays in `pending/<msgid>.json` with `state.phase = "AWAITING_DISAMBIGUATION"` and `state.choices = [...]` and `state.disambiguationMessageId = "<our-reply-msgid>"`.
- The user's reply email's `In-Reply-To` header points at our disambiguation reply's `Message-ID`. Parser uses that header to find the pending request — no token needed in the email body.
- If the reply has no `In-Reply-To` matching a pending disambiguation, treat it as a fresh email and parse normally.

### Timeout

- Awaiting-disambiguation requests auto-cancel **24 hours after the disambiguation reply was sent**, OR at `poll_start_time - 5 minutes` (whichever is earlier — if the train is leaving in 20 minutes, we can't wait 24 hours).
- On timeout: send "Disambiguation timed out for `<TRAINNUM>`. Send a fresh email with a more specific station name." Move file to `done/` with `phase = "TIMED_OUT"`.

### Coverage

This flow applies to:
- Origin / destination station ambiguity (the common case)
- Train-number ambiguity from §18 ("Train 104 matches: ICE 104 and TGV 104") — uses the same numbered-reply mechanism, with `state.choices` containing operator-distinguished trains

---

## 8. Data Sources & Endpoint Strategy

### Library

`hafas-client` (npm). Wraps the HAFAS protocol used by most major European rail operators.

### POC findings (2026-04-28) — endpoint strategy revised

The original v1.0 PRD assumed per-country HAFAS profiles (SNCF, DB, SBB, NS, SNCB, Trenitalia, Eurostar). The POC probed every profile shipped by `hafas-client` and found:

| Original assumption | Reality (verified live) |
|---|---|
| SNCF profile | ❌ never shipped by hafas-client |
| SBB profile | ❌ never shipped |
| NS profile | ❌ never shipped |
| Trenitalia profile | ❌ never shipped |
| Eurostar profile | ❌ never shipped |
| DB profile | ❌ DNS dead (`reiseauskunft.bahn.de` decommissioned) |
| SNCB profile | ❌ rejected ("Invalid client version") |
| ÖBB profile | ✅ works, **and returns live data for stations across France, Germany, Belgium, Netherlands, Italy, Switzerland, UK, Luxembourg** |
| PKP profile | ✅ works with comparable cross-border coverage |

The ÖBB HAFAS endpoint is effectively a universal European rail query gateway. POC confirmed **live boards** at Frankfurt Hbf (ICE 1021, ICE 677, ICE 920, ICE 1272), Paris Nord (TER48535, TER47401, EUR 9303 to Amsterdam, RER E), Lille Flandres (TGV 7200 to Paris Nord, TER41901), Bruxelles Midi (IC 2021, IC 1921, IC 521), Hamburg Hbf (ICE 921, ICE 1707, ICE 1271), Roma Termini (R 20049), Zürich HB (S 5), Amsterdam Centraal (IC 2985), and London St Pancras. Every product family the system needs (TER, IC, EUR, TGV, ICE, RJ/NJ, regional, suburban) is surfaced with line name, fahrtNr, product, direction, planned/actual times, and platforms.

### Endpoint configuration

```json
{
  "primary":  "oebb",
  "fallback": "pkp"
}
```

That's the entire endpoint table. No per-country routing, no operator-prefix guessing.

### Resolution algorithm

1. Query **ÖBB** for the train using the user's `From:` station departure board (window: scheduled departure ± 30 min, or "today/tomorrow" if no time hint), match by line name + fahrtNr.
2. If no match: retry against **PKP** with the same query.
3. If still no match: reply with §7's "train not found" template.
4. Once matched, fetch full trip via `client.trip(tripId)` to get the stop sequence for §7a disambiguation and §9 polling.

### Fallback during polling

- If ÖBB returns null platform at T-15 for Mode B, query PKP and use whichever has data.
- If ÖBB returns 5xx or times out three consecutive polls, switch to PKP for the remainder of the session.
- Log endpoint disagreements (e.g., ÖBB says delay +5, PKP says delay +12 for the same train) to `disagreement.log` for later tuning.
- **Never merge** — pick one source per poll, log the choice. Merging multi-source data invites bugs at 6am in Gare du Nord.

### Durability risk (NEW — must be acknowledged)

The system now has a **single-vendor data dependency on ÖBB's HAFAS endpoint**. PKP fallback partially mitigates but offers similar cross-border coverage from a similar third-party gateway. If both ÖBB and PKP lock down their public HAFAS gateways the way DB and SNCB did, the project breaks until alternative data sources (operator-specific REST APIs, navitia.io, Transport API, etc.) are integrated.

Mitigation posture for v1:
- Accept the risk; this is a personal-use tool, not a service we owe SLAs on.
- `disagreement.log` doubles as an early-warning signal — sudden divergence may indicate one endpoint deteriorating.
- §24 (future considerations) gains an item: "abstract `resolve.js` and `poll.js` behind a data-source interface so a non-HAFAS provider can be slotted in without touching the rest of the system."

---

## 9. Polling Cadence & Change Detection

### Diff-based push

Every poll produces a `TrainState` snapshot:

```js
{
  trainId: "RE19750",
  scheduledDeparture: "2026-04-28T14:02:00+02:00",
  actualDeparture: "2026-04-28T14:08:00+02:00",
  delayMinutes: 6,
  platform: "7",
  platformScheduled: null,
  status: "on_time" | "delayed" | "cancelled" | "replaced" | "departed" | "arrived",
  route: [
    { station: "Amiens",     scheduledArr: null,             actualArr: null,             scheduledDep: "...", actualDep: "...", platform: "7" },
    { station: "Arras",      scheduledArr: "...", actualArr: "...", ... },
    ...
  ],
  endpoint: "sncf",
  pollTimestamp: "2026-04-28T13:48:23+02:00"
}
```

Push fires when diffing previous vs current snapshot reveals one of:

| Change | Threshold | Priority |
|---|---|---|
| `platform` null → value | any | urgent |
| `platform` value → different value | any | urgent |
| `delayMinutes` change | ≥2 min pre-departure, ≥5 min in-transit | high |
| `status` → cancelled | any | urgent |
| `status` → replaced | any | urgent |
| `status` → arrived (Mode A or at `To:` in Mode B) | terminal | default |
| Downstream stop's delay propagating to `To:` arrival | ≥5 min | high |
| Train terminating before `To:` | any | urgent |

### Suppression

- No push for unchanged state (avoid every-30s spam)
- No push for delay oscillation within ±1 min of last pushed value (debounce)
- Mandatory push at start of polling (T-30) regardless of changes — confirms tracking is live
- Mandatory push at terminal state — confirms tracking ended cleanly

---

## 10. State Machine

```
┌──────────┐
│ RECEIVED │  email arrives at Worker
└────┬─────┘
     │  Worker validates sender, hands to parser
     ▼
┌──────────┐
│  PARSED  │  local-part → train number; subject/body → mode + stations
└────┬─────┘
     │  resolver looks up train via hafas-client (oebb → pkp fallback)
     │  if station ambiguous on route AND not auto-resolvable from context:
     ▼
┌──────────────────────────┐
│ AWAITING_DISAMBIGUATION  │  numbered reply sent; waiting on user pick
└────┬─────────────────────┘
     │  user replies (digit or station name); In-Reply-To matches
     │  timeout: 24h after disambiguation reply, OR poll_start_time-5min
     ▼
┌────────────┐
│ VALIDATED  │  train exists, route validated, stations match
└────┬───────┘
     │  scheduler writes pending/<msgid>.json with poll_start_time
     │  reply confirmation sent to user
     ▼
┌────────────┐
│ SCHEDULED  │  waiting for poll_start_time
└────┬───────┘
     │  wake.sh cron (every 1min) moves due files to active/
     ▼
┌──────────┐
│  ACTIVE  │  poller daemon picks up, polls every 30-60s, diffs, pushes
└────┬─────┘
     │  terminal event (arrival / cancellation / past grace)
     ▼
┌──────┐
│ DONE │  moved to done/<msgid>.json with final state
└──────┘
```

Failure transitions (any state → `ERROR`):
- HAFAS endpoint down (both ÖBB and PKP) → retry 3x → escalate to user via push: "Lost tracking for RE19750, data source unavailable"
- Parser failure → reply with error, no state file written
- Validator failure → reply with error, no state file written
- Disambiguation timeout (3 retries OR 24h OR poll_start_time-5min) → move to `done/` with `phase = "TIMED_OUT"`, send timeout reply

`ERROR` files moved to `errors/<msgid>.json` for inspection. No retry except where explicitly noted (HAFAS 5xx).

---

## 11. Architecture

### Components

1. **Cloudflare Email Worker** (edge): receives email, validates sender, posts JSON to Node service
2. **Node service** (VPS or home server): parser, resolver, scheduler, poller, push dispatcher
3. **ntfy app on phone**: subscribed to user's private topic
4. **Cron** (`wake.sh`): activates due requests every minute
5. **File system**: `pending/`, `active/`, `done/`, `errors/` directories as the only state store

### File layout

```
latefyi/
├── package.json              # deps: hafas-client only
├── config/
│   ├── config.json           # allowed_senders, ntfy server, channels default,
│   │                         # large_terminals list, polling overrides
│   └── endpoints.json        # operator → HAFAS profile mapping
├── src/
│   ├── parse.js              # email payload → {trainNum, mode, from, to, channels}
│   ├── resolve.js            # train number → {endpoint, route, schedule, validation}
│   ├── reply.js              # send reply emails (via Worker callback or SMTP)
│   ├── schedule.js           # write pending/<msgid>.json with poll_start_time
│   ├── poll.js               # active loop: hafas-client → diff → push
│   ├── diff.js               # state comparison, decides what to push
│   ├── push.js               # ntfy POST + email send dispatch
│   ├── channels.js           # channel preference resolution per sender/request
│   ├── users.js              # per-user state file CRUD, opt-in flow handler
│   ├── stations.js           # fuzzy station name matching, alias table
│   └── server.js             # HTTP endpoint receiving Worker callbacks
├── scripts/
│   ├── wake.sh               # cron-invoked: scan pending/, move due → active/
│   ├── setup-ntfy.sh         # generate user topic + QR for operator's own use
│   └── test-email.sh         # local parser test fixture runner
├── worker/
│   ├── wrangler.toml
│   └── index.js              # Cloudflare Email Worker
├── state/
│   ├── users/                # per-user lifetime state (channel pref, ntfy topic)
│   ├── pending/              # per-train, waiting for poll_start_time
│   ├── active/               # per-train, currently being polled
│   ├── done/                 # per-train, terminal state
│   └── errors/               # parser/validator/runtime failures
├── logs/
│   ├── audit.jsonl           # one line per state transition
│   ├── disagreement.log      # endpoint primary vs fallback diffs
│   └── push.jsonl            # one line per push attempt (success/failure)
└── README.md
```

### Lines of code estimate

| Component | LOC |
|---|---|
| `parse.js` | 60 |
| `resolve.js` | 90 |
| `reply.js` | 60 |
| `schedule.js` | 30 |
| `poll.js` | 80 |
| `diff.js` | 70 |
| `push.js` | 60 |
| `channels.js` | 40 |
| `users.js` | 50 |
| `stations.js` | 60 |
| `server.js` | 40 |
| `wake.sh` | 20 |
| Worker `index.js` | 60 |
| **Total** | **~720** |

Plus configs and tests. Single dependency: `hafas-client`. (QR generation in `users.js` uses a tiny inline `qrcode-terminal` style ASCII renderer or shells out to `qrencode` if available — no extra npm dep required.)

---

## 12. Storage Schema

### `pending/<msgid>.json` and `active/<msgid>.json`

```json
{
  "msgid": "abc123@late.fyi",
  "received_at": "2026-04-28T10:15:00Z",
  "sender": "amr@example.com",
  "request": {
    "trainNum": "RE19750",
    "mode": "B",
    "from": "Amiens",
    "to": "Lille Flanders",
    "channels": "ntfy"
  },
  "resolved": {
    "endpoint": "sncf",
    "trainId": "SNCF:RE19750:2026-04-28",
    "scheduledDeparture": "2026-04-28T14:02:00+02:00",
    "scheduledArrivalAtTo": "2026-04-28T14:38:00+02:00",
    "route": ["Amiens", "Arras", "Douai", "Lille Flanders"]
  },
  "schedule": {
    "poll_start_time": "2026-04-28T13:32:00+02:00",
    "poll_end_time": "2026-04-28T15:08:00+02:00"
  },
  "state": {
    "phase": "PRE_DEPARTURE",
    "lastPolledAt": null,
    "lastPushedSnapshot": null,
    "consecutivePollFailures": 0,
    "endpointInUse": "sncf"
  },
  "pushes": []
}
```

### `done/<msgid>.json`

Same schema, with `state.phase = "DONE"` and `pushes` populated. Retained 30 days then auto-pruned by `wake.sh`.

### `state/users/<sender_hash>.json` (per-user, lifetime)

One file per allowlisted sender. Created lazily on first email from a sender, updated on `CHANNELS` reconfiguration. Hash is `sha256(sender_email)[:16]` — same derivation as the ntfy topic suffix, so the topic is implicit in the filename.

```json
{
  "sender_hash": "a3f9c2e1b4d8e7f2",
  "sender_email": "amr@example.com",
  "channel": "email",
  "ntfy_topic": "latefyi-a3f9c2e1b4d8e7f2",
  "ntfy_opt_in_sent_at": null,
  "first_seen_at": "2026-04-15T09:22:00Z",
  "last_seen_at": "2026-04-28T10:15:00Z",
  "trains_tracked_count": 12
}
```

When user emails `CHANNELS ntfy` or `CHANNELS both`:
- Update `channel`
- If `ntfy_opt_in_sent_at` is null: send the QR/URL opt-in reply (see §7), set `ntfy_opt_in_sent_at = now`
- If already set: just confirm the channel change, don't resend the QR (they already have it)

When user emails `CHANNELS email`:
- Update `channel = "email"`
- ntfy topic remains in the file (so re-opting back in is instant, no fresh QR needed unless they ask)

### Why files, not a database

- Bare-suite aesthetic: zero deps, debuggable with `cat` and `ls`
- Modest scale: handful of users, dozens of concurrent active trains at most
- Crash-safe: filesystem rename is atomic
- Backup: `tar czf backup.tgz state/`
- Per-user files separate cleanly from per-train files — independent lifetimes, independent storage

---

## 13. Component Specifications

### 13.1 `parse.js`

**Input:** raw email JSON from Worker callback (`{from, to, subject, body, msgid, headers}`)

**Output:** one of `{kind: "track", trainNum, mode, from, to, trip, channels}`, `{kind: "stop", scope, target}`, `{kind: "config", channel}`, `{kind: "disambiguation_reply", inReplyTo, answer}`, or `ParseError`.

**Logic:**
1. **Reserved local-parts first.** If `to` local-part is a reserved keyword (`config`, `stop`, `help`), route to the matching handler before applying the train-number regex. Otherwise fall through to step 2.
2. **Disambiguation reply check.** If the email's `In-Reply-To` header matches a known `state.disambiguationMessageId` of a pending request, return `{kind: "disambiguation_reply", inReplyTo, answer}` where `answer` is the stripped first non-empty body line. (See §7a.)
3. **STOP detection.** If the body or subject begins with `STOP` (case-insensitive), parse the variant: `STOP` alone, `STOP <TRAINNUM>`, `STOP TRIP <name>`, `STOP ALL`. Return `{kind: "stop", scope, target}`.
4. **Train-number extraction.** Take the local-part of `to`. Uppercase. Validate against `/^[A-Z]{0,4}\d{2,5}$/`. Reject otherwise with `ParseError("invalid_trainnum")`.
5. **Header extraction.** Combine subject + first non-empty body line. Match `/(from|to|trip|channels):\s*([^,\n]+)/gi` — keys case-insensitive, values trimmed and preserved verbatim.
6. **Mode determination.** `from` present → `B` (boarding); only `to` present → `A` (pickup); neither → `MISSING` → §7 missing-context reply. **Never** auto-pick `from`/`to` from the train's route, even if it's unambiguous (decision §22-27).
7. **Trip validation.** If `trip` present, validate against `/^[A-Za-z0-9_-]{1,32}$/`. Invalid → reply asking for a corrected tag. Empty/missing → null.
8. **Channels resolution.** Default to user's stored preference from `state/users/<sender_hash>.json`, or `email` if no user record yet. Per-request `Channels:` header overrides for this train only.
9. Return parsed object.

### 13.2 `resolve.js`

**Input:** parsed object

**Output:** `{endpoint, trainId, route, schedule, validation, disambiguationNeeded?}` or `ResolveError`

**Logic:**
1. Resolve `from` station via ÖBB `client.locations()` to get a station ID. (If `from` is missing — Mode A — start from `to` instead.)
2. Query ÖBB `client.departures(stationId, { duration: 90 })` for the window covering the user's intended trip (default: now → +24h; narrowed if user provided times).
3. Match against the user's train number: compare against `line.fahrtNr` and the trailing digits of `line.name`. Accept first exact match.
4. If no match on ÖBB: repeat steps 1-3 against PKP.
5. If still no match: return `ResolveError("train not found")` → §7 reply.
6. On match, call `client.trip(tripId)` to get full stop sequence.
7. Validate `from` and `to` against the stop sequence using `stations.js`. For each:
   - Unique route stop matching → resolved.
   - Multiple route stops match the user's text (e.g., "Paris" matches both Paris Nord and Paris Bercy on route) → set `disambiguationNeeded` for that field, attach the candidate list. Caller (`server.js`) sends the §7a numbered reply and parks the request in `AWAITING_DISAMBIGUATION`.
   - No route stops match → return `ResolveError("station not on route")` → §7 reply with route summary.
8. Return resolved data with `endpoint` recorded so the poller starts on the same source.

No operator-prefix guessing. No per-country routing. ÖBB is the single primary; PKP is the single fallback.

### 13.3 `stations.js`

**Input:** user-typed station name + canonical route stop list

**Output:** matched canonical name or `null` (with suggested alternatives)

**Logic:**
1. Normalize: lowercase, strip punctuation, collapse whitespace, transliterate accents
2. Exact match first
3. Alias table lookup (e.g., "Paris Nord" → "Paris Gare du Nord", "Lille" → ambiguous between "Lille Flanders" and "Lille Europe")
4. Levenshtein distance ≤ 2
5. Return best match if unambiguous, list of candidates if ambiguous, null if no match

Alias table maintained in `config/aliases.json`, seeded with common cases, extensible.

### 13.4 `schedule.js`

**Input:** resolved object

**Output:** writes `pending/<msgid>.json`, returns confirmation data for reply

**Logic:**
1. Compute `poll_start_time = scheduledDeparture - 30min` (or -45min for large terminals from `config.json`)
2. Compute `poll_end_time` per Mode A/B rules
3. Atomic write: write to `pending/<msgid>.json.tmp`, rename to `.json`
4. Return data for reply

### 13.5 `poll.js`

**Input:** an `active/<msgid>.json` file

**Output:** updates same file in place, dispatches pushes, eventually moves to `done/`

**Logic:**
```
loop:
  load active/<msgid>.json
  call hafas-client for current train state
  if endpoint failure:
    increment consecutivePollFailures
    if >= 3: switch to fallback endpoint
    if >= 6: emit "tracking lost" push, move to errors/
    continue with backoff
  build TrainState snapshot
  diff against state.lastPushedSnapshot
  if changes: push.js dispatch
  update state.lastPushedSnapshot, state.lastPolledAt
  atomic write
  if terminal: move to done/, exit
  sleep per cadence rules
```

### 13.6 `diff.js`

Pure function: `(prev: TrainState, curr: TrainState) → PushEvent[]`

Each `PushEvent`: `{type, priority, title, body, tags}`

### 13.7 `push.js`

**Input:** `(channelPref, topic, email, pushEvent[])`

**Logic:**
1. For each event:
   - If `channelPref` includes `ntfy`: POST to ntfy server, log result
   - If `channelPref` includes `email` OR event is critical: send email, log result
   - On 3 consecutive ntfy failures for this request: promote to `both` for the rest of the trip, send notice in next email
2. Append to `logs/push.jsonl`

### 13.7a `users.js`

**Responsibility:** per-user state (channel preference, ntfy topic, opt-in tracking).

**Functions:**
- `getOrCreate(senderEmail) → UserRecord`: load `state/users/<hash>.json`, create with defaults if absent (`channel: "email"`, `ntfy_topic` derived but not yet "active")
- `setChannel(senderEmail, channel) → {wasFirstNtfyOptIn: boolean}`: update channel field, return whether this is the first time the user opted into ntfy (triggers QR reply)
- `getNtfyTopic(senderEmail) → string`: deterministic, doesn't require existing user record
- `incrementTrainCount(senderEmail)`: bump `trains_tracked_count`, update `last_seen_at`

**Atomic writes:** all updates write to `<file>.tmp` then rename. No locking needed at this scale.

### 13.8 `wake.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

NOW=$(date -u +%s)

# Activate due pending requests
for f in state/pending/*.json; do
  [ -e "$f" ] || continue
  POLL_START=$(jq -r '.schedule.poll_start_time' "$f")
  POLL_START_TS=$(date -u -d "$POLL_START" +%s)
  if [ "$POLL_START_TS" -le "$NOW" ]; then
    mv "$f" "state/active/$(basename "$f")"
    echo "Activated: $(basename "$f")" >> logs/audit.jsonl
  fi
done

# Prune done/ older than 30 days
find state/done -name "*.json" -mtime +30 -delete

# Ensure poller is running
if ! pgrep -f "node src/poll-runner.js" > /dev/null; then
  nohup node src/poll-runner.js >> logs/poller.log 2>&1 &
fi
```

Crontab: `* * * * * /opt/latefyi/scripts/wake.sh`

### 13.9 `worker/index.js` (Cloudflare Email Worker)

```js
export default {
  async email(message, env, ctx) {
    const allowedSenders = env.ALLOWED_SENDERS.split(',');
    if (!allowedSenders.includes(message.from)) {
      // Silent drop; do not bounce (avoids backscatter to spoofed senders)
      return;
    }

    const body = await new Response(message.raw).text();
    const subject = message.headers.get('subject') || '';

    const payload = {
      msgid: message.headers.get('message-id'),
      from: message.from,
      to: message.to,
      subject,
      body,
      receivedAt: new Date().toISOString(),
    };

    const resp = await fetch(env.TRAINME_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.TRAINME_INGEST_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.error('Ingest failed', resp.status);
    }
  }
};
```

`wrangler.toml` configures the email route `*@late.fyi → this worker` and the secrets `ALLOWED_SENDERS`, `TRAINME_INGEST_URL`, `TRAINME_INGEST_TOKEN`.

---

## 14. Cloudflare Worker setup

### Steps for the developer

1. `npm install -g wrangler`
2. `wrangler login`
3. Create Worker: `wrangler init worker`
4. Set secrets:
   ```
   wrangler secret put ALLOWED_SENDERS    # comma-separated list
   wrangler secret put TRAINME_INGEST_URL # https://<your-vps>/ingest
   wrangler secret put TRAINME_INGEST_TOKEN # random 32-byte hex
   ```
5. Deploy: `wrangler deploy`
6. In Cloudflare dashboard → Email → Email Routing → Routing Rules:
   - Catch-all rule: `*@late.fyi` → "Send to a Worker" → select deployed worker
7. Verify by sending test email; check Worker logs in dashboard

### Why edge Worker for ingest

- Email Routing requires a Cloudflare-side handler (Worker or forward-to-address)
- A Worker lets us validate sender at the edge before ever waking the VPS
- Free tier covers 100k requests/day, vastly more than personal use will need

---

## 15. Domain & DNS setup

### Steps

1. Buy domain at any registrar (Cloudflare Registrar at-cost recommended; Namecheap, Porkbun fine alternatives)
2. In Cloudflare dashboard, add the site (free plan)
3. Cloudflare gives you two nameservers (e.g., `ns1.cloudflare.com`, `ns2.cloudflare.com`)
4. At registrar, change nameservers to those two values. Propagation: minutes to 24 hours.
5. In Cloudflare → Email → Email Routing → Enable. This auto-adds the required MX, SPF, DKIM, DMARC records.
6. Verify DNS propagation: `dig MX late.fyi +short` should return Cloudflare's mail servers.

No paid Cloudflare plan required. Workers free tier and Email Routing free tier are both sufficient.

---

## 16. ntfy setup

ntfy is **opt-in per user**. The operator does not need to set up ntfy at all if no users want it. Email works for everyone out of the box.

### How a user opts in

1. User emails `config@late.fyi` with subject `CHANNELS ntfy` or `CHANNELS both`
2. `users.js` updates their `state/users/<sender_hash>.json`, sets `channel`, and (if first time) triggers an opt-in reply email containing:
   - Their personal ntfy topic URL (deterministic: `latefyi-<sha256(email)[:16]>`)
   - A QR code (rendered in HTML email body) for one-tap mobile subscription
   - Brief setup instructions (install app, scan QR, done)
3. User installs the ntfy app, scans the QR or pastes the URL → subscribed
4. From this point, every train this user tracks pushes to that topic. Lifetime. No further setup ever.

### Server-side ntfy options

**Option A: Public ntfy.sh (zero operator infra)**
- POST directly to `https://ntfy.sh/<topic>`
- Topics are unguessable (16 hex chars from sha256), effectively private
- Free, rate-limited, operated as a public service
- Use this unless you have a privacy reason not to

**Option B: Self-hosted ntfy (full control)**
- Run `ntfy serve` on the VPS (single Go binary, no deps)
- Set `ntfy.base_url` in `config.json` to the self-hosted domain
- Use access tokens via `ntfy.auth_token` for true privacy
- Same ntfy app supports custom servers — users still subscribe via QR/URL identically
- Adds one process to operate, eliminates external dependency

Recommendation: start with Option A, migrate to B if usage grows or privacy demands warrant it.

### `setup-ntfy.sh` (operator's own use)

```bash
./scripts/setup-ntfy.sh amr@example.com
# → Topic: latefyi-a3f9c2e1b4d8e7f2
# → Subscribe URL: https://ntfy.sh/latefyi-a3f9c2e1b4d8e7f2
# → QR code printed to terminal
```

This bypasses the email opt-in flow for the operator's own setup convenience. Equivalent to emailing yourself `CHANNELS ntfy` and reading the reply, but useful during initial deployment when you may not yet have outbound email working.

The topic is `sha256(sender_email)[:16]` so it's reproducible without storing state — running the script again any time produces the same topic.

---

## 17. Configuration

### `config/config.json`

```json
{
  "allowed_senders": ["amr@example.com", "friend@example.com"],
  "default_channel": "email",
  "ntfy": {
    "base_url": "https://ntfy.sh",
    "auth_token": null,
    "topic_prefix": "latefyi-"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "user": "noreply@late.fyi",
    "pass_env": "SMTP_PASS",
    "from_address": "noreply@late.fyi"
  },
  "ingest_token_env": "TRAINME_INGEST_TOKEN",
  "ingest_port": 8787,
  "large_terminals": [
    "Paris Gare du Nord",
    "Paris Gare de Lyon",
    "Paris Montparnasse",
    "Paris Gare de l'Est",
    "Frankfurt Hbf",
    "Berlin Hbf",
    "München Hbf",
    "Roma Termini",
    "Milano Centrale",
    "Brussels Midi/Zuid"
  ],
  "polling": {
    "default_pre_t30_minutes": 30,
    "large_terminal_pre_t_minutes": 45,
    "pre_departure_interval_seconds": 30,
    "in_transit_interval_seconds": 60,
    "arrival_interval_seconds": 30,
    "grace_minutes": 30
  },
  "diff_thresholds": {
    "delay_pre_departure_minutes": 2,
    "delay_in_transit_minutes": 5
  },
  "log_retention_days": 30
}
```

### `config/endpoints.json`

(See section 8.)

### `config/aliases.json`

```json
{
  "Paris Nord": "Paris Gare du Nord",
  "Paris Lyon": "Paris Gare de Lyon",
  "Lille": "AMBIGUOUS:Lille Flanders|Lille Europe",
  "Brussels": "Brussels Midi/Zuid",
  "Bruxelles Midi": "Brussels Midi/Zuid",
  "Frankfurt": "Frankfurt Hbf",
  "Munich": "München Hbf"
}
```

---

## 18. Edge cases & error handling

| Case | Behavior |
|---|---|
| Email arrives before train is scheduled (booked weeks ahead) | Schedule normally; `wake.sh` activates at T-30. |
| Email arrives after train has already departed | If still in transit and Mode B, start polling immediately. If Mode A and >30min past arrival, reply "already arrived". |
| Email arrives after train cancelled | Reply with cancellation status; no tracking. |
| Train number matches multiple operators (e.g., "104" exists on DB and SNCF same day) | Reply: "Train 104 matches: ICE 104 (DB, Frankfurt→Basel) and TGV 104 (SNCF, Paris→Marseille). Reply with operator prefix or distinguishing detail." |
| Cross-border train with different IDs per endpoint | Endpoint resolver picks operator-of-record (the one running the train), per route table. |
| Train splits mid-route (e.g., ICE divides at Hannover) | Detect via HAFAS `trip().stopovers` containing split markers; push notice; continue tracking the half going to user's `To:`. |
| Replacement bus | Status `replaced`; push includes "Bus from <station> to <station>" if HAFAS provides; otherwise "Replacement service — check operator app". |
| HAFAS endpoint completely down (both primary and fallback) | After 6 consecutive failures, push "Lost tracking, data source unavailable", move to `errors/`, do not retry automatically. |
| Sender's domain has SPF/DKIM failures | Worker still accepts (sender allowlist is the auth boundary), but logs it. |
| Reply email bounces | Logged to `errors/`, no retry. User won't see confirmation but tracking proceeds. |
| ntfy delivery fails persistently | Auto-fallback to email per section 6. |
| User sends `STOP` for unknown msgid | Reply "No active tracking matches that. Send STOP <trainNum> to stop a specific train, or STOP ALL to clear everything." |
| `STOP ALL` | Move all `active/<msgid>.json` for sender to `done/` with note. |
| `STOP TRIP <name>` | Move all `active/<msgid>.json` for sender where `request.trip` matches `<name>` (case-insensitive) to `done/`. Reply summarizes count + train list. If no matches, reply "No active trips named '<name>'." |
| `STOP TRIP` for a tag with zero pending/active matches but a recently-completed match | Reply "No *active* trains in trip '<name>' (3 already completed in the last 24h)." |
| Disk fills up | `wake.sh` log retention prevents unbounded growth in normal operation. Add disk monitoring out of band. |

---

## 19. Security & Privacy

- **Sender allowlist**: only allowlisted senders' emails are processed. Everything else dropped silently at Worker.
- **Ingest auth**: Worker → VPS uses bearer token over HTTPS. Token rotated by setting new secret in Wrangler.
- **No PII storage beyond email + train number**: state files contain sender email and train metadata only. No location tracking, no payment info, no booking references.
- **ntfy topic derivation**: `sha256(sender_email)[:16]` — topic doesn't reveal email but is stable per-sender.
- **No telemetry, no analytics, no remote sinks.** All logs local.
- **Audit log** (`logs/audit.jsonl`): one JSONL line per state transition, for forensic debugging only.
- **Outbound traffic** limited to: Cloudflare API (replies), HAFAS endpoints, ntfy server, optional SMTP relay. Document this in README for transparency.
- **Token storage**: secrets in environment variables, never in committed files. `.env` in `.gitignore`.

---

## 20. Testing strategy

### Unit tests
- `parse.js`: 20+ fixture emails (happy path, missing headers, malformed train numbers, multiple `To:`, headers in body vs subject)
- `stations.js`: alias table, fuzzy match cases (typos, accents, ambiguous names)
- `diff.js`: pure-function tests with synthetic before/after `TrainState` pairs
- `channels.js`: preference resolution under various combinations

### Integration tests (offline)
- `resolve.js` with mocked `hafas-client` returning canned responses for known trains
- `poll.js` with mocked endpoint and clock advancement

### Manual smoke test (live)
1. Send test email from allowlisted address for a train scheduled in next hour
2. Verify confirmation reply received
3. Verify push at T-30
4. Compare pushes against operator app over the journey
5. Verify terminal push on arrival

### Load test
Not applicable — single-tenant scale. At most ~10 concurrent active requests.

---

## 21. Deployment

### Minimum infra

- 1× Cloudflare account (free)
- 1× domain (~$10/yr)
- 1× small VPS (1 vCPU, 512MB RAM, 10GB disk — e.g., Hetzner CX11 ~€4/mo) OR a home server / Raspberry Pi
- Optional: 1× SMTP relay account if not using Cloudflare email send (free tier on most providers)

### Deploy steps

1. `git clone <repo> /opt/latefyi`
2. `cd /opt/latefyi && npm install`
3. Edit `config/config.json` with your sender email(s) and SMTP creds
4. Set env vars (`SMTP_PASS`, `TRAINME_INGEST_TOKEN`)
5. Open ingest port: `sudo ufw allow 8787/tcp` (or put behind reverse proxy with TLS)
6. Add cron: `* * * * * /opt/latefyi/scripts/wake.sh`
7. Deploy Worker: `cd worker && wrangler deploy`
8. Set Worker secrets (see section 14)
9. Configure Cloudflare Email Routing
10. Run `./scripts/setup-ntfy.sh <your-email>`
11. Subscribe phone to printed ntfy topic
12. Send test email, verify end-to-end

### Reverse proxy (recommended)

Put the ingest endpoint behind nginx/caddy with TLS. Caddy example:

```
ingest.late.fyi {
  reverse_proxy localhost:8787
}
```

Update `TRAINME_INGEST_URL` Worker secret accordingly.

---

## 22. Decisions Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Local-part = train number, headers = optional context | Maximally one-shot; train number is the only mandatory input |
| 2 | `From:` present = boarding mode; absent = pickup mode | Encodes intent in single bit, no flags or separate addresses |
| 3 | One train per email | Multi-train parsing adds ambiguity; multi-leg = multiple emails |
| 4 | Primary + fallback endpoint, never merge | Determinism beats coverage; merging multi-source live data is a debugging nightmare |
| 5 | File-based state (no DB) | Modest scale doesn't warrant a DB; `cat`/`ls` debuggability is bare-suite-aligned |
| 6 | Cloudflare Email Worker for ingest, not own SMTP | SMTP setup is a months-long deliverability project; Cloudflare handles it free |
| 7 | **Email as default channel, ntfy as opt-in upgrade** (REVISED from original "ntfy primary, email fallback") | Email works for everyone with zero install; this system is shared with friends/family who shouldn't need to install an app to use it. ntfy is offered for users who explicitly want push. |
| 8 | Critical events override channel preference | Cancellation safety > user preference |
| 9 | Sender allowlist as auth boundary | Allowlist is simpler and more robust than per-request signing; supports multi-user without auth complexity |
| 10 | Topic derived from `sha256(sender_email)[:16]` | Stable, private, stateless, regenerable |
| 11 | Polling cadence varies by phase | T-30 to departure needs density; in-transit is sparser |
| 12 | Diff-based push, not poll-based | Avoid spam; debounce delay oscillation |
| 13 | Cron + `wake.sh` for scheduling | Matches Amr's bare-suite pattern; no in-process scheduler complexity |
| 14 | Single dependency: `hafas-client` | Bare-suite aesthetic; everything else is Node built-ins |
| 15 | No web UI, no dashboard | Out of scope; operator apps cover that need |
| 16 | Domain via Cloudflare Registrar (recommended, not required) | At-cost, integrates seamlessly with Email Routing |
| 17 | Reply emails threaded via `In-Reply-To` | Mail clients group updates per train automatically |
| 18 | 30-day retention for `done/` and logs | Enough for debugging recent issues, prevents unbounded growth |
| 19 | **Three lifetimes: per-user, per-train, per-change** | Cleanly separates lifetime preference (channel, ntfy topic) from ephemeral tracking (one trip) from delivery events. Eliminates the "do I need a new ntfy topic per train?" question — no, you don't. |
| 20 | **One ntfy topic per user, all trains stream through it** | Stable subscription, no setup per train, unlimited concurrent trains. ntfy doesn't merge POSTs so each train update is its own notification. |
| 21 | **ntfy opt-in via `CHANNELS ntfy` to `config@late.fyi`; QR sent once** | The QR/URL is the only friction point in the entire ntfy setup, and it happens exactly once per user, ever. After that, the channel is invisible. |
| 22 | **`state/users/<sender_hash>.json` for per-user state** | Separates user lifetime data from per-train data; clean schema boundary; trivial to inspect with `cat` |
| 23 | **Multi-user supported within single deployment** (allowlist) | Same instance can serve operator + friends + family; each gets independent channel preference and (if opted in) independent ntfy topic. Not "SaaS" — still single deployment, no auth, no billing. |
| 24 | **Single primary endpoint (ÖBB), single fallback (PKP)** — REPLACES original per-operator endpoint table | POC (2026-04-28) found native SNCF/SBB/NS/Trenitalia/Eurostar profiles never shipped in `hafas-client`; DB profile has dead DNS; SNCB profile rejects clients. ÖBB returns live data for stations across the entire EU plus UK and is the de-facto universal HAFAS gateway. Massive simplification: ~80 LOC of `resolve.js` becomes ~20. Acknowledged single-vendor data risk (see §8). |
| 25 | **Two-layer station disambiguation: auto-resolve from route context first, numbered reply only when truly ambiguous** | Most ambiguities (Paris/Brussels/Lille) collapse to one option once we have the train's route. Auto-resolving silently in those cases eliminates ~80% of round-trips. The remaining ambiguous cases get a numbered reply that accepts either a digit or a fuzzy-matched station name (forgiving parsing) — matches what users naturally do. |
| 26 | **One train per email, hard rule. No multi-leg itinerary parsing — ever.** | Three reasons: (a) the *first* train is the load-bearing event for any chain — if it slips, the rest of the plan is dead anyway and the user is replanning, not waiting on automation; (b) booking-confirmation parsing is a moving-target maintenance black hole (each operator's HTML format, multiple languages, yearly drift); (c) plans change constantly and a tracked itinerary drifts out of sync with reality faster than a single-train tracking does. Multi-leg friction is mitigated instead by the optional `Trip:` tag and `STOP TRIP <name>` (cheap teardown when a chain dies) — the *real* multi-train UX win is fast unwind, not fast setup. |
| 27 | **Always require explicit `From:` and `To:` — never auto-pick from train route, even when unambiguous** | Building the habit of typing the headers is the design goal. Auto-picking saves one round-trip in the easy case but trains users to expect the system to guess, which fails in the hard cases (multi-Paris, Lille Flandres vs Europe). Forcing explicit headers also keeps the parser predictable and makes the §7 "missing context" reply the universal entry-point doc. |
| 28 | **Standard footer on every outbound email** | Every reply ends with the same compact footer (format reminder + STOP variants + Trip tag + case-insensitivity note). Reasons: (a) passive teaching — users absorb the grammar by repetition without reading docs; (b) every email is self-contained — no "where do I find STOP?" moment; (c) one source of truth in `reply.js` keeps the footer easy to update everywhere. ntfy push bodies skip the footer to stay short. |

---

## 23. Out of scope (NO-GO list)

To prevent scope creep over time, the following are explicitly out of scope and should be rejected if proposed:

- ❌ Booking, ticketing, refunds, seat reservation
- ❌ Journey planning ("how do I get from X to Y?")
- ❌ Multi-tenant SaaS, user accounts, billing, payment
- ❌ Web UI, dashboard, admin console
- ❌ Push channels beyond ntfy + email (no Telegram, Discord, Signal, SMS)
- ❌ Operator-website scraping (HAFAS only)
- ❌ Train delay prediction / ML / "smart" recommendations
- ❌ Aggregated stats, leaderboards, "trains I tracked this year"
- ❌ Public API for third parties
- ❌ Hosted SaaS version of latefyi
- ❌ Mobile app (ntfy app is the mobile app)
- ❌ Plugin system for new operators (just add to `endpoints.json`)
- ❌ Calendar integration ("auto-track trains from calendar events")
- ❌ Group tracking ("track this train for me and three friends")
- ❌ Geofencing ("notify when train enters X km of Y")
- ❌ Voice / chatbot interfaces

---

## 24. Future considerations (parked)

Items not in v1.0 but worth revisiting if felt pain emerges:

- **`latefyictl`**: a CLI tool to inspect `state/`, manually trigger pushes, manage allowlist. Probably useful by v0.3.
- **Self-hosted ntfy as default**: if usage grows, document the migration.
- **Per-user preference persistence**: currently inferred from `config.json`; could move to `state/users/<email>.json` for multi-tenant support (which is itself a NO-GO, but the structure helps even single-tenant).
- **Webhook notification**: sibling to ntfy/email, for advanced users wanting to wire latefyi into Home Assistant or similar. Only if requested.
- **iCal feed**: read-only iCal of currently-tracked trains, for calendar overlays. Only if requested.
- **Operator-specific quirks**: e.g., SNCF announces some intercity platforms via separate API; could add operator adapter layer if HAFAS proves insufficient.

These are listed for completeness only. Do not implement unless explicit pain demonstrated. Re-litigation after the fact is a known failure mode.

---

## 25. Implementation milestones

Suggested phasing for Claude during development. Phases are ordered so each is independently demoable and the system is **fully usable end-to-end after Phase 4** (the email channel covers the full default user experience). ntfy is a Phase 5 enhancement.

**Phase 1 — parser + resolver (offline)**
- Build `parse.js` with fixture tests
- Build `stations.js` with alias table
- Build `resolve.js` with mocked `hafas-client`
- Goal: given a fixture email, produce a fully-resolved request object

**Phase 2 — scheduler + state**
- Build `schedule.js`, file layout, `wake.sh`, `users.js`
- Goal: parsed request → `pending/<msgid>.json` → moved to `active/` at the right moment; per-user state files created on first contact

**Phase 3 — poller + diff (no delivery yet)**
- Build `poll.js`, `diff.js` against live `hafas-client`
- Pushes are written to `logs/push.jsonl` only, not delivered
- Goal: real polling against real trains, real diff events recorded — verify cadence and diff logic before any delivery is wired

**Phase 4 — email channel + reply (full default UX)**
- Build `reply.js`, email side of `push.js`, SMTP config
- Implement confirmation replies, error replies, threaded update emails
- **At end of this phase the system is fully usable**: email-in, email-out, complete loop
- Goal: track a real train end-to-end via email only

**Phase 5 — Cloudflare Worker + DNS (production ingest)**
- Deploy Worker, configure Email Routing, allowlist enforcement at edge
- Goal: real emails to `*@late.fyi` trigger real tracking in production

**Phase 6 — ntfy opt-in**
- Build ntfy side of `push.js`, `CHANNELS` configuration handler in `users.js`
- Build opt-in reply with QR code generation
- Wire fallback-to-email on ntfy failures
- Goal: users who want push notifications can opt in and get them; email users completely unaffected

**Phase 7 — hardening**
- Edge cases, error handling, log retention pruning, disagreement logging
- 30-day unattended-operation soak test
- Goal: runs unattended for 30+ days, recovers from HAFAS outages, never loses a tracking request

Each phase is independently demoable and shippable. Email-default architecture means Phases 1–5 deliver complete value; Phase 6 (ntfy) is purely additive.

---

**End of PRD.**
