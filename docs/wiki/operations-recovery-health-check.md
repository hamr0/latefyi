---
title: Operations Recovery and Health Check
theme: operations-recovery-health-check
sources:
  - docs/archive/cloudflare-setup.md
---

# Operations Recovery and Health Check

A recovery table of common symptoms with their causes and fixes, plus a quick health check to run any time (docs/archive/cloudflare-setup.md:617-636) (docs/archive/cloudflare-setup.md:637-646).

## Recovery / common gotchas

Each row gives the symptom, its cause, and the fix (docs/archive/cloudflare-setup.md:617-633).

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
| CF error 526 (invalid SSL cert) | Origin cert missing/expired, or SSL mode not Full (strict) | Recheck `/etc/ssl/cloudflare/ingest.late.fyi.*` + CF SSL/TLS mode; `sudo nginx -t` |
| CF error 521/522 (origin down/unreachable) | ingest/nginx down, or `:443` firewall dropped a source that is actually current CF | `systemctl status nginx latefyi-ingest`; confirm the `:443` allow-list still covers Cloudflare's ranges |
| `late.fyi` apex doesn't resolve | Pages "auto add CNAME" skipped on the existing zone | DNS → Add CNAME `@` → `<project>.<account>.workers.dev`, **proxied** |
| `feedback@late.fyi` got a "not a valid train number" reply | CF Email Routing custom rule missing/disabled; catch-all caught it | Step 19 — add the custom rule (Worker drops `feedback@` defensively, but the rule is what delivers it) |
| Local resolver shows NXDOMAIN, `@1.1.1.1` works | Negative-cache TTL on systemd-resolved | `sudo resolvectl flush-caches`, retry |

## Quick health check (anytime)

Three checks: VPS daemon health, public reachability, and Worker reachability. The Worker check should fail with 5.1.1 if inactive and succeed if active (docs/archive/cloudflare-setup.md:637-646).

```sh
# VPS daemon health
sudo systemctl is-active latefyi-ingest latefyi-poller postfix nginx
# Public reachability
curl -s https://ingest.late.fyi/health
# Worker reachability (this should fail with 5.1.1 if inactive, succeed if active)
echo | mail -s "From: A, To: B" ICE145@late.fyi  # or use your real client
```
