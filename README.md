# latefyi

> Email-driven European train tracker. Email `<TRAIN>@late.fyi`, get real-time platform/delay/cancellation notifications back.

`latefyi` is a small, self-hosted notifier for European rail. You email it the train number you care about (with optional `From:` / `To:` headers), and it watches the live HAFAS feed and pings you when something changes — platform announced, departure delayed, arrival platform changed, train terminating short, cancellation, replacement service. Email by default, ntfy push opt-in, both available.

It is **not** a journey planner, ticketing tool, or web app. It does one thing.

---

## How it works (user view)

```
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
To:      ICE145@late.fyi
```

Reply, threaded, within seconds:

```
Tracking ICE 145 — Amsterdam Centraal → Berlin Ostbahnhof.
Scheduled: dep 10:00, arr 16:02.
Updates by email starting T-30 at 09:30.
```

From T-30 onwards, you only hear from it when something changes. Silence means everything is on schedule.

Optional headers:

| Header | Effect |
|---|---|
| `From: <station>` | Boarding mode — track from this station |
| `To: <station>` | Pickup or destination — track until this station |
| `Trip: <name>` | Group multiple trains under a label for `STOP TRIP <name>` |
| `Channels: ntfy\|email\|both` | Per-request channel override |

Reply with `STOP`, `STOP TRIP <name>`, or `STOP ALL` to cancel tracking. Email `config@late.fyi` with `CHANNELS ntfy` to opt into push notifications.

Full grammar and reply behaviors: see [PRD §4 and §7](docs/01-product/latefyi-prd.md).

---

## Status

| Phase | What | Status |
|---|---|---|
| 0 | POC: validate ÖBB universal HAFAS gateway, prove diff loop on real train | ✅ Done — ICE 145 Amsterdam→Berlin tracked end-to-end overnight, 0 errors |
| 1 | `parse.js`, `stations.js`, `resolve.js` (offline) | ✅ Done — 58 tests |
| 2 | `users.js`, `schedule.js`, `wake.sh` (state + scheduler) | ✅ Done — 25 tests, integration verified |
| 3 | `diff.js`, `poll.js`, `poll-runner.js` (live polling daemon) | ✅ Done — 51 tests, full email→push.jsonl chain integration-verified |
| 4 | `reply.js`, `push.js`, `server.js` (email channel + orchestrator) | ✅ Done — 48 tests, end-to-end email-in/email-out via injected transport |
| 5 | `worker/`, `ingest-server.js`, `smtp-transport.js` (production ingest) | ✅ Done — 13 tests, deployment runbook in `worker/README.md` |
| 6 | ntfy opt-in flow + QR (real ntfy transport) | ⏳ Next |
| 7 | Hardening, edge cases, 30-day soak | ⏳ |

System is end-to-end usable after Phase 4. ntfy is purely additive in Phase 6.

---

## Architecture

Two pieces, one in each box. Cloudflare handles inbound email receipt at the edge; a small Node process on a VPS (or any always-on machine) does the actual work.

```
                       Cloudflare account                                 Your VPS
   ┌────────────────────────────────────────┐    ┌──────────────────────────────────────────┐
   │  late.fyi MX → Email Routing           │    │                                          │
   │   ↓                                    │    │     systemd: latefyi-ingest (port 8787)  │
   │  Catch-all rule → Worker               │    │       POST /ingest  (Bearer token)       │
   │   ↓                                    │    │       parse → resolve → schedule         │
   │  worker/index.js (~50 LOC, stateless)  │    │       reply via SMTP transport ──────────┼──▶ SMTP relay
   │   ├─ allowlist check                   │    │                                          │       (Resend / Postmark / SES)
   │   └─ POST {payload} ───────────────────┼────▶                                          │
   │      to ingest.late.fyi (A record)     │    │     systemd: latefyi-poller              │
   │                                        │    │       reads state/active/*.json          │
   │  late.fyi DNS:                         │    │       polls hafas-client (oebb / pkp)    │
   │   - MX (auto by Email Routing)         │    │       diff → events → push.jsonl + send  │
   │   - A: ingest.late.fyi → VPS IP        │    │                                          │
   └────────────────────────────────────────┘    │     cron (every minute):                 │
                                                 │       scripts/wake.sh                    │
                                                 │       moves pending → active at T-30     │
                                                 │                                          │
                                                 │     state/ on disk:                      │
                                                 │       users/, pending/, active/,         │
                                                 │       done/, errors/                     │
                                                 └──────────────────────────────────────────┘
```

