---
title: VPS ingest host setup
theme: vps-ingest-host-setup
sources:
  - docs/archive/cloudflare-setup.md
---

# VPS ingest host setup

Bootstrapping the VPS without disturbing existing sites: ingest token, `/etc/latefyi.env`, systemd units, and the `wake.sh` cron. (docs/archive/cloudflare-setup.md:67-83) (docs/archive/cloudflare-setup.md:84-96) (docs/archive/cloudflare-setup.md:97-121) (docs/archive/cloudflare-setup.md:122-196) (docs/archive/cloudflare-setup.md:197-209)

## Step 2 — VPS bootstrap (don't disturb existing sites)

Create a dedicated no-shell system user, clone the repo as that user, and install production deps only (no dev tooling or test runner needed at runtime). (docs/archive/cloudflare-setup.md:67-80)

```sh
# Create a dedicated, no-shell system user
sudo useradd --system --home /opt/latefyi --shell /sbin/nologin latefyi

# Clone the repo as that user (or as root, then chown)
sudo mkdir -p /opt/latefyi && sudo chown latefyi:latefyi /opt/latefyi
sudo -u latefyi git clone https://github.com/hamr0/latefyi /opt/latefyi

# Production deps only — no nodemailer dev tooling, no test runner needed at runtime
cd /opt/latefyi
sudo -u latefyi npm install --omit=dev
```

## Step 3 — Generate the shared ingest token

The same value goes in two places: (docs/archive/cloudflare-setup.md:86-88)

1. `/etc/latefyi.env` on the VPS (read by systemd)
2. The Worker's `LATEFYI_INGEST_TOKEN` secret

```sh
INGEST_TOKEN=$(openssl rand -hex 32)
echo "$INGEST_TOKEN"   # save — you'll paste this into Worker secrets too
```

(docs/archive/cloudflare-setup.md:90-93)

## Step 4 — `/etc/latefyi.env`

(docs/archive/cloudflare-setup.md:97-116)

```sh
sudo tee /etc/latefyi.env > /dev/null <<EOF
STATE_DIR=/opt/latefyi/state
LOG_DIR=/opt/latefyi/logs
INGEST_PORT=8787
INGEST_TOKEN=<paste $INGEST_TOKEN>
ALLOWED_SENDERS=you@example.com

# Local Postfix (+ opendkim, selector latefyi2026) sends all outbound mail.
# SMTP_HOST has no default: unset = dry-run, replies parsed but not sent.
# SMTP_FROM is only a last-resort default; each message sets its own routable From.
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_FROM=noreply@late.fyi
EOF
sudo chmod 640 /etc/latefyi.env
sudo chown root:latefyi /etc/latefyi.env
```

Permissions matter: root-owned, `latefyi` group-readable, world-unreadable. (docs/archive/cloudflare-setup.md:118)

## Step 5 — systemd units

`/etc/systemd/system/latefyi-ingest.service`: (docs/archive/cloudflare-setup.md:124-153)

```ini
[Unit]
Description=latefyi inbound email ingest server
After=network.target postfix.service
Wants=postfix.service

[Service]
Type=simple
User=latefyi
Group=latefyi
WorkingDirectory=/opt/latefyi
EnvironmentFile=/etc/latefyi.env
ExecStart=/usr/bin/node src/ingest-server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Light hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/latefyi
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/latefyi-poller.service`: (docs/archive/cloudflare-setup.md:155-182)

```ini
[Unit]
Description=latefyi poll-runner daemon
After=network.target

[Service]
Type=simple
User=latefyi
Group=latefyi
WorkingDirectory=/opt/latefyi
EnvironmentFile=/etc/latefyi.env
ExecStart=/usr/bin/node src/poll-runner.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/latefyi
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and verify: (docs/archive/cloudflare-setup.md:184-191)

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now latefyi-ingest latefyi-poller
sudo systemctl status latefyi-ingest latefyi-poller
ss -tlnp | grep 8787
# Expect: 127.0.0.1:8787  LISTEN  node ...
curl -s http://127.0.0.1:8787/health   # → ok
```

`ingest-server.js` binds to `127.0.0.1` by default; the reverse proxy will front it on 443. (docs/archive/cloudflare-setup.md:193)

## Step 6 — Cron for `wake.sh`

Install a per-minute cron entry for the `latefyi` user and list it back to confirm. (docs/archive/cloudflare-setup.md:197-204)

```sh
( sudo -u latefyi crontab -l 2>/dev/null
  echo "* * * * * /opt/latefyi/scripts/wake.sh >> /opt/latefyi/logs/wake.log 2>&1"
) | sudo -u latefyi crontab -
sudo -u latefyi crontab -l
```

This activates due `pending/` records every minute. (docs/archive/cloudflare-setup.md:206)
