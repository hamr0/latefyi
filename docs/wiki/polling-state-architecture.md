---
title: Polling, State Machine and Architecture
theme: polling-state-architecture
sources:
  - docs/archive/latefyi-prd.md
---

# Polling, State Machine and Architecture

Internals as specified in the PRD: operational modes and polling cadence, the trip state machine, architecture, component specs and test strategy. Section references (§) point to other PRD sections.

## Operational modes

Both modes share the same event categories. They differ only in the anchor station and the polling window; the notification taxonomy lives in §9 (docs/archive/latefyi-prd.md:154-154).

| | Mode A: Pickup | Mode B: Boarding |
|---|---|---|
| Trigger | `To:` present, `From:` absent (docs/archive/latefyi-prd.md:157-157) | `From:` present, with or without `To:` (docs/archive/latefyi-prd.md:166-166) |
| Anchor | The `To:` station (docs/archive/latefyi-prd.md:158-158) | The `From:` station (docs/archive/latefyi-prd.md:167-167) |
| Watching | Arrival board at `To:` plus upstream route, to detect early termination, rerouting or replacement (docs/archive/latefyi-prd.md:159-159) | Departure board at `From:` plus downstream stops up to `To:` (or terminus), to detect delay propagation, rerouting, splitting or early termination (docs/archive/latefyi-prd.md:168-168) |
| "Platform" means | Arrival platform at `To:` (docs/archive/latefyi-prd.md:160-160) | Departure platform at `From:` and arrival platform at `To:` (docs/archive/latefyi-prd.md:169-169) |
| Polling window | T-30 before scheduled arrival at `To:` until actual arrival or +30 min grace (docs/archive/latefyi-prd.md:161-161) | T-30 before scheduled departure at `From:` until arrival at `To:` (or terminus) +30 min grace (docs/archive/latefyi-prd.md:170-170) |
| Terminal state | Train arrives at `To:`, is cancelled, or is +30 min past last known ETA with no data (docs/archive/latefyi-prd.md:162-162) | Arrival at `To:`, cancellation, or train passes `To:` per live data (docs/archive/latefyi-prd.md:171-171) |

In Mode A, "delay" means delay propagating to `To:`'s arrival and "terminating short" means the train ends before `To:`; cancellation, replacement service and mid-route disruption all apply (docs/archive/latefyi-prd.md:160-160). In Mode B, delay thresholds tighten pre-departure (2 min or more) and loosen in transit (5 min or more) per §9 (docs/archive/latefyi-prd.md:169-169).

### Polling cadence by phase

| Phase | Window | Frequency |
|---|---|---|
| Pre-T-30 | Email receipt to T-30 | Not polled; the scheduler waits (docs/archive/latefyi-prd.md:178-178) |
| Pre-anchor | T-30 to scheduled departure (Mode B) or scheduled arrival (Mode A) | Every 30s (docs/archive/latefyi-prd.md:179-179) |
| In-transit (Mode B only) | Scheduled departure to scheduled arrival at `To:` | Every 60s (docs/archive/latefyi-prd.md:180-180) |
| Arrival window | T-5 to actual arrival, both modes | Every 30s (docs/archive/latefyi-prd.md:181-181) |
| Grace | Actual arrival or +30 min cutoff | Stop (docs/archive/latefyi-prd.md:182-182) |

Large terminal stations (Paris-Nord, Gare de Lyon, Frankfurt Hbf, Roma Termini, etc., listed in `config.json`) extend the pre-departure window to T-45 because they often announce later (docs/archive/latefyi-prd.md:184-184).

## State machine

A request moves through these states (docs/archive/latefyi-prd.md:738-775):

