# CLAUDE.md — late.fyi

Email-driven European train tracker. User emails `<TRAINNUM>@late.fyi`, gets push/email updates only when something matters.

## Run

- `npm test` — node:test (built-in, no jest). Tests stay offline; no real HAFAS calls.
- Baseline: 233 tests pass in ~1s.

## Architecture (one path through the system)

`*@late.fyi` → CF Email Worker (`worker/index.js`) → POST /ingest on VPS → `src/server.js handleInbound` → parse / resolve / schedule → `state/pending/<msgid>.json` → `scripts/wake.sh` cron → `state/active/` → `src/poll-runner.js` → diff → `src/push.js` → SMTP (postfix on VPS) or ntfy POST → terminal → `state/done/` (sender scrubbed).

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

VPS at `155.94.144.191`. `opendkim` signs `noreply@late.fyi` with selector `latefyi2026`. SPF / DKIM / DMARC all PASS to Gmail. Don't add HTTP routes to the Email Worker. Don't enable Cloudflare Web Analytics on Pages (the privacy claim says no analytics).

## Reserved email local-parts

`worker/index.js` `NON_TRACKING_LOCALPARTS` (`feedback`, `postmaster`, `abuse`, `admin`, ...) drops before any processing. CF Email Routing custom rules are the primary delivery; this is defense in depth so a missing rule doesn't bounce "not a valid train number" to a real human.

## Operator secrets at `pass latefyi/`

| Path | What |
|---|---|
| `ssh/{host,user,private_key}` | VPS access (same key as `addypin/ssh` — same VPS) |
| `ingest_token` | Bearer token Worker → VPS |
| `ingest_url` | `https://ingest.late.fyi/ingest` |
| `allowed_senders` | comma-separated; empty = open |
| `dkim/{selector,private_key,dns_record_value}` | DKIM material |
| `cloudflare_api` | Workers Scripts: Edit only. **DNS and Email Routing edits are dashboard-only** by design (least privilege). |

## Common gotchas

- HAFAS endpoints come and go. ÖBB primary + PKP fallback are current; DB and SNCB endpoints are dead. **Don't add per-operator routing** — ÖBB is a universal European gateway, validated in the POC.
- `On: <date>` rejects pure-numeric (`05/04/26` is US/EU ambiguous). ISO `2026-05-04` or named-month (`5 May 2026`) only.
- TXT record paste in CF UI sometimes preserves newlines as `\010` bytes. Always paste single-line or fix via API.
- The `latefyi-ingest` Worker deploys via direct CF API multipart PUT (not `wrangler deploy`) because that's how it was bootstrapped; wrangler config at `worker/wrangler.toml` is reference-only.

## Phase status

Phases 1–7 are shipped and live. Allowlist is **open** to anyone. Outstanding: 30-day soak, ntfy fail-streak → email fallback promotion.

## Reply-To threading

Outbound replies have `From: noreply@late.fyi` (worker drops `noreply@`) and `Reply-To: <TRAINNUM>@late.fyi`. User's "Reply" routes through the worker via the trainnum address. When the parser sees `In-Reply-To` + no headers, it returns `kind: 'reply'` regardless of local-part. That's how disambiguation answers + replies-to-confirmations work.

## Update landing page privacy claim if you change retention

`web/index.html` "What we don't do" section says "your address AND the record are deleted on trip end". If you ever add a `done/` archive (you shouldn't), update the page first.
