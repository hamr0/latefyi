// Pure email-reply templating. Every function returns { subject, body, headers }
// where headers may contain In-Reply-To for threading. No I/O. The transport
// (SMTP / Cloudflare Email send / etc.) is wired up by the caller.
//
// Implements PRD §7 (reply behaviors) and §7a (disambiguation).
// All replies end with FOOTER (single source of truth).

const DOMAIN = 'late.fyi';
const DISPLAY_NAME = 'latefyi';

// Build the "From:" header. The local-part is meaningful — it's the address
// the user's Reply will go to. We choose it per template so a Reply lands
// somewhere routable instead of `noreply@` (which the Cloudflare worker
// drops via NON_TRACKING_LOCALPARTS as defense-in-depth). Display name keeps
// the inbox sender clean ("latefyi" instead of bare local-part).
function fromAddress(localPart = 'noreply') {
  return `${DISPLAY_NAME} <${localPart}@${DOMAIN}>`;
}

export const FOOTER = `— late.fyi
list@${DOMAIN} (your active trains) | feedback@${DOMAIN} | we don't store your email past notifications or STOP`;

// ---- helpers ----

function fmtTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toISOString().replace(/^.+T(\d{2}:\d{2}).+$/, '$1');
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayName(iso) {
  return DAYS[new Date(iso).getUTCDay()];
}

function fmtDatetime(iso) {
  if (!iso) return '?';
  const base = new Date(iso).toISOString().replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).+$/, '$1 $2');
  return `${dayName(iso)}, ${base}`;
}

function fmtDate(iso) {
  if (!iso) return '?';
  return new Date(iso).toISOString().slice(0, 10);
}

function withFooter(body) {
  return `${body}\n\n${FOOTER}`;
}

// Inbox-grouping signals split into prefix (trip tag, before the route) and
// suffix (ISO date, after the route, always present when known — subject lines
// are frozen at send time so relative terms like "today" become wrong by
// tomorrow).
//   prefix: ` [trip]`
//   suffix: ` — 2026-05-06`
function subjectTags({ trip, scheduledIso }) {
  const prefix = trip ? ` [${trip}]` : '';
  const suffix = scheduledIso ? ` — ${dayName(scheduledIso)}, ${scheduledIso.slice(0, 10)}` : '';
  return { prefix, suffix };
}

// One-click stop links. Mail clients render bare `mailto:` URIs as tappable
// links; clicking opens a fresh compose with `Subject: STOP <TRAIN>` already
// filled, which the parser handles deterministically. The `body=` parameter
// is belt-and-suspenders: some clients (notably Outlook.com web with browser-
// handled mailto) silently drop `?subject=` during handoff to the compose
// window. Including STOP in body too means the parser still catches it via
// the first-non-empty-body-line path that headerSource() folds into headerSrc.
function stopLinks(trainNum, trip) {
  const lines = [];
  if (trainNum) {
    const cmd = `STOP ${trainNum}`;
    const enc = encodeURIComponent(cmd);
    lines.push(`Stop tracking this train:`);
    lines.push(`  mailto:stop@${DOMAIN}?subject=${enc}&body=${enc}`);
  }
  if (trip) {
    const cmd = `STOP TRIP ${trip}`;
    const enc = encodeURIComponent(cmd);
    lines.push(`Stop the whole trip (${trip}):`);
    lines.push(`  mailto:stop@${DOMAIN}?subject=${enc}&body=${enc}`);
  }
  return lines.join('\n');
}

function reply({ subject, body, to, inReplyTo, references, msgid, replyTo, fromLocal }) {
  const headers = {};
  if (inReplyTo) {
    headers['In-Reply-To'] = inReplyTo;
    headers['References'] = references || inReplyTo;
  }
  if (msgid) headers['Message-ID'] = msgid;
  // Reply-To is now redundant when From: itself uses a routable local-part
  // (the new pattern). Kept for legacy callers and as defense-in-depth: if
  // a client doesn't honor Reply-To, From: is the fallback and now also routes.
  if (replyTo) headers['Reply-To'] = replyTo;
  return {
    from: fromAddress(fromLocal),
    to,
    subject,
    body: withFooter(body),
    headers,
  };
}

// ---- §7: confirmation (happy path) ----

