// Inbound sender authentication. The trust model gates every per-user action
// (track, STOP, list, config) on the email's `From`, which is trivially
// spoofable on its own. The receiving MTA (Cloudflare Email Routing for
// *@late.fyi) evaluates SPF/DKIM/DMARC and records the verdict in an
// `Authentication-Results` header; we read it here so a spoofed `From` can be
// dropped before it deletes someone's tracking or amplifies backscatter.
//
// Policy: reject ONLY on an explicit `dmarc=fail`. That is precisely the case
// where the From domain published a DMARC policy and this message failed
// alignment — i.e. a forgery of a real domain (gmail, outlook, …). We do NOT
// reject on absent header / `dmarc=none` / temperror, because those can't
// prove spoofing and rejecting them would bounce legitimate mail from domains
// without DMARC. Conservative by design: closes the realistic spoof, no false
// positives on well-behaved senders.
//
// Pure function, no I/O — unit-tested in tests/auth-results.test.js.

export function senderFailsDmarc(authResultsHeader) {
  if (!authResultsHeader || typeof authResultsHeader !== 'string') return false;
  // Header may carry multiple `dmarc=` tokens if relayed through several hops;
  // a single explicit failure anywhere is enough to drop.
  const matches = authResultsHeader.toLowerCase().matchAll(/\bdmarc\s*=\s*([a-z]+)/g);
  for (const m of matches) {
    if (m[1] === 'fail') return true;
  }
  return false;
}
