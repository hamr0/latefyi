# latefyi Worker

Cloudflare Email Worker for inbound email ingest. Validates the sender at the edge, then POSTs a JSON payload to the Node ingest server.

## One-time setup

1. **Domain in Cloudflare.** Add `late.fyi` (or your domain) to your Cloudflare account. Update nameservers at the registrar.

2. **Email Routing.** In Cloudflare dashboard → Email → Email Routing → Get started. Cloudflare auto-adds the required MX/SPF/DMARC records.

3. **Wrangler.**
   ```sh
   npm install -g wrangler   # or use `npx wrangler`
   wrangler login
   ```
   Edit `wrangler.toml` and uncomment the `account_id` line with your account ID.

4. **Set secrets.**
   ```sh
   cd worker
   wrangler secret put ALLOWED_SENDERS         # e.g. amr@example.com,friend@example.com
   wrangler secret put LATEFYI_INGEST_URL      # e.g. https://ingest.late.fyi/ingest
   wrangler secret put LATEFYI_INGEST_TOKEN    # 32+ char random hex (must match server's INGEST_TOKEN)
   ```

5. **Deploy.**
   ```sh
   wrangler deploy
   ```

6. **Wire Email Routing → Worker.** In dashboard → Email → Email Routing → Routing rules:
   - Add a **Catch-all** rule
   - Action: **Send to a Worker**
   - Destination: `latefyi-ingest`
   - Save and enable

## Verify

Send a test email from an allowlisted address to `ICE145@late.fyi` (replace with a real train running today). Within seconds:

- Worker logs (`wrangler tail`) show the POST to your ingest URL
- The Node ingest server (running on your VPS) receives the payload and returns the parsed reply
- You receive the confirmation reply email

If nothing arrives, check in order:
1. `dig MX late.fyi +short` returns Cloudflare mail servers
2. Worker logs show the email was received
3. Ingest URL is reachable from the public internet (HTTPS, valid cert, port 443)
4. INGEST_TOKEN matches between Worker secret and server env

## What the Worker does NOT do

- No MIME parsing — the raw body is forwarded to the server. Server-side `parse.js` reads headers (From:/To:/Trip:) primarily from the subject, which is always cleanly available via `message.headers.get('subject')`.
- No reply sending — that's the server's job, via SMTP relay.
- No state — the Worker is stateless. Allowlist lives in `ALLOWED_SENDERS` secret.

If you change the allowlist, update the secret and re-deploy. (Or move it to KV later if it grows beyond a comma-separated string.)
