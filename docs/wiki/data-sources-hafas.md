---
title: Data sources and HAFAS
theme: data-sources-hafas
sources:
  - docs/archive/latefyi-prd.md
---

# Data sources and HAFAS

External train data: HAFAS endpoints and fallback policy, station resolution, and parked data-source and expansion ideas.

## Library

The system uses `hafas-client` (npm), which wraps the HAFAS protocol used by most major European rail operators (docs/archive/latefyi-prd.md:561-563).

## Endpoint strategy (POC 2026-04-28)

The original v1.0 PRD assumed per-country HAFAS profiles (SNCF, DB, SBB, NS, SNCB, Trenitalia, Eurostar). The POC probed every profile shipped by `hafas-client` (docs/archive/latefyi-prd.md:567).

| Original assumption | Reality (verified live) |
|---|---|
| SNCF, SBB, NS, Trenitalia, Eurostar profiles | Never shipped by hafas-client |
| DB profile | DNS dead (`reiseauskunft.bahn.de` decommissioned) |
| SNCB profile | Rejected ("Invalid client version") |
| ÖBB profile | Works; returns live data for stations across France, Germany, Belgium, Netherlands, Italy, Switzerland, UK, Luxembourg |
| PKP profile | Works with comparable cross-border coverage |

(docs/archive/latefyi-prd.md:569-579)

The ÖBB endpoint is effectively a universal European rail query gateway. The POC confirmed live boards at Frankfurt Hbf, Paris Nord, Lille Flandres, Bruxelles Midi, Hamburg Hbf, Roma Termini, Zürich HB, Amsterdam Centraal and London St Pancras. Every product family needed (TER, IC, EUR, TGV, ICE, RJ/NJ, regional, suburban) comes back with line name, fahrtNr, product, direction, planned/actual times and platforms (docs/archive/latefyi-prd.md:581).

### Endpoint configuration

The whole endpoint table is `{ "primary": "oebb", "fallback": "pkp" }`. There is no per-country routing and no operator-prefix guessing (docs/archive/latefyi-prd.md:583-592).

## Resolution algorithm

1. Query ÖBB using the user's `From:` station departure board (window: scheduled departure ± 30 min, or "today/tomorrow" with no time hint), matching by line name + fahrtNr.
2. If no match, retry against PKP with the same query.
3. If still no match, reply with the section 7 "train not found" template.
4. Once matched, fetch the full trip via `client.trip(tripId)` to get the stop sequence for section 7a disambiguation and section 9 polling.

(docs/archive/latefyi-prd.md:594-599)

## Fallback policy: sticky source, no mid-trip switching (Policy A)

Fallback fires only at resolve time. Once a trip's winning source is recorded in `state/active/<msgid>.json` (`record.resolved.endpoint`), it never changes for that trip (docs/archive/latefyi-prd.md:601-603).

- On poll failure, retry the same source. After `MAX_CONSECUTIVE_FAILURES = 6` (`src/poll.js:109`), emit `tracking_lost`. The user can re-engage with a fresh email and may land on the other source on re-resolve (docs/archive/latefyi-prd.md:605).
- No mid-trip switch to the alternate source (docs/archive/latefyi-prd.md:606).
- No `disagreement.log`: comparing sources mid-trip means querying both each poll, doubling request volume against free public endpoints. The system does not shadow-query (docs/archive/latefyi-prd.md:607).
- Implementation: `src/poll-runner.js:95` reads `record.state?.endpointInUse || record.resolved?.endpoint || 'oebb'` per poll (docs/archive/latefyi-prd.md:609).

### Why: POC 2026-05-04

A second POC examined adding a third HAFAS source and mid-trip switching. Three fallback options were considered: pre-capture all sources at resolve, race in parallel each poll, or sticky-with-resolve-time-fallback. The third won (docs/archive/latefyi-prd.md:621).

**No viable third source.** `hafas-client` v6 ships 38 profiles and SBB is not among them. SBB's stable open API is `transport.opendata.ch`, a different protocol, so wiring it would need a non-HAFAS adapter for marginal gain, since ÖBB already proxies Swiss long-distance trains. The remaining profiles (`db`, `sncb`, `cfl`, etc.) are dead or sub-regional. Decision: stay at two sources (oebb, pkp) and revisit only if both deteriorate simultaneously (docs/archive/latefyi-prd.md:623).

**Mid-trip switching is unsafe.** A live comparison of `RJ 854` (Wien Hbf to Villach Hbf), both sources resolving the same train independently (docs/archive/latefyi-prd.md:625):

| Field | ÖBB | PKP |
|---|---|---|
| Departure delay | 120s | null |
| `line.product` | `nationalExpress` | `high-speed-train` |
| Stop name (sample) | `Flughafen Wien Bahnhof` | `Flughafen Wien` |
| Cold-resolve latency | 4976ms | 716ms |

(docs/archive/latefyi-prd.md:628-632)

PKP's realtime feed for Austrian trains is sparser. A mid-trip switch would make the next diff see "delay cleared, stop name changed, product changed" and emit a false-positive push. Resolve-time fallback is safe because there is no diff baseline yet. `tracking_lost` after 6 consecutive failures is the correct exit, a clean signal rather than a degraded one (docs/archive/latefyi-prd.md:634).

