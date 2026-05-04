// Renders a representative sample of every outbound email template
// late.fyi can produce. Used to (re)generate docs/email-formats.md.
//
//   node scripts/dump-email-samples.js > /tmp/samples.txt
//
// Pure offline call into reply.js + diff.js with synthetic data — no
// network, no state. Re-run after touching any template to refresh
// the doc.

import * as R from '../src/reply.js';
import { diff } from '../src/diff.js';
import { pushReply } from '../src/reply.js';

const sender = 'you@example.com';
const incomingMsgid = '<incoming-1@example.com>';
const trainNum = 'EUR9340';
const line = 'EUR 9340';
const fromName = 'Amsterdam Centraal';
const toName = 'Paris Nord';

const resolved = {
  endpoint: 'oebb',
  tripId: '2|...',
  line,
  from: fromName,
  to: toName,
  schedule: {
    scheduledDeparture: '2026-05-04T11:10:00+02:00',
    scheduledArrival:   '2026-05-04T14:42:00+02:00',
  },
  mode: 'B',
  departurePlatform: '15a',
  arrivalPlatform: null,
};

const baseSnap = {
  trainNum, line, mode: 'B',
  cancelled: false, replaced: false, hasDeparted: false, hasArrived: false,
  scheduledDeparture: '2026-05-04T11:10:00+02:00',
  predictedDeparture: '2026-05-04T11:10:00+02:00',
  departureDelayMin: 0,
  departurePlatform: '15a', departurePlatformScheduled: '15a',
  scheduledArrival: '2026-05-04T14:42:00+02:00',
  predictedArrival: '2026-05-04T14:42:00+02:00',
  arrivalDelayMin: 0,
  arrivalPlatform: null,
  fromName, toName,
  stopoversCancelled: {},
};

function show(label, msg) {
  console.log(`\n### ${label}\n`);
  console.log(`**From:** ${msg.from}`);
  console.log(`**To:** ${msg.to}`);
  console.log(`**Subject:** ${msg.subject}`);
  console.log('```');
  console.log(msg.body);
  console.log('```');
}

function showPush(label, event) {
  const msg = pushReply({
    event, line, trainNum, trip: null,
    scheduledIso: baseSnap.scheduledDeparture,
    sender, confirmationMsgid: '<confirm-1@late.fyi>',
  });
  show(label, msg);
}

// ===== Reply templates =====

show('confirmation (happy path)',
  R.confirmationReply({ resolved, sender, incomingMsgid, trainNum }));

show('missing context (train number invalid / no from-to)',
  R.missingContextReply({ trainNum, sender, incomingMsgid }));

show('train not found',
  R.trainNotFoundReply({ trainNum, sender, incomingMsgid, onDate: '2026-05-04' }));

show('station not on route',
  R.stationNotOnRouteReply({
    trainNum, line, station: 'Lyon', route: ['Amsterdam', 'Brussels', 'Paris'],
    suggestion: 'Brussels', sender, incomingMsgid,
  }));

show('ambiguous station (disambiguation)',
  R.ambiguousStationReply({
    trainNum, line, station: 'paris',
    candidates: ['Paris Nord', 'Paris Est'],
    sender, incomingMsgid,
  }));

show('already arrived',
  R.alreadyArrivedReply({
    trainNum, line, toStation: toName,
    arrivedAt: '2026-05-04T14:42:00+02:00',
    sender, incomingMsgid,
  }));

show('rate-limited',
  R.rateLimitedReply({
    reason: 'hourly',
    retryAt: '2026-05-04T12:00:00+02:00',
    sender, incomingMsgid,
  }));

show('too many active trips',
  R.tooManyActiveReply({ count: 20, max: 20, sender, incomingMsgid }));

show('unauthorized sender (only when allowlist non-empty)',
  R.unauthorizedSenderReply({ sender, incomingMsgid }));

show('disposable inbox (only when BLOCK_DISPOSABLE=true)',
  R.disposableSenderReply({ sender: 'throwaway@mailinator.com', incomingMsgid }));

show('STOP confirmation (single train)',
  R.stopReply({
    scope: 'single', target: 'EUR9340',
    count: 1,
    trains: [{ trainNum: 'EUR9340', line: 'EUR 9340', from: 'Amsterdam', to: 'Paris', scheduledDeparture: '2026-05-04T11:10:00+02:00' }],
    sender, incomingMsgid,
  }));

