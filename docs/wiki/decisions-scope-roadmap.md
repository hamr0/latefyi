---
title: Decisions, Scope and Roadmap
theme: decisions-scope-roadmap
sources:
  - docs/archive/latefyi-prd.md
---

# Decisions, Scope and Roadmap

Why late.fyi is shaped the way it is: the numbered decisions log, the explicit NO-GO list, and the phased implementation milestones.

## Decisions log

### Input grammar and parsing

- The local-part is the train number and headers are optional context, so the train number is the only mandatory input (docs/archive/latefyi-prd.md:1547).
- `From:` present means boarding mode; absent means pickup mode. Intent is encoded in a single bit, with no flags or separate addresses (docs/archive/latefyi-prd.md:1548).
- One train per email. Multi-train parsing adds ambiguity, so multi-leg means multiple emails (docs/archive/latefyi-prd.md:1549).
- Hard rule, no multi-leg itinerary parsing, ever (docs/archive/latefyi-prd.md:1572):
  - The first train is the load-bearing event for any chain; if it slips the user is replanning, not waiting on automation.
  - Booking-confirmation parsing is a moving-target maintenance black hole (operator HTML formats, languages, yearly drift).
  - Tracked itineraries drift out of sync with reality faster than single-train tracking.
  - Multi-leg friction is mitigated by the optional `Trip:` tag and `STOP TRIP <name>`; the real multi-train win is fast unwind, not fast setup.
- Always require explicit `From:` and `To:`, never auto-pick from the train route, even when unambiguous. Typing the headers is the design goal; guessing fails in hard cases (multi-Paris, Lille Flandres vs Europe), and it keeps the parser predictable and makes the "missing context" reply the universal entry-point doc (docs/archive/latefyi-prd.md:1573).
- Two-layer station disambiguation: auto-resolve from route context first, numbered reply only when truly ambiguous. Most ambiguities (Paris/Brussels/Lille) collapse once the route is known, eliminating about 80% of round-trips. Remaining cases get a numbered reply accepting a digit or a fuzzy-matched station name (docs/archive/latefyi-prd.md:1571).

### Data source

- Primary plus fallback endpoint, never merged: determinism beats coverage, and merging multi-source live data is a debugging nightmare (docs/archive/latefyi-prd.md:1550).
- Single primary endpoint (ÖBB) and single fallback (PKP), replacing the original per-operator endpoint table (docs/archive/latefyi-prd.md:1570):
  - A POC (2026-04-28) found native SNCF/SBB/NS/Trenitalia/Eurostar profiles never shipped in `hafas-client`; the DB profile has dead DNS; the SNCB profile rejects clients.
  - ÖBB returns live data across the EU plus UK and is the de-facto universal HAFAS gateway.
  - Simplification: about 80 LOC of `resolve.js` becomes about 20. A single-vendor data risk is acknowledged (see PRD §8).
- Single dependency: `hafas-client`; everything else is Node built-ins (docs/archive/latefyi-prd.md:1560).

### State and scheduling

- File-based state, no DB: modest scale does not warrant one, and `cat`/`ls` debuggability is bare-suite-aligned (docs/archive/latefyi-prd.md:1551).
- Cron plus `wake.sh` for scheduling, matching the bare-suite pattern with no in-process scheduler complexity (docs/archive/latefyi-prd.md:1559).
- Polling cadence varies by phase: T-30 to departure needs density; in-transit is sparser (docs/archive/latefyi-prd.md:1557).
- Diff-based push, not poll-based, to avoid spam and debounce delay oscillation (docs/archive/latefyi-prd.md:1558).
- Three lifetimes: per-user, per-train, per-change. This separates lifetime preference (channel, ntfy topic) from ephemeral tracking (one trip) from delivery events, and removes the "new ntfy topic per train?" question (docs/archive/latefyi-prd.md:1565).
- `state/users/<sender_hash>.json` holds per-user state: a clean schema boundary, trivial to inspect with `cat` (docs/archive/latefyi-prd.md:1568).
- 30-day retention for `done/` and logs: enough for debugging recent issues, prevents unbounded growth (docs/archive/latefyi-prd.md:1564).