1. **RECEIVED**: email arrives at the Worker, which validates the sender and hands it to the parser (docs/archive/latefyi-prd.md:739-742).
2. **PARSED**: the local-part gives the train number; subject/body give mode and stations (docs/archive/latefyi-prd.md:744-746).
3. **AWAITING_DISAMBIGUATION**: entered when the resolver (hafas-client, oebb then pkp fallback) finds an ambiguous station that cannot be auto-resolved from context. A numbered reply is sent and the system waits for the user's pick (digit or station name, matched via In-Reply-To). Timeout is 24h after the disambiguation reply, or poll_start_time minus 5 min (docs/archive/latefyi-prd.md:747-755).
4. **VALIDATED**: train exists, route validated, stations match (docs/archive/latefyi-prd.md:756-757).
5. **SCHEDULED**: the scheduler wrote `pending/<msgid>.json` with `poll_start_time` and a confirmation reply was sent; the request waits for `poll_start_time` (docs/archive/latefyi-prd.md:759-763).
6. **ACTIVE**: `wake.sh` cron (every 1 min) moves due files to `active/`; the poller daemon polls every 30-60s, diffs and pushes (docs/archive/latefyi-prd.md:765-768).
7. **DONE**: on a terminal event (arrival, cancellation, past grace) the record is deleted (`unlinkSync()`); there is no `done/` archive (docs/archive/latefyi-prd.md:770-774).

### Failure transitions (any state to ERROR)

- HAFAS endpoint down (both ÖBB and PKP): retry 3x, then push "Lost tracking for RE19750, data source unavailable" (docs/archive/latefyi-prd.md:778-778).
- Parser or validator failure: reply with an error, no state file written (docs/archive/latefyi-prd.md:779-780).
- Disambiguation timeout (3 retries, 24h, or poll_start_time minus 5 min): the parked `pending-disambig/` record expires after 24h (lazy expiry on read) and is deleted; a later reply to it is dropped silently, with no timeout reply and no `done/` copy (docs/archive/latefyi-prd.md:781-781).
- There is no `errors/` archive: a malformed `active/` record is logged and deleted. No retry except HAFAS 5xx (docs/archive/latefyi-prd.md:783-783).

## Architecture

### Components

1. Cloudflare Email Worker (edge): receives email, validates sender, posts JSON to the Node service (docs/archive/latefyi-prd.md:791-791).
2. Node service (VPS or home server): parser, resolver, scheduler, poller, push dispatcher (docs/archive/latefyi-prd.md:792-792).
3. ntfy app on the phone, subscribed to the user's private topic (docs/archive/latefyi-prd.md:793-793).
4. Cron (`wake.sh`) activating due requests every minute (docs/archive/latefyi-prd.md:794-794).
5. File system: `pending/`, `active/` (plus `users/` and `pending-disambig/`) as the only state store; terminal records are deleted, not archived (docs/archive/latefyi-prd.md:795-795).

### File layout

The PRD's layout (docs/archive/latefyi-prd.md:799-836):

- `config/`: `config.json` (allowed_senders, ntfy server, default channels, large_terminals, polling overrides) and `endpoints.json` (operator to HAFAS profile mapping).
- `src/`: `parse.js`, `resolve.js`, `reply.js`, `schedule.js`, `poll.js`, `diff.js`, `push.js`, `channels.js`, `users.js`, `stations.js`, `server.js`.
- `scripts/`: `wake.sh`, `setup-ntfy.sh`, `test-email.sh`.
- `worker/`: `wrangler.toml`, `index.js` (Cloudflare Email Worker).
- `state/`: `users/` (per-user lifetime state), `pending/`, `active/`, `pending-disambig/`. No `done/` or `errors/`: terminal records are deleted.
- `logs/`: `push.jsonl` (one line per push attempt, senderHash only) and `errors.jsonl` (flightlog) are what the code writes; the PRD's `audit.jsonl` and `disagreement.log` are not implemented.

`package.json` declares `hafas-client` only (docs/archive/latefyi-prd.md:801-801).

### Size estimate

About 720 lines of code in total: `parse.js` 60, `resolve.js` 90, `reply.js` 60, `schedule.js` 30, `poll.js` 80, `diff.js` 70, `push.js` 60, `channels.js` 40, `users.js` 50, `stations.js` 60, `server.js` 40, `wake.sh` 20, Worker `index.js` 60 (docs/archive/latefyi-prd.md:840-855). The single dependency is `hafas-client`; QR generation in `users.js` uses a tiny inline ASCII renderer or shells out to `qrencode` if available (docs/archive/latefyi-prd.md:857-857).

## Component specifications

### `parse.js` (13.1)

