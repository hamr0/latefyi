# Cloudflare + VPS deployment runbook

Step-by-step deployment of `latefyi` on a fresh setup OR on an existing VPS that's already serving other sites.

This document records what we actually did to deploy at `late.fyi` on a RackNerd AlmaLinux 8 VPS already running `addypin.com` behind nginx + Postfix. Adapt domain / IP / sender as needed.

---

## Architecture recap

Two pieces, one in each box:

```
       Cloudflare account                              Your VPS (already running other sites)
   ┌─────────────────────────────┐    HTTPS    ┌──────────────────────────────────────────┐
   │  late.fyi MX → Email        │    POST     │  nginx vhost: ingest.late.fyi (TLS)      │
   │   Routing                   │ ──────────▶ │   /ingest  → 127.0.0.1:8787              │
   │  Catch-all → Worker         │             │                                          │
   │   ↓                         │             │  systemd: latefyi-ingest                 │
   │  worker/index.js            │             │  systemd: latefyi-poller                 │
   │   ├ allowlist               │             │  cron:    scripts/wake.sh (every 1m)     │
   │   └ POST /ingest            │             │                                          │
   │                             │             │  state/ on disk                          │
   │  late.fyi DNS:              │             │                                          │
   │   - MX (auto by ER)         │             │  Postfix on :25 — outbound replies       │
   │   - A: ingest → VPS IP      │             │   (or msmtp / external SMTP relay)       │
   │  ingest.late.fyi A → VPS    │             │                                          │
   └─────────────────────────────┘             └──────────────────────────────────────────┘
```

**Why both?** Cloudflare Workers can't run a long-lived polling daemon or hold file-system state. Workers handle inbound mail at the edge (allowlist + forward); the VPS handles everything else. PRD §22 decisions 5 and 13 chose this split deliberately.

---

## Prerequisites

- Cloudflare account, domain on it (here: `late.fyi`)
- VPS with public IP (here: `155.94.144.191` AlmaLinux 8.10), Node ≥ 20 installed
- Outbound SMTP — Postfix on the box, or an external relay (Resend / Postmark / SES). Most providers block outbound port 25; check yours.
- nginx (or any reverse proxy you can add a vhost to)
- `certbot` for Let's Encrypt cert provisioning
- A way to add a Cloudflare API token, OR `wrangler login` access from a browser

---

## Step 1 — DNS in Cloudflare

In the CF dashboard for `late.fyi`:

1. **DNS** → **Records** → **Add record**:
   - Type: `A`
   - Name: `ingest`
   - IPv4: `<VPS public IP>`
   - Proxy status: **DNS only** (gray cloud — easier for ACME challenges and avoids CF intercepting the HTTPS handshake)
   - TTL: Auto

2. **Email** → **Email Routing** → **Get started**.
   The wizard requires creating at least one rule; satisfy it with a throwaway:
   - Custom address: `test@late.fyi`
   - Action: Send to an email
   - Destination: any inbox you can verify
   - Click the verification email link
   This activates Email Routing and auto-creates the required MX/SPF/DKIM records.

---

## Step 2 — VPS bootstrap (don't disturb existing sites)

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

---

## Step 3 — Generate the shared ingest token

The same value goes in two places:
1. `/etc/latefyi.env` on the VPS (read by systemd)
2. The Worker's `LATEFYI_INGEST_TOKEN` secret

```sh
INGEST_TOKEN=$(openssl rand -hex 32)
echo "$INGEST_TOKEN"   # save — you'll paste this into Worker secrets too
```

---

## Step 4 — `/etc/latefyi.env`

```sh
sudo tee /etc/latefyi.env > /dev/null <<EOF
STATE_DIR=/opt/latefyi/state
LOG_DIR=/opt/latefyi/logs
INGEST_PORT=8787
INGEST_TOKEN=<paste $INGEST_TOKEN>
ALLOWED_SENDERS=you@example.com

# Local Postfix as smarthost. If you don't have Postfix, point this at an
# external SMTP relay (Resend: smtp.resend.com:465, user "resend",
# pass = your API key).
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_FROM=noreply@late.fyi
EOF
sudo chmod 640 /etc/latefyi.env
sudo chown root:latefyi /etc/latefyi.env
```