// `channel` is accepted but unused while ntfy is deferred — keeps callers stable.
export function confirmationReply({ resolved, sender, channel: _channel = 'email', incomingMsgid, ourMsgid, trainNum }) {
  const line = resolved.line || resolved.trainNum;
  const fromName = resolved.from || '?';
  const toName = resolved.to || '?';
  const dep = resolved.schedule?.scheduledDeparture;
  const arr = resolved.schedule?.scheduledArrival;
  const t30 = dep ? new Date(new Date(dep).getTime() - 30 * 60 * 1000) : null;

  const tripLine = resolved.trip ? `\nTrip: ${resolved.trip}` : '';
  const updatesLine = `Updates by email starting T-30 at ${t30 ? fmtTime(t30) : '?'}.`;
  const stopBlock = stopLinks(trainNum, resolved.trip);

  // Surface platform + status fields up front to set expectations: confirmation
  // is the schedule; live data (operator-assigned platform, real-time delay)
  // arrives at T-30 when polling kicks in. "TBC" = to be confirmed.
  const depPlat = resolved.departurePlatform || 'TBC';
  const arrPlat = resolved.arrivalPlatform || 'TBC';
  const status  = resolved.status || 'TBC';

  return reply({
    fromLocal: trainNum || 'help',
    subject: (() => {
      const { prefix, suffix } = subjectTags({ trip: resolved.trip, scheduledIso: dep });
      return `Tracking ${line}${prefix} — ${fromName} → ${toName}${suffix}`;
    })(),
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    replyTo: trainNum ? `${trainNum}@${DOMAIN}` : undefined,
    body:
      `Tracking ${line}, ${fromName} → ${toName}.${tripLine}\n` +
      `Scheduled: dep ${fmtDatetime(dep)} ${fromName}, arr ${fmtDatetime(arr)} ${toName}.\n` +
      `Departure platform: ${depPlat}    Arrival platform: ${arrPlat}\n` +
      `Status: ${status}\n` +
      `${updatesLine}\n\n${stopBlock}`,
  });
}

// ---- §7: missing context ----

export function missingContextReply({ trainNum, sender, incomingMsgid, ourMsgid }) {
  return reply({
    fromLocal: 'help',
    subject: `Need more info for ${trainNum}`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `Got ${trainNum} but I don't know what you need. Resend with one of:\n\n` +
      `Picking someone up:\n` +
      `  Subject: To: <station>\n\n` +
      `Boarding:\n` +
      `  Subject: From: <station>, To: <station>\n` +
      `  (just From: works too — we'll track to the train's terminus)\n\n` +
      `Optional headers (combine freely, comma-separated, in subject):\n` +
      `  On: 2026-05-04         travelling later (ISO date or "5 May 2026", up to 90 days ahead)\n` +
      `  Trip: <name>           tag for grouping; STOP TRIP <name> tears the chain down\n\n` +
      `Example:\n` +
      `  Subject: From: Amsterdam, To: Berlin Ostbahnhof, On: 2026-05-04, Trip: berlin-weekend\n\n` +
      `Headers are case-insensitive and can also go in the body's first non-empty line.`,
  });
}

// ---- §7: train not found ----

export function trainNotFoundReply({ trainNum, sender, incomingMsgid, ourMsgid, onDate }) {
  const window = onDate ? `on ${onDate}` : 'today or tomorrow';
  return reply({
    fromLocal: trainNum || 'help',
    subject: `Can't find train ${trainNum}`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    replyTo: trainNum ? `${trainNum}@${DOMAIN}` : undefined,
    body:
      `No train matching "${trainNum}" found ${window}.\n\n` +
      `Common confusions:\n` +
      `- TGV INOUI: 4 digits (e.g. 9876)\n` +
      `- TER/RE: 4-5 digits, often prefixed RE/TER\n` +
      `- Eurostar: prefixed EUR + 4 digits\n` +
      `- ICE: prefixed ICE + 3-4 digits\n` +
      `- Numbers reset daily — train numbers can also vary by day-of-week\n\n` +
      (onDate
        ? `Tip: if the date is more than a few weeks out, HAFAS may not have published that day's schedule yet — try again closer to the date.\n\n`
        : '') +
      `Check your booking confirmation and resend.`,
  });
}

// ---- §7: station not on route ----

export function stationNotOnRouteReply({ trainNum, line, station, route, suggestion, sender, incomingMsgid, ourMsgid }) {
  const routeLine = (route || []).join(' → ');
  const suggestionLine = suggestion ? `Closest match: ${suggestion}.\n` : '';
  return reply({
    fromLocal: trainNum || 'help',
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
    fromLocal: trainNum || 'help',
    subject: `Which ${station} for ${line || trainNum}?`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    // Reply lands at <TRAINNUM>@late.fyi so the worker (which drops noreply@)
    // forwards it to ingest, and the parser sees inReplyTo + a body that's
    // just a digit/name → kind: 'reply'.
    replyTo: trainNum ? `${trainNum}@${DOMAIN}` : undefined,
    body:
      `"${station}" matches multiple stops on ${line || trainNum}'s route:\n` +
      `${numbered}\n\n` +
      `Reply with just the number (1${candidates.length > 1 ? ` or ${candidates.length}` : ''}), or the full name.`,
  });
}

// ---- §18: train already passed ----