Input is the raw Worker callback JSON `{from, to, subject, body, msgid, headers}`. Output is one of `track`, `stop`, `config`, `disambiguation_reply`, or `ParseError` (docs/archive/latefyi-prd.md:946-948). Logic in order (docs/archive/latefyi-prd.md:950-959):

1. Reserved local-parts (`config`, `stop`, `help`) route to their handlers before the train-number regex.
2. If `In-Reply-To` matches a pending `disambiguationMessageId`, return `disambiguation_reply` with the stripped first non-empty body line as `answer` (see §7a).
3. If body or subject begins with `STOP` (case-insensitive), parse `STOP`, `STOP <TRAINNUM>`, `STOP TRIP <name>` or `STOP ALL`.
4. Train number: uppercased local-part validated against `/^[A-Z]{0,4}\d{2,5}$/`, else `ParseError("invalid_trainnum")`.
5. Headers: subject plus first non-empty body line matched with `/(from|to|trip|channels):\s*([^,\n]+)/gi`; keys case-insensitive, values trimmed and kept verbatim.
6. Mode: `from` present means B, only `to` means A, neither means `MISSING` (the §7 missing-context reply). It never auto-picks `from`/`to` from the route (decision §22-27).
7. `trip` must match `/^[A-Za-z0-9_-]{1,32}$/`; invalid triggers a reply asking for a corrected tag; empty becomes null.
8. Channels default to the user's stored preference (`state/users/<sender_hash>.json`) or `email`; a per-request `Channels:` header overrides for that train only.

### `resolve.js` (13.2)

Output is `{endpoint, trainId, route, schedule, validation, disambiguationNeeded?}` or `ResolveError` (docs/archive/latefyi-prd.md:963-965). Logic (docs/archive/latefyi-prd.md:967-980):

1. Resolve `from` via ÖBB `client.locations()` (start from `to` in Mode A).
2. Query ÖBB `client.departures(stationId, { duration: 90 })` for the trip window (default now to +24h, narrowed if times were given).
3. Match the train number against `line.fahrtNr` and the trailing digits of `line.name`; accept the first exact match.
4. No ÖBB match: repeat against PKP. Still none: `ResolveError("train not found")` leading to a §7 reply.
5. On match, call `client.trip(tripId)` for the full stop sequence.
6. Validate `from` and `to` against the stops with `stations.js`: a unique match resolves; multiple matches (e.g. Paris Nord and Paris Bercy) set `disambiguationNeeded` with candidates, and `server.js` sends the §7a reply and parks the request in `AWAITING_DISAMBIGUATION`; no match gives `ResolveError("station not on route")` with a route summary.
7. Return the data with `endpoint` recorded so the poller starts on the same source.

There is no operator-prefix guessing or per-country routing: ÖBB is the single primary and PKP the single fallback.

### `stations.js` (13.3)

Input is a user-typed name plus the canonical route stop list; output is the matched canonical name or `null` with suggestions (docs/archive/latefyi-prd.md:984-986). Steps: normalize (lowercase, strip punctuation, collapse whitespace, transliterate accents), exact match, alias lookup (e.g. "Paris Nord" to "Paris Gare du Nord"; "Lille" is ambiguous between "Lille Flanders" and "Lille Europe"), then Levenshtein distance of 2 or less. It returns the best unambiguous match, a candidate list if ambiguous, or null (docs/archive/latefyi-prd.md:988-993). Aliases live in `config/aliases.json`, seeded with common cases and extensible (docs/archive/latefyi-prd.md:995-995).

### `schedule.js` (13.4)

Computes `poll_start_time = scheduledDeparture - 30min` (-45min for large terminals) and `poll_end_time` per Mode A/B rules, then writes `pending/<msgid>.json.tmp` and renames it to `.json` atomically, returning data for the reply (docs/archive/latefyi-prd.md:1003-1007).

### `poll.js` (13.5)

Takes an `active/<msgid>.json`, updates it in place, dispatches pushes and eventually deletes it on a terminal event (docs/archive/latefyi-prd.md:1011-1013). The loop (docs/archive/latefyi-prd.md:1016-1032):