**Pre-capturing both sources' tripIds at resolve time was rejected.** TripIds are per-day and per-profile (ÖBB encodes the date as `DA#40526`; PKP's appears as a trailing `4052026` segment). A cached fallback tripId saves about 700ms on a rare fallback but can go stale if the operator regenerates schedules, which is exactly when fallback is needed. Re-resolving from `{trainNum, anchorStation, departureDate}` on the next source avoids that bug class. Extra cached tripIds would also be dead weight in 99% of `state/active/` records, which fights the privacy invariant (docs/archive/latefyi-prd.md:636).

## Durability risk

The system has a single-vendor data dependency on ÖBB's HAFAS endpoint. PKP only partially mitigates this, offering similar coverage from a similar third-party gateway. If both lock down their public gateways the way DB and SNCB did, the project breaks until alternative sources (operator REST APIs, navitia.io, Transport API, etc.) are integrated (docs/archive/latefyi-prd.md:611-613).

Mitigation posture for v1: accept the risk (a personal-use tool with no SLAs), and track in section 24 an item to abstract `resolve.js` and `poll.js` behind a data-source interface so a non-HAFAS provider can be slotted in (docs/archive/latefyi-prd.md:615-617).

## Bus tracking: out of scope

Considered and rejected (docs/archive/latefyi-prd.md:640):

- **FlixBus / BlaBlaCar Bus**: neither exposes a public realtime API, and ride identifiers are internal booking IDs, not memorable numbers (docs/archive/latefyi-prd.md:642).
- **Urban / regional buses**: fragmented per-city via GTFS-RT. Aggregators (Transitous, Navitia, EU NAP portals per Regulation 2017/1926) exist with patchy realtime coverage, and a city bus is "line 47, departing Place X at 09:42", not a number (docs/archive/latefyi-prd.md:643).
- **HAFAS bus legs**: ÖBB and PKP surface some regional buses as multimodal results. Not excluded from query, not a deliberate target (docs/archive/latefyi-prd.md:644).

The premise "user emails a number, we track it" does not map to bus operations unless a different identifier mechanic emerges (docs/archive/latefyi-prd.md:646).

## Parked: future considerations

Not in v1.0 but worth revisiting if felt pain emerges (docs/archive/latefyi-prd.md:1603):

- `latefyictl`: a CLI to inspect `state/`, manually trigger pushes, manage the allowlist; probably useful by v0.3 (docs/archive/latefyi-prd.md:1605).
- Per-user preference persistence in `state/users/<email>.json` rather than inferred from `config.json` (docs/archive/latefyi-prd.md:1607).
- Webhook notification (e.g. Home Assistant), only if requested (docs/archive/latefyi-prd.md:1608).
- iCal feed of currently-tracked trains, only if requested (docs/archive/latefyi-prd.md:1609).
- Operator-specific quirks, e.g. SNCF announcing some intercity platforms via a separate API; an operator adapter layer could be added if HAFAS proves insufficient (docs/archive/latefyi-prd.md:1610).

## Parked: geographic expansion beyond EU (2026-05-04 survey)

Scope filter: regional and long-distance trains only. Urban metro, tram and S-Bahn-class commuter services are excluded because their identifier is a line code (e.g. "U6") rather than a numbered service (docs/archive/latefyi-prd.md:1614).

**Sequencing.** Stay EU-only until coverage is demonstrably solid (no felt gaps, ÖBB+PKP not failing visibly). The EU is the only region served by a protocol-uniform source set (HAFAS); every other region needs a non-HAFAS adapter (docs/archive/latefyi-prd.md:1616).

| Region | Source | Status | Notes |
|---|---|---|---|
| Switzerland | `transport.opendata.ch` | stable, free, no key | REST (not HAFAS); IR/IC/RE long-distance + S-Bahn. Highest-ROI single addition if Swiss gaps surface. |
| Norway | Entur (`api.entur.io`) | stable, free, NeTEx/SIRI | NSB intercity + regional + local. Excellent quality. |
| Sweden | Trafiklab | free with key | SJ long-distance + regional. GTFS-RT + REST. |
| Finland | Digitransit | free, MIT-licensed stack | VR network is small. Self-hostable. |
| Taiwan | PTX (`tdx.transportdata.tw`) | free with registration | TRA + THSRC. Train-numbered, realtime delays. |
| UK | National Rail Open Data (Darwin/HSP) | free with registration (caveat) | Strong realtime, but riders think in headcodes/destinations, not train numbers. |
| Japan (Tokyo) | ODPT | free, registration, non-commercial (caveat) | Tokyo metro area only; Shinkansen and JR mainline not covered. |
| Korea | data.go.kr (KORAIL) | registration often gated to Korean residents (caveat) | Practically inaccessible for foreign developers. |
| US | per-operator (MBTA, Caltrain, LIRR, Metra...) | federated GTFS-RT (caveat) | No national Amtrak open API; per-agency only. |
| China | none | closed | 12306.cn has no public API; scrapers fragile and adversarial. |
| India | none stable | closed | Third-party APIs come and go; IRCTC closed. |
| Russia, most of LATAM, most of SE Asia | none | closed | |

