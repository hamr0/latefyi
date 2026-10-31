---
title: Deployment, Configuration and Observability
theme: deployment-config-observability
sources:
  - docs/archive/latefyi-prd.md
---

# Deployment, Configuration and Observability

Running the system: Cloudflare Worker and DNS, configuration, deployment and systemd, flightlog/pulselog observability.

## Cloudflare Worker setup

Steps for the developer (docs/archive/latefyi-prd.md:1139-1153):

1. `npm install -g wrangler`
2. `wrangler login`
3. Create Worker: `wrangler init worker`
4. Set secrets:
   ```
   wrangler secret put ALLOWED_SENDERS    # comma-separated list
   wrangler secret put LATEFYI_INGEST_URL # https://<your-vps>/ingest
   wrangler secret put LATEFYI_INGEST_TOKEN # random 32-byte hex
   ```
5. Deploy: `wrangler deploy`
6. In Cloudflare dashboard -> Email -> Email Routing -> Routing Rules: catch-all rule `*@late.fyi` -> "Send to a Worker" -> select the deployed worker.
7. Verify by sending a test email; check Worker logs in the dashboard.

Why an edge Worker for ingest: Email Routing requires a Cloudflare-side handler (Worker or forward-to-address); a Worker validates the sender at the edge before waking the VPS; the free tier covers 100k requests/day (docs/archive/latefyi-prd.md:1157-1159).

## Domain and DNS setup

1. (docs/archive/latefyi-prd.md:1167-1170) Buy the domain at any registrar (Cloudflare Registrar at-cost recommended; Namecheap, Porkbun fine), add the site to Cloudflare (free plan), and change the registrar nameservers to the two Cloudflare gives (e.g. `ns1.cloudflare.com`, `ns2.cloudflare.com`). Propagation: minutes to 24 hours.
2. Cloudflare -> Email -> Email Routing -> Enable. This auto-adds the required MX, SPF, DKIM, DMARC records (docs/archive/latefyi-prd.md:1171).
3. Verify propagation: `dig MX late.fyi +short` should return Cloudflare's mail servers (docs/archive/latefyi-prd.md:1172).

No paid Cloudflare plan is required; Workers free tier and Email Routing free tier are both sufficient (docs/archive/latefyi-prd.md:1174).

## Configuration

### `config/config.json`

