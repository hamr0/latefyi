// HTTP /ingest endpoint. Accepts POST from the Cloudflare Email Worker
// with a Bearer token, runs handleInbound, and (if a transport is wired)
// sends the reply email. Stateless — all persistence happens via the
// state/* file tree handled inside handleInbound.
//
// Routes:
//   GET  /health   — liveness probe (no auth, returns "ok")
//   POST /ingest   — auth: Bearer <INGEST_TOKEN>; body: JSON email payload
//
// Tests use the returned http.Server directly. Production calls .listen()
// from a tiny CLI entry below or from a process manager.

import { createServer } from 'node:http';
import { handleInbound } from './server.js';

export function createIngestServer({
  stateDir,
  primaryClient,
  fallbackClient,
  aliases = {},
  allowlist = null,
  transport = null,
  ingestToken,
} = {}) {
  if (!stateDir) throw new Error('createIngestServer: stateDir required');
  if (!ingestToken) throw new Error('createIngestServer: ingestToken required');
  if (!primaryClient) throw new Error('createIngestServer: primaryClient required');

  return createServer(async (req, res) => {
    try {
      // Liveness probe: unauthenticated, cheap.
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }

      if (req.method !== 'POST' || req.url !== '/ingest') {
        res.writeHead(404).end();
        return;
      }

      // Auth — exact-match Bearer token, no constant-time comparison
      // (single-tenant, low traffic; timing attacks aren't realistic here).
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${ingestToken}`) {
        res.writeHead(401).end();
        return;
      }

      // Read JSON body. Cap at 1 MB to deflect garbage POSTs.
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 1024 * 1024) {
          res.writeHead(413).end('payload too large');
          return;
        }
        chunks.push(chunk);
      }
      const bodyText = Buffer.concat(chunks).toString('utf8');

      let email;
      try { email = JSON.parse(bodyText); }
      catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid json');
        return;
      }

      const reply = await handleInbound({
        email, stateDir, primaryClient, fallbackClient, aliases, allowlist,
      });

      let sent = false, sendError = null;
      if (reply && transport) {
        try {
          await transport.sendEmail(reply);
          sent = true;
        } catch (e) {
          sendError = e.message;
          console.error('[ingest] sendEmail failed:', e.message);
        }
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, replied: !!reply, sent, sendError }));
    } catch (e) {
      console.error('[ingest] uncaught:', e);
      try { res.writeHead(500).end('internal error'); } catch { /* socket may be closed */ }
    }
  });
}

// CLI entry: `node src/ingest-server.js`. Wires real hafas-clients and
// an SMTP transport from environment config.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createClient } = await import('hafas-client');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { readFileSync, existsSync } = await import('node:fs');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, '..');

  const stateDir = process.env.STATE_DIR || join(root, 'state');
  const port     = parseInt(process.env.INGEST_PORT || '8787', 10);
  // Default to localhost-only — the reverse proxy always lives on the same
  // host. Set INGEST_HOST=0.0.0.0 to expose directly (not recommended).
  const host     = process.env.INGEST_HOST || '127.0.0.1';
  const ingestToken = process.env.INGEST_TOKEN;
  if (!ingestToken) {
    console.error('FATAL: INGEST_TOKEN env var required');
    process.exit(1);
  }

  // Allowlist
  const allowlistEnv = (process.env.ALLOWED_SENDERS || '').trim();
  const allowlist = allowlistEnv ? allowlistEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;

  // Aliases
  let aliases = {};
  const aliasPath = join(root, 'config', 'aliases.json');
  if (existsSync(aliasPath)) aliases = JSON.parse(readFileSync(aliasPath, 'utf8'));

  // hafas-clients
  const profiles = {};
  for (const name of ['oebb', 'pkp']) {
    try {
      const mod = await import(`hafas-client/p/${name}/index.js`);
      profiles[name] = createClient(mod.profile || mod.default, 'latefyi/0.5.0');
    } catch (e) {
      console.error(`failed to load profile ${name}:`, e.message);
    }
  }

  // SMTP transport (if configured)
  let transport = null;
  if (process.env.SMTP_HOST) {
    const { createSmtpTransport } = await import('./smtp-transport.js');
    transport = createSmtpTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromAddress: process.env.SMTP_FROM || 'noreply@late.fyi',
    });
    console.log(`[ingest] SMTP transport: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
  } else {
    console.log('[ingest] no SMTP_HOST set — running in dry-run mode (replies parsed but not sent)');
  }

  const server = createIngestServer({
    stateDir, primaryClient: profiles.oebb, fallbackClient: profiles.pkp,
    aliases, allowlist, transport, ingestToken,
  });
  server.listen(port, host, () => console.log(`[ingest] listening on ${host}:${port}`));
}
