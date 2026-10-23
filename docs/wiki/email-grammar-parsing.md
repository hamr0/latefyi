---
title: Email Grammar and Parsing
theme: email-grammar-parsing
sources:
  - docs/archive/latefyi-prd.md
---

# Email Grammar and Parsing

How inbound emails are parsed: the train-number and header grammar, and the disambiguation flow for ambiguous stations.

## Grammar forms

The local part of the address is the train number; headers choose the mode (docs/archive/latefyi-prd.md:102-108).

| Email | Meaning |
|---|---|
| `<TRAINNUM>@late.fyi` | need more info, reply asking |
| `... To: <STATION>` | Mode A: pickup at STATION |
| `... From: <STATION>` | Mode B: board STATION, ride to terminus |
| `... From: <X>, To: <Y>` | Mode B: board X, ride to Y |
| `... From: <X>, To: <Y>, Trip: <T>` | as above, grouped under trip "T" |

(docs/archive/latefyi-prd.md:103-107)

## Rules

- **Train number**: the local part, required; uppercase, alphanumeric, no whitespace (e.g. `RE19750`, `9876`, `ICE104`, `ES9114`, `TGV6201`) (docs/archive/latefyi-prd.md:112).
- **Where headers go**: `From:`, `To:`, `Trip:` may be in the subject line (preferred) or the body's first non-empty line; the classic form is key-colon-value, comma-separated (docs/archive/latefyi-prd.md:113).
- **Case-insensitive keys**: `From:`, `from:`, `FROM:`, `tO:` parse identically. Values are normalized for matching but preserved verbatim for replies (docs/archive/latefyi-prd.md:114).
- **Forgiving parsing**: colons and commas are optional; the parser splits on keyword boundaries (`from` / `to` / `on` / `trip` / `channels`) (docs/archive/latefyi-prd.md:115). All of these work (docs/archive/latefyi-prd.md:116-119):
  - `From: Amsterdam, To: Berlin Ostbahnhof` (classic)
  - `from amsterdam to berlin ostbahnhof` (no colons, no commas)
  - `from amsterdam to paris nord on 2026-05-06` (all bare)
  - `From: Amsterdam to Berlin On: 2026-05-04` (mixed)
- **Station matching**: case-insensitive against the resolved train's stop sequence, using fuzzy match (Levenshtein <= 2 against canonical names and known aliases) (docs/archive/latefyi-prd.md:120).
- **Unknown headers** are ignored silently, as is extra body content (docs/archive/latefyi-prd.md:123).

### Trip tag

`Trip:` is an optional free-text tag (alphanumeric plus dash/underscore, up to 32 chars) that groups per-train requests for batch operations like `STOP TRIP <name>`. Trips are not validated against any list (docs/archive/latefyi-prd.md:121).

### Advance planning with `On:`

- Accepted: ISO `2026-05-04`, or day-month-year with a named month such as `5 May 2026`, `5-May-2026`, `05-May-26` (docs/archive/latefyi-prd.md:122).
- Pure-numeric forms like `05/04/26` are rejected because of US vs EU ambiguity (docs/archive/latefyi-prd.md:122).
- The date must be today or future, at most 90 days ahead, since HAFAS doesn't publish further (docs/archive/latefyi-prd.md:122).
- With `On:` set, the request is resolved against that day's HAFAS data; the record sits in `state/pending/` until T-30 of the actual departure, then activates on the existing wake-up cron. Without it, HAFAS picks the nearest run (today or tomorrow) (docs/archive/latefyi-prd.md:122).

### Deliberate restrictions

- **One train per email.** Multi-train journeys are multiple emails; the system never parses a multi-leg itinerary from one message. Rationale: parsing booking confirmations is a maintenance black hole, and the user's first train is the load-bearing event for the chain (PRD §22 decision 26) (docs/archive/latefyi-prd.md:124).
- **Bare emails always get the "missing context" reply**, even if the train number resolves to one train and one route. The system never auto-picks `From:` or `To:`; forcing explicit headers is intentional (PRD §22 decision 27) (docs/archive/latefyi-prd.md:125).

