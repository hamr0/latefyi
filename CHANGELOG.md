# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/).

This project tracks two streams in lockstep:
- **PRD versions** (`docs/01-product/latefyi-prd.md`) — spec evolution.
- **Implementation versions** (`package.json`) — code shipping.

---

## [Unreleased]

## 0.18.0 — Observability: flightlog + pulselog (2026-07-02)

Wire two zero-dep sibling libs (`flightlog`, `pulselog`) per `hamr0/observability-playbook.md`. Four independent layers; 1–3 shipped, layer 4 (off-box backup/watch) parked. PRD → 1.18.0.

### Added

- **flightlog — in-app error capture.** `install()` runs once in each daemon's CLI block (`src/ingest-server.js`, `src/poll-runner.js`): global handlers catch uncaught exceptions (log synchronously → exit 1 for a clean systemd restart) and unhandled rejections (log, survive). `capture()` records the handled swallow points that keep a daemon alive across a fault — poll-runner tick-level catch (`where: 'poll-tick'`), operator-alert send failure (`where: 'operator-alert-send'`), and the ingest request/send catches (`where: 'ingest-request' | 'ingest-send'`). All append to `logs/errors.jsonl`. `createIngestServer`, `tick`, and `run` take an **optional** no-op `capture`/`captureError`, so behavior tests inject nothing.
- **pulselog health — `latefyi-health.timer`, every 15 min.** `service` (poller / ingest / postfix / opendkim), `http` on ingest `/health`, `disk` (root + `/opt/latefyi`), `ssl` (`late.fyi`, `ingest.late.fyi`, warn <14d), `mailq` depth. Silent on green; one summary email to `$OPERATOR_EMAIL` on any failure. Supersedes the PRD §18 "add disk monitoring out of band" note.
- **pulselog digest — `latefyi-stats-digest.timer`, weekly (Sun 09:00 UTC).** `bin/stats.js` prints `{users, trains, completed, active_trains, active_users}` (counts only; active users by senderHash) → pulselog appends a `kind:"stats"` line to `logs/stats.jsonl` and emails a week-over-week table + a flightlog rollup (**counts and group-names only, never messages/stacks**).
- **`trains_completed_count`** (`state/users/<hash>.json`) — new per-user counter, "works ran" in the digest. `incrementCompletedCount()` (`src/users.js`) is bumped by the poll-runner at **both** terminal-delete sites (eviction + poll-then-terminal), symmetric to `trains_tracked_count`, counted exactly once per trip, best-effort and decoupled from the privacy-critical unlink. +8 tests (both terminal paths, no double-count, non-terminal no-op, users increment); 303 total green.
- **Four systemd units** (`systemd/latefyi-{health,stats-digest}.{service,timer}`) and a committed **`pulselog.config.template.json`**. `scripts/install-units.sh` now installs all four units, renders `${OPERATOR_EMAIL}` from `/etc/latefyi.env` into the gitignored `/opt/latefyi/pulselog.config.json` (so `deploy.sh`'s `git pull` never clobbers it), and `enable --now`s the timers.

### Changed

- `flightlog` + `pulselog` added to runtime `dependencies` (both zero-dep, `node:*` only, so `npm ci --omit=dev` on the VPS installs them). `deploy.sh` unchanged — the existing `npm ci` picks them up.
- `.gitignore` now excludes `/state/`, `/logs/`, and the rendered `/pulselog.config.json`.

### Privacy

- **`logs/errors.jsonl` holds only Error name/message/stack + a static low-cardinality `where` — never a sender or trip record**, a first-class extension of the §19 invariant. The digest's flightlog rollup emails counts and group-names only. Alert/digest sender is `noreply@late.fyi` (the only address opendkim signs, selector `latefyi2026`) — verified by capturing a real `mail -r noreply@late.fyi` send, so mail is DKIM-aligned and DMARC-passing like all other outbound.

### Deliverability (found during validation)

- Sending a real digest to the operator surfaced a **pre-existing** block, not a regression: the shared VPS IP `155.94.144.191` (AS3130) is on Microsoft's Spamhaus feed, so alert/digest mail to `@msn/outlook/hotmail/live` hard-bounces at `MAIL FROM` (`550 5.7.1 … blocked using Spamhaus`) **despite passing SPF/DKIM/DMARC** — opendkim signed it correctly (`s=latefyi2026, d=late.fyi`); Microsoft rejects on connecting-IP reputation before it reads the signature. Also affects product mail to Microsoft-domain users. Fix is IP reputation only — Spamhaus delist requested from a role address on the rDNS domain (`abuse@addypin.com`), then Microsoft feed refresh + Sender Support/JMRP (SNDS already enrolled) — no code or DNS change. Gmail-class delivery is unaffected. See `CLAUDE.md` → "Deliverability is wired".

### Notes

- Verified end-to-end before ship: a real `tick()` completing a trip wrote `trains_completed_count`, `bin/stats.js` read it, and the digest dry-run rendered the `completed` column; the health run really executed the `service` checks; a real digest generated + opendkim-signed + wrote `logs/stats.jsonl`. 303 tests pass.

## 0.17.0 — Security contact & DMARC enforcement (2026-06-03)

Two deliverability/security-posture changes prompted by Cloudflare's domain-security insights. No application code paths touched — a new static web asset plus a DNS policy change. The privacy posture is untouched (no analytics, no new data collected).

### Added

- **`web/.well-known/security.txt`** (RFC 9116) — `Contact: mailto:security@late.fyi`, `Expires: 2027-06-03`, `Canonical`, `Preferred-Languages: en`. Served static via Cloudflare Pages at `https://late.fyi/.well-known/security.txt`; the app surface is email, so there is no web path to disclose beyond the contact. **Delivery caveat:** `security` is in `worker/index.js` `NON_TRACKING_LOCALPARTS`, so the Worker drops it as defense-in-depth — a Cloudflare Email Routing rule (`security@late.fyi` → operator inbox) must exist for reports to land, otherwise the published address is a sink.

### Security

- **DMARC raised to enforcement.** `_dmarc.late.fyi` went `p=none` → `p=quarantine` with an explicit `sp=quarantine`. Outbound is fully aligned — VPS `155.94.144.191` is in SPF, and mail is DKIM-signed under two valid selectors (`latefyi2026` = VPS opendkim, `cf2024-1` = Cloudflare Email Routing) — so enforcement is safe with no legitimate-mail risk. Clears Cloudflare's three "DMARC Record Error detected" insights (the same single record scored against multiple checks, not three records). **Rollout:** soak `rua` aggregate reports (`postmaster@late.fyi`) ~2 weeks, then raise to `p=reject; sp=reject`. Alignment kept relaxed (`adkim=r`/`aspf=r`); no `ruf=` (forensic reports embed message samples — against the privacy posture). This is a **DNS-only** change, not in the repo — DNS/Email-Routing edits are dashboard-only by least-privilege design.

### Notes

- This published-policy DMARC change is distinct from the **inbound** `dmarc=fail` drop shipped in 1.15.0 (`src/auth-results.js`, §19): that rejects forged senders trying to STOP/delete others' tracking; this protects `late.fyi` itself from being spoofed at receivers elsewhere.
- The three AI-bot insights Cloudflare also suggested (block AI bots / AI Labyrinth / Bot Fight Mode) were **declined** — they directly contradict the 0.16.0 discoverability work that deliberately invites retrieval/training crawlers, and Bot Fight Mode's JS gating cuts against the no-analytics posture.
- Static-asset + DNS/docs change; no code paths touched, tests unaffected.

## 0.16.0 — Landing-page discoverability (2026-06-02)

Closes the remaining gaps from the privacy-respecting discoverability playbook (`docs/04-process/privacy-seo.md`) on the `late.fyi` landing page. All declarative, static, open-web — no scripts, no analytics, no calls home; the privacy posture is untouched. Every machine-readable claim mirrors the page's "What we don't do" section and `CLAUDE.md`'s privacy invariant (the privacy claim is a contract).

### Added

- **JSON-LD** (`web/index.html`) — `SoftwareApplication` + `FAQPage` in one `@graph`. Four Q&As (no account, how to track, no analytics, how to stop) written to be lifted verbatim by an assistant. Pure `application/ld+json` — parsed, not executed; same open-web tier as `<meta>`.
- **`web/llms.txt`** — curated agent-facing index: one-line summary, the deletion invariant up top, then links. Real URLs only (apex + GitHub) — single-page site, so no invented routes. Low-cost include; LLM-crawler adoption still partial.
- **AI crawlers named in `robots.txt`** — retrieval/cite-live bots (`Claude-User`, `Claude-SearchBot`, `OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`) and training bots (`ClaudeBot`, `GPTBot`) all explicitly `Allow`-ed. Marketing copy with no PII, meant to spread; the app surface is email, not a web path, so nothing PII-bearing to disallow.

### Changed

- **`sitemap.xml`** — replaced `<changefreq>`/`<priority>` (Google ignores both) with `<lastmod>`, which it does use to prioritise recrawls.

### Notes

- `og:image` (1200×630 `web/og.png`) + `twitter:card: summary_large_image` were already live (2026-05-10); the playbook's stale "og-card deferred / JSON-LD skipped" note is now superseded. The landing page is all-green against the on-page audit; only Tier 3 distribution (Privacy Guides, awesome-* PRs, a philosophical post) remains, which is off-page.
- 299 tests green (static-asset change; no code paths touched).

## 0.15.0 — Security hardening (2026-05-23)

Closes the findings from a grounded security audit — each was reproduced with a PoC against the running code, then re-verified fixed. No behavior change for legitimate senders. 18 regression tests added (299 total; the 4 failures are pre-existing date-fixture staleness, unrelated).

### Security

- **Inbound sender authentication (anti-spoofing).** Every per-user action trusts `From`, so a forged sender could `STOP ALL` and delete a victim's active tracking. Both `worker/index.js` (edge, before waking the VPS) and `src/server.js` `handleInbound` (defense-in-depth) now drop mail whose `Authentication-Results` shows an explicit `dmarc=fail`, via `src/auth-results.js`. Conservative policy: reject only on `dmarc=fail`; absent header / `dmarc=none` / temperror pass through so legit mail from no-DMARC domains isn't bounced. "Fail anywhere rejects" — a forged `dmarc=pass` injected by the sender can't override Cloudflare's real verdict.
- **ntfy fully gated while paused (`NTFY_ENABLED`, default off).** `effectiveChannels` always forced *critical* events (cancelled / replaced / terminating_short / tracking_lost) to BOTH channels, which silently defeated the email-only "pause" — cancellations were being published to `latefyi-sha256(email)[:16]`, a public, email-derivable ntfy topic, for users who never opted in. `dispatch`/`effectiveChannels` now take `ntfyEnabled`; the poll-runner passes it from `NTFY_ENABLED` and strips ntfy from *every* result while off (email remains the fallback, so no silent void). The "critical → both" semantics are preserved for when ntfy is re-enabled.
- **Per-sender action limit across all command kinds.** Only `track` was rate-limited; `stop`/`list`/`config`/`reply`/`help` were unbounded (backscatter amplification + repeated full-state scans, and one user file created per distinct — spoofable — sender). New broad ceiling of 60 inbound commands/hr/sender (`checkActionRateLimit`/`recordAction` in `users.js`), checked in `handleInbound` after the auth gate; over the cap → silent drop.
- **Cross-sender record overwrite fixed.** Pending/active files were keyed on the sanitized inbound `Message-ID`; two senders with msgids that sanitize identically (`<a/b@…>` and `<a_b@…>`) collided, letting a crafted Message-ID overwrite another sender's record. Files are now `<senderHash>-<msgid>.json` (`src/schedule.js`).

### Changed

- **`nodemailer` 6.10.1 → 8.0.7.** Clears the recursive-`addressparser` DoS (GHSA-rcmh-qjqh-p98v) and related advisories; the parser is reachable via the reply `to:` which derives from the attacker-influenced `From`. `npm audit` now reports 0 vulnerabilities (also bumped transitive `qs`).
- **SSH operator scripts hardened.** `scripts/{deploy,vps}.sh` use `StrictHostKeyChecking=accept-new` (was `no`); `scripts/vps.sh` caches the decrypted key in `$XDG_RUNTIME_DIR` (per-user tmpfs, mode 0700, cleared on logout) instead of world-shared `/tmp`.

### Fixed

- **`findRecordsForSender` no longer parses every user's records.** It scopes by the new `<senderHash>-` filename prefix (O(this sender's records), not O(all active trains)), with a transitional content-check fallback for any record predating the prefix scheme so in-flight trips aren't orphaned across this deploy.