### Ingest and auth

- Cloudflare Email Worker for ingest rather than own SMTP: SMTP setup is a months-long deliverability project that Cloudflare handles free (docs/archive/latefyi-prd.md:1552).
- Sender allowlist as the auth boundary: simpler and more robust than per-request signing, and supports multi-user without auth complexity (docs/archive/latefyi-prd.md:1555).
- Multi-user within a single deployment (allowlist): operator, friends and family each get an independent channel preference and (if opted in) ntfy topic. Not SaaS: single deployment, no auth, no billing (docs/archive/latefyi-prd.md:1569).
- Domain via Cloudflare Registrar is recommended, not required: at-cost and integrates with Email Routing (docs/archive/latefyi-prd.md:1562).

### Channels and replies

- Email is the default channel and ntfy an opt-in upgrade (revised from the original "ntfy primary, email fallback"). Email works for everyone with zero install, and the system is shared with friends and family who should not need an app (docs/archive/latefyi-prd.md:1553).
- Critical events override channel preference: cancellation safety beats user preference (docs/archive/latefyi-prd.md:1554).
- ntfy topic is derived from `sha256(sender_email)[:16]`: stable, private, stateless, regenerable (docs/archive/latefyi-prd.md:1556).
- One ntfy topic per user, all trains stream through it: stable subscription, no per-train setup, unlimited concurrent trains. ntfy does not merge POSTs, so each update is its own notification (docs/archive/latefyi-prd.md:1566).
- ntfy opt-in via `CHANNELS ntfy` to `config@late.fyi`, with the QR sent once. The QR/URL is the only friction point and happens exactly once per user (docs/archive/latefyi-prd.md:1567).
- Reply emails are threaded via `In-Reply-To`, so mail clients group updates per train (docs/archive/latefyi-prd.md:1563).
- Standard footer on every outbound email (format reminder, STOP variants, Trip tag, case-insensitivity note). Reasons: passive teaching by repetition, every email self-contained, and one source of truth in `reply.js`. ntfy push bodies skip the footer to stay short (docs/archive/latefyi-prd.md:1574).
- No web UI and no dashboard; operator apps cover that need (docs/archive/latefyi-prd.md:1561).

## Out of scope (NO-GO list)

To prevent scope creep, the following are explicitly out of scope and should be rejected if proposed (docs/archive/latefyi-prd.md:1580):

| Area | Rejected items |
|---|---|
| Transactions | Booking, ticketing, refunds, seat reservation (docs/archive/latefyi-prd.md:1582) |
| Planning | Journey planning, "how do I get from X to Y?" (docs/archive/latefyi-prd.md:1583) |
| Product model | Multi-tenant SaaS, user accounts, billing, payment; hosted SaaS version (docs/archive/latefyi-prd.md:1584, 1591) |
| Interfaces | Web UI, dashboard, admin console; mobile app (ntfy app is the mobile app); voice/chatbot interfaces (docs/archive/latefyi-prd.md:1585, 1592, 1597) |
| Channels | Anything beyond ntfy + email: no Telegram, Discord, Signal, SMS (docs/archive/latefyi-prd.md:1586) |
| Data | Operator-website scraping (HAFAS only) (docs/archive/latefyi-prd.md:1587) |
| Intelligence | Delay prediction, ML, "smart" recommendations (docs/archive/latefyi-prd.md:1588) |
| Stats | Aggregated stats, leaderboards, "trains I tracked this year" (docs/archive/latefyi-prd.md:1589) |
| Extensibility | Public API for third parties; plugin system for new operators (just add to `endpoints.json`) (docs/archive/latefyi-prd.md:1590, 1593) |
| Features | Calendar integration, group tracking, geofencing (docs/archive/latefyi-prd.md:1594-1596) |

