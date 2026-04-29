// Parses inbound email payloads into a discriminated-union request shape
// the rest of the system can route on. Pure function — no I/O, no state.
//
// See PRD §4 (grammar), §7 (replies), §13.1 (this module).
//
// Input shape:
//   { from, to, subject, body, msgid, headers? }
//   - `to` is the recipient address; its local-part is the routing key
//   - `subject` and `body` are strings (body may be multi-line)
//   - `headers` optional; if present, headers['in-reply-to'] is read
//
// Output: one of
//   { kind: "track",   trainNum, mode, from, to, trip, channels, inReplyTo? }
//   { kind: "stop",    scope: "this"|"single"|"trip"|"all", target, inReplyTo? }
//   { kind: "config",  field: "channels", value: "email"|"ntfy"|"both", inReplyTo? }
//   { kind: "reply",   inReplyTo, answer }      // reply to a prior outbound
//   { kind: "help" }
//   { kind: "error",   code, message }

const TRAINNUM_RE = /^[A-Z]{0,4}\d{2,5}$/;
const TRIP_RE     = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_LOCALPARTS = new Set(['config', 'stop', 'help']);
const VALID_CHANNELS = new Set(['email', 'ntfy', 'both']);

const HEADER_RE = /(from|to|trip|channels)\s*:\s*([^,\n\r]+)/gi;

function localPartOf(addr) {
  if (!addr || typeof addr !== 'string') return '';
  const at = addr.indexOf('@');
  return (at >= 0 ? addr.slice(0, at) : addr).trim();
}

function firstNonEmptyLine(text) {
  if (!text) return '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

// Build the "header source" combining subject and the first non-empty body line.
// PRD §4: headers may appear in subject (preferred) or in body's first non-empty line.
function headerSource(subject, body) {
  const parts = [];
  if (subject && subject.trim()) parts.push(subject.trim());
  const bodyLine = firstNonEmptyLine(body);
  if (bodyLine) parts.push(bodyLine);
  return parts.join('\n');
}

function extractHeaders(src) {
  const out = {};
  for (const m of src.matchAll(HEADER_RE)) {
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    // First occurrence wins — don't overwrite if already set
    if (!(key in out)) out[key] = val;
  }
  return out;
}

function getInReplyTo(headers) {
  if (!headers) return null;
  // Email headers are conventionally case-insensitive
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'in-reply-to') {
      const v = headers[key];
      return typeof v === 'string' ? v.trim() : null;
    }
  }
  return null;
}

// Parse `STOP`, `STOP <TRAINNUM>`, `STOP TRIP <name>`, `STOP ALL`.
// Source can be subject or body; case-insensitive.
function tryParseStop(src) {
  if (!src) return null;
  const trimmed = src.trim();
  // Must START with STOP (word boundary) to count
  const m = trimmed.match(/^STOP\b\s*(.*)$/i);
  if (!m) return null;
  const rest = (m[1] || '').trim();
  if (!rest) return { scope: 'this', target: null };
  const upper = rest.toUpperCase();
  if (upper === 'ALL') return { scope: 'all', target: null };
  const tripMatch = rest.match(/^TRIP\s+(\S+)/i);
  if (tripMatch) return { scope: 'trip', target: tripMatch[1] };
  // Anything else: assume it's a train number (preserve uppercase, validate)
  const candidate = rest.split(/\s+/)[0].toUpperCase();
  if (TRAINNUM_RE.test(candidate)) return { scope: 'single', target: candidate };
  return { scope: 'this', target: null }; // garbage after STOP — treat as bare STOP
}

