---
title: Outbound deliverability (SPF / DKIM / DMARC)
theme: outbound-deliverability-spf-dkim-dmarc
sources:
  - docs/archive/cloudflare-setup.md
---

# Outbound deliverability (SPF / DKIM / DMARC)

## Step 17 — Overview

CF Email Routing only configures inbound. For replies sent FROM the VPS, all three records below (SPF, DKIM, DMARC) must pass; without them Gmail/Outlook will silently junk replies. (docs/archive/cloudflare-setup.md:461-463)

## 17a. SPF

Edit the existing SPF TXT record on the apex and **append `ip4:<VPS IP>`** before the `include:`. (docs/archive/cloudflare-setup.md:465-467)

```
v=spf1 ip4:155.94.144.191 include:_spf.mx.cloudflare.net ~all
```

Verify (docs/archive/cloudflare-setup.md:473-476):

```sh
dig +short TXT late.fyi @1.1.1.1 | grep spf1
```

## 17b. DKIM (opendkim)

`opendkim` already runs on the deployment VPS (for the co-tenant `addypin.com`). Add a key and signing-table entry for `late.fyi`, SSH'd to the VPS as root. (docs/archive/cloudflare-setup.md:478-480)

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

(docs/archive/cloudflare-setup.md:482-498)

### DNS record

The `.txt` file contains a multi-line `( "v=DKIM1; k=rsa; " "p=..." "..." )`. Concatenate the quoted segments into a **single line** when pasting into Cloudflare DNS. (docs/archive/cloudflare-setup.md:500)

| Type | Name | Content |
|---|---|---|
| TXT | `latefyi2026._domainkey` | `v=DKIM1; k=rsa; p=<one long base64 string, no line breaks>` |

(docs/archive/cloudflare-setup.md:502-504)

Warning: Cloudflare's DNS UI sometimes preserves newlines from your paste, which appear as `\010` bytes in `dig` output. Always paste single-line, or fix via API. Newlines in TXT will silently break DKIM verification at the receiver. (docs/archive/cloudflare-setup.md:506)

### Validate

After saving the DNS record, validate against the live key (docs/archive/cloudflare-setup.md:508-515):

```sh
opendkim-testkey -d late.fyi -s latefyi2026 -k /etc/opendkim/keys/late.fyi/latefyi2026.private -vvv
# expect: "key OK" (the "key not secure" warning is DNSSEC; harmless)

systemctl restart opendkim
```

### Postfix milter config

Postfix should already have the following, set up for the co-tenant; both domains share the same milter. (docs/archive/cloudflare-setup.md:517-522)

```
smtpd_milters = unix:/run/opendkim/opendkim.sock
non_smtpd_milters = unix:/run/opendkim/opendkim.sock
```

## 17c. DMARC

Add a TXT record for monitoring (`p=none`). Tighten to `quarantine` then `reject` after 1–2 weeks of clean reports. (docs/archive/cloudflare-setup.md:524-526)

| Type | Name | Content |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@late.fyi; fo=1; adkim=r; aspf=r` |

(docs/archive/cloudflare-setup.md:528-530)

The `rua` mailbox gets aggregate XML reports from receivers. Email Routing needs a custom rule for it (or catch-all); see step 19. (docs/archive/cloudflare-setup.md:532)

## 17d. PTR / reverse DNS

Set via the VPS provider portal. RackNerd's default `155.94.144.191.<provider>` is fine for shared use; it is not strictly required if SPF/DKIM/DMARC pass. (docs/archive/cloudflare-setup.md:534-536)

## 17e. Verify end-to-end

Send a test message from the VPS (docs/archive/cloudflare-setup.md:538-548):

```sh
ssh root@<VPS> sendmail -f noreply@late.fyi -t <<EOF
From: noreply@late.fyi
To: <your-gmail>
Subject: late.fyi DKIM/SPF/DMARC verification

This is a deliverability test.
EOF
```

In Gmail open the message, then the three-dot menu, then **Show original**. The top of the headers should show (docs/archive/cloudflare-setup.md:550-556):

```
SPF:    PASS with IP <VPS IP>
DKIM:   'PASS' with domain late.fyi
DMARC:  'PASS'
```

All three must say PASS before opening the allowlist. (docs/archive/cloudflare-setup.md:558)