### Docs (PRD 1.15.0)

- **§19 Security & Privacy** updated: added sender-authentication and per-sender action-limit entries; rewrote the ntfy-topic line to state the derivability risk, the `NTFY_ENABLED` pause, and the requirement to mix in a per-user secret before un-pausing.

### Added

- **Brand mark.** `web/favicon.svg` — lowercase `l` with an amber dot, doubling as `.fyi` punctuation and a status indicator. Wired via `<link rel="icon">` in `web/index.html`.
- **Inline header logo.** `web/logo.svg` — bg-free variant of the mark used next to the wordmark in the landing page header, sized to match cap-height. Amber `.` separator placed between logo and `late.fyi` wordmark.
- **Mobile-responsive landing page.** Brand row flex-wraps so the subtitle drops to its own line on narrow viewports; logo + wordmark scale down at ≤600px. `pre` blocks get `overflow-wrap: anywhere` (long mailto URLs no longer push the page wider than the viewport) plus tighter font/padding on mobile. Body padding tightened at ≤600px.
- **OG image — link-preview banner.** `web/og.png` (1200×630) — closes out the placeholder noted in 0.14.6. Design is `web/favicon.svg` scaled to fit the 630px height and centered on a `#0a0c10` canvas — single recognisable brand mark, no wordmark / tagline / extra chrome. Same identity in browser tab and link unfurl. Rasterised via ImageMagick from a font-substituted copy of the favicon (JetBrains Mono in place of `ui-monospace`/Menlo so the `l` stroke renders cleanly at scale instead of falling back to a serifed Courier-style glyph). `web/index.html` adds `og:image` (+ `:width`, `:height`, `:alt`) and upgrades `twitter:card` from `summary` (icon-only) to `summary_large_image` (banner). Static asset, no scripts, no third-party calls. After deploy, bust caches via Facebook's Sharing Debugger (covers WA + FB) and LinkedIn Post Inspector; Twitter picks up changes within ~24h.

### Docs (PRD 1.14.6)

Design lock + regional survey, no code changes. Captures decisions reached via a second-pass POC (untracked diagnostics in `scripts/poc-*.js`, not shipped):

- **§8 — Fallback policy locked (Policy A).** Rewrote stale "Fallback during polling" subsection that described mid-trip switching + `disagreement.log`; the shipped code in `src/poll-runner.js:95` and `src/poll.js:109` has always done sticky-source-with-tracking-lost. PRD now matches reality.
- **§8 — POC findings (2026-05-04) added.** SBB rejected as third source (no `hafas-client` profile; would require a non-HAFAS adapter for marginal gain since ÖBB already proxies CH long-distance). Mid-trip source switching rejected on data-quality asymmetry — live comparison on `RJ 854` showed ÖBB reporting 120s delay while PKP reported null on the same train, plus `nationalExpress` vs `high-speed-train` product taxonomy and stop-name divergence (`Flughafen Wien Bahnhof` vs `Flughafen Wien`); switching mid-trip would emit false-positive "delay cleared" pushes. Pre-capturing both sources' tripIds at resolve rejected on stale-cache risk (tripIds are per-day per-profile).
- **§8 — Bus tracking out of scope.** FlixBus / BlaBlaCar Bus (no public realtime API, internal booking IDs not user-memorable) and urban GTFS-RT (fragmented, identifier mismatch with the "email a number" UX). Buses do not map to the product premise unless a different identifier mechanic emerges.
- **§24 — Geographic expansion survey (parked).** Ranked open-API regions for any future non-EU expansion: 🟢 Switzerland (`transport.opendata.ch`), Norway (Entur), Sweden (Trafiklab), Finland (Digitransit), Taiwan (PTX); 🟡 UK (Darwin/HSP, identifier UX awkward), Japan (ODPT, Tokyo metro only), Korea (gated to residents), US (per-operator only); 🔴 China, India, Russia, most of LATAM (closed). Scope filter: regional/long-distance only — no urban metro/tram. Stay EU-only until coverage gaps are felt.
- **§24 — Multi-adapter routing scheme agreed in principle (B + D).** Local-part syntax: `<trainnum>@late.fyi` for EU (default, unchanged), `<cc><trainnum>@late.fyi` for non-EU using ISO 3166 alpha-2 (`ch, no, se, fi, gb, jp, tw`). Optional dash form accepted but not advertised. `eu` silently stripped if typed. Discoverability hint added to §7 "train not found" reply when adapter #2 ships. **Implementation gated on adapter #2 having a concrete reason to exist.**