## Implementation milestones

Phases are ordered so each is independently demoable, and the system is fully usable end-to-end after Phase 4 (email covers the full default experience). ntfy is a Phase 5-6 enhancement (docs/archive/latefyi-prd.md:1704).

| Phase | Scope | Goal |
|---|---|---|
| 1. Parser + resolver (offline) | `parse.js` with fixture tests, `stations.js` alias table, `resolve.js` with mocked `hafas-client` (docs/archive/latefyi-prd.md:1706-1709) | A fixture email yields a fully-resolved request object (docs/archive/latefyi-prd.md:1710) |
| 2. Scheduler + state | `schedule.js`, file layout, `wake.sh`, `users.js` (docs/archive/latefyi-prd.md:1712-1713) | Parsed request goes to `pending/<msgid>.json`, then `active/` at the right moment; per-user files created on first contact (docs/archive/latefyi-prd.md:1714) |
| 3. Poller + diff (no delivery) | `poll.js`, `diff.js` against live `hafas-client`; pushes written only to `logs/push.jsonl` (docs/archive/latefyi-prd.md:1716-1718) | Verify cadence and diff logic on real trains before wiring delivery (docs/archive/latefyi-prd.md:1719) |
| 4. Email channel + reply | `reply.js`, email side of `push.js`, SMTP config, confirmation/error replies, threaded updates (docs/archive/latefyi-prd.md:1721-1723) | Track a real train end-to-end via email only; the system is fully usable here (docs/archive/latefyi-prd.md:1724-1725) |
| 5. Cloudflare Worker + DNS | Deploy Worker, configure Email Routing, allowlist enforcement at edge (docs/archive/latefyi-prd.md:1727-1728) | Real emails to `*@late.fyi` trigger real tracking in production (docs/archive/latefyi-prd.md:1729) |
| 6. ntfy opt-in | ntfy side of `push.js`, `CHANNELS` handler in `users.js`, opt-in reply with QR, fallback-to-email on ntfy failures (docs/archive/latefyi-prd.md:1731-1734) | Push users can opt in; email users are unaffected (docs/archive/latefyi-prd.md:1735) |
| 7. Hardening | See below (docs/archive/latefyi-prd.md:1737-1747) | Runs unattended 30+ days, recovers from HAFAS outages, never loses a request, replies reach Gmail/Outlook/Apple, safe to broaden the allowlist (docs/archive/latefyi-prd.md:1749) |

### Phase 7 detail

- Outbound deliverability, so replies do not land in junk beyond the operator's own inbox (docs/archive/latefyi-prd.md:1738-1741):
  - SPF: append VPS IP `155.94.144.191` to the `late.fyi` SPF TXT record.
  - DKIM: configure the opendkim signing-table for `noreply@late.fyi` (opendkim already runs on the VPS for addypin; add a key and entry).
  - PTR / reverse DNS for the sending IP via the VPS provider.
- Disambiguation reply completion: `server.js` silently dropped replies that were not fresh tracking requests; wire the digit-or-fuzzy-name reply back to the pending station resolution (docs/archive/latefyi-prd.md:1742).
- Abuse limits ahead of broadening the allowlist: per-sender rate limits (fresh requests per hour/day), max active trains per sender, first-time-sender confirmation handshake (docs/archive/latefyi-prd.md:1743-1746).
- Operations: log retention pruning (`logs/push.jsonl`, error logs), HAFAS-disagreement logging when ÖBB and PKP both succeed but disagree, edge-case error handling (docs/archive/latefyi-prd.md:1747).
- 30-day unattended-operation soak test (docs/archive/latefyi-prd.md:1748).

Email-default architecture means Phases 1-5 deliver complete value, and Phase 6 (ntfy) is purely additive (docs/archive/latefyi-prd.md:1751).