(docs/archive/latefyi-prd.md:1620-1633)

Priority order if expansion is ever pursued: Switzerland, then Norway/Sweden, then Taiwan. The first three are clean drop-ins; Taiwan validates the non-EU pattern at low cost (docs/archive/latefyi-prd.md:1635).

## Parked: multi-adapter architecture

Every non-HAFAS source forces a real abstraction. Today `resolve.js` and `poll.js` are HAFAS-shaped (tripId, `client.trip()`, `departures()` boards). A single adapter interface is the prerequisite for any expansion (docs/archive/latefyi-prd.md:1639):

```
interface DataSource {
  id: string                          // 'oebb', 'sbb-ch', 'entur-no'
  resolve(parsed) -> ResolvedTrip|null
  poll(tripRef) -> Snapshot
}
```

(docs/archive/latefyi-prd.md:1641-1647)

Each adapter encapsulates its own protocol and the orchestrator iterates sources in priority order. The current ÖBB to PKP pattern in `resolve.js` is a degenerate case of this (docs/archive/latefyi-prd.md:1649).

### Routing strategies considered

- **A. Probe all adapters in priority order.** Simple, but breaks down past about 3 sources since every miss multiplies request volume against free public endpoints.
- **B. User-typed region prefix in the local-part.** Cheapest logic, near-zero ambiguity, a small one-time UX tax on non-EU users only.
- **C. Country inference from `From:`/`To:` stations.** Best UX, but the station-name to country index is a maintenance surface.
- **D. Probe EU first, disambiguation reply on miss.** A stepping stone extending the section 7a flow to ask whether the user meant a non-EU train.

(docs/archive/latefyi-prd.md:1653-1656)

Chosen scheme (parked, agreed in principle 2026-05-04): B + D, an explicit region prefix for non-EU plus a discoverability hint when a prefix-less email does not resolve (docs/archive/latefyi-prd.md:1658).

### Local-part syntax

```
EU (default):  <trainnum>@late.fyi             e.g. rj854@late.fyi, tgv6207@late.fyi, ic2021@late.fyi
Non-EU:        <cc><trainnum>@late.fyi         e.g. chic5@late.fyi, nor9602@late.fyi, jphikari503@late.fyi
               <cc>-<trainnum>@late.fyi        optional dash form, accepted but not advertised
```

(docs/archive/latefyi-prd.md:1662-1666)

Region codes are ISO 3166 alpha-2. The advertised namespace is `{ch, no, se, fi, gb, jp, tw}`, codes with a viable open API in the survey. A new code is gated on identifying a viable adapter; the namespace is not pre-reserved (e.g. `es` is unavailable because Renfe has no stable open API as of 2026-05-04) (docs/archive/latefyi-prd.md:1668).

`eu` is never required and not advertised. If typed anyway (`eutgv345@late.fyi`), the parser silently strips it and routes to the EU default (docs/archive/latefyi-prd.md:1670).

### Parser rule

Lowercase the local-part. If it starts with an advertised region code and the remainder validates as a train identifier against that region's adapter, route there; otherwise route to the EU default. The optional `-` separator is stripped before matching (docs/archive/latefyi-prd.md:1674).

The validation check is the safety net: if a future EU service class collided with a region code (none today, verified against `RJ, RJX, IC, EC, EN, NJ, EUR, ICE, TGV, TER, S, RE, IR, RB`), the wrong path fails resolve and falls through to EU, costing one extra resolve attempt (docs/archive/latefyi-prd.md:1676).

### Discoverability (the D part)

When a prefix-less email fails EU resolve and the identifier could plausibly be non-EU, the section 7 "train not found" reply gains a hint line suggesting a region prefix (e.g. `ch<trainnum>@late.fyi` for Switzerland) and listing the codes ch, no, se, fi, gb, jp, tw. It ships with the same PR that adds adapter #2, since until then it would advertise capabilities that do not exist (docs/archive/latefyi-prd.md:1680-1684).

### Implementation gating

This is forward-looking design only. Nothing changes in `resolve.js`, `parse.js` or `worker/index.js` until adapter #2 has a concrete reason to exist (felt user pain, repeated requests for a region). The work order then is (docs/archive/latefyi-prd.md:1688):

1. Refactor `resolve.js`/`poll.js` to take `DataSource[]` instead of `primaryClient`/`fallbackClient`; ÖBB and PKP become the first two adapters under a single `eu` region.
2. Add the second region's adapter (real, not stub).
3. Add the prefix parsing rule to `parse.js` / `worker/index.js`.
4. Add the discoverability hint to the section 7 "train not found" template.
5. Update `web/index.html` with a region table.

(docs/archive/latefyi-prd.md:1690-1694)

Skipping straight to step 2 without step 1 is the trap: it produces `if (region === 'ch') ...` branches in `resolve.js` (docs/archive/latefyi-prd.md:1696). These items are listed for completeness only; do not implement without demonstrated pain, as re-litigation after the fact is a known failure mode (docs/archive/latefyi-prd.md:1698).
