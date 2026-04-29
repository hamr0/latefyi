// Pure email-reply templating. Every function returns { subject, body, headers }
// where headers may contain In-Reply-To for threading. No I/O. The transport
// (SMTP / Cloudflare Email send / etc.) is wired up by the caller.
//
// Implements PRD §7 (reply behaviors) and §7a (disambiguation).
// All replies end with FOOTER (single source of truth).

const DOMAIN = 'late.fyi';
const FROM_ADDRESS = `noreply@${DOMAIN}`;

export const FOOTER = `— late.fyi
─────
Format: <TRAINNUM>@${DOMAIN}   Subject: From: <station>, To: <station>   (or just To: for pickup)
Optional: Trip: <name>   ·   Reply STOP / STOP TRIP <name> / STOP ALL   ·   Headers case-insensitive`;

// ---- helpers ----

function fmtTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toISOString().replace(/^.+T(\d{2}:\d{2}).+$/, '$1');
}

function fmtDate(iso) {
  if (!iso) return '?';
  return new Date(iso).toISOString().slice(0, 10);
}

function withFooter(body) {
  return `${body}\n\n${FOOTER}`;
}

function reply({ subject, body, to, inReplyTo, references, msgid }) {
  const headers = {};
  if (inReplyTo) {
    headers['In-Reply-To'] = inReplyTo;
    headers['References'] = references || inReplyTo;
  }
  if (msgid) headers['Message-ID'] = msgid;
  return {
    from: FROM_ADDRESS,
    to,
    subject,
    body: withFooter(body),
    headers,
  };
}

// ---- §7: confirmation (happy path) ----

export function confirmationReply({ resolved, sender, channel = 'email', incomingMsgid, ourMsgid }) {
  const line = resolved.line || resolved.trainNum;
  const fromName = resolved.from || '?';
  const toName = resolved.to || '?';
  const dep = resolved.schedule?.scheduledDeparture;
  const arr = resolved.schedule?.scheduledArrival;
  const t30 = dep ? new Date(new Date(dep).getTime() - 30 * 60 * 1000) : null;

  const channelBlurb = channel === 'ntfy'
    ? `Push starts T-30 at ${t30 ? fmtTime(t30) : '?'} via ntfy.\nReply CHANNELS email to switch back.`
    : channel === 'both'
      ? `Updates by both email and ntfy starting T-30 at ${t30 ? fmtTime(t30) : '?'}.\nReply CHANNELS email or CHANNELS ntfy to change.`
      : `Updates by email starting T-30 at ${t30 ? fmtTime(t30) : '?'}.\nReply CHANNELS ntfy or CHANNELS both to switch delivery.`;

  const tripLine = resolved.trip ? `\nTrip: ${resolved.trip}` : '';

  return reply({
    subject: `Tracking ${line} — ${fromName} → ${toName}`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `Tracking ${line}, ${fromName} → ${toName}.${tripLine}\n` +
      `Scheduled: dep ${fmtTime(dep)} ${fromName}, arr ${fmtTime(arr)} ${toName}.\n` +
      channelBlurb,
  });
}

// ---- §7: missing context ----

export function missingContextReply({ trainNum, sender, incomingMsgid, ourMsgid }) {
  return reply({
    subject: `Need more info for ${trainNum}`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `Got ${trainNum} but I don't know what you need.\n` +
      `- Reply with \`To: <station>\` if you're picking someone up at that station.\n` +
      `- Reply with \`From: <station>\` (and optionally \`To: <station>\`) if you're boarding.\n\n` +
      `Example: From: Amsterdam, To: Berlin Ostbahnhof`,
  });
}

// ---- §7: train not found ----

export function trainNotFoundReply({ trainNum, sender, incomingMsgid, ourMsgid }) {
  return reply({
    subject: `Can't find train ${trainNum}`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `No train matching "${trainNum}" found today or tomorrow.\n\n` +
      `Common confusions:\n` +
      `- TGV INOUI: 4 digits (e.g. 9876)\n` +
      `- TER/RE: 4-5 digits, often prefixed RE/TER\n` +
      `- Eurostar: prefixed EUR + 4 digits\n` +
      `- ICE: prefixed ICE + 3-4 digits\n` +
      `- Numbers reset daily — yesterday's ${trainNum} may not exist today\n\n` +
      `Check your booking confirmation and resend.`,
  });
}

// ---- §7: station not on route ----

