---
title: Deployment Steps and Infrastructure
theme: deployment-config-observability
sources:
  - docs/archive/latefyi-prd.md
---

# Deployment Steps and Infrastructure

Where each piece runs, minimum infra, the VPS deploy steps, systemd units, reverse proxy, cert renewal, Worker update and verification. Split out of [Deployment, Configuration and Observability](deployment-config-observability.md).

The operator runbook (copy-pasteable, with a real-world example) is `cloudflare-setup.md`; this section keeps the reference architecture and is the source of truth for what lives where, while the runbook is the source of truth for how to set it up step by step (docs/archive/latefyi-prd.md:1360).

### Where each piece runs

(docs/archive/latefyi-prd.md:1364-1371)

| Component | Hosted on | Why |
|---|---|---|
| Inbound email receipt + edge allowlist | Cloudflare Email Worker (free) | Email Routing only delivers via Workers; CPU-cheap allowlist filtering at the edge |
| HTTP `/ingest` endpoint | Your VPS, port 8787 (behind reverse proxy on 443) | Persistent process, file-system state |
| Polling daemon (`poll-runner.js`) | Your VPS | Long-lived loop; ditto state |
| Cron `wake.sh` (every minute) | Your VPS | Activates due `pending/` records |
| Outbound mail | Your VPS: local postfix + opendkim (selector `latefyi2026`) | Own IP, domain and DKIM; no third-party relay. (The original PRD specified an SMTP relay such as Resend; superseded.) |
| DNS for `late.fyi` and `ingest.late.fyi` | Cloudflare | Same dashboard handles MX + A record |

### Minimum infra

(docs/archive/latefyi-prd.md:1375-1378)

- 1x Cloudflare account (free); 1x domain (`late.fyi`, $11-13/yr at Cloudflare Registrar)
- 1x small VPS (1 vCPU, 512 MB RAM, 10 GB disk) OR Raspberry Pi at home: anything always-on with a public IP
- Outbound mail goes through postfix + opendkim on the VPS itself (no relay account)

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
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_FROM=noreply@late.fyi
EOF
sudo chmod 600 /etc/latefyi.env

# 4. systemd units — see "systemd" section below

# 5. Cron for wake.sh
( crontab -l 2>/dev/null; echo "* * * * * /opt/latefyi/scripts/wake.sh >> /opt/latefyi/logs/wake.log 2>&1" ) | crontab -

# 6. Reverse proxy — see "Reverse proxy" section below
#    sudo systemctl reload caddy   (or nginx)

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