The Worker can't run the polling loop or hold state — Cloudflare Workers are stateless and CPU-time-limited per request. Its job is just to filter at the edge and forward. Could the whole system run on Workers + KV + Durable Objects + Cron Triggers? Yes, but it would require a $5/mo paid plan, lose file-based simplicity, and rewrite Phases 2–3. PRD §22 decisions 5 and 13 chose the bare-suite VPS path on purpose.

**What "always on" means in practice:** a tiny VPS (Hetzner CX11 €4/mo, Oracle free tier, Fly.io shared-cpu, etc.), a home server, or a Raspberry Pi all qualify. ~50 MB resident, trivial CPU.

State lives in plain files under `state/`:

- `state/users/<sender_hash>.json` — per-user lifetime state (channel pref, ntfy topic)
- `state/pending/<msgid>.json` — scheduled but not yet polling (waiting for T-30)
- `state/active/<msgid>.json` — currently polling
- `state/done/<msgid>.json` — terminal state, retained 30 days
- `state/errors/<msgid>.json` — parse/resolve/runtime failures

Single dependency: [`hafas-client`](https://github.com/public-transport/hafas-client) (npm). Everything else is Node built-ins.

Endpoint strategy: **ÖBB primary, PKP fallback.** POC verified ÖBB returns live data for stations across NL / DE / FR / AT / IT / BE / CH / UK / LU. The original PRD's per-country endpoint table was discarded because the underlying HAFAS profiles for SNCF / SBB / NS / Trenitalia / Eurostar were never shipped by `hafas-client`, and DB / SNCB are dead. ÖBB serves as a universal European gateway.

---

## Repo layout

```
latefyi/
├── docs/01-product/latefyi-prd.md   Product spec (canonical, ~1300 lines)
├── src/                              Production code
│   ├── parse.js                      Email payload → discriminated union
│   ├── stations.js                   Fuzzy matching + disambiguation
│   ├── resolve.js                    HAFAS lookup + route validation
│   ├── users.js                      Per-user state (channel, ntfy topic)
│   └── schedule.js                   Pending file writer + activator helpers
├── tests/                            node:test behavior tests, no external deps
├── config/aliases.json               Common station-name aliases
├── scripts/wake.sh                   Cron-driven activator (every 1min)
├── poc/                              Validation scripts retained for reference
└── CHANGELOG.md                      PRD + implementation history
```

---

## Run the tests

```sh
npm install
npm test
```

Currently: **196/196 pass** in ~600 ms. No network required (HAFAS interactions are dependency-injected fakes; SMTP is stubbed; HTTP ingest tests spin up real servers on random ports).

## Deploy to your own VPS

Full runbook lives in [PRD §21](docs/01-product/latefyi-prd.md#21-deployment) and [worker/README.md](worker/README.md). Short version:

1. **Domain** — point nameservers at Cloudflare; enable Email Routing (free).
2. **VPS** — clone repo, `npm install --omit=dev`, write `/etc/latefyi.env` with `INGEST_TOKEN`, `ALLOWED_SENDERS`, SMTP relay creds.
3. **Two systemd units** — `latefyi-ingest` (HTTP server) and `latefyi-poller` (polling daemon). Both restart-on-failure.
4. **Cron** — `* * * * * /opt/latefyi/scripts/wake.sh` for T-30 activation.
5. **Reverse proxy** — Caddy or nginx terminating TLS on `ingest.late.fyi`. Caddyfile is one block.
6. **DNS** — A record `ingest.late.fyi` → VPS IP, in the same Cloudflare dashboard.
7. **Worker** — `wrangler secret put` the three values (allowlist, ingest URL, ingest token), then `wrangler deploy`. Wire Email Routing → Worker.
8. **Test** — email `Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof` to `ICE145@late.fyi` from an allowlisted address.

No Docker required. No DB. ~50 MB resident on the VPS.

---

## Why "latefyi"

European trains run late more often than not. The system's most-sent message is always going to be "your train is delayed by N minutes." Naming the service after its loudest, most-needed message is honest branding: `late.fyi` = *your train is late, FYI*. The on-time confirmations are quiet by design (PRD §9 suppression).

Short, memorable, cheap (`.fyi` ~$13/yr), email-routable. Six characters end-to-end.

---

## Acknowledgments

Built with [`hafas-client`](https://github.com/public-transport/hafas-client) — the only thing standing between this project and writing a HAFAS protocol implementation by hand. Thank you to its maintainers.

---

## License

[Apache License 2.0](LICENSE)