Permissions matter: root-owned, latefyi group-readable, world-unreadable.

---

## Step 5 — systemd units

`/etc/systemd/system/latefyi-ingest.service`:

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

`/etc/systemd/system/latefyi-poller.service`:

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

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now latefyi-ingest latefyi-poller
sudo systemctl status latefyi-ingest latefyi-poller
ss -tlnp | grep 8787
# Expect: 127.0.0.1:8787  LISTEN  node ...
curl -s http://127.0.0.1:8787/health   # → ok
```

`ingest-server.js` binds to `127.0.0.1` by default; the reverse proxy will front it on 443.

---

## Step 6 — Cron for `wake.sh`

```sh
( sudo -u latefyi crontab -l 2>/dev/null
  echo "* * * * * /opt/latefyi/scripts/wake.sh >> /opt/latefyi/logs/wake.log 2>&1"
) | sudo -u latefyi crontab -
sudo -u latefyi crontab -l
```

This activates due `pending/` records every minute, prunes `done/` after 30 days.

---

## Step 7 — nginx HTTPS vhost (stage 1: HTTP-only for ACME)

Create `/etc/nginx/conf.d/latefyi-ingest.conf` with HTTP only first, so certbot can answer the challenge:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name ingest.late.fyi;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 503 "ingest.late.fyi: waiting for TLS cert provisioning"; }
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
```

---

## Step 8 — Issue cert with certbot

```sh
sudo certbot certonly --webroot -w /var/www/certbot -d ingest.late.fyi \
  --non-interactive --agree-tos --email you@example.com --no-eff-email
```

Certs land under `/etc/letsencrypt/live/ingest.late.fyi/`. Certbot installs an auto-renewal timer.

---

## Step 9 — nginx HTTPS vhost (stage 2: full)

Replace `/etc/nginx/conf.d/latefyi-ingest.conf` with:

```nginx
limit_conn_zone $binary_remote_addr zone=latefyi_perip:10m;

# HTTP → HTTPS, keep ACME path open for renewals
server {
    listen 80;
    listen [::]:80;
    server_name ingest.late.fyi;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://ingest.late.fyi$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ingest.late.fyi;

    ssl_certificate     /etc/letsencrypt/live/ingest.late.fyi/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ingest.late.fyi/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers   HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer-when-downgrade always;

    limit_conn latefyi_perip 20;
    client_max_body_size 1m;

    access_log /var/log/nginx/latefyi-ingest.access.log;
    error_log  /var/log/nginx/latefyi-ingest.error.log warn;

    location = /health {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_read_timeout 5s;
    }

    location = /ingest {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection        "";
        proxy_buffering    off;
        proxy_read_timeout 30s;
    }

    location / { return 404; }
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
curl -s https://ingest.late.fyi/health   # → ok
```

---

## Step 10 — VPS half end-to-end smoke test

Before touching the Worker, prove the VPS can take an inbound payload and send a reply:

```sh
INGEST_TOKEN=$(grep ^INGEST_TOKEN= /etc/latefyi.env | cut -d= -f2)

curl -sS -X POST https://ingest.late.fyi/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "from":"you@example.com",
    "to":"ICE145@late.fyi",
    "subject":"From: Amsterdam Centraal, To: Berlin Ostbahnhof",
    "body":"",
    "msgid":"<smoke-1@example.com>",
    "headers":{}
  }'
```

Expect `{"ok":true,"replied":true,"sent":true,"sendError":null}`. Check `/opt/latefyi/state/pending/` for the new file. Check your inbox for the confirmation reply (may land in junk first time — see DKIM note below).

If `sent: true` but no email arrives, check Postfix's mail log:

```sh
sudo tail -30 /var/log/maillog
```

---

## Step 11 — Cloudflare API token

Create at: My Profile → API Tokens → Create Token → use the **"Edit Cloudflare Workers"** template, then add one extra permission:

- Account → Workers Scripts: Edit ← (auto from template)
- User → User Details: Read ← (auto from template)
- Zone → **Email Routing Rules: Edit** ← add manually

