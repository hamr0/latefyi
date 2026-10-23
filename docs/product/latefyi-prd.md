---
title: late.fyi PRD - Product and User Email Protocol
theme: user-email-protocol
sources:
  - docs/archive/latefyi-prd.md
---

# late.fyi PRD: product and user email protocol

**Version:** 1.18.2
**Status:** Phases 1–7 shipped and live at `late.fyi`. Allowlist is **open** to anyone (`ALLOWED_SENDERS=`). Privacy contract is literal: trip ends → address AND record both deleted, no archive. Disambiguation completion (numbered/named replies) wired end-to-end with `Reply-To` threading. Abuse limits live (10/hr, 50/day, 20 active per sender), deliverability verified PASS to Gmail (SPF/DKIM/DMARC), `On: <date>` advance planning live (up to 90 days). Landing page at `late.fyi` via Cloudflare Pages. **Routable From:** per-template (`<TRAINNUM>@`, `stop@`, `config@`, `help@`, `list@`) with display name `latefyi`. **Subject inbox-grouping signals** — `[trip]` prefix + day+date suffix always present in confirmation and per-event subjects. **`list@late.fyi`** — email any time to get a listing of all active trains. **STOP ALL / STOP TRIP** list cleared trains with dates. **Notification reliability hardened (1.14.0):** systemd is the single daemon authority (flock'd, `wake.sh` no longer spawns); failed sends are logged, retried up to 10× over ~5 min via on-record `pendingDeliveries`, and surface to `OPERATOR_EMAIL` on give-up; `logs/delivery-errors.log` mirrors every attempt. **Station-local time everywhere (1.14.0)**: HAFAS offsets are honoured per-station — `dep Monday, 2026-05-04 11:10 Amsterdam Centraal` reads as Amsterdam time by construction, no UTC label needed. **Rich change pushes (1.14.0)**: every event body opens with `<line>, <from> → <to>` and uses `> ` row markers + inline `(+Nmin)`/`(was X)` annotations. **Operator metrics**: daily snapshot (`scripts/stats.sh`) + weekly digest email (`scripts/stats-email.sh`). **Repo-tracked systemd units** (`systemd/`, `scripts/install-units.sh`) and **`scripts/vps.sh`** for one-shot VPS access. **Email format catalogue:** `docs/product/email-formats.md` (regenerated via `scripts/dump-email-samples.js`). **Disposable-inbox blocklist (1.14.1):** opt-in `BLOCK_DISPOSABLE=true`; snapshot at `config/disposable-domains.txt` (9189 domains as of the 2026-10-01 refresh), refresh with `scripts/refresh-disposable-domains.sh`. **Quarterly refresh cron (1.14.2):** root crontab runs `scripts/cron-refresh-disposable.sh` at 06:00 UTC on Jan 1 / Apr 1 / Jul 1 / Oct 1; auto-restarts `latefyi-ingest` if the snapshot changed and emails the operator with success/failure. **Mode A pickup confirmation (1.14.4):** confirmation reply branches on mode — pickup (To:-only) opens "Picking up X at Y", subject is "Pickup X — Y", and the irrelevant origin / departure-platform fields are dropped; boarding unchanged. The same release fixes the post-refresh EACCES that crashed `latefyi-ingest` after the first quarterly run (refresh script now writes 0644 + chowns to the service user when invoked by root). **Mode A push events (1.14.5):** `src/diff.js` `richBody` and per-event headlines are now mode-aware — T-30, platform_assigned, delay_change, terminating_short, and arrived all collapse to the pickup shape (no origin, no dep platform, no "? →" placeholder). Push subject date suffix anchors on arrival for Mode A so it matches the confirmation. `deploy.sh` now soaks 3 s post-restart and tails recent journalctl lines so a fast crash doesn't slip past the immediate `is-active` check. **Security hardening (1.15.0):** inbound sender authentication (drop `dmarc=fail` at Worker + `handleInbound`, `src/auth-results.js`) so a spoofed `From` can't STOP/delete another user's tracking; ntfy fully gated behind `NTFY_ENABLED` (default off) so critical events no longer publish to the public, email-derivable ntfy topic while paused; broad per-sender action limit (60/hr across all command kinds) caps backscatter amplification; pending files keyed `<senderHash>-<msgid>.json` to prevent cross-sender record overwrite and scope `findRecordsForSender` to the sender; `nodemailer` upgraded 6→8 (addressparser DoS/CVEs, `npm audit` clean). See §19. 295/299 tests pass (the 4 failures are pre-existing date-fixture staleness, unrelated). **Landing-page discoverability (1.16.0):** the `late.fyi` page now carries JSON-LD (`SoftwareApplication` + `FAQPage`, answers lifted verbatim from "What we don't do"), a curated `web/llms.txt`, explicit AI-crawler allow rules in `robots.txt` (retrieval bots `Claude-User`/`Claude-SearchBot`/`OAI-SearchBot`/`ChatGPT-User`/`PerplexityBot` + training `ClaudeBot`/`GPTBot`), and a `<lastmod>` sitemap (dropped Google-ignored `changefreq`/`priority`) — all declarative/static, every claim mirrored from the privacy invariant; the email app surface has no web path to expose. Playbook detail in `docs/wiki/privacy-seo.md`. **Security contact & DMARC enforcement (1.17.0):** `web/.well-known/security.txt` (RFC 9116) publishes `security@late.fyi`; `_dmarc.late.fyi` raised `p=none` → `p=quarantine` (`sp=quarantine`) now that outbound is fully SPF/DKIM-aligned — soaking `rua` reports before `p=reject`. Clears Cloudflare's domain-security insights; the AI-bot-blocking suggestions were declined as contrary to 1.16.0 discoverability. See §19. **Observability (1.18.0):** two zero-dep sibling libs wired per the ops playbook — `flightlog` in-app error capture (`install()` in both daemon entrypoints → `logs/errors.jsonl`, name/message/stack + static `where` only, never a sender), and `pulselog` off-app watchers on systemd timers — `latefyi-health.timer` every 15 min (services, ingest `/health`, disk, SSL, mail queue; silent on green, one email on failure) and `latefyi-stats-digest.timer` weekly (WoW `{users, trains, completed, active_trains, active_users}` via `bin/stats.js` + a flightlog counts-only rollup). New `trains_completed_count` counter ("works ran") bumped at both terminal-delete sites, symmetric to `trains_tracked_count`. Config rendered on the VPS from a committed template + `/etc/latefyi.env` (operator email never in git); sender `noreply@late.fyi` (DKIM-aligned). See §21 Observability. **pulselog mail fix (1.18.1):** both pulselog units now carry `SupplementaryGroups=postdrop` + a writable `/var/spool/postfix/maildrop`; under `NoNewPrivileges`/`ProtectSystem=strict` the setgid `postdrop` handoff failed silently, so no digest or health alert had ever been delivered.

**Deferred in v1.9.0 — ntfy push notifications.** The full code path (per-user derived topic, opt-in QR/deep-link reply, push transport, fail-streak counter) is intact, but no longer surfaced in user-facing copy. Real-world testing showed that even with the designed onboarding (`CHANNELS ntfy` → reply with `ntfy://subscribe/<topic>` deep link + `https://ntfy.sh/<topic>` fallback), the deep link is dead on a fresh device (no ntfy app registered for the scheme) and the HTTPS fallback drops users into a no-push browser tab. "No extra setup, ever" is not honest until we either (a) ship a hosted PWA that owns the scheme + handles web push, or (b) replace ntfy with first-party web push. Until then: `config@late.fyi` accepts `CHANNELS ntfy` but replies "ntfy delivery is paused" and pins the user to email; confirmation/missing-context bodies omit any ntfy/CHANNELS mention.

Outstanding: 30-day soak.

See `CHANGELOG.md` for the full revision history. See `docs/product/cloudflare-setup.md` for the operator deployment runbook.
**Owner:** Amr
**Intended developer:** Claude (Sonnet 4.6+ recommended for implementation)

(docs/archive/latefyi-prd.md:3-12)

## Pages

- [Email Grammar and Parsing](../wiki/email-grammar-parsing.md) — how inbound emails are parsed: grammar, headers, disambiguation.
- [Reply and Notification Copy](../wiki/reply-notification-copy.md) — wording of every reply and push, STOP variants, event taxonomy.
- [Notification channels and ntfy](../wiki/notification-channels-ntfy.md) — email default, paused ntfy opt-in, channel selection.
- [Data sources and HAFAS](../wiki/data-sources-hafas.md) — HAFAS endpoints, fallback policy, station resolution.
- [Polling, State Machine and Architecture](../wiki/polling-state-architecture.md) — modes, cadence, state machine, components, tests.
- [Privacy, Security and Abuse Controls](../wiki/privacy-security-abuse.md) — allowlist, sender auth, what is stored, storage schema.
- [Deployment, Configuration and Observability](../wiki/deployment-config-observability.md) — Cloudflare Worker, DNS, config, flightlog/pulselog.
- [Deployment Steps and Infrastructure](../wiki/deployment-steps.md) — where each piece runs, VPS deploy steps, systemd, reverse proxy, verification.
- [Decisions, Scope and Roadmap](../wiki/decisions-scope-roadmap.md) — decisions log, NO-GO list, phased milestones.

What the product is, how users interact with it by email, and how user-visible edge cases behave.

## Purpose

- `latefyi` is a small, self-hosted, email-driven train-tracking notifier for European rail. It removes the need to refresh operator websites and station boards in unfamiliar languages (docs/archive/latefyi-prd.md:18-18).
- The user sends one email per train. Updates come back on platform assignment, delays, cancellations and route changes. Email is the default channel and ntfy push is an opt-in (docs/archive/latefyi-prd.md:18-18).
- The user emails `<TRAINNUM>@late.fyi`, optionally with `From:` / `To:` headers to disambiguate intent. Notifications run from T-30 minutes through arrival or destination (docs/archive/latefyi-prd.md:20-20).
- Email is the default because it needs no app install, setup or account. ntfy is an opt-in upgrade for faster, quieter, app-style push. Both can run together (`both`) for redundancy (docs/archive/latefyi-prd.md:22-22).

## What it is

- A single-purpose, email-in / notification-out tracker for European trains (docs/archive/latefyi-prd.md:29-29).
- Email-first: works with just an email account (docs/archive/latefyi-prd.md:30-30).
- Self-hosted: one Cloudflare Worker plus one Node.js process on a small VPS or home server (docs/archive/latefyi-prd.md:31-31).
- Multi-recipient: any allowlisted address can use it independently (docs/archive/latefyi-prd.md:32-32).
- Zero telemetry, zero accounts, zero web UI (docs/archive/latefyi-prd.md:33-33).
- Operator-agnostic where HAFAS endpoints exist (SNCF, DB, SBB, ÖBB, NS, SNCB, Trenitalia, Eurostar) (docs/archive/latefyi-prd.md:34-34).
- Forgiving: parses missing or malformed input and replies with a concrete fix (docs/archive/latefyi-prd.md:35-35).
- ntfy-optional: never required (docs/archive/latefyi-prd.md:36-36).

## What it is not

- A ticketing or booking system (docs/archive/latefyi-prd.md:39-39).
- A journey planner; there is no "find me a route from X to Y" (docs/archive/latefyi-prd.md:40-40).
- A public SaaS: a single instance with allowlisted senders, though multiple users can share it (docs/archive/latefyi-prd.md:41-41).
- A web app, with no dashboard or admin UI (docs/archive/latefyi-prd.md:42-42).
- A replacement for operator apps, which still own ticketing, seat selection and refunds (docs/archive/latefyi-prd.md:43-43).
- A general-purpose notification platform; its one purpose is trains (docs/archive/latefyi-prd.md:44-44).
- An aggregator or scraper of operator websites. It only uses the HAFAS protocol via `hafas-client` (docs/archive/latefyi-prd.md:45-45).
- ntfy-required; email is always available (docs/archive/latefyi-prd.md:46-46).

## User experience flows

### Primary flow: Mode B, boarding (default email channel)

Example: RE19750, Amiens to Lille Flanders, departing 14:02 (docs/archive/latefyi-prd.md:54-54).

1. The user emails `RE19750@late.fyi` with `From: Amiens, To: Lille Flanders` from their allowlisted address (docs/archive/latefyi-prd.md:55-55).
2. The system replies within seconds: "Tracking RE19750, Amiens → Lille Flanders, scheduled 14:02. Updates will arrive by email starting T-30 at 13:32." It includes a one-click `mailto:stop@late.fyi?subject=STOP%20RE19750` link, so cancelling is a tap rather than a typed reply (docs/archive/latefyi-prd.md:56-56).
3. At 13:32 polling begins, with an email such as "RE19750 — no platform yet, on time" (docs/archive/latefyi-prd.md:57-57).
4. At 13:48 the platform is announced. Subject: "RE19750 → Platform 7"; body: "Platform 7 at Amiens. On time." (docs/archive/latefyi-prd.md:58-58).
5. At 13:55 a delay is detected: "RE19750 delayed +6min. New departure 14:08, Platform 7." (docs/archive/latefyi-prd.md:59-59).
6. After departure, polling continues. Downstream delay or disruption triggers an email; otherwise it stays silent until the arrival window (docs/archive/latefyi-prd.md:60-60).
7. On arrival: "RE19750 arrived at Lille Flanders, Platform 4." Tracking ends (docs/archive/latefyi-prd.md:61-61).

All update emails for one tracked train share an `In-Reply-To` header. They thread into one collapsed conversation per train in the user's mail client (docs/archive/latefyi-prd.md:63-63).

### Secondary flow: Mode A, pickup

Example: picking up a friend on TGV 9876 arriving at Lille Flanders 16:48 (docs/archive/latefyi-prd.md:67-67).

1. The user emails `9876@late.fyi` with `To: Lille Flanders` (docs/archive/latefyi-prd.md:68-68).
2. The system replies: "Tracking TGV 9876 arriving Lille Flanders 16:48. Updates by email starting T-30 at 16:18." (docs/archive/latefyi-prd.md:69-69).
3. Email updates cover the arrival platform when assigned, delays as announced, and cancellation if it happens (docs/archive/latefyi-prd.md:70-70).
4. On arrival: "TGV 9876 arrived Lille Flanders, Platform 2." Tracking ends (docs/archive/latefyi-prd.md:71-71).

### Optional flow: ntfy opt-in

For users who want faster, app-style push instead of, or in addition to, email (docs/archive/latefyi-prd.md:75-75). **Currently paused:** `config@late.fyi` accepts `CHANNELS ntfy` but replies "ntfy delivery is paused" and keeps the user on email; the flow below is the designed behaviour, kept for re-enable.

1. The user emails `config@late.fyi` with subject `CHANNELS ntfy` (or `CHANNELS both`) (docs/archive/latefyi-prd.md:77-77).
2. The system replies once with a personal ntfy topic URL and a QR code. The reply explains how to install the ntfy app and subscribe, says all tracked trains will push there, and says `CHANNELS email` switches back (docs/archive/latefyi-prd.md:78-83).
3. The user scans the QR once and the ntfy app subscribes (docs/archive/latefyi-prd.md:84-84).
4. From then on every tracked train for this user delivers via ntfy (or both, depending on choice). There is no further setup and no per-train links: one topic, all trains, lifetime (docs/archive/latefyi-prd.md:85-85).

### Operator setup flow (one time)

1. Buy a domain (~$10/yr at any registrar, or Cloudflare Registrar at cost) (docs/archive/latefyi-prd.md:89-89).
2. Point the domain nameservers at Cloudflare (docs/archive/latefyi-prd.md:90-90).
3. Enable Email Routing in the Cloudflare dashboard (docs/archive/latefyi-prd.md:91-91).
4. Deploy the Worker (`wrangler deploy`) (docs/archive/latefyi-prd.md:92-92).
5. Set up SMTP credentials (or Cloudflare Email send) for outbound replies (docs/archive/latefyi-prd.md:93-93).
6. Allowlist permitted sender addresses in `config.json` (docs/archive/latefyi-prd.md:94-94).
7. Optionally run `setup-ntfy.sh` for personal use (docs/archive/latefyi-prd.md:95-95).
8. Send a test email from an allowlisted address and receive the confirmation reply (docs/archive/latefyi-prd.md:96-96).

## Edge cases and error handling

| Case | Behavior |
|---|---|
| Email arrives before the train is scheduled (booked weeks ahead) | Schedule normally; `wake.sh` activates at T-30 (docs/archive/latefyi-prd.md:1298-1298). |
| Email arrives after the train has departed | If still in transit and Mode B, start polling immediately. If Mode A and more than 30 min past arrival, reply "already arrived" (docs/archive/latefyi-prd.md:1299-1299). |
| Email arrives after the train was cancelled | Reply with cancellation status; no tracking (docs/archive/latefyi-prd.md:1300-1300). |
| Train number matches multiple operators (e.g. "104" on DB and SNCF the same day) | Reply listing the matches (ICE 104 DB Frankfurt→Basel; TGV 104 SNCF Paris→Marseille) and ask for an operator prefix or distinguishing detail (docs/archive/latefyi-prd.md:1301-1301). |
| Cross-border train with different IDs per endpoint | The endpoint resolver picks the operator-of-record (the one running the train), per route table (docs/archive/latefyi-prd.md:1302-1302). |
| Train splits mid-route (e.g. ICE divides at Hannover) | Detect via HAFAS `trip().stopovers` split markers, push a notice, and continue tracking the half going to the user's `To:` (docs/archive/latefyi-prd.md:1303-1303). |
| Replacement bus | Status `replaced`. The push includes "Bus from <station> to <station>" if HAFAS provides it, otherwise "Replacement service — check operator app" (docs/archive/latefyi-prd.md:1304-1304). |
| HAFAS endpoint completely down (primary and fallback) | After 6 consecutive failures, push "Lost tracking, data source unavailable", delete the record (no `errors/` archive), no automatic retry (docs/archive/latefyi-prd.md:1305-1305). |
| Sender's domain has SPF/DKIM failures | The Worker still accepts (the sender allowlist is the auth boundary) but logs it (docs/archive/latefyi-prd.md:1306-1306). |
| Reply email bounces | Not archived (there is no `errors/`). The user won't see confirmation but tracking proceeds (docs/archive/latefyi-prd.md:1307-1307). |
| ntfy delivery fails persistently | Auto-fallback to email per section 6 of the PRD (docs/archive/latefyi-prd.md:1308-1308). |
| `STOP` for an unknown msgid | Reply "No active tracking matches that. Send STOP <trainNum> to stop a specific train, or STOP ALL to clear everything." (docs/archive/latefyi-prd.md:1309-1309). |
| `STOP ALL` | Delete all `active/<msgid>.json` for the sender (no `done/` archive) (docs/archive/latefyi-prd.md:1310-1310). |
| `STOP TRIP <name>` | Delete all of the sender's `active/<msgid>.json` where `request.trip` matches `<name>` (case-insensitive). The reply summarizes count and train list; with no matches it replies "No active trips named '<name>'." (docs/archive/latefyi-prd.md:1311-1311). |
| `STOP TRIP` for a tag with no pending/active matches but a recently completed one | Reply "No *active* trains in trip '<name>' (3 already completed in the last 24h)." (docs/archive/latefyi-prd.md:1312-1312). |
| Disk fills up | `wake.sh` log retention prevents unbounded growth in normal operation; add disk monitoring out of band (docs/archive/latefyi-prd.md:1313-1313). |
