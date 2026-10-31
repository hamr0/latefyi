# CLAUDE.md — late.fyi

Email-driven European train tracker. User emails `<TRAINNUM>@late.fyi`, gets email updates only when something matters.

## Run

- `npm test` — node:test (built-in, no jest). Tests stay offline; no real HAFAS calls.
- Baseline: 278 tests pass in ~4s.
- CI (`.github/workflows/ci.yml`): `npm ci` → `npm test` on every push/PR, Node 22 (`engines` `>=22`); read-only `contents` permission, no secrets.

## Architecture (one path through the system)

`*@late.fyi` → CF Email Worker (`worker/index.js`) → POST /ingest on VPS → `src/server.js handleInbound` → parse / resolve / schedule → `state/pending/<msgid>.json` → `scripts/wake.sh` cron → `state/active/` → `src/poll-runner.js` → diff → `src/push.js` → SMTP (postfix on VPS) → terminal → record deleted (no `done/` archive).

## Two Workers, often confused

- **`latefyi-ingest`** — Email Worker. Trigger: catch-all `*@late.fyi`. No HTTP route. Forwards JSON to VPS ingest. Deploys via direct CF API (`PUT /accounts/.../scripts/latefyi-ingest`) since the API token is scoped to Workers Scripts: Edit only.
- **`latefyi`** — Pages-style Worker. Serves the apex `late.fyi` landing page (`web/index.html`). Auto-deploys from git push.

## Conventions

- Vanilla > stdlib > external dep. Only runtime deps: `hafas-client`, `nodemailer`. Tests use node:test.
- File-based state under `state/{users,pending,active,pending-disambig}/`. Atomic writes via tmp+rename. **No `done/` or `errors/`** — terminal records are deleted, not archived.
- Discriminated unions for parse/resolve outputs (`kind: 'track' | 'stop' | 'config' | 'reply' | 'help' | 'error' | 'resolved' | 'disambiguation_needed'`).
- Behavior tests, no internal mocking — inject fakes for hafas-client / transport / fetch.
- No backwards-compat shims, no half-finished implementations. If something's removed, delete it.

## Privacy invariant (hard requirement)

Plaintext sender lives only in `state/active/<msgid>.json` during active tracking. On terminal (arrival / STOP / cancellation / tracking-lost), the record is `unlinkSync()`'d — no copy, no archive. `push.jsonl` event log uses `senderHash` only. Tests assert active/ becomes empty post-terminal — don't add a `done/` archive without an explicit privacy-policy change.

## Deliverability is wired

VPS at `155.94.144.191`. `opendkim` signs `noreply@late.fyi` with selector `latefyi2026`. SPF / DKIM / DMARC all PASS to Gmail. **Outlook/Hotmail/msn caveat:** can hard-bounce at `MAIL FROM` (`550 … blocked using Spamhaus`) — an IP-reputation block on the shared VPS IP, independent of the (passing) auth. Fix is IP delisting, not auth/DNS; prefer a non-Microsoft operator inbox. Detail in CHANGELOG 0.18.0 / PRD §21. Don't add HTTP routes to the Email Worker. Don't enable Cloudflare Web Analytics on Pages (the privacy claim says no analytics).

**Inbound sender auth (anti-spoofing).** Every per-user action trusts `From`, so a forged sender could STOP/delete someone else's tracking. The Worker and `handleInbound` both drop mail whose `Authentication-Results` shows an explicit `dmarc=fail` (`src/auth-results.js`). Policy is conservative: reject only on `dmarc=fail` (a real domain's owner didn't send it) — absent header / `dmarc=none` / temperror pass through, so legit mail from no-DMARC domains isn't bounced. "Fail anywhere rejects" so a forged `dmarc=pass` header can't override CF's real verdict.

## Reserved email local-parts

`worker/index.js` `NON_TRACKING_LOCALPARTS` (`feedback`, `postmaster`, `abuse`, `admin`, `config` (retired command), ...) drops before any processing. CF Email Routing custom rules are the primary delivery; this is defense in depth so a missing rule doesn't bounce "not a valid train number" to a real human.

## Operator secrets at `pass latefyi/`

| Path | What |
|---|---|
| `ssh/{host,user,private_key}` | VPS access (same key as `addypin/ssh` — same VPS) |
| `ingest_token` | Bearer token Worker → VPS |
| `ingest_url` | `https://ingest.late.fyi/ingest` |
| `allowed_senders` | comma-separated; empty = open |
| `dkim/{selector,private_key,dns_record_value}` | DKIM material |
| `cloudflare_api` | Workers Scripts: Edit only. **DNS and Email Routing edits are dashboard-only** by design (least privilege). |
| `origin_cert/{ingest_pem,ingest_key}` | CF Origin CA cert + key for `ingest.late.fyi` (behind the orange proxy, SSL Full strict). Lives on the VPS at `/etc/ssl/cloudflare/`; this is a **backup only** — regenerable free from the CF dashboard (SSL/TLS → Origin Server). |