Zone Resources: Include → `late.fyi`

---

## Step 12 — Find account and zone IDs

```sh
CF_TOKEN="<your-new-token>"
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=late.fyi" \
  | python3 -c "import json,sys; [print(z['id'], '|', z['account']['id']) for z in json.load(sys.stdin)['result']]"
```

Save both IDs.

---

## Step 13 — Deploy Worker via direct API

`wrangler` requires several extra account-scope permissions just to bootstrap. Bypassing it is faster:

```sh
ACCOUNT_ID="<account id>"

cd /path/to/latefyi/worker

curl -sS -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F 'metadata={"main_module":"index.js","compatibility_date":"2025-01-01"};type=application/json' \
  -F 'index.js=@index.js;type=application/javascript+module' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/latefyi-ingest"
```

Expect `"success": true`.

---

## Step 14 — Set Worker secrets

```sh
set_secret() {
  local name="$1" value="$2"
  curl -sS -X PUT \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$(python3 -c "import json,sys; print(json.dumps({'name':sys.argv[1],'text':sys.argv[2],'type':'secret_text'}))" "$name" "$value")" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/latefyi-ingest/secrets" \
    | python3 -c "import json,sys; print(' ', sys.argv[1] + ':', 'OK' if json.load(sys.stdin).get('success') else 'FAILED')" "$name"
}

INGEST_TOKEN=$(ssh root@<vps> 'grep ^INGEST_TOKEN= /etc/latefyi.env | cut -d= -f2')

set_secret ALLOWED_SENDERS      "you@example.com"
set_secret LATEFYI_INGEST_URL   "https://ingest.late.fyi/ingest"
set_secret LATEFYI_INGEST_TOKEN "$INGEST_TOKEN"
```

---

## Step 15 — Wire the catch-all rule

Easiest path: **CF dashboard → late.fyi → Email → Email Routing → Routing rules**, edit the Catch-all row:

- Action: **Send to a Worker**
- Destination: **`latefyi-ingest`**
- Save, ensure Enabled

API equivalent (needs Email Routing Rules: Edit on the token):

```sh
ZONE_ID="<zone id>"
curl -sS -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "name":"latefyi catch-all → worker",
    "enabled":true,
    "matchers":[{"type":"all"}],
    "actions":[{"type":"worker","value":["latefyi-ingest"]}]
  }' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules/catch_all"
```

If the catch-all is still **Drop**, the receiving end gets a `5.1.1 The address you sent your message to wasn't found at the destination domain` bounce. Switching it to the Worker fixes that.

You can also delete the throwaway `test@late.fyi` rule from step 1 — the catch-all covers it now.

---

## Step 16 — Real end-to-end test

From your allowlisted inbox:

```
To:      ICE145@late.fyi   (or any train running today)
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
```

Watch the logs as it lands:

```sh
# On VPS
sudo journalctl -u latefyi-ingest -f
sudo journalctl -u latefyi-poller -f
sudo tail -f /var/log/maillog

# Worker logs (from anywhere with the API token)
# — visible in the CF dashboard → Workers & Pages → latefyi-ingest → Logs
```

Confirmation reply within seconds.

---

## Step 17 — Outbound deliverability (SPF / DKIM / DMARC)

CF Email Routing only configures inbound. For replies sent FROM the VPS, all three records below must pass — without them Gmail/Outlook will silently junk replies.

### 17a. SPF

Edit the existing SPF TXT record on the apex; **append `ip4:<VPS IP>`** before the `include:`:

```
v=spf1 ip4:155.94.144.191 include:_spf.mx.cloudflare.net ~all
```

Verify:
```sh
dig +short TXT late.fyi @1.1.1.1 | grep spf1
```

### 17b. DKIM (opendkim)

`opendkim` runs on the deployment VPS already (for the co-tenant `addypin.com`). Add a key + signing-table entry for `late.fyi`. SSH to the VPS as root.

