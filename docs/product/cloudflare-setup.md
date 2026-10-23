---
title: Cloudflare Setup Runbook
theme: deployment-spine
sources:
  - docs/archive/cloudflare-setup.md
---

# Cloudflare Setup Runbook

End-to-end runbook overview: the architecture split (Worker at the edge, daemons on the VPS), prerequisites, and Step 1 (DNS records in Cloudflare).

## Architecture recap

Two pieces, one in each box (docs/archive/cloudflare-setup.md:11-11).

Cloudflare account side (docs/archive/cloudflare-setup.md:14-28):

- `late.fyi` MX goes to Email Routing; the catch-all routes to the Worker.
- `worker/index.js` applies the allowlist and does `POST /ingest`.
- `late.fyi` DNS holds the MX (auto-created by Email Routing) and an A record `ingest` pointing to the VPS IP; `ingest.late.fyi` A points to the VPS.

VPS side, reached over HTTPS POST (docs/archive/cloudflare-setup.md:14-28):

- nginx vhost `ingest.late.fyi` (TLS): `/ingest` goes to `127.0.0.1:8787`.
- systemd units: `latefyi-ingest` and `latefyi-poller`.
- cron: `scripts/wake.sh` (every 1m).
- `state/` on disk.
- Postfix on `:25` for outbound replies (or msmtp / external SMTP relay).

**Why both?** Cloudflare Workers can't run a long-lived polling daemon or hold file-system state. Workers handle inbound mail at the edge (allowlist + forward); the VPS handles everything else. PRD §22 decisions 5 and 13 chose this split deliberately (docs/archive/cloudflare-setup.md:31-31).

## Prerequisites

- Cloudflare account, domain on it (here: `late.fyi`) (docs/archive/cloudflare-setup.md:37-37)
- VPS with public IP (here: `155.94.144.191` AlmaLinux 8.10), Node >= 20 installed (docs/archive/cloudflare-setup.md:38-38)
- Outbound SMTP: Postfix on the box, or an external relay (Resend / Postmark / SES). Most providers block outbound port 25; check yours (docs/archive/cloudflare-setup.md:39-39).
- nginx (or any reverse proxy you can add a vhost to) (docs/archive/cloudflare-setup.md:40-40)
- A Cloudflare **Origin certificate** for `ingest.late.fyi` (generated in the dashboard, Step 7). No `certbot`/ACME: ingest is proxied, so Cloudflare terminates the public TLS and the origin serves a long-lived CF Origin cert (docs/archive/cloudflare-setup.md:41-41).
- A way to add a Cloudflare API token, OR `wrangler login` access from a browser (docs/archive/cloudflare-setup.md:42-42)

## Step 1 — DNS in Cloudflare

In the CF dashboard for `late.fyi` (docs/archive/cloudflare-setup.md:48-48):

1. **DNS** -> **Records** -> **Add record** (docs/archive/cloudflare-setup.md:50-55):
   - Type: `A`
   - Name: `ingest`
   - IPv4: `<VPS public IP>`
   - Proxy status: **Proxied** (orange cloud). This hides the origin IP from public DNS and lets the VPS firewall drop `:443` from non-Cloudflare source ranges. Pairs with a CF Origin cert + SSL mode **Full (strict)** (Step 7).
   - TTL: Auto

2. **Email** -> **Email Routing** -> **Get started** (docs/archive/cloudflare-setup.md:57-63).
   The wizard requires creating at least one rule; satisfy it with a throwaway:
   - Custom address: `test@late.fyi`
   - Action: Send to an email
   - Destination: any inbox you can verify
   - Click the verification email link

   This activates Email Routing and auto-creates the required MX/SPF/DKIM records (docs/archive/cloudflare-setup.md:63-63).

## Steps

- [VPS ingest host setup](../wiki/vps-ingest-host-setup.md) (Steps 2–6)
- [TLS origin proxy](../wiki/tls-origin-proxy.md) (Steps 7–10)
- [Worker deploy and inbound routing](../wiki/worker-deploy-inbound-routing.md) (Steps 11–16, 19)
- [Outbound deliverability: SPF, DKIM, DMARC](../wiki/outbound-deliverability-spf-dkim-dmarc.md) (Step 17)
- [Apex landing page on Pages](../wiki/apex-landing-page-pages.md) (Step 18)
- [Operations: recovery and health check](../wiki/operations-recovery-health-check.md) (recovery + health check)