## Examples

- To `tgv9876@late.fyi`, subject `To: Lille Flanders`, empty body: Mode A, pickup at Lille Flanders (docs/archive/latefyi-prd.md:130-133).
- To `RE19750@late.fyi`, subject `From: Amiens, To: Lille Flanders`, empty body: Mode B, board Amiens to Lille Flanders (docs/archive/latefyi-prd.md:137-140).
- To `ICE104@late.fyi`, empty subject, body `From: Frankfurt Hbf`: Mode B, board Frankfurt Hbf to terminus (docs/archive/latefyi-prd.md:144-147).

## Disambiguation flow

Station names are commonly ambiguous ("Paris", "Brussels", "Lille", "Frankfurt"). The system first tries to auto-resolve from context, and only then asks the user (docs/archive/latefyi-prd.md:504).

### Layer 1: auto-resolve from context

When a typed name fuzzy-matches several canonical stations but only one of them is on the resolved train's stop sequence, that one is taken silently and mentioned in the confirmation reply so the user can correct it (docs/archive/latefyi-prd.md:508).

Example: `EUR9310@late.fyi` with `From: Paris, To: Amsterdam`. Eurostar EUR9310 only stops at Paris Nord in the Paris area, so the system resolves `Paris` to `Paris Nord` and confirms, offering `STATION Paris Est` (etc.) within 24h to correct (docs/archive/latefyi-prd.md:510-513). This removes the round-trip when the train constrains the answer (docs/archive/latefyi-prd.md:515).

### Layer 2: numbered reply when truly ambiguous

When the text matches more than one stop on the train's route, the system replies with a numbered list, for example subject "Which Paris for TGV6611?", listing `1. Paris Gare de Lyon` and `2. Paris Bercy`, and asks for just the number or the full name (docs/archive/latefyi-prd.md:519-530).

### Reply parsing (forgiving)

The reply is matched against `state.choices` in order (docs/archive/latefyi-prd.md:534-538):

1. Pure digit: index into `state.choices`; out-of-range re-asks.
2. Fuzzy station name (Levenshtein <= 2 against each choice): a unique match wins.
3. Still ambiguous (e.g. "Paris" again): re-ask the same list and increment a retry counter; after 3 retries, cancel and ask for a fresh email.
4. No match at all: reply with the numbered list plus a note that the answer wasn't recognized.

### State correlation (no tokens in body)

- The original request stays in `pending/<msgid>.json` with `state.phase = "AWAITING_DISAMBIGUATION"`, `state.choices = [...]` and `state.disambiguationMessageId = "<our-reply-msgid>"` (docs/archive/latefyi-prd.md:542).
- The user's reply carries an `In-Reply-To` header pointing at our disambiguation reply's `Message-ID`; the parser uses it to find the pending request, so no token is needed in the body (docs/archive/latefyi-prd.md:543).
- A reply with no `In-Reply-To` matching a pending disambiguation is treated as a fresh email and parsed normally (docs/archive/latefyi-prd.md:544).

### Timeout

- Awaiting-disambiguation requests auto-cancel 24 hours after the disambiguation reply was sent, or at `poll_start_time - 5 minutes`, whichever is earlier (docs/archive/latefyi-prd.md:548).
- As implemented, a parked disambiguation record expires after 24h (`src/disambig.js`, lazy expiry on read) and is deleted; a later reply to it is dropped silently, so no timeout message is sent and nothing is archived to `done/`. (The original PRD text specified a "Disambiguation timed out" reply and a `done/` move with `phase = "TIMED_OUT"`: docs/archive/latefyi-prd.md:549.)

### Coverage

The flow applies to origin/destination station ambiguity (the common case) and to train-number ambiguity from PRD §18 ("Train 104 matches: ICE 104 and TGV 104"), using the same numbered-reply mechanism with operator-distinguished trains in `state.choices` (docs/archive/latefyi-prd.md:553-555).