export function alreadyArrivedReply({ trainNum, line, toStation, arrivedAt, sender, incomingMsgid, ourMsgid }) {
  return reply({
    fromLocal: trainNum || 'help',
    subject: `${line || trainNum} already arrived`,
    to: sender,
    inReplyTo: incomingMsgid,
    msgid: ourMsgid,
    body:
      `${line || trainNum} arrived at ${toStation} at ${fmtTime(arrivedAt)} today. Nothing left to track.\n\n` +
      `If this is for tomorrow's ${trainNum}, resend after midnight (train numbers are per-day, not unique across days).`,
  });
}

// ---- abuse limits ----

function fmtDateTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toISOString().replace(/^(.+T\d{2}:\d{2}).+$/, '$1Z');
}

export function rateLimitedReply({ reason, retryAt, sender, incomingMsgid, ourMsgid }) {
  const window = reason === 'hourly' ? 'in the last hour' : 'in the last 24 hours';
  return reply({
    fromLocal: 'help',
    subject: `Too many tracking requests`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body:
      `You've sent too many fresh tracking requests ${window}.\n` +
      `Try again after ${fmtDateTime(retryAt)}.\n\n` +
      `Already-tracked trains keep updating — this only blocks new ones.`,
  });
}

export function tooManyActiveReply({ count, max, sender, incomingMsgid, ourMsgid }) {
  return reply({
    fromLocal: 'stop',
    subject: `Too many active trains`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body:
      `You're already tracking ${count} trains, which is the per-sender limit (${max}).\n\n` +
      `Reply STOP <TRAINNUM> on any of them, or STOP ALL to clear everything, then resend this request.`,
  });
}

// ---- §7: unauthorized sender (system-internal note; rarely sent) ----

export function unauthorizedSenderReply({ sender, incomingMsgid, ourMsgid }) {
  return reply({
    fromLocal: 'help',
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
    const list = (trains || []).map(t => `  - ${t.line || t.trainNum}${t.from && t.to ? ` (${t.from} → ${t.to})` : ''}`).join('\n');
    return reply({
      fromLocal: 'stop',
      subject: `Stopped all tracking`,
      to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
      body: `Cleared ${count} active train${count === 1 ? '' : 's'}:\n${list || '  (none)'}\n\nNo more updates until you start fresh.`,
    });
  }
  if (scope === 'trip') {
    const list = (trains || []).map(t => `  - ${t.line || t.trainNum}${t.from && t.to ? ` (${t.from} → ${t.to})` : ''}`).join('\n');
    return reply({
      fromLocal: 'stop',
      subject: `Stopped trip "${target}"`,
      to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
      body: `Cleared ${count} train${count === 1 ? '' : 's'} from trip "${target}":\n${list || '  (none)'}`,
    });
  }
  // single
  return reply({
    fromLocal: 'stop',
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
    fromLocal: 'config',
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
export function pushReply({ event, line, trainNum, trip, scheduledIso, sender, confirmationMsgid, ourMsgid }) {
  const baseTitle = event.title || `${line || trainNum} update`;
  const { prefix, suffix } = subjectTags({ trip: trip || event.trip, scheduledIso });
  const subject = `${baseTitle}${prefix}${suffix}`;
  const baseBody = event.body || event.title || `${line || trainNum} update`;
  const stopBlock = stopLinks(trainNum, trip || event.trip);
  return reply({
    fromLocal: trainNum || 'help',
    subject,
    to: sender,
    inReplyTo: confirmationMsgid,
    references: confirmationMsgid,
    msgid: ourMsgid,
    body: stopBlock ? `${baseBody}\n\n${stopBlock}` : baseBody,
  });
}

// ---- Helper for non-confirmation system errors that don't have a clean
//      template (e.g., generic resolver failures we want to surface) ----

export function genericErrorReply({ trainNum, code, message, sender, incomingMsgid, ourMsgid }) {
  return reply({
    fromLocal: trainNum && trainNum !== '(unknown)' ? trainNum : 'help',
    subject: `Couldn't track ${trainNum}`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body:
      `Got your request for ${trainNum}, but ran into a problem: ${message}\n\n` +
      `(Internal code: ${code})`,
  });
}

// ---- §list: active trains for sender ----

export function listReply({ trains, sender, incomingMsgid, ourMsgid }) {
  let body;
  if (!trains || trains.length === 0) {
    body = `No trains currently being tracked.\n\nSend a new request: <trainnum>@${DOMAIN}`;
  } else {
    const count = trains.length;
    const lines = trains.map(t => {
      const dep = t.scheduledDeparture ? fmtDatetime(t.scheduledDeparture) : '?';
      const stop = stopLinks(t.trainNum);
      return `${t.line || t.trainNum} — ${t.from || '?'} → ${t.to || '?'}\n  Dep ${dep}\n  ${stop}`;
    });
    body = `${count} train${count === 1 ? '' : 's'} currently tracked:\n\n${lines.join('\n\n')}`;
  }
  return reply({
    fromLocal: 'list',
    subject: `Your active trains`,
    to: sender, inReplyTo: incomingMsgid, msgid: ourMsgid,
    body,
  });
}