Reference shape from the original PRD (docs/archive/latefyi-prd.md:1226-1272). The running system does not read a `config/config.json`: settings come from `/etc/latefyi.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `ALLOWED_SENDERS` (empty = open), `OPERATOR_EMAIL`, ...), and `config/` holds only `aliases.json` and `disposable-domains.txt`. Outbound mail is the VPS's own postfix + opendkim, not a relay, and ntfy was removed in 0.19.0 (the `NTFY_*` vars are gone); read the `smtp`, `ntfy` and `log_retention_days` keys below as historical:

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
  "ingest_token_env": "LATEFYI_INGEST_TOKEN",
  "ingest_port": 8787,
  "large_terminals": ["Paris Gare du Nord", "Paris Gare de Lyon", "Paris Montparnasse", "Paris Gare de l'Est", "Frankfurt Hbf", "Berlin Hbf", "München Hbf", "Roma Termini", "Milano Centrale", "Brussels Midi/Zuid"],
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

Refers to section 8 of the PRD (docs/archive/latefyi-prd.md:1274-1276).

### `config/aliases.json`

Maps common station names to canonical names; an `AMBIGUOUS:` prefix lists alternatives (docs/archive/latefyi-prd.md:1278-1290):

```json
{"Paris Nord": "Paris Gare du Nord", "Paris Lyon": "Paris Gare de Lyon", "Lille": "AMBIGUOUS:Lille Flanders|Lille Europe", "Brussels": "Brussels Midi/Zuid", "Bruxelles Midi": "Brussels Midi/Zuid", "Frankfurt": "Frankfurt Hbf", "Munich": "München Hbf"}
```

## Deployment

The deploy steps, systemd units, reverse proxy, cert renewal, Worker update and verification live in [Deployment Steps and Infrastructure](deployment-steps.md).

## Observability (flightlog + pulselog)

Two zero-dep sibling libs (`flightlog`, `pulselog`), wired per `hamr0/observability-playbook.md`. Four independent layers; layers 1-3 are shipped, layer 4 (off-box backup/watch) is a parked follow-up (docs/archive/latefyi-prd.md:1525).

- **flightlog, in-app error capture.** `install()` runs once in each daemon's CLI block (`src/ingest-server.js`, `src/poll-runner.js`): global handlers catch uncaught exceptions (log synchronously, then exit 1 so systemd `Restart=on-failure` restarts clean) and unhandled rejections (log, stay alive). `capture()` records the handled swallow points that keep a daemon alive across a fault: the poll-runner tick-level catch (`where: 'poll-tick'`) and operator-alert send failure (`where: 'operator-alert-send'`), and the ingest request/send catches (`where: 'ingest-request' | 'ingest-send'`). All append to `logs/errors.jsonl`. Library functions take an optional no-op `capture`/`captureError` so tests inject nothing. Privacy: `errors.jsonl` holds only Error name/message/stack plus a static low-cardinality `where`, never a sender or trip record (a first-class extension of the section 19 invariant) (docs/archive/latefyi-prd.md:1527).
- **pulselog health, `latefyi-health.timer`, every 15 min.** Runs the `checks` in `pulselog.config.json`: `service` (poller / ingest / postfix / opendkim), `http` on the ingest `/health`, `disk` (root + `/opt/latefyi`), `ssl` (`late.fyi`, `ingest.late.fyi`, warn <14 days), and a `mailq` depth guard. Silent on green; one summary email to `$OPERATOR_EMAIL` on any failure. Supersedes the section 18 "add disk monitoring out of band" note (docs/archive/latefyi-prd.md:1528).
- **pulselog digest, `latefyi-stats-digest.timer`, weekly (Sun 09:00 UTC).** `bin/stats.js` prints one flat JSON object of counts, `{users, trains, completed, active_trains, active_users}` (counts only; active users by senderHash). pulselog appends a `kind:"stats"` line to `logs/stats.jsonl` and emails a week-over-week table plus a flightlog rollup (counts and group-names only, never messages/stacks). `completed` ("works ran") = `trains_completed_count` summed across user files (section 12) (docs/archive/latefyi-prd.md:1529).
- **Config is rendered, not committed.** `pulselog.config.template.json` is committed; `scripts/install-units.sh` renders `${OPERATOR_EMAIL}` from `/etc/latefyi.env` into the gitignored `/opt/latefyi/pulselog.config.json` (so `deploy.sh`'s `git pull` never clobbers it). Alert/digest sender is `noreply@late.fyi`, the only address opendkim signs (selector `latefyi2026`), so mail is DKIM-aligned and DMARC-passing like all other outbound. Deploy the timers with `scripts/install-units.sh` (installs all four units, renders the config, `enable --now`s the timers, runs one health check) (docs/archive/latefyi-prd.md:1530).
- **Deliverability caveat, operator address on a Microsoft domain.** Alert/digest mail is plain `sendmail` through the VPS postfix. The shared IP `155.94.144.191` (AS3130) is on Microsoft's Spamhaus feed, so mail to `@msn/outlook/hotmail/live` hard-bounces at `MAIL FROM` (`550 5.7.1 … blocked using Spamhaus`) regardless of the (passing) SPF/DKIM/DMARC; validated 2026-07-02: the operator digest signed correctly (`s=latefyi2026`) but bounced at Outlook. The fix is IP reputation (Spamhaus delist from `abuse@addypin.com`, the rDNS domain; then Microsoft feed refresh / Sender Support + JMRP; SNDS already enrolled), not any change here. Prefer a non-Microsoft operator inbox, and keep a secondary signal (the JSONL logs, and the parked section 8 off-box watch) so a blocked alert isn't the only notice (docs/archive/latefyi-prd.md:1531).

Inspection commands (docs/archive/latefyi-prd.md:1533-1539):

```sh
# Inspect
tail -1 /opt/latefyi/logs/stats.jsonl | jq .          # latest weekly snapshot
cat /opt/latefyi/logs/errors.jsonl | jq -r .where | sort | uniq -c   # error groups
systemctl list-timers 'latefyi-*'                     # are the timers scheduled?
node node_modules/pulselog/bin/pulselog.js --digest --dry-run --config /opt/latefyi/pulselog.config.json
```