## Common gotchas

- HAFAS endpoints come and go. ÖBB primary + PKP fallback are current; DB and SNCB endpoints are dead. **Don't add per-operator routing** — ÖBB is a universal European gateway, validated in the POC.
- `On: <date>` rejects pure-numeric (`05/04/26` is US/EU ambiguous). ISO `2026-05-04` or named-month (`5 May 2026`) only.
- TXT record paste in CF UI sometimes preserves newlines as `\010` bytes. Always paste single-line or fix via API.
- The `latefyi-ingest` Worker deploys via direct CF API multipart PUT (not `wrangler deploy`) because that's how it was bootstrapped; wrangler config at `worker/wrangler.toml` is reference-only.
- `ingest.late.fyi` is **orange-clouded** (CF proxy) with a **CF Origin cert** at `/etc/ssl/cloudflare/` under SSL Full (strict) — not grey/Let's Encrypt. The VPS firewall drops `:443` from non-Cloudflare source ranges. Don't revert it to grey or an LE/ACME cert — that re-exposes the shared origin IP and breaks the firewall lock. Real client IP comes from the box's **global** `00-cloudflare-realip.conf` (shared with the co-tenant); don't add a latefyi-local `set_real_ip_from` copy, and never edit that file from this repo (it carries the co-tenant's origin-lock block).

## Observability (flightlog + pulselog)

Two zero-dep sibling libs, wired per `hamr0/observability-playbook.md`.

- **flightlog** (in-app error net). `install()` runs once in each daemon's CLI block (`src/ingest-server.js`, `src/poll-runner.js`) — global handlers catch uncaught throws / rejections, and `capture()` records the two swallow points that keep a daemon alive across a fault: the poll-runner tick-level catch (`where: 'poll-tick'`) + operator-alert send failure (`where: 'operator-alert-send'`), and the ingest request/send catches (`where: 'ingest-request' | 'ingest-send'`). Both write `logs/errors.jsonl`. Library functions (`createIngestServer`, `tick`/`run`) take an **optional** `captureError`/`capture` (no-op default) so tests inject nothing. **Privacy: `errors.jsonl` holds only Error name/message/stack + a static low-cardinality `where` — never a sender or trip record.** Don't pass user data to `capture()`.
- **pulselog** (off-app watcher, systemd timers on the VPS). `latefyi-health.timer` runs `pulselog` every 15 min (services, ingest `/health`, disk, SSL, mailq — silent on green, one email on failure). `latefyi-stats-digest.timer` runs `pulselog --digest` weekly (Sun 09:00 UTC): `bin/stats.js` prints `{users,trains,completed,active_trains,active_users}` (counts only; `completed` = trips run to a terminal end via `trains_completed_count`, "works ran"; senderHash for active users), pulselog appends a `kind:"stats"` line to `logs/stats.jsonl` and emails a WoW table + a flightlog rollup (**counts and group-names only, never messages/stacks**).
- **Config is rendered, not committed.** `pulselog.config.template.json` is committed; `scripts/install-units.sh` renders `${OPERATOR_EMAIL}` from `/etc/latefyi.env` into `/opt/latefyi/pulselog.config.json` (gitignored, so `deploy.sh`'s `git pull` never clobbers it). Sender is `noreply@late.fyi` because opendkim only signs that address. Deploy the timers with `scripts/install-units.sh` (installs all four units + renders config + `enable --now` the timers).
- **Not yet done:** off-box backup/watch host (playbook §8) — the only layer that survives the VPS being fully down. Optional follow-up.

## Phase status

Phases 1–7 are shipped and live. Allowlist is **open** to anyone. Outstanding: 30-day soak.

## Reply-To threading

Outbound replies have `From: noreply@late.fyi` (worker drops `noreply@`) and `Reply-To: <TRAINNUM>@late.fyi`. User's "Reply" routes through the worker via the trainnum address. When the parser sees `In-Reply-To` + no headers, it returns `kind: 'reply'` regardless of local-part. That's how disambiguation answers + replies-to-confirmations work.

## Update landing page privacy claim if you change retention

`web/index.html` "What we don't do" section says "your address AND the record are deleted on trip end". If you ever add a `done/` archive (you shouldn't), update the page first.

<!-- MEMORY:START -->
@.claude/remember/MEMORY.md
<!-- MEMORY:END -->

<!-- AGENT_RULES:START -->
Consult when building something new or adding a feature — a standards guide, not hot
context like MEMORY.md above:
.claude/remember/AGENT_RULES.md
<!-- AGENT_RULES:END -->

<!-- DOCS_INDEX:START -->
Docs map: `docs/index.md` — every doc in this project, with line counts.
Search this corpus instead of reading it whole: `/docs-builder search <query words>`
<!-- DOCS_INDEX:END -->
