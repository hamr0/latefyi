---
title: Worker deploy and inbound routing
theme: worker-deploy-inbound-routing
sources:
  - docs/archive/cloudflare-setup.md
---

# Worker deploy and inbound routing

CF API token, direct-API Worker deploy, Worker secrets, catch-all and non-tracking Email Routing rules, and the real end-to-end inbound test.

## Step 11 — Cloudflare API token

Create at My Profile → API Tokens → Create Token, using the **"Edit Cloudflare Workers"** template, then add one extra permission (docs/archive/cloudflare-setup.md:341-347):

- Account → Workers Scripts: Edit (auto from template)
- User → User Details: Read (auto from template)
- Zone → **Email Routing Rules: Edit** (add manually)

Zone Resources: Include → `late.fyi` (docs/archive/cloudflare-setup.md:347).

## Step 12 — Find account and zone IDs

Save both IDs (docs/archive/cloudflare-setup.md:353-360):

```sh
CF_TOKEN="<your-new-token>"
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=late.fyi" \
  | python3 -c "import json,sys; [print(z['id'], '|', z['account']['id']) for z in json.load(sys.stdin)['result']]"
```

## Step 13 — Deploy Worker via direct API

`wrangler` requires several extra account-scope permissions just to bootstrap, so bypassing it is faster (docs/archive/cloudflare-setup.md:366):

```sh
ACCOUNT_ID="<account id>"

cd /path/to/latefyi/worker

curl -sS -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F 'metadata={"main_module":"index.js","compatibility_date":"2025-01-01"};type=application/json' \
  -F 'index.js=@index.js;type=application/javascript+module' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/latefyi-ingest"
```

Expect `"success": true` (docs/archive/cloudflare-setup.md:368-380).

## Step 14 — Set Worker secrets

Secrets set on `latefyi-ingest` are `ALLOWED_SENDERS`, `LATEFYI_INGEST_URL` and `LATEFYI_INGEST_TOKEN`; the token is read from `/etc/latefyi.env` on the VPS (docs/archive/cloudflare-setup.md:386-402):

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

## Step 15 — Wire the catch-all rule

Easiest path: **CF dashboard → late.fyi → Email → Email Routing → Routing rules**, edit the Catch-all row (docs/archive/cloudflare-setup.md:408-412):

- Action: **Send to a Worker**
- Destination: **`latefyi-ingest`**
- Save, ensure Enabled

API equivalent, which needs Email Routing Rules: Edit on the token (docs/archive/cloudflare-setup.md:414-428):

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

If the catch-all is still **Drop**, the sender gets a `5.1.1 The address you sent your message to wasn't found at the destination domain` bounce; switching it to the Worker fixes that (docs/archive/cloudflare-setup.md:430). The throwaway `test@late.fyi` rule from step 1 can be deleted, since the catch-all covers it now (docs/archive/cloudflare-setup.md:432).

## Step 16 — Real end-to-end test

From your allowlisted inbox (docs/archive/cloudflare-setup.md:438-443):

```
To:      ICE145@late.fyi   (or any train running today)
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
```

Watch the logs as it lands (docs/archive/cloudflare-setup.md:445-455):

```sh
# On VPS
sudo journalctl -u latefyi-ingest -f
sudo journalctl -u latefyi-poller -f
sudo tail -f /var/log/maillog

# Worker logs (from anywhere with the API token)
# — visible in the CF dashboard → Workers & Pages → latefyi-ingest → Logs
```

A confirmation reply arrives within seconds (docs/archive/cloudflare-setup.md:457).

## Step 19 — Email Routing for non-tracking addresses

The Worker has a defensive `NON_TRACKING_LOCALPARTS` list (`feedback`, `postmaster`, `abuse`, `admin`, `noreply`, etc.) that drops mail to those addresses before any allowlist or ingest forward. CF Email Routing custom rules are the primary delivery mechanism; the Worker's drop is defense-in-depth for misconfigured or missing rules (docs/archive/cloudflare-setup.md:601).

To deliver `feedback@late.fyi` to a real inbox (docs/archive/cloudflare-setup.md:603-609):

1. **Email** → **Email Routing** → **Destination addresses** → **Add destination address** → enter your inbox (e.g., `you@gmail.com`). Click the verification link CF sends.
2. **Routing rules** → **Create rule**:
   - **Match** — Custom address: `feedback@late.fyi`
   - **Action** — Send to email: `you@gmail.com`
   - **Save** + **Enable**

CF evaluates custom rules before the catch-all, so `feedback@` goes to your inbox and everything else hits the catch-all → Worker (docs/archive/cloudflare-setup.md:611).

Add similar rules for `postmaster@`, `abuse@`, `admin@` if you want incident reports, DMARC aggregate reports and abuse complaints to land somewhere usable (docs/archive/cloudflare-setup.md:613).
