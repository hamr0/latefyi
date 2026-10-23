---
title: TLS, Origin Certificate and Proxy Setup for ingest.late.fyi
theme: tls-origin-proxy
sources:
  - docs/archive/cloudflare-setup.md
---

# TLS, Origin Certificate and Proxy Setup for ingest.late.fyi

Runbook for the proxied `ingest.late.fyi`: Cloudflare Origin certificate, placing it on the VPS, the nginx HTTPS vhost, real-IP/firewall notes, and the VPS-half smoke test.

## Step 7 — Cloudflare Origin certificate (dashboard)

`ingest.late.fyi` is proxied (Step 1), so Cloudflare terminates public TLS with its own edge cert. The origin only needs a cert Cloudflare trusts on the CF→origin hop: a **CF Origin certificate** (15-year, no ACME, no renewal). This replaces certbot/Let's Encrypt entirely. (docs/archive/cloudflare-setup.md:212-212)

In the CF dashboard for `late.fyi` (docs/archive/cloudflare-setup.md:214-221):

1. **SSL/TLS** → **Origin Server** → **Create Certificate**
2. Private key type: **RSA (2048)** (or ECDSA) — let Cloudflare generate it
3. Hostnames: `ingest.late.fyi`
4. Validity: **15 years** → **Create**
5. Copy both blobs shown — the **Origin Certificate** (PEM) and the **Private Key** (shown once, save it now)
6. **SSL/TLS** → **Overview** → set encryption mode to **Full (strict)** so CF validates the origin cert

## Step 8 — Place the Origin cert on the VPS

(docs/archive/cloudflare-setup.md:225-235)

```sh
sudo mkdir -p /etc/ssl/cloudflare

# paste the Origin Certificate, then Ctrl-D:
sudo tee /etc/ssl/cloudflare/ingest.late.fyi.pem >/dev/null
# paste the Private Key, then Ctrl-D:
sudo tee /etc/ssl/cloudflare/ingest.late.fyi.key >/dev/null

sudo chmod 644 /etc/ssl/cloudflare/ingest.late.fyi.pem
sudo chmod 600 /etc/ssl/cloudflare/ingest.late.fyi.key   # key stays unreadable to the latefyi service user
```

The private key is operator material — it lives on the box (like any TLS key), never in the repo. (docs/archive/cloudflare-setup.md:237-237)

## Step 9 — nginx HTTPS vhost

Create `/etc/nginx/conf.d/latefyi-ingest.conf` (docs/archive/cloudflare-setup.md:243-298):

```nginx
limit_conn_zone $binary_remote_addr zone=latefyi_perip:10m;

# HTTP → HTTPS (Cloudflare also redirects at the edge; this covers direct hits)
server {
    listen 80;
    listen [::]:80;
    server_name ingest.late.fyi;

    location / { return 301 https://ingest.late.fyi$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ingest.late.fyi;

    ssl_certificate     /etc/ssl/cloudflare/ingest.late.fyi.pem;
    ssl_certificate_key /etc/ssl/cloudflare/ingest.late.fyi.key;
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

Test, reload and check health (docs/archive/cloudflare-setup.md:300-303):

```sh
sudo nginx -t && sudo systemctl reload nginx
curl -s https://ingest.late.fyi/health   # → ok
```

### Real client IP and the `:443` firewall

- Because ingest is proxied, every request reaches the origin from Cloudflare's ranges. The box's **global** CF real-IP config (`/etc/nginx/conf.d/00-cloudflare-realip.conf`, http-context, shared with the co-tenant on this VPS) restores the true client into `$remote_addr`, so `limit_conn` and the access log key on the real sender. (docs/archive/cloudflare-setup.md:305-305)
- **Don't add a latefyi-local `set_real_ip_from` copy** — it duplicates the CF range list and invites drift. (docs/archive/cloudflare-setup.md:305-305)
- With every vhost on the box now proxied, the origin firewall can drop `:443` from any non-Cloudflare source (applied out-of-band on the VPS), closing the raw-load path a grey-clouded origin left open. (docs/archive/cloudflare-setup.md:305-305)
- Never edit `00-cloudflare-realip.conf` from this repo — it also carries the co-tenant's origin-lock block. (docs/archive/cloudflare-setup.md:305-305)

## Step 10 — VPS half end-to-end smoke test

Before touching the Worker, prove the VPS can take an inbound payload and send a reply (docs/archive/cloudflare-setup.md:311-327):

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

Expect `{"ok":true,"replied":true,"sent":true,"sendError":null}`. Check `/opt/latefyi/state/pending/` for the new file. Check your inbox for the confirmation reply (may land in junk first time — see DKIM note below). (docs/archive/cloudflare-setup.md:329-329)

If `sent: true` but no email arrives, check Postfix's mail log (docs/archive/cloudflare-setup.md:331-335):

```sh
sudo tail -30 /var/log/maillog
```