## 0.14.6 — Declarative discoverability + privacy-SEO playbook (2026-05-04)

### Added

Boring open-web bits that let people find late.fyi without adding any surveillance:

- `web/index.html` — `<link rel="canonical">`, `<meta name="theme-color">`, OpenGraph tags (`og:type`, `og:title`, `og:description`, `og:url`, `og:site_name`), `twitter:card`. Tightened `<meta name="description">` to surface the privacy posture in the snippet ("…no accounts, no analytics, open source") so the audience self-selects in search results.
- `web/robots.txt` — `User-agent: *` / `Allow: /` / `Sitemap:` line.
- `web/sitemap.xml` — single-URL sitemap for the apex.

All static head tags and static files. No scripts, no analytics, no third-party calls. Link unfurls in iMessage / Slack / Signal / Discord / Mastodon now render with title + description (and once an `og-card.png` is added, an image).

### Docs

- `docs/04-process/privacy-seo.md` — playbook for privacy-respecting discoverability. Covers the philosophy ("SEO" is two different things mashed together — declarative machine-readability is open-web, conversion-funnel growth-hacking is what conflicts), tier-1 head tags, tier-2 static files, what to never add (analytics, AMP, tag managers, cookie banners), distribution targets (Privacy Guides, alternativeto, awesome-privacy, Show HN, lobste.rs, IndieWeb wiki), the philosophical-post strategy, and a quarterly audit checklist. Reusable across sibling projects.

### Deferred

- `web/og-card.png` (1200×630) — richer link unfurls. Design task.
- JSON-LD `SoftwareApplication` schema — skipped on principle for now per the guide.

### Verified

`curl https://late.fyi/robots.txt` returns the file; head tags present in the served HTML. Cloudflare Pages-style worker auto-deployed from git push, no manual step.

---

## 0.14.5 / PRD 1.14.5 — Mode A push events + deploy soak (2026-05-04)

### Changed

`src/diff.js` is now fully mode-aware. 0.14.4 fixed only the confirmation reply; every push event that follows (T-30 mandatory push, platform assigned/changed, delay change, terminating short, arrived) was still emitting the boarding shape — so a pickup user got "Picking up EUR9328 at Paris Nord." in the confirmation and then "Tracking EUR 9328, ? → Paris Nord." in the very next email. This release closes the gap.

Pickup mode now emits, across all event types:
- `richBody`: drops the dep schedule line and `Departure platform` field; surfaces only `Scheduled arrival: <time> <to>` and `Arrival platform: <plat>`.
- `tracking_started`: title `Picking up <line>`, body opener `Picking up <line> at <to>.`
- `platform_assigned` / `platform_changed`: headline `<line> arrival platform: <p>, at <to>.` (anchor was already arrival in 1.14.0; only the body copy lagged).
- `delay_change`: headline `<line> arrival +Nmin, at <to>.`
- `terminating_short` / `arrived`: route tail dropped because `<verb> X, at X` reads tautologically (toName is already the headline anchor).

`src/poll-runner.js` now passes `scheduledArrival` as `scheduledIso` for Mode A trains so the push subject's date suffix (` — Monday, 2026-05-04`) matches the confirmation's, instead of being absent (Mode A had no `scheduledDeparture` to anchor on).

### Fixed

