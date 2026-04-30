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

// Forgiving header extractor. Matches `<keyword>` (with or without `:`),
// captures the value lazily up to the next keyword, comma, or end of line.
// Accepts all of these:
//   "From: Amsterdam, To: Berlin Ostbahnhof"
//   "from amsterdam to berlin ostbahnhof"
//   "from amsterdam to paris nord on 2026-05-06"
//   "From Amsterdam, To Berlin, On 2026-05-04"
const HEADER_RE = /\b(from|to|trip|channels|on)\b[\s:]+([^,\n\r]+?)(?=\s+\b(?:from|to|trip|channels|on)\b|\s*[,\n\r]|\s*$)/gi;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MAX_PLAN_AHEAD_DAYS = 90;

// Parse the `On:` header. Accepts unambiguous formats only:
//   2026-05-04          (ISO)
//   5 May 2026 / 05-May-2026 / 5-May-26
// Rejects pure-numeric like 05/04/26 (US vs EU ambiguous).
// Returns { ok: true, date: 'YYYY-MM-DD' } or { ok: false, error }.
export function parseOnDate(raw, now = Date.now()) {
  if (!raw) return null;
  const s = raw.trim();
  let y, m, d;

  let match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    y = parseInt(match[1], 10); m = parseInt(match[2], 10); d = parseInt(match[3], 10);
  } else {
    match = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]+)[\s\-\/]+(\d{2,4})$/);
    if (!match) return { ok: false, error: 'invalid_date_format' };
    d = parseInt(match[1], 10);
    m = MONTHS[match[2].toLowerCase()];
    if (!m) return { ok: false, error: 'invalid_date_format' };
    y = parseInt(match[3], 10);
    if (y < 100) y += 2000;
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(date.getTime()) ||
      date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { ok: false, error: 'invalid_date' };
  }
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  if (date.getTime() < today.getTime()) {
    return { ok: false, error: 'date_in_past' };
  }
  const cutoff = today.getTime() + MAX_PLAN_AHEAD_DAYS * 24 * 60 * 60 * 1000;
  if (date.getTime() > cutoff) {
    return { ok: false, error: 'date_too_far' };
  }
  return { ok: true, date: date.toISOString().slice(0, 10) };
}

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

// If no `on` keyword was found, look for a bare date anywhere in the source
// and inject an `on ` prefix before it so the next extraction pass picks it
// up. Lets users write `from X to Y 2026-05-04` without the `on` keyword.
// ISO is tried first; if absent, fall back to named-month form.
function injectOnBeforeBareDate(src) {
  const iso = src.replace(/(\b\d{4}-\d{2}-\d{2}\b)/, 'on $1');
  if (iso !== src) return iso;
  return src.replace(
    /(\b\d{1,2}[\s\-\/]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-\/]+\d{2,4}\b)/i,
    'on $1'
  );
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
  //    A reply is identified by: In-Reply-To present AND no recognized
  //    headers in subject/body. With recognized headers, the user is
  //    re-sending a fresh tracking request — fall through to track.
  //    Local-part doesn't disambiguate (Reply-To routes replies to
  //    <TRAINNUM>@late.fyi to bypass the worker's noreply@ drop).
  if (inReplyTo) {
    const peekHeaders = extractHeaders(headerSrc);
    const hasFreshHeaders = !!(peekHeaders.from || peekHeaders.to);
    const answer = firstNonEmptyLine(body) || subject.trim();
    if (answer && !hasFreshHeaders) {
      return { kind: 'reply', inReplyTo, answer };
    }
    // Fresh headers → user re-submitted from scratch; fall through to track.
  }

  // 4. Train-number extraction & validation.
  const trainNum = localPart.toUpperCase();
  if (!TRAINNUM_RE.test(trainNum)) {
    return { kind: 'error', code: 'invalid_trainnum',
             message: `local-part "${localPart}" is not a valid train number (expected up to 4 letters + 2-5 digits)` };
  }

  // 5. Header extraction. Two-pass: if `on` is absent but a bare date is
  // present, inject an `on ` prefix so the second pass picks it up cleanly
  // (and prevents a trailing date from being swallowed into to:).
  let headers = extractHeaders(headerSrc);
  if (!headers.on) {
    const withOn = injectOnBeforeBareDate(headerSrc);
    if (withOn !== headerSrc) headers = extractHeaders(withOn);
  }

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

  // 9. Optional date for advance planning.
  let onDate = null;
  if (headers.on) {
    const r = parseOnDate(headers.on);
    if (r && !r.ok) {
      return { kind: 'error', code: r.error,
               message: `On: "${headers.on}" — ${dateErrorMessage(r.error)}` };
    }
    onDate = r ? r.date : null;
  }

  return {
    kind: 'track',
    trainNum,
    mode,
    from: headers.from || null,
    to: headers.to || null,
    trip,
    channels,
    onDate,
    inReplyTo,
  };
}

function dateErrorMessage(code) {
  switch (code) {
    case 'invalid_date_format': return 'use YYYY-MM-DD or 5 May 2026 (numeric-only formats are ambiguous)';
    case 'invalid_date':        return 'date does not exist';
    case 'date_in_past':        return 'date has already passed';
    case 'date_too_far':        return `more than ${MAX_PLAN_AHEAD_DAYS} days ahead — schedules aren't published that far out`;
    default:                    return 'invalid date';
  }
}