```sh
# 1. Generate key (selector = `latefyi2026`, year-versioned)
mkdir -p /etc/opendkim/keys/late.fyi
cd /etc/opendkim/keys/late.fyi
opendkim-genkey -b 2048 -d late.fyi -s latefyi2026
chown opendkim:opendkim latefyi2026.private latefyi2026.txt
chmod 600 latefyi2026.private
chmod 750 /etc/opendkim/keys/late.fyi

# 2. Wire it into opendkim's tables
echo "latefyi2026._domainkey.late.fyi late.fyi:latefyi2026:/etc/opendkim/keys/late.fyi/latefyi2026.private" >> /etc/opendkim/KeyTable
echo "*@late.fyi latefyi2026._domainkey.late.fyi" >> /etc/opendkim/SigningTable
echo "late.fyi" >> /etc/opendkim/TrustedHosts

# 3. Show the public key for the DNS TXT record
cat /etc/opendkim/keys/late.fyi/latefyi2026.txt
```

The `.txt` file contains a multi-line `( "v=DKIM1; k=rsa; " "p=..." "..." )` — concatenate the quoted segments into a **single line** when pasting into Cloudflare DNS:

| Type | Name | Content |
|---|---|---|
| TXT | `latefyi2026._domainkey` | `v=DKIM1; k=rsa; p=<one long base64 string, no line breaks>` |

⚠️ **Cloudflare's DNS UI sometimes preserves newlines from your paste**, which appear as `\010` bytes in `dig` output. Always paste single-line, or fix via API. Newlines in TXT will silently break DKIM verification at the receiver.

After saving the DNS record, validate against the live key:

```sh
opendkim-testkey -d late.fyi -s latefyi2026 -k /etc/opendkim/keys/late.fyi/latefyi2026.private -vvv
# expect: "key OK" (the "key not secure" warning is DNSSEC; harmless)

systemctl restart opendkim
```

Postfix should already have:
```
smtpd_milters = unix:/run/opendkim/opendkim.sock
non_smtpd_milters = unix:/run/opendkim/opendkim.sock
```
(Set up for the co-tenant; both domains share the same milter.)

### 17c. DMARC

Add a TXT record for monitoring (`p=none`). Tighten to `quarantine` then `reject` after 1–2 weeks of clean reports.

| Type | Name | Content |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@late.fyi; fo=1; adkim=r; aspf=r` |

The `rua` mailbox gets aggregate XML reports from receivers. Email Routing needs a custom rule for it (or catch-all) — see step 19.

### 17d. PTR / reverse DNS

Set via VPS provider portal. RackNerd's default `155.94.144.191.<provider>` is fine for shared use; not strictly required if SPF/DKIM/DMARC pass.

### 17e. Verify end-to-end

```sh
ssh root@<VPS> sendmail -f noreply@late.fyi -t <<EOF
From: noreply@late.fyi
To: <your-gmail>
Subject: late.fyi DKIM/SPF/DMARC verification