// Parse `CHANNELS <value>` from subject or body.
function tryParseChannels(src) {
  if (!src) return null;
  const m = src.match(/CHANNELS\s+(email|ntfy|both)\b/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

// ---- main parser ----

export function parse(email) {
  if (!email || typeof email !== 'object') {
    return { kind: 'error', code: 'invalid_input', message: 'email payload missing or not an object' };
  }
  const inReplyTo = getInReplyTo(email.headers);
  const localPart = localPartOf(email.to).toLowerCase();
  const subject = email.subject || '';
  const body = email.body || '';
  const headerSrc = headerSource(subject, body);

  // 1. Reserved local-parts: route on the address, not the train regex.
  if (RESERVED_LOCALPARTS.has(localPart)) {
    if (localPart === 'config') {
      const channel = tryParseChannels(headerSrc);
      if (!channel) {
        return { kind: 'error', code: 'config_unrecognized',
                 message: 'config@ requires `CHANNELS <email|ntfy|both>` in subject or body' };
      }
      return { kind: 'config', field: 'channels', value: channel, inReplyTo };
    }
    if (localPart === 'stop') {
      const stop = tryParseStop(headerSrc);
      if (stop) return { kind: 'stop', ...stop, inReplyTo };
      return { kind: 'error', code: 'stop_unrecognized',
               message: 'stop@ body must contain STOP / STOP <TRAIN> / STOP TRIP <name> / STOP ALL' };
    }
    if (localPart === 'help') {
      return { kind: 'help' };
    }
  }

  // 2. STOP detection in body/subject (works for replies threaded to a confirmation,
  //    e.g. user replies "STOP" to the tracking-confirmation email).
  const stop = tryParseStop(headerSrc);
  if (stop) {
    // If the local-part is a valid train number and STOP came alone, that train is the target.
    let scope = stop.scope;
    let target = stop.target;
    if (scope === 'this' && TRAINNUM_RE.test(localPart.toUpperCase())) {
      scope = 'single';
      target = localPart.toUpperCase();
    }
    return { kind: 'stop', scope, target, inReplyTo };
  }

  // 3. Replies threaded to a prior outbound (disambiguation, etc.).
  //    Caller decides if In-Reply-To matches a known pending request.
  if (inReplyTo) {
    // Heuristic: a "reply" is a message with In-Reply-To and either an empty
    // subject/body header surface OR a body that's just an answer (digit/name).
    // We can't know for sure here — just return the raw answer + inReplyTo and
    // let the router check pending state.
    const answer = firstNonEmptyLine(body) || subject.trim();
    if (answer && !TRAINNUM_RE.test(localPart.toUpperCase())) {
      return { kind: 'reply', inReplyTo, answer };
    }
    // If the local-part IS a valid train number, treat as a fresh tracking
    // request (user may have re-sent to the same address). Fall through.
  }

  // 4. Train-number extraction & validation.
  const trainNum = localPart.toUpperCase();
  if (!TRAINNUM_RE.test(trainNum)) {
    return { kind: 'error', code: 'invalid_trainnum',
             message: `local-part "${localPart}" is not a valid train number (expected up to 4 letters + 2-5 digits)` };
  }

  // 5. Header extraction.
  const headers = extractHeaders(headerSrc);

  // 6. Mode determination.
  let mode;
  if (headers.from) mode = 'B';
  else if (headers.to) mode = 'A';
  else mode = 'MISSING';

  // 7. Trip validation.
  let trip = null;
  if (headers.trip) {
    if (!TRIP_RE.test(headers.trip)) {
      return { kind: 'error', code: 'invalid_trip',
               message: `trip tag "${headers.trip}" must be 1-32 chars: letters, digits, dash, underscore` };
    }
    trip = headers.trip;
  }

  // 8. Channels override (per-request only — caller merges with user pref).
  let channels = null;
  if (headers.channels) {
    const c = headers.channels.toLowerCase();
    if (!VALID_CHANNELS.has(c)) {
      return { kind: 'error', code: 'invalid_channels',
               message: `channels "${headers.channels}" must be one of: email, ntfy, both` };
    }
    channels = c;
  }

  return {
    kind: 'track',
    trainNum,
    mode,
    from: headers.from || null,
    to: headers.to || null,
    trip,
    channels,
    inReplyTo,
  };
}
