// Cloudflare Email Worker — receives mail at *@late.fyi, validates the
// sender against an allowlist, and POSTs a JSON payload to the Node
// ingest server on the VPS for actual processing.
//
// Why edge: Email Routing requires a CF-side handler. Doing allowlist
// enforcement here means non-allowlisted mail never wakes the VPS.
//
// Secrets (set via `wrangler secret put`):
//   ALLOWED_SENDERS           comma-separated lowercase emails. Empty = open.
//   LATEFYI_INGEST_URL        e.g. https://ingest.late.fyi/ingest
//   LATEFYI_INGEST_TOKEN      32+ char random hex; matches server's INGEST_TOKEN

// Local-parts that should never reach the tracking-ingest pipeline.
// CF Email Routing custom rules handle delivery (forward to a real inbox),
// but if a rule is misconfigured or ordered after the catch-all, the
// Worker is the last line of defense — we drop silently so we don't bounce
// "not a valid train number" replies for mail that was never train-related.
const NON_TRACKING_LOCALPARTS = new Set([
  'feedback', 'postmaster', 'abuse', 'admin', 'hostmaster', 'webmaster',
  'security', 'noreply', 'no-reply', 'mailer-daemon',
]);

function localPartOf(addr) {
  if (!addr) return '';
  const at = addr.indexOf('@');
  return (at >= 0 ? addr.slice(0, at) : addr).toLowerCase();
}

export default {
  async email(message, env, ctx) {
    // Bail before anything else if this is going to a reserved address.
    // No allowlist check, no ingest forward — just drop and let CF routing
    // rules (or the implicit "no rule = reject" behavior) handle delivery.
    if (NON_TRACKING_LOCALPARTS.has(localPartOf(message.to))) {
      return;
    }

    const allowed = (env.ALLOWED_SENDERS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const sender = (message.from || '').toLowerCase();
    if (allowed.length > 0 && !allowed.includes(sender)) {
      // Silent drop — never bounce, avoids backscatter to spoofed senders.
      return;
    }

    // Read the full raw RFC 5322 stream. We forward it as the JSON `body`
    // field; for v1 the server-side parser pulls headers (From:/To:/Trip:)
    // primarily from the email subject, so MIME-correctness of the body is
    // not load-bearing. Phase 7 hardening can add postal-mime if needed.
    const raw = await new Response(message.raw).text();

    // Extract the message body part (after the blank line that ends headers).
    // For multipart messages the result is raw MIME — that's fine because the
    // parser falls back to subject-only when body lines don't match the
    // header regex.
    const headerEnd = raw.indexOf('\r\n\r\n');
    const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';

    const headers = {};
    for (const [k, v] of message.headers.entries()) {
      headers[k.toLowerCase()] = v;
    }

    const payload = {
      from: message.from,
      to: message.to,
      subject: message.headers.get('subject') || '',
      body,
      msgid: message.headers.get('message-id') || '',
      headers,
      receivedAt: new Date().toISOString(),
    };

    const ingestUrl = env.LATEFYI_INGEST_URL;
    const token = env.LATEFYI_INGEST_TOKEN;
    if (!ingestUrl || !token) {
      console.error('Worker misconfigured: LATEFYI_INGEST_URL or LATEFYI_INGEST_TOKEN missing');
      return;
    }

    try {
      const resp = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        console.error('ingest failed', resp.status, await resp.text());
      }
    } catch (e) {
      console.error('ingest fetch error:', e.message);
    }
  },
};