This is a deliverability test.
EOF
```

In Gmail open the message → ⋮ → **Show original**. Top of headers should show:

```
SPF:    PASS with IP <VPS IP>
DKIM:   'PASS' with domain late.fyi
DMARC:  'PASS'
```

All three must say PASS before opening the allowlist.

---

## Step 18 — Apex landing page via Cloudflare Pages

The apex `late.fyi` serves a static one-pager from `web/index.html`.

1. Cloudflare → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git** → repo `hamr0/latefyi`
2. Build settings:

| Field | Value |
|---|---|
| Project name | `latefyi` |
| Production branch | `main` |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `web` |
| Root directory | *(empty)* |

3. Save and Deploy. The `<project>.pages.dev` URL serves immediately.
4. **Custom domains** → **Set up a custom domain** → `late.fyi`. CF auto-creates a CNAME-flattened apex record (DNS already on the same zone).

⚠️ If apex DNS doesn't resolve after the custom-domain step, manually add a CNAME at `@` pointing to `<project>.<account>.workers.dev`, **proxied** (orange cloud). The "auto-add" step occasionally skips when other DNS rows for the apex already exist.

5. Verify:
   ```sh
   dig +short late.fyi @1.1.1.1   # should return CF anycast (188.114.x.x)
   curl -sI https://late.fyi | head -1   # HTTP/2 200
   ```

Subsequent pushes to `main` auto-deploy the page. Branch pushes get preview URLs (`<branch>.latefyi.pages.dev`).

⚠️ **Two Workers, often confused:**
- `latefyi-ingest` — Email Worker (this guide steps 13–15). No HTTP route.
- `latefyi` — Pages-style Worker (this step). Has custom domain `late.fyi`.

Don't add the email handler to the Pages Worker, and don't add an HTTP route to the email Worker. They show up in the same dashboard.

---

## Step 19 — Email Routing for non-tracking addresses

Some local-parts shouldn't reach the tracking pipeline. The Worker has a defensive `NON_TRACKING_LOCALPARTS` list (`feedback`, `postmaster`, `abuse`, `admin`, `noreply`, etc.) that drops mail to those addresses before any allowlist or ingest forward. **CF Email Routing custom rules are the primary delivery mechanism**; the Worker's drop is defense-in-depth for misconfigured or missing rules.

To deliver `feedback@late.fyi` to a real inbox:

1. **Email** → **Email Routing** → **Destination addresses** → **Add destination address** → enter your inbox (e.g., `you@gmail.com`). Click the verification link CF sends.
2. **Routing rules** → **Create rule**:
   - **Match** — Custom address: `feedback@late.fyi`
   - **Action** — Send to email: `you@gmail.com`
   - **Save** + **Enable**

CF evaluates custom rules **before** the catch-all, so `feedback@` goes to your inbox; everything else hits the catch-all → Worker.

Add similar rules for `postmaster@`, `abuse@`, `admin@` if you want incident reports / DMARC aggregate reports / abuse complaints to land somewhere usable.

---

## Recovery / common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Email rejected `5.1.1 address not found` | Catch-all rule is Drop, no rule matches | Step 15 — switch catch-all to Worker |
| Worker upload returns 10000 Authentication error | Token missing Account → Workers Scripts: Edit | Add it (token edit), retry |
| `/health` returns 502 | ingest service crashed | `journalctl -u latefyi-ingest -n 50` |
| Confirmation never arrives but `sent: true` | Receiver junked it (no DKIM/SPF) | See step 17 (deliverability) |
| Gmail "Show original" shows `dkim=none` | Worker signed with addypin's selector, not late.fyi's | Verify `/etc/opendkim/SigningTable` has `*@late.fyi …`, restart `opendkim` |
| `dig` shows DKIM TXT with `\010` bytes | CF DNS UI preserved newlines from paste | Re-edit, paste single-line (use `cat /tmp/file.txt` and copy from there) |
| `wrangler` complains about /memberships 9106 | Token lacks User Details: Read | Use template "Edit Cloudflare Workers" or bypass wrangler (steps 13–15 use raw API) |
| Pending file written but never polled | poller service down OR cron not running | `systemctl status latefyi-poller`, `sudo -u latefyi crontab -l` |
| ACME challenge fails | DNS not propagated yet, or proxy ON in CF (must be DNS only / gray cloud) | Wait, recheck `dig ingest.late.fyi`, ensure A record proxy is gray |
| `late.fyi` apex doesn't resolve | Pages "auto add CNAME" skipped on the existing zone | DNS → Add CNAME `@` → `<project>.<account>.workers.dev`, **proxied** |
| `feedback@late.fyi` got a "not a valid train number" reply | CF Email Routing custom rule missing/disabled; catch-all caught it | Step 19 — add the custom rule (Worker drops `feedback@` defensively, but the rule is what delivers it) |
| Local resolver shows NXDOMAIN, `@1.1.1.1` works | Negative-cache TTL on systemd-resolved | `sudo resolvectl flush-caches`, retry |

---

## Quick health check (anytime)

```sh
# VPS daemon health
sudo systemctl is-active latefyi-ingest latefyi-poller postfix nginx
# Public reachability
curl -s https://ingest.late.fyi/health
# Worker reachability (this should fail with 5.1.1 if inactive, succeed if active)
echo | mail -s "From: A, To: B" ICE145@late.fyi  # or use your real client
```