- Load the file and call hafas-client for current train state.
- On endpoint failure increment `consecutivePollFailures`; at 3 or more switch to the fallback endpoint; at 6 or more emit a "tracking lost" push and delete the record; continue with backoff.
- Build a `TrainState` snapshot, diff against `state.lastPushedSnapshot`, and call `push.js` if there are changes.
- Update `lastPushedSnapshot` and `lastPolledAt`, write atomically, and if terminal delete the record and exit; otherwise sleep per cadence rules.

### `diff.js` (13.6)

A pure function `(prev: TrainState, curr: TrainState) → PushEvent[]`, where each `PushEvent` is `{type, priority, title, body, tags}` (docs/archive/latefyi-prd.md:1036-1038).

### `push.js` (13.7)

Input is `(channelPref, topic, email, pushEvent[])`. For each event: if `channelPref` includes `ntfy`, POST to the ntfy server and log; if it includes `email` or the event is critical, send email and log. After 3 consecutive ntfy failures for a request, promote to `both` for the rest of the trip and note it in the next email. Results are appended to `logs/push.jsonl` (docs/archive/latefyi-prd.md:1042-1049).

### `users.js` (13.7a)

Per-user state: channel preference, ntfy topic, opt-in tracking (docs/archive/latefyi-prd.md:1053-1053). Functions (docs/archive/latefyi-prd.md:1056-1059):

- `getOrCreate(senderEmail)`: loads `state/users/<hash>.json`, creating defaults if absent (`channel: "email"`, derived but inactive `ntfy_topic`).
- `setChannel(senderEmail, channel)`: returns `{wasFirstNtfyOptIn}`, which triggers the QR reply.
- `getNtfyTopic(senderEmail)`: deterministic; needs no existing record.
- `incrementTrainCount(senderEmail)`: bumps `trains_tracked_count` and `last_seen_at`.

All updates write to `<file>.tmp` then rename; no locking is needed at this scale (docs/archive/latefyi-prd.md:1061-1061).

### `wake.sh` (13.8)

Run by cron every minute (`* * * * * /opt/latefyi/scripts/wake.sh`) (docs/archive/latefyi-prd.md:1092-1092). As specified, it (docs/archive/latefyi-prd.md:1070-1089):

- Moves each `state/pending/*.json` whose `schedule.poll_start_time` is due into `state/active/` and echoes a line to stdout (cron appends it to `logs/wake.log`); no `audit.jsonl` is written.
- Does not prune or spawn anything: there is no `done/` to prune, and the poll-runner daemon is owned by systemd (`wake.sh` only activates due records).

### `worker/index.js` (13.9)

The Cloudflare Email Worker silently drops mail from senders not in `ALLOWED_SENDERS` when it is set (empty = open, as in production) (no bounce, to avoid backscatter to spoofed senders). Otherwise it reads the raw body and subject and POSTs `{msgid, from, to, subject, body, receivedAt}` as JSON to `LATEFYI_INGEST_URL` with a `Bearer` `LATEFYI_INGEST_TOKEN`, logging an error if the response is not ok (docs/archive/latefyi-prd.md:1098-1129). `wrangler.toml` configures the route `*@late.fyi` to this worker and the secrets `ALLOWED_SENDERS`, `LATEFYI_INGEST_URL`, `LATEFYI_INGEST_TOKEN` (docs/archive/latefyi-prd.md:1133-1133).

## Testing strategy

- **Unit tests** (docs/archive/latefyi-prd.md:1336-1340):
  - `parse.js`: 20+ fixture emails (happy path, missing headers, malformed train numbers, multiple `To:`, headers in body vs subject).
  - `stations.js`: alias table and fuzzy cases (typos, accents, ambiguity).
  - `diff.js`: pure-function tests with synthetic before/after `TrainState` pairs.
  - `channels.js`: preference resolution across combinations.
- **Integration tests, offline** (docs/archive/latefyi-prd.md:1342-1344): `resolve.js` with mocked `hafas-client` returning canned responses; `poll.js` with a mocked endpoint and clock advancement.
- **Manual live smoke test** (docs/archive/latefyi-prd.md:1346-1351): send a test email from an allowlisted address for a train in the next hour; verify the confirmation reply; verify the push at T-30; compare pushes against the operator app over the journey; verify the terminal push on arrival.
- **Load test**: not applicable at single-tenant scale, at most about 10 concurrent active requests (docs/archive/latefyi-prd.md:1353-1354).