show('STOP confirmation (ALL)',
  R.stopReply({
    scope: 'all', target: null,
    count: 2,
    trains: [
      { trainNum: 'EUR9340', line: 'EUR 9340', from: 'Amsterdam', to: 'Paris', scheduledDeparture: '2026-05-04T11:10:00+02:00' },
      { trainNum: 'ICE145',  line: 'ICE 145',  from: 'Amsterdam', to: 'Berlin', scheduledDeparture: '2026-05-05T08:00:00+02:00' },
    ],
    sender, incomingMsgid,
  }));

show('ntfy opt-in (after CHANNELS=ntfy)',
  R.ntfyOptInReply({ topic: 'latefyi-abc123', sender, incomingMsgid }));

show('generic error (resolver fallback)',
  R.genericErrorReply({
    trainNum, code: 'resolve_failed',
    message: 'HAFAS endpoint timed out twice',
    sender, incomingMsgid,
  }));

show('list active trains',
  R.listReply({
    trains: [
      { trainNum: 'EUR9340', line: 'EUR 9340', from: 'Amsterdam', to: 'Paris', scheduledDeparture: '2026-05-04T11:10:00+02:00' },
      { trainNum: 'ICE145',  line: 'ICE 145',  from: 'Amsterdam', to: 'Berlin', scheduledDeparture: '2026-05-05T08:00:00+02:00' },
    ],
    sender, incomingMsgid,
  }));

show('list (empty)',
  R.listReply({ trains: [], sender, incomingMsgid }));

// ===== Push events (each wrapped via pushReply) =====

console.log('\n## Push notifications (poll-runner → user)\n');
console.log('Each push notification is built by `diff.js` (event title+body) and wrapped by `pushReply()` in `reply.js` (From, threading headers, mailto links, footer).\n');

// tracking_started: prev=null
for (const e of diff(null, baseSnap)) showPush('tracking_started (T-30)', e);

// platform_changed
const prevPlat = baseSnap;
const currPlat = { ...baseSnap, departurePlatform: '16b' };
for (const e of diff(prevPlat, currPlat)) showPush(`${e.type}`, e);

// delay_change (anchor)
const currDelay = { ...baseSnap, departureDelayMin: 5, predictedDeparture: '2026-05-04T11:15:00+02:00' };
for (const e of diff(baseSnap, currDelay)) showPush(`${e.type}`, e);

// arrival_platform_assigned (post-departure mode B)
const departedSnap = { ...baseSnap, hasDeparted: true };
const currArrPlat = { ...departedSnap, arrivalPlatform: '7' };
for (const e of diff(departedSnap, currArrPlat)) showPush(`${e.type}`, e);

// arrival_delay_change (post-departure)
const currArrDelay = { ...departedSnap, arrivalDelayMin: 8, predictedArrival: '2026-05-04T14:50:00+02:00' };
for (const e of diff(departedSnap, currArrDelay)) showPush(`${e.type}`, e);

// cancelled
const currCancelled = { ...baseSnap, cancelled: true };
for (const e of diff(baseSnap, currCancelled)) showPush(`${e.type}`, e);

// replaced
const currReplaced = { ...baseSnap, replaced: true };
for (const e of diff(baseSnap, currReplaced)) showPush(`${e.type}`, e);

// terminating_short
const currTermShort = { ...baseSnap, stopoversCancelled: { [toName]: true } };
for (const e of diff(baseSnap, currTermShort)) showPush(`${e.type}`, e);

// departed
const justDeparted = { ...baseSnap, hasDeparted: true };
for (const e of diff(baseSnap, justDeparted)) showPush(`${e.type}`, e);

// arrived (terminal)
const arrivedSnap = { ...baseSnap, hasDeparted: true, hasArrived: true };
for (const e of diff(departedSnap, arrivedSnap)) showPush(`${e.type}`, e);

// tracking_lost (synthesized — produced by poll.js after MAX_CONSECUTIVE_FAILURES)
showPush('tracking_lost (synthetic — produced by poll.js, not diff.js)', {
  type: 'tracking_lost',
  priority: 'urgent',
  title: `Lost tracking for ${line}`,
  body: `${line}, ${fromName} → ${toName}.\n6 consecutive poll failures. Last error: HAFAS 502 Bad Gateway`,
});
