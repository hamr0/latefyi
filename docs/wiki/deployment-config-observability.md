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

Reference shape (docs/archive/latefyi-prd.md:1226-1272):

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

The operator runbook (copy-pasteable, with a real-world example) is `cloudflare-setup.md`; this section keeps the reference architecture and is the source of truth for what lives where, while the runbook is the source of truth for how to set it up step by step (docs/archive/latefyi-prd.md:1360).

### Where each piece runs

(docs/archive/latefyi-prd.md:1364-1371)

| Component | Hosted on | Why |
|---|---|---|
| Inbound email receipt + edge allowlist | Cloudflare Email Worker (free) | Email Routing only delivers via Workers; CPU-cheap allowlist filtering at the edge |
| HTTP `/ingest` endpoint | Your VPS, port 8787 (behind reverse proxy on 443) | Persistent process, file-system state |
| Polling daemon (`poll-runner.js`) | Your VPS | Long-lived loop; ditto state |
| Cron `wake.sh` (every minute) | Your VPS | Activates due `pending/` records |
| Outbound mail | Your VPS -> SMTP relay (Resend / Postmark / SES / etc.) | CF Email send-binding only works inside Workers and is destination-verified-only on free; SMTP relay is the open path |
| DNS for `late.fyi` and `ingest.late.fyi` | Cloudflare | Same dashboard handles MX + A record |

### Minimum infra

(docs/archive/latefyi-prd.md:1375-1378)

- 1x Cloudflare account (free); 1x domain (`late.fyi`, $11-13/yr at Cloudflare Registrar)
- 1x small VPS (1 vCPU, 512 MB RAM, 10 GB disk) OR Raspberry Pi at home: anything always-on with public IP and outbound 587/465
- 1x SMTP relay account (Resend free tier = 3,000/mo, Postmark, AWS SES, etc.); most VPS providers block port 25, so a relay is the practical path

### Deploy steps (existing VPS path)

(docs/archive/latefyi-prd.md:1382-1425)

```sh
# 1. On VPS — get the code
sudo mkdir -p /opt/latefyi && sudo chown $USER /opt/latefyi
git clone https://github.com/hamr0/latefyi /opt/latefyi
cd /opt/latefyi
npm install --omit=dev

# 2. Generate the shared ingest token (32-byte hex)
INGEST_TOKEN=$(openssl rand -hex 32)
echo "$INGEST_TOKEN"   # save — you'll need it on both ends

# 3. Create env file (read by systemd unit)
sudo tee /etc/latefyi.env > /dev/null <<EOF
STATE_DIR=/opt/latefyi/state
LOG_DIR=/opt/latefyi/logs
INGEST_PORT=8787
INGEST_TOKEN=$INGEST_TOKEN
ALLOWED_SENDERS=you@example.com
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxx
SMTP_FROM=noreply@late.fyi
EOF
sudo chmod 600 /etc/latefyi.env

# 5. Cron for wake.sh
( crontab -l 2>/dev/null; echo "* * * * * /opt/latefyi/scripts/wake.sh >> /opt/latefyi/logs/wake.log 2>&1" ) | crontab -

# 7. DNS — in Cloudflare dashboard add A record:
#    ingest.late.fyi → <vps public IP>, proxy ON (orange) — hides origin IP + enables the
#    :443 firewall; needs a CF Origin cert + SSL Full (strict). See cloudflare-setup.md Steps 1/7.

# 8. Worker — see worker/README.md for the four wrangler secret commands and `wrangler deploy`

# 9. Test: send From: your-allowlisted-address to ICE145@late.fyi with
#    Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
#    Confirmation reply within seconds.
```

### systemd units

`/etc/systemd/system/latefyi-ingest.service` (docs/archive/latefyi-prd.md:1429-1447):

```ini
[Unit]
Description=latefyi inbound email ingest server
After=network.target

[Service]
Type=simple
User=latefyi
WorkingDirectory=/opt/latefyi
EnvironmentFile=/etc/latefyi.env
ExecStart=/usr/bin/node src/ingest-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/latefyi-poller.service` is identical except `Description=latefyi poll-runner daemon` and `ExecStart=/usr/bin/node src/poll-runner.js` (docs/archive/latefyi-prd.md:1449-1467).

Create the user and enable (docs/archive/latefyi-prd.md:1469-1475):

```sh
sudo useradd --system --home /opt/latefyi --shell /usr/sbin/nologin latefyi
sudo chown -R latefyi:latefyi /opt/latefyi
sudo systemctl daemon-reload
sudo systemctl enable --now latefyi-ingest latefyi-poller
sudo systemctl status latefyi-ingest latefyi-poller
```

### Reverse proxy (Caddy, easy TLS)

(docs/archive/latefyi-prd.md:1479-1483)

```
ingest.late.fyi {
  reverse_proxy localhost:8787
}
```

- Run `sudo caddy reload` or restart the service. With `ingest.late.fyi` proxied (orange), the origin serves a CF Origin cert under SSL Full (strict), not Let's Encrypt; point Caddy at it with an explicit `tls /etc/ssl/cloudflare/ingest.late.fyi.pem /etc/ssl/cloudflare/ingest.late.fyi.key` directive instead of its auto-TLS. The nginx runbook in `cloudflare-setup.md` is the canonical path (docs/archive/latefyi-prd.md:1485).
- For nginx, use an equivalent reverse_proxy block. Either way only port 443 is publicly exposed (the VPS firewall drops it from non-Cloudflare sources); 8787 stays bound to localhost (docs/archive/latefyi-prd.md:1487).

### Cert renewal

- The CF Origin cert is 15-year and needs no renewal (docs/archive/latefyi-prd.md:1489).
- The previously-used Let's Encrypt cert is retired: HTTP-01 webroot renewal can't complete behind the orange proxy, so certbot renewal for ingest is disabled by renaming `/etc/letsencrypt/renewal/ingest.late.fyi.conf` to `.disabled` (certbot's renew loop only reads `*.conf`). The LE cert files under `/etc/letsencrypt/live/ingest.late.fyi/` are left in place but unused (docs/archive/latefyi-prd.md:1489).
- A direct-served CF Origin cert would fail on a grey record (it isn't publicly trusted); if ingest is ever reverted to grey, regenerate a Let's Encrypt cert rather than serving the Origin cert directly (docs/archive/latefyi-prd.md:1489).

### Update the Worker

From `worker/`, re-run `wrangler secret put` for `LATEFYI_INGEST_URL` (`https://ingest.late.fyi/ingest`), `LATEFYI_INGEST_TOKEN` (the same `INGEST_TOKEN` from step 2) and `ALLOWED_SENDERS` (`you@example.com`), then `wrangler deploy` (docs/archive/latefyi-prd.md:1493-1502).

Then in the CF dashboard: Email -> Email Routing -> Routing rules -> Catch-all -> "Send to a Worker" -> `latefyi-ingest` (docs/archive/latefyi-prd.md:1504).

### Verifying

(docs/archive/latefyi-prd.md:1508-1521)

```sh
journalctl -u latefyi-ingest -f
journalctl -u latefyi-poller -f

curl https://ingest.late.fyi/health
# → ok

cd worker && wrangler tail
```

Send a test email; you should see, in order: wrangler tail logs the receipt, ingest journalctl logs the POST, then the reply email lands in your inbox (docs/archive/latefyi-prd.md:1521).

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