- `confirmationReply` Mode A with `arr=null` (degraded HAFAS response that found the train but no plannedArrival) now renders `Scheduled arrival: TBC.` instead of `Scheduled arrival: ?.`. T-30 line also falls back to `at ?` when no anchor.
- `scripts/deploy.sh` soaks 3 s after `systemctl restart` then re-checks `is-active` and tails recent journal lines. Catches the crash-loop pattern that masked the EACCES regression on the previous deploy (unit reports `active` at start, crashes ~200 ms later before deploy script's immediate check returns).

### Tests

281/281 pass (was 271). New: 7 diff.js Mode A tests (T-30 verb, no-origin, no dep platform, scheduled-arrival-only, platform_assigned headline, delay_change headline, terminating_short / arrived route-tail dropped) + 1 boarding regression guard + 3 confirmation gap tests (pickup+trip, pickup+arr=null, pickup without trainNum).

### Audit

VPS root cron writes into `/opt/latefyi/` were audited: only `cron-refresh-disposable.sh` (already self-healing per 1.14.4). `wake.sh` runs as `latefyi`, so any state files it writes are correctly owned. No further perm traps.

---

## 0.14.4 / PRD 1.14.4 — Mode A pickup confirmation + post-refresh EACCES fix (2026-05-04)

### Changed

Confirmation reply now branches on `resolved.mode`. Mode A (pickup, `To:` only) gets a shape that drops irrelevant origin/departure data:

Before (Mode A):
```
Subject: Tracking EUR 9340, ? → Paris Nord
Body:    Tracking EUR 9340, ? → Paris Nord.
         Scheduled: dep ? ?, arr Monday, 2026-05-04 14:42 Paris Nord.
         Departure platform: TBC    Arrival platform: TBC
         Status: TBC
         Updates by email starting T-30 at 14:12.
```

After (Mode A):
```
Subject: Pickup EUR 9340 — Paris Nord — Monday, 2026-05-04
Body:    Picking up EUR 9340 at Paris Nord.
         Scheduled arrival: Monday, 2026-05-04 14:42 Paris Nord.
         Arrival platform: TBC
         Status: TBC
         Updates by email starting T-30 at 14:12.
```

- Subject verb: `Pickup` (vs `Tracking`); no `→` arrow; date suffix anchored on arrival time.
- Body opens "Picking up X at Y" instead of synthesising a "? → Y" route.
- Drops the `dep ? ?` line and `Departure platform` field — neither concept applies when the user isn't boarding.
- T-30 anchor was already correct (arrival for Mode A, departure for Mode B); now the surrounding copy matches.

Mode B (boarding, `From:` present) is unchanged — same "Tracking X, A → B." opener, same dep/arr line, same dep+arr platforms.

### Fixed

`latefyi-ingest` crash-loop on `/opt/latefyi/config/disposable-domains.txt` (`EACCES`) after the first quarterly refresh. Root cause: cron runs as root, `mktemp` creates 0600, `mv` preserves that mode, so the refreshed file landed `0600 root:root` — unreadable by the `latefyi` service user. `scripts/refresh-disposable-domains.sh` now `chmod 644`s the destination and `chown`s it back to `latefyi:latefyi` when invoked as root. The next quarterly cron is self-healing; the current snapshot was repaired manually.

### Tests

271/271 pass (was 264). New: 7 pickup-mode confirmation tests (subject verb, no-arrow, no-question-mark, scheduled-arrival-only line, no dep platform, T-30 anchored on arrival) + 1 explicit boarding-mode regression guard.

---

## 0.14.3 / PRD 1.14.3 — Self-contained push body openers (2026-05-04)

### Changed

Every push body's first line now mirrors the subject's verb so the body reads as a complete sentence on its own — notification previews, forwarded mail, and archive snippets that strip the subject still tell the user *what kind* of update this is.

Before:
```
Subject: Tracking ECD 9536 — Monday, 2026-05-04
Body:    ECD 9536, Amsterdam Centraal → Bruxelles Midi.
         Scheduled: dep ...
```

After:
```
Subject: Tracking ECD 9536 — Monday, 2026-05-04
Body:    Tracking ECD 9536, Amsterdam Centraal → Bruxelles Midi.
         Scheduled: dep ...
```

Same pattern applied to all event types:

| Event                       | New body opener                                                          |
| --------------------------- | ------------------------------------------------------------------------ |
| `tracking_started`          | `Tracking <line>, <from> → <to>.`                                        |
| `platform_assigned`         | `<line> departure platform: <plat>, <from> → <to>.`                      |
| `platform_changed`          | `<line> departure platform CHANGED → <new> (was <old>), <from> → <to>.`  |
| `delay_change`              | `<line> departure +<N>min, <from> → <to>.`                               |
| `arrival_platform_assigned` | `<line> arrival platform: <plat>, <from> → <to>.`                        |
| `arrival_platform_changed`  | `<line> arrival platform CHANGED → <new> (was <old>), <from> → <to>.`    |
| `arrival_delay_change`      | `<line> arrival +<N>min, <from> → <to>.`                                 |
| `cancelled`                 | `<line> CANCELLED, <from> → <to>.`                                       |
| `replaced`                  | `<line> REPLACED, <from> → <to>.`                                        |
| `terminating_short`         | `<line> TERMINATING before <to>, <from> → <to>.`                         |
| `departed`                  | `<line> departed <from>, <from> → <to>.`                                 |
| `arrived`                   | `<line> arrived <to>, <from> → <to>.`                                    |

`richBody()` in `src/diff.js` now takes an optional `headline` param (defaults to the bare-route line for back-compat). Each event in `diff()` passes the appropriate sentence-form opener. For pickup mode (mode A), platform/delay openers say "arrival" instead of "departure" — matching what the user actually cares about.

`docs/02-features/email-formats.md` regenerated to show every new body opener verbatim.

## 0.14.2 / PRD 1.14.2 — Quarterly disposable-list refresh + email notification (2026-05-04)

### Added

- **`scripts/cron-refresh-disposable.sh`** — wraps `refresh-disposable-domains.sh` with operator notification. Runs the refresh, captures old/new line counts + sha256, and (when the snapshot changes and the refresh succeeded) `systemctl restart latefyi-ingest` so the new domains load without a redeploy. Always sends a status email via local postfix to the operator (`avoidaccess@gmail.com`), with subject `[late.fyi] disposable-domains refresh OK (M → N)` or `… FAILED (…)`. Exits 0 unconditionally — the email IS the failure signal, so cron's own MAILTO doesn't double-notify.
- **Quarterly cron entry installed on the VPS (root crontab):**
  ```
  0 6 1 1,4,7,10 * /opt/latefyi/scripts/cron-refresh-disposable.sh
  ```
  Runs at 06:00 UTC on Jan 1, Apr 1, Jul 1, Oct 1.

### Notes

The cron writes the snapshot in-place inside `/opt/latefyi/config/disposable-domains.txt` (the same file checked into the repo). After it runs, the VPS's working tree drifts from `origin/main` until the operator mirrors the new snapshot back to git from their laptop. The drift is harmless (the file is append-mostly data); the email body includes the copy-paste sequence to upstream the change when convenient.

## 0.14.1 / PRD 1.14.1 — Disposable-inbox blocklist (2026-05-04)

### Added

- **Disposable-inbox blocklist**, opt-in via `BLOCK_DISPOSABLE=true` in `/etc/latefyi.env`. Vendored snapshot at `config/disposable-domains.txt` (5437 domains, sourced from [disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)). Senders on a blocked domain receive a friendly bounce (`disposableSenderReply`) — unlike the silent allowlist drop, which exists to avoid backscatter to spoofed senders. The disposable sender authored their own email; an explicit reply is appropriate.
- **`scripts/refresh-disposable-domains.sh`** — manually refresh the snapshot from upstream. Refuses to overwrite if the fetched file looks broken (<1000 lines). Run quarterly + commit the diff. Intentionally NOT fetched at runtime so a remote list change can't silently expand the block surface.

### Why

Per-sender abuse limits (10/hr, 50/day, 20 active) defend the small VPS from runaway resource use, but they're keyed on the sender's email. A script using a fresh disposable inbox per request defeats them trivially. Beyond abuse, disposable inboxes are typically public — sending tracking notifications there leaks the user's trip details into a world-readable inbox they'll never read meaningfully.

264/264 tests pass.

## 0.14.0 / PRD 1.14.0 — Notification reliability + station-local time (2026-05-04)

Two real-world incidents drove this release:

- **2026-05-03 / TGV9810 missed.** All three push events (`tracking_started`, `departed`, `arrived`) were generated and recorded in `push.jsonl`, but **postfix never received any send attempt**. Root cause: a cron-spawned poll-runner orphan (started by `wake.sh` because its pgrep didn't match systemd's relative-path argv) was racing the systemd-managed daemon, ran with no environment (no `SMTP_HOST`), and the dispatch error was silently swallowed by an empty `try/catch`.
- **2026-05-04 / EUR9340 confusion.** Confirmation said `dep Monday, 2026-05-04 09:10` for a train actually departing 11:10 Amsterdam-local. All time formatters used `new Date(iso).toISOString()` which forces UTC and dropped the offset HAFAS gave us per-station.

### Fixed

- **Silent push failures (root + visibility):**
  - `src/poll-runner.js` — failed sends are no longer silently dropped. Every failed channel attempt logs to systemd journal **and** appends to `logs/delivery-errors.log` with timestamp / trainNum / senderHash / channel / attempt / error. Each event is retried up to `MAX_DELIVERY_ATTEMPTS` (10, ≈ 5-min window) via a per-record `state.pendingDeliveries` queue. After give-up: operator alert mailed to `OPERATOR_EMAIL` (subject `[late.fyi] dropped <type> for <trainNum>`).
  - `src/poll-runner.js tick()` — runs `isTerminal()` at the top of the per-record loop. Without it, an arrived record whose linger window hadn't expired on the same poll tick stayed in `state/active/` forever, since `shouldPollNow` then refused to re-poll terminal-phase records. Cleaned up the stuck TGV9810 record.

- **Single-daemon enforcement:**
  - `scripts/wake.sh` — removed the "ensure poll-runner alive" block that spawned `nohup node …` orphans every minute (no env, old code, swallowed errors). systemd is now the single authority for the daemon. wake.sh is a pure pending → active activator.
  - `systemd/latefyi-{poller,ingest}.service` (vendored in repo) — `ExecStart` wrapped in `flock -n /run/latefyi-{poller,ingest}/lock` so a 2nd instance fails fast. `RuntimeDirectory=` provides the lock path. `ExecStartPre=-pkill` catches any orphan spawned outside systemd before flock acquires.
  - `scripts/install-units.sh` — idempotent VPS push of the units (cat → systemd, daemon-reload, kill orphans, restart).

- **Station-local time everywhere:**
  - `src/time-fmt.js` (new) — `parseLocal(iso)` reads literal Y/M/D/HH:MM/offset from the ISO string instead of going through `Date.toISOString()`. `fmtTime`, `fmtDate`, `fmtDatetime`, `dayName` all switch to it. `shiftIso(iso, deltaMin)` shifts while preserving the original offset (used for T-30 anchors).
  - `src/reply.js` and `src/diff.js` — share the new module. The same UTC-conversion bug existed independently in both; now there's a single source.
  - Display rule: time is always station-local. The station name appears next to the time on every line, so we don't add a TZ label — `dep Monday, 2026-05-04 11:10 Amsterdam Centraal` reads as Amsterdam time by construction.
  - T-30 anchor uses `arr` for pickup mode (mode A) and `dep` for boarding mode (mode B).

- **`alreadyArrived` reply** — subject and body now name the actual arrival date instead of "today" (which is stale by the next morning when the email is forwarded/archived). Suggested resend hint is a copy-pasteable `On: <next-day>` header.

- **`unauthorizedSender` reply** — body no longer points at a nonexistent `config.json`. Now says "contact the operator (feedback@late.fyi)". Doc explicitly notes the allowlist is currently empty in production (open to all), so the template is dormant unless `ALLOWED_SENDERS` is populated.

### Changed

- **All push notifications use the rich confirmation shape** (`src/diff.js`). Every change-event body opens with `<line>, <fromName> → <toName>.` so it's self-identifying when read in isolation. Rows that changed get a leading `> ` marker and inline annotations: `(+5min)` next to a delayed time, `(was 15a)` next to a re-platformed train. `cancelled`, `replaced`, `terminating_short`, `departed`, `arrived`, `tracking_lost` all also start with the same self-id line. Title still names the event (e.g. `EUR 9340 platform CHANGED → 16b`) so inbox preview is useful.

### Operator

- **`scripts/vps.sh`** — one-shot VPS access wrapper. Pulls SSH host/user/key from `pass latefyi/ssh/`, materialises the PEM-wrapped key once at `$LATEFYI_SSH_KEY` (default `/tmp/latefyi_key`). `scripts/vps.sh '<cmd>'` for one-off, `scripts/vps.sh` for interactive.

- **`OPERATOR_EMAIL`** env var (`/etc/latefyi.env`). Set to your own email. You receive a `[late.fyi] dropped …` alert only when the system has exhausted retries on a user event. Quiet inbox = healthy system.

- **`logs/delivery-errors.log`** — append-only local mirror of every failed delivery attempt. `tail -f` for live view. Survives even when SMTP itself is the broken thing.

### Documentation

- **`docs/02-features/email-formats.md`** — full catalogue of every email the system reads or writes. Inbound (per-localpart routing + header surface), outbound replies, push notifications (with rich-body samples), operator alerts. Backed by `scripts/dump-email-samples.js`, which regenerates samples by calling each template — re-run after touching `reply.js` or `diff.js` to refresh the doc.

260/260 tests pass.

## 0.13.0 / PRD 1.13.0 — Dates everywhere + list command (2026-05-02)

### Added

- **`list@late.fyi` command.** Email `list@late.fyi` any time to get a reply listing all your currently tracked trains — line, route, and scheduled departure. Footer of every outbound email now surfaces `list@late.fyi (your active trains)` so it's one click away.

### Changed

- **Date always in subject.** Subject lines previously suppressed the ISO date suffix for same-day and next-day trains, relying on the email client's receipt timestamp. Subjects are frozen at send time and become ambiguous when read the following day. Date now always present: `Tracking EUR 9358 — Amsterdam Centraal → Paris Nord — Saturday, 2026-05-02`.
- **Day-of-week added to all dates.** Both subject suffix and body scheduled line now include the day name: `dep Saturday, 2026-05-02 11:42 Amsterdam Centraal`. Applies to confirmation, list, and push replies.
- **STOP ALL / STOP TRIP list the cleared trains with dates.** Previously just "Cleared 2 active trains." Now lists each train with route and dep datetime, same format as `list@` reply.

### Operator

- **`scripts/deploy.sh`** — one-command deploy: pulls SSH host/user/key from `pass latefyi/ssh/`, `git pull` on VPS, restarts both services. No secrets stored on disk.

258/258 tests pass.

## 0.12.0 / PRD 1.12.0 — Bug fixes from code review (2026-05-01)

### Fixed

- **C-1 (critical): push notifications never delivered in production.** `run()` in `poll-runner.js` accepted `transport` and `getUserChannel` at the CLI call site but its own signature didn't declare them, so they were silently dropped before being forwarded to `tick()`. The `if (transport && getUserChannel …)` dispatch block inside `tick()` therefore never fired. One-line fix to the `run()` signature; regression test added.
- **I-1: `CHANNELS email` config reply had wrong `From:` and no FOOTER.** The confirmation was sent from bare `noreply@late.fyi` (no display name) and omitted the standard footer. Now uses `latefyi <config@late.fyi>` and appends FOOTER, matching every other reply template. Test assertion added.
- **I-2: bare `STOP` to `stop@late.fyi` produced "Stopped tracking null".** `parse.js` correctly returns `{scope:'this', target:null}` for a bare STOP (local-part carries no train number). `handleStop` now detects this case and treats it as STOP ALL rather than matching `r.request?.trainNum === null` (always false) and then calling `stopReply` with `target:null`. Test added.
- **I-3: `stats.sh` piped plaintext `.sender` through a shell pipeline to count active users.** The intermediate `xargs jq -r '.sender'` step extracted and deduplicated raw email addresses in-process. Replaced with `.senderHash` — already present on every active record — so no plaintext email is ever materialised outside the JSON file.
- **I-5: HAFAS user-agent version mismatch.** `ingest-server.js` sent `latefyi/0.5.0`; `poll-runner.js` sent `latefyi/0.6.0`. Both now send `latefyi/0.11.0`.
- **m-4: dead `done/` directory cleanup removed.** Terminal records are deleted in-place (`unlinkSync`), not moved to `done/`. The `find … done/ … -delete` pruning line in `wake.sh` and the `done` entry in `ensureStateDirs` (`schedule.js`) were dead code. Both removed.
- **m-5: inconclusive test assertion tightened.** `assert.ok(len===1||len===0)` in the arrived-record test accepted either outcome; replaced with `assert.equal(len, 1)` with a comment explaining the two-tick eviction design.

251/251 tests pass.

## 0.11.0 / PRD 1.11.0 — Subject inbox-grouping + landing-page polish (2026-05-01)

### Subject inbox-grouping signals (`[trip]` + ISO date)
- Subject lines now carry conditional inbox-grouping signals: `Tracking ICE 1255 [austria] — Amsterdam Centraal → Stuttgart Hbf — 2026-05-06`. Trip tag in brackets between train and route (only when set); ISO date suffix after the route (only when train date is *not* today/tomorrow — receipt date covers near-term trains in the inbox column). Same convention threads through `pushReply` so update emails stay grouped consistently.
- Helper `subjectTags({ trip, scheduledIso })` returns `{ prefix, suffix }` (production passes a real clock, tests inject one). Plumbed `trip` + `scheduledIso` from `poll-runner` → `push.dispatch` → `pushReply`.
- 3 new tests covering trip-only, date-only, and combined formats; 249/249 pass.

### Routable From: address + display name (PRD 1.10.0 / impl 0.10.0)
- Outbound replies now use `latefyi <<routable-local>@late.fyi>` instead of `noreply@late.fyi`. The local-part is meaningful per template — confirmations and per-train updates use `<TRAINNUM>@`, stop confirmations use `stop@`, config replies use `config@`, error/help replies use `help@`. Display name `latefyi` keeps the inbox sender clean.
- **Real bug behind "reply STOP doesn't work":** Gmail and others use the `From:` address (not `Reply-To:`) when you hit Reply on a confirmation. Replies were going to `noreply@late.fyi`, which the Cloudflare worker drops via `NON_TRACKING_LOCALPARTS` (defense against worker→worker loops) — silent disappearance, no log on our side. The new From: locals are all routable through the worker, so Reply now lands at the parser. `Reply-To:` retained as belt-and-suspenders for clients that honor it.

### Stop UX — one-click mailto links
- Every confirmation and update email now includes a `mailto:` link: `Stop tracking this train → mailto:stop@late.fyi?subject=STOP%20<TRAIN>&body=STOP%20<TRAIN>`. Tap it, your client opens a fresh compose with subject + body pre-filled, hit send. No reply parsing, no client-specific quirks. The `body=` parameter is belt-and-suspenders for clients (notably Outlook.com web with browser-handled mailto) that silently drop `?subject=`.
- Confirmations with a `Trip:` tag include a second link: `Stop the whole trip (<name>)`.
- Reply-STOP retained as a silent fallback (works for top-posted `STOP` / `STOP <TRAIN>` / `STOP TRIP <name>` / `STOP ALL`); mailto is the only advertised path.

### Confirmation expectations: platform + status fields
- Confirmation reply now surfaces `Departure platform`, `Arrival platform`, and `Status`. Values render as `TBC` until polling fills them at T-30. Sets the expectation that operator-assigned platforms and live status arrive close to departure, not at booking time.

### Bug fix — tryParseStop multi-line regex
- `tryParseStop` regex `/^STOP\b\s*(.*)$/i` failed whenever the input contained a newline (subject + body folded together, or any body with a signature line). JS `.` doesn't match `\n` and `$` is end-of-string, so the regex couldn't reach `$` past the newline → silent unrecognized error. Manifested as `STOP EUR9316` in subject + a Thunderbird `-- Ciao` signature returning `stop_unrecognized`. Now operates on the first non-empty line only. Regression test added.

### ntfy push — deferred (PRD 1.9.0)
- Real-world testing showed the designed onboarding (`CHANNELS ntfy` → reply with `ntfy://subscribe/<topic>` deep link + HTTPS fallback) breaks for fresh users: the deep link is dead without the ntfy app pre-installed, and the fallback drops users into a no-push browser tab. "No extra setup, ever" wasn't honest until we ship a hosted PWA or first-party web push.
- Surfaced as **paused** in user-facing copy: `confirmationReply` and `missingContextReply` strip ntfy/CHANNELS mentions; `config@` accepts `CHANNELS ntfy|both` but replies "ntfy delivery is paused" and pins the user to email. Existing user records with `channel:'ntfy'` are forced to email at the `dispatch` site so they don't fall into a silent void.
- All code paths intact — derived per-user topic, opt-in QR/deep-link reply, push transport, ntfy fail-streak counter — for clean re-enable. One-line revert in `poll-runner.js` plus copy restoration in three reply templates.

### Forgiving subject parser
- Colons and commas are now optional. The parser splits on keyword boundaries (`from` / `to` / `on` / `trip` / `channels`) and captures values lazily up to the next keyword, comma, or end of line.
- **Bare dates auto-detected.** If no `on` keyword is present, an ISO `2026-05-04` or named-month (`5 May 2026`) date anywhere in the subject is auto-tagged as the `on` value. Two-pass extraction: a bare date that would otherwise be swallowed into the `to:` value is recovered. All of these work:
  - `From: Amsterdam, To: Berlin Ostbahnhof` (classic)
  - `from amsterdam to berlin ostbahnhof` (bare)
  - `from amsterdam to paris nord on 2026-05-06` (all bare, with date keyword)
  - `from amsterdam to paris nord 2026-05-06` (bare date, no `on`)
  - `from amsterdam to paris nord 5 May 2026` (bare named-month)
  - `From: Amsterdam to Berlin On: 2026-05-04` (mixed)
- 6 new tests; 240/240 pass.

### Operator metrics — daily snapshot + weekly digest
- `scripts/stats.sh` — daily cron job (00:05 UTC) appends one JSON line to `state/stats/daily.jsonl` with absolute counters: `users_total`, `trips_total`, `active_users`, `active_trips`, `events_total`. Idempotent (skips if today's row already written). Computed from existing state — no new retention. Privacy-safe: no per-user / per-trip detail.
- `scripts/stats-email.sh` — weekly cron (Mondays 00:07 UTC). Picks the latest snapshot from each of the last 4 ISO weeks (4 rows, not 30 daily) and emails a plain-text digest via the VPS postfix (DKIM-signed). Recipient via `LATEFYI_STATS_TO` (default `avoidaccess@gmail.com`).
- Cron entries land at `/etc/cron.d/latefyi-stats`. First snapshot recorded on production VPS; first weekly digest sent and confirmed delivered to Gmail.

### Implementation: 0.8.0 — privacy retention zero + disambiguation completion + open allowlist

**Privacy: delete on terminal (no retention).**
The `done/` archive is gone. When a trip ends — arrival, STOP, cancellation, tracking-lost — the record is `unlinkSync()`'d from `state/active/` with no copy left behind. `errors/` is also gone; malformed records are logged once and deleted (we couldn't extract a sender from them anyway). The `scrubSender()` helper is removed as dead code; `state/active/<msgid>.json` keeps plaintext sender only during active tracking, and that's the entire window the address is held. Operator-level metrics (total users, total trips) derive from `state/users/<hash>.json` counters and `logs/push.jsonl` (senderHash-keyed). Privacy claim is now literally true: **address and record are both deleted at trip end.**

**Disambiguation reply completion.**
When resolve returns `disambiguation_needed`, `server.js` now parks the partial parsed state at `state/pending-disambig/<our-msgid>.json` (24h TTL, lazy expiry). When the user replies — body is just a digit (`1`) or a station name — the parser returns `kind: 'reply'` and `handleDisambigReply` looks up by `In-Reply-To`, applies the answer via `resolveDisambiguation`, and resolves fresh. Out-of-range digits re-send the numbered list. Replies with unknown In-Reply-To are silently dropped.

**Reply-To threading.**
Outbound replies from `noreply@late.fyi` now carry `Reply-To: <TRAINNUM>@late.fyi` so the user's "Reply" routes back through the worker (which still drops `noreply@` defensively). Without this, replies to confirmation/disambig emails would never reach ingest.

**Parser fix.**
`parse.js` now treats any inbound with `In-Reply-To` and no recognized headers as `kind: 'reply'`, regardless of local-part. Previously a valid-trainnum local-part would short-circuit to fresh-track even on a reply to disambig.

**Allowlist opened.**
`ALLOWED_SENDERS=` (empty) on both VPS and Worker. Anyone can email `<TRAINNUM>@late.fyi`, subject to the rate/active limits (10/hr, 50/day, 20 active per sender) shipped earlier in this release.

234/234 tests pass.

### `missingContextReply` documents all subject options
- The "I don't know what you need" reply now surfaces the full subject grammar in a structured layout: pickup vs boarding modes, plus optional `On:`, `Trip:`, `Channels:` with a combined example. Previously only `From:` / `To:` were mentioned. This is the canonical teaching reply — when a sender is confused, they see the whole UX, not just half.

### Feedback channel + reply-footer redesign + worker hardening
- `feedback@late.fyi` is now forwarded to the operator's inbox via a Cloudflare Email Routing custom rule (verified destination + literal-match rule, ordered before the catch-all so it never reaches the Worker).
- `worker/index.js` now declares `NON_TRACKING_LOCALPARTS` (`feedback`, `postmaster`, `abuse`, `admin`, `hostmaster`, `webmaster`, `security`, `noreply`, `no-reply`, `mailer-daemon`) and silently drops mail to those before any allowlist check or ingest forward. Defense-in-depth: if a CF routing rule is missing or misordered, we don't reply with a "not a valid train number" error to legitimate non-tracking mail.
- Reply `FOOTER` slimmed to identity + feedback + privacy claim:
  ```
  — late.fyi
  feedback@late.fyi | we don't store your email past notifications or STOP
  ```
  Format help (subject syntax, optional headers, STOP variants) lives in `missingContextReply` where it actually teaches a confused user. Confirmation/update emails no longer carry instructions for users who already used the system correctly.
- Landing page (`web/index.html`) — added "Travelling later?" section showing the `On: <date>` form, plus `feedback@late.fyi` mailto link in the footer.
- Tests adjusted; 233/233 still pass.

### Phase 7: deliverability + abuse limits + advance planning
- **Deliverability** — SPF (added VPS IP `155.94.144.191`), DKIM (selector `latefyi2026`, opendkim signing-table entry, public key TXT at `latefyi2026._domainkey.late.fyi`), DMARC (`_dmarc.late.fyi`, `p=none` monitoring). Verified via direct send to Gmail: SPF=PASS, DKIM=PASS, DMARC=PASS.
- **Abuse limits** — `users.js` `checkRateLimit()` + `recordRequest()` (pure, with bounded 24h timestamp array per user), wired into `server.js handleTrack`. Defaults: 10 fresh requests/hour, 50/day, 20 active trains/sender. Two new reply templates: `rateLimitedReply` (with retry time), `tooManyActiveReply` (suggests STOP). Failed resolves don't count against the budget.
- **`On: <date>` advance planning** — `parseOnDate()` accepts ISO `2026-05-04`, `5 May 2026`, `5-May-2026`, `05-May-26` (rejects ambiguous `05/04/26`). Validation: must be today or future, max 90 days ahead. Threaded through resolve as a `when: Date` option to HAFAS departures/arrivals. Records sit in `state/pending/` until T-30 (existing wake-up mechanism, no new infra).
- 13 new tests; 233/233 pass.

### Privacy: scrub plaintext sender on terminal (no retention)
- New `scrubSender(rec)` in `src/users.js`: replaces `rec.sender` with `rec.senderHash`. Pure / no I/O.
- `src/server.js` `moveToDone()` now reads → scrubs → atomic-writes to `done/` → unlinks `active/`. Used by all STOP scopes (single / TRIP / ALL).
- `src/poll-runner.js` terminal-move path scrubs the same way. Also: `push.jsonl` event log now records `senderHash` instead of plaintext sender — long-lived log, no plaintext accumulation.
- Privacy claim updated on the landing page: "the moment the trip ends — arrival, STOP, or cancellation — your address is deleted." That's now literal.
- 5 new tests (3 in users.test.js for the helper, 1 in server.test.js for STOP scrub, 2 in poll-runner.test.js for terminal scrub + push.jsonl). 209/209 pass.

### Web: landing page (departure-board)
- `web/index.html` — single-file static landing for `late.fyi`. Departure-board aesthetic (amber on near-black), no JS, no external deps. Sample board with on-time/delayed/cancelled rows. "What we don't do" section states the privacy contract.
- Three variations were prototyped (minimal / email-mock / departure-board); v3 picked.
- Deploy plan: Cloudflare Pages connected to the GitHub repo, `web/` as build output, custom apex `late.fyi`.

### Implementation: 0.6.0 — Phase 6 (ntfy opt-in, partial)
- `src/ntfy-transport.js` — real ntfy POST adapter. `createNtfyTransport({ baseUrl, fetch? })` returns `{ sendNtfy({ topic, title, message, priority?, tags? }) }` matching the payload shape `push.js` already builds. Title/Priority/Tags map to ntfy headers. Throws on non-2xx. 7 new tests (POST URL composition, header serialization, error mapping, missing-fetch guard, missing-topic guard, default base URL).
- `src/poll-runner.js` CLI — composes SMTP + ntfy transports and wires `getUserChannel` from `users.js`. Now actually delivers events instead of only logging to `push.jsonl`.
- `src/reply.js` — `ntfyOptInReply` reworked. Removed the QR-code stub (proportional-font mail clients render ASCII QR poorly, and the QR helps only in laptop-opt-in cases). Replaced with `ntfy://subscribe/<topic>` deep link (one-tap subscribe on phones with the ntfy app installed) plus the plain `https://ntfy.sh/<topic>` URL as fallback. Setup steps streamlined.
- 1 new test added in `tests/reply.test.js` covering deep-link presence.
- 204/204 tests pass.
- **Deferred to Phase 7**: ntfy fail-streak → email fallback promotion (counter is already persisted across polls; the promotion + one-time notice will land alongside abuse limits).

### Live: first real-world tracking request (2026-04-29)
- Confirmed end-to-end with a real email from an Outlook inbox: `To: ICE145@late.fyi`, `Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof`. Cloudflare Email Routing → Worker → VPS ingest → resolve (ÖBB HAFAS) → schedule → confirmation reply delivered to sender within seconds. Reply correctly threaded, scheduled departure/arrival times rendered, T-30 wake time shown, footer rendered.
- Catch-all `*@late.fyi` switched from Drop → Worker via dashboard (the API token used for Worker upload didn't include `Email Routing Rules: Edit`, by design — least-privilege).
- PRD bumped to **1.4.0** (out of draft).

### Deployed to production (2026-04-29)
- First production deployment at `late.fyi`. RackNerd VPS (AlmaLinux 8.10) at `155.94.144.191` already running `addypin.com` — latefyi added alongside without disturbing the existing site.
- Provisioned: dedicated `latefyi` system user, `/opt/latefyi` clone, `npm install --omit=dev`, `/etc/latefyi.env` with INGEST_TOKEN/ALLOWED_SENDERS/SMTP creds, two systemd units (`latefyi-ingest`, `latefyi-poller`) with hardening (NoNewPrivileges, ProtectSystem=strict, ReadWritePaths, ProtectHome, PrivateTmp), cron for `wake.sh`.
- nginx vhost `ingest.late.fyi` co-located with addypin's vhost. TLS via certbot webroot mode (matches addypin's convention). HTTP→HTTPS redirect, ACME path open for renewals, per-IP connection limit, 1MB body cap matching `ingest-server.js`.
- DNS in Cloudflare: A record `ingest.late.fyi` → VPS IP (DNS only, gray cloud). Email Routing enabled.
- Worker `latefyi-ingest` deployed via direct CF API (bypassing `wrangler` and its required Account → User Details: Read scope). Three secrets set: ALLOWED_SENDERS, LATEFYI_INGEST_URL, LATEFYI_INGEST_TOKEN.
- Email Routing catch-all switched from Drop → Worker.
- VPS-side end-to-end test passed: synthetic POST to `/ingest` produced a pending record + confirmation reply delivered to Outlook (`status=sent ... 250 2.6.0 Queued mail for delivery`).
- **Outbound deliverability todo (Phase 7):** SPF needs the VPS IP added; DKIM signing for `noreply@late.fyi` (opendkim already on the box for addypin, just needs a signing-table entry); PTR; same-domain enforcement on receiver junk filters.

### Code: localhost-only ingest bind (2026-04-29)
- `src/ingest-server.js` now binds to `127.0.0.1` by default; override via `INGEST_HOST=0.0.0.0`. Reverse proxy is always co-located, so binding to all interfaces just widened the attack surface for nothing. firewalld already blocked external access on the deployed VPS, but defense-in-depth: localhost-only from the start. 196/196 tests still pass.

### Docs (2026-04-29)
- New: `docs/cloudflare-setup.md` — complete deployment runbook with the 16 actual steps used for late.fyi (DNS → bootstrap → env → systemd → cron → nginx HTTP → certbot → nginx HTTPS → smoke test → CF token → Worker upload → secrets → catch-all rule → real test → outbound hardening notes → recovery table).
- README rewritten to be **user-facing**: how to send the email, optional headers (Trip:, Channels:), STOP variants, what gets pushed (the four windows), coverage, limitations. Developer info moved out into links to PRD / CHANGELOG / cloudflare-setup.
- PRD §21 expanded into the canonical reference for the deployment runbook (kept synchronized with `docs/cloudflare-setup.md`).

### Docs: deployment runbook (2026-04-29)
- PRD §21 expanded into a complete VPS-existing-runbook: where each component lives, systemd unit files for `latefyi-ingest` + `latefyi-poller`, Caddy reverse-proxy block, env-file template, DNS A record + cron + Worker secrets — top-to-bottom-copy-pasteable.
- README architecture diagram redrawn to show the Cloudflare ↔ VPS split clearly. Added "Deploy to your own VPS" 8-step summary linking out to PRD §21.
- Why two pieces explicitly addressed: Workers can't run the polling loop or hold state. Could move to Workers + KV + DOs + Cron Triggers but it'd need a paid plan and rewrite Phases 2–3. Bare-suite VPS path is the deliberate choice (PRD §22 decisions 5, 13).

### Implementation: 0.5.0 — Phase 5 (2026-04-29)
- `worker/index.js` — Cloudflare Email Worker. Allowlist enforcement at the edge (silent drop, no backscatter), then forwards a JSON payload (subject + body + headers + msgid) to the VPS ingest server with a Bearer token. Stateless. ~50 LOC.
- `worker/wrangler.toml` — minimal Worker config; `account_id` to fill in at deploy.
- `worker/README.md` — deployment runbook (wrangler login → secrets → deploy → wire Email Routing).
- `src/ingest-server.js` — Node HTTP server. `GET /health` (unauthenticated liveness probe) and `POST /ingest` (Bearer-token-authed). Calls `handleInbound` and dispatches the reply through an injected transport. Caps payloads at 1 MB. CLI entry wires real hafas-clients + SMTP transport from environment. 13 new tests covering auth, allowlist, transport-failure tolerance, payload limits, malformed JSON.
- `src/smtp-transport.js` — `nodemailer`-based adapter exposing the `{ sendEmail, sendNtfy }` interface push.js expects. Threading headers preserved (In-Reply-To, References, Message-ID). `sendNtfy` throws — Phase 6 wires that.
- `nodemailer` added as a dependency. AGENT_RULES external-dep checklist passes (security-critical SMTP, established, lightweight). Not loaded by tests; only by the production CLI entry.
- PRD §14 secret names updated from `TRAINME_INGEST_*` to `LATEFYI_INGEST_*` to match deployed worker.
- 13 new tests; **196/196 passing total.**

### Implementation: 0.4.0 — Phase 4 (2026-04-29)
- `src/reply.js` — pure templating. Single FOOTER constant (PRD §7) appended to every reply. Functions for confirmation (channel-aware), missing-context, train-not-found, station-not-on-route (with route + suggestion), ambiguous-station (numbered list per §7a), train-already-passed, unauthorized-sender, STOP/STOP TRIP/STOP ALL confirmations, ntfy opt-in (URL + setup), threaded push reply for tracked-train events, generic error.
- `src/push.js` — notification dispatcher. Channel-preference routing (email / ntfy / both). Critical-event override per §6 (cancellation, terminating-short, etc. always go to all channels). ntfy payload mapping (priority + tags + topic from sender hash). Rolling failure-streak counter for §6 ntfy fallback. Transport injected (sendEmail / sendNtfy).
- `src/server.js` — inbound-email orchestrator: parse → route by kind → resolve+schedule+confirm | stop | config | help | error reply. Allowlist enforcement at the edge (silent drop, no backscatter). Generates outbound Message-IDs and stores them on the pending record so subsequent updates thread correctly.
- `src/schedule.js` extended with optional `confirmationMsgid` field on the record (so the poller threads update emails into the original confirmation conversation).
- `src/poll-runner.js` extended with optional `transport` + `getUserChannel` parameters: when provided, events are dispatched via push.dispatch in addition to the audit log. When absent, falls back to log-only behavior (preserves prior tests).
- `src/resolve.js` errors now carry `field` and `userText` for cleaner downstream reply construction.
- 48 new tests (reply 25, push 12, server 11). **183/183 passing total.**

### Implementation: 0.3.0 — Phase 3 (2026-04-29)
- `src/diff.js` — pure `(prev, curr) → PushEvent[]` implementing PRD §9 + the unified taxonomy. Mode-aware anchor (dep for B, arr for A). 22 tests covering all event types and suppression boundaries.
- `src/poll.js` — single-train poll cycle: builds `TrainState` from a hafas-client trip, runs `diff`, returns updated record. Exports `computePhase`, `pollIntervalMs`, `shouldPollNow`, `isTerminal` for the runner. Handles 6-consecutive-failure tracking-lost semantics. 19 tests.
- `src/poll-runner.js` — daemon driver. `tick()` (one-pass, testable) + `run()` (loop forever) + CLI entry. Reads `state/active/*.json`, polls each at the right cadence, atomic-writes back, appends events to `logs/push.jsonl`, moves terminal records to `state/done/`. Malformed JSON → `state/errors/`. Dependency-injected client. 8 tests.
- `tests/integration-pipeline.test.js` extended: end-to-end email → parse → resolve → schedule → activate → **tick** → push.jsonl, all in one test. The full Phase 1+2+3 chain now closes.
- 51 new tests; **135/135 passing total**.

### PRD 1.3.0-draft
- **§5 Modes** — Mode A event coverage clarified to match Mode B (platform changes, terminating short, rerouting now apply to pickup mode too, anchored on the arrival station).
- **§9 Diff table** — added a "Modes" column making per-mode applicability explicit. Replaced ambiguous "platform" with anchor-aware language.
- **§9 Notification taxonomy** — new subsection introducing four canonical windows (tracking start / pre-anchor / in-transit-or-approach / tracking end) consolidating what gets pushed and when. Same windows apply to both modes.
- Status note bumped to "Phases 1 & 2 implemented and validated live against ICE 145."

### Implementation
- Live overnight tracking POC against ICE 145 Amsterdam → Berlin, departed on time at 10:00 CEST 2026-04-29 from platform 8b. 0 poll errors over 135 polls.
- 83/83 tests passing across all phases.

---

## 0.2.0 — Phase 2 (2026-04-29)

### Added
- `src/users.js` — per-user record CRUD at `state/users/<sender_hash>.json`. Deterministic `sha256(email)[:16]` → ntfy topic. Tracks first-time ntfy opt-in for triggering the §7 QR reply only once.
- `src/schedule.js` — writes `state/pending/<msgid>.json` per PRD §12 with computed `poll_start_time` (T-30 default, T-45 for large terminals) and `poll_end_time` (scheduled arrival + grace). Atomic writes via tmp+rename, idempotent on msgid.
- `scripts/wake.sh` — cron-driven activator. Promotes due files from `pending/` → `active/`, prunes `done/` older than 30 days, ensures the (Phase 3) poll-runner stays alive. Survives malformed JSON.
- `tests/integration-pipeline.test.js` — proves parse → resolve → schedule → activate composes end-to-end with correct T-30 timestamps.
- 25 new tests (users 11, schedule 12, wake.sh 2, pipeline 1). Total: **83/83 passing**.

---

## 0.1.0 — Phase 1 (2026-04-29)

### Added
- `src/parse.js` — pure email parser. Returns a discriminated union: `track` | `stop` | `config` | `reply` | `help` | `error`. Implements §4 grammar (Trip tag, case-insensitive headers, reserved local-parts, no auto-pick on missing context) and §13.1 logic.
- `src/stations.js` — fuzzy station matcher. Two-layer disambiguation per §7a: auto-resolve when route narrows to one match, numbered reply otherwise. Levenshtein + alias table + token-level matching for typos on multi-word stops. Forgiving disambiguation reply parser (digit OR fuzzy name).
- `src/resolve.js` — train resolver. ÖBB primary + PKP fallback per §13.2. Anchors at `From:` (Mode B) or `To:` (Mode A), searches departures/arrivals, matches by `fahrtNr` or trailing digits of `line.name`, fetches full trip, validates against route. Returns `resolved` | `disambiguation_needed` | `error`.
- `config/aliases.json` — seed alias table for common ambiguous European station names (Paris, Brussels, Lille, Munich, etc.).
- 58 behavior tests using `node:test` (parse 27, stations 20, resolve 11). Dependency-injected fake hafas-client per Testing Standards — no monkey-patching.

---

## PRD 1.2.0-draft (2026-04-28)

### Added
- **§4 grammar** — `Trip:` optional header (alphanumeric + `-`/`_`, ≤32 chars, case-insensitive). Hard rule: bare emails always trigger §7 missing-context reply, never auto-pick `From:`/`To:` from train route.
- **§7 standard footer** — single canonical footer block referenced as `[FOOTER]` in all reply templates. Compact format/STOP variants reminder. Implementation note: one constant in `reply.js`.
- **§7 STOP variants table** — `STOP`, `STOP <TRAINNUM>`, `STOP TRIP <name>`, `STOP ALL` with confirmation templates.
- **§13.1 parse.js** — restructured to return discriminated-union output. Added reserved local-parts (`config`, `stop`, `help`), explicit STOP variant parsing, `Trip:` validation.
- **§18 edge cases** — `STOP TRIP` empty-trip handling.
- **§22 decisions** — rows 26 (one train per email, no multi-leg parsing), 27 (always require From/To), 28 (standard footer rationale).

---

## PRD 1.1.0-draft (2026-04-28)

### Added (POC findings driven)
- **§7 ambiguous-station reply** — numbered format, accepts name or number.
- **§7a (new)** — full disambiguation flow: auto-resolve from route context, numbered reply only when truly ambiguous, forgiving parser (digit or fuzzy name), `In-Reply-To` correlation, 24h or T-poll-start-minus-5 timeout, 3-retry cap.
- **§22 decisions** — rows 24 (single primary endpoint with PKP fallback) and 25 (two-layer station disambiguation).

### Changed (POC findings driven)
- **§8 endpoint strategy** — rewritten end-to-end. POC verified that of the seven national HAFAS profiles the original spec relied on, only ÖBB is alive. Replaced the per-country endpoint table with `primary: oebb, fallback: pkp`. Added "POC findings" subsection documenting the verification, "durability risk" subsection acknowledging single-vendor data dependency.
- **§10 state machine** — added `AWAITING_DISAMBIGUATION` node and timeout transition.
- **§13.2 resolve.js** — rewritten to drop operator routing; resolves via station-departures search on ÖBB then PKP.

### Validated by POC
- ÖBB returns live data for stations across NL/DE/FR/AT/IT/BE/CH/UK/LU. Every product family the system needs (TER/IC/EUR/TGV/ICE/RJ/NJ/regional/suburban) surfaces with line name, fahrtNr, product, direction, planned/actual times, and platforms.
- PKP confirmed as a working fallback with comparable cross-border coverage.

---

## PRD 1.0.0-draft (2026-04-20)

### Initial product spec
- Email-driven European train tracker. Email `<TRAIN>@<domain>` → real-time platform/delay/cancellation notifications.
- Two modes: A (pickup), B (boarding).
- Three notification channels: email (default, opt-out), ntfy (opt-in), both.
- Bare-suite architecture: Cloudflare Email Worker + Node.js process + cron + filesystem state.
- 25 sections covering grammar, replies, modes, polling, state machine, components, edge cases, security, deployment.