export function stationNotOnRouteReply({ trainNum, line, station, route, suggestion, sender, incomingMsgid, ourMsgid }) {
  const routeLine = (route || []).join(' → ');
  const suggestionLine = suggestion ? `Closest match: ${suggestion}.\n` : '';
  return reply({
    subject: `${station} not on ${line || trainNum}'s route`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `${line || trainNum} runs: ${routeLine}.\n` +
      `"${station}" isn't a stop. ${suggestionLine}\n` +
      `Reply with corrected station.`,
  });
}

// ---- §7a: ambiguous station ----

export function ambiguousStationReply({ trainNum, line, station, candidates, sender, incomingMsgid, ourMsgid }) {
  const numbered = candidates.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  return reply({
    subject: `Which ${station} for ${line || trainNum}?`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `"${station}" matches multiple stops on ${line || trainNum}'s route:\n` +
      `${numbered}\n\n` +
      `Reply with just the number (1${candidates.length > 1 ? ` or ${candidates.length}` : ''}), or the full name.`,
  });
}

// ---- §18: train already passed ----

export function alreadyArrivedReply({ trainNum, line, toStation, arrivedAt, sender, incomingMsgid, ourMsgid }) {
  return reply({
    subject: `${line || trainNum} already arrived`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `${line || trainNum} arrived at ${toStation} at ${fmtTime(arrivedAt)} today. Nothing left to track.\n\n` +
      `If this is for tomorrow's ${trainNum}, resend after midnight (train numbers are per-day, not unique across days).`,
  });
}

// ---- §7: unauthorized sender (system-internal note; rarely sent) ----

export function unauthorizedSenderReply({ sender, incomingMsgid, ourMsgid }) {
  return reply({
    subject: `Sender not allowlisted`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `Email from ${sender} isn't authorized for this latefyi instance.\n` +
      `Add to config.json \`allowed_senders\` and redeploy.`,
  });
}

// ---- §7: STOP variants ----

export function stopReply({ scope, target, count, trains, sender, incomingMsgid, ourMsgid }) {
  if (scope === 'all') {
    return reply({
      subject: `Stopped all tracking`,
      to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
      body: `Cleared ${count} active trains. No more updates until you start fresh.`,
    });
  }
  if (scope === 'trip') {
    const list = (trains || []).map(t => `  - ${t.line || t.trainNum}${t.from && t.to ? ` (${t.from} → ${t.to})` : ''}`).join('\n');
    return reply({
      subject: `Stopped trip "${target}"`,
      to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
      body: `Cleared ${count} train${count === 1 ? '' : 's'} from trip "${target}":\n${list || '  (none)'}`,
    });
  }
  // single
  return reply({
    subject: `Stopped tracking ${target}`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body: `OK, no more updates for ${target}.`,
  });
}

// ---- §7: ntfy opt-in (sent once on first opt-in) ----

export function ntfyOptInReply({ topic, sender, incomingMsgid, ourMsgid, baseUrl = 'https://ntfy.sh' }) {
  const url = `${baseUrl}/${topic}`;
  const deepLink = `ntfy://subscribe/${topic}`;
  return reply({
    subject: `ntfy enabled for late.fyi`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body:
      `Install ntfy (App Store, Play Store, or F-Droid), then open this on your phone:\n\n` +
      `   ${deepLink}\n\n` +
      `Or open in any browser to subscribe manually:\n\n` +
      `   ${url}\n\n` +
      `From now on, every train you track will push here. Multiple trains in tandem all flow through this one topic — no extra setup, ever.\n\n` +
      `Reply CHANNELS email to disable ntfy. Reply CHANNELS both to keep both channels active.`,
  });
}

// ---- push reply (a notification email for a tracked-train event) ----

// Threaded to the original confirmation so the user's mail client groups
// all updates per-train into one collapsed conversation (PRD §6).
export function pushReply({ event, line, trainNum, sender, confirmationMsgid, ourMsgid }) {
  const subject = event.title || `${line || trainNum} update`;
  return reply({
    subject,
    to: sender,
    inReplyTo: confirmationMsgid,
    references: confirmationMsgid,
    msgid: ourMsgid,
    body: event.body || event.title || `${line || trainNum} update`,
  });
}

// ---- Helper for non-confirmation system errors that don't have a clean
//      template (e.g., generic resolver failures we want to surface) ----

export function genericErrorReply({ trainNum, code, message, sender, incomingMsgid, ourMsgid }) {
  return reply({
    subject: `Couldn't track ${trainNum}`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body:
      `Got your request for ${trainNum}, but ran into a problem: ${message}\n\n` +
      `(Internal code: ${code})`,
  });
}
