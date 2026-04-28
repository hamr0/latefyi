// POC tracker: live-watch a single train end-to-end.
// Hardcoded for ICE 145 Amsterdam Centraal → Berlin Ostbahnhof.
// Polls every 60s, snapshots state, diffs vs previous, logs events to JSONL.
// Exits on arrival, cancellation, or +30min past scheduled arrival with no data.
//
// Run: node track.js > track.log 2>&1 &
//
// Outputs:
//   logs/snapshots.jsonl  — every poll's snapshot
//   logs/events.jsonl     — diff-derived push events (would-be notifications)

import { createClient } from 'hafas-client';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const SNAP_LOG = join(LOG_DIR, 'snapshots.jsonl');
const EVT_LOG  = join(LOG_DIR, 'events.jsonl');

const POLL_INTERVAL_MS = 60_000;
const TARGET = {
  trainNum: '145',
  lineRegex: /^ICE/i,
  fromName: 'Amsterdam Centraal',
  toName:   'Berlin Ostbahnhof',
};

const mod = await import('hafas-client/p/oebb/index.js');
const client = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');

function log(line) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${line}`);
}
function appendJsonl(path, obj) {
  appendFileSync(path, JSON.stringify(obj) + '\n');
}

// --- 1. Resolve ICE 145 on Amsterdam Centraal's board ---
log(`Resolving ${TARGET.lineRegex} ${TARGET.trainNum} from "${TARGET.fromName}"...`);
const fromLocs = await client.locations(TARGET.fromName, { results: 1 });
if (!fromLocs?.length) { log('FATAL: origin station not found'); process.exit(1); }
const fromStation = fromLocs[0];
log(`Origin: ${fromStation.name} (${fromStation.id})`);

const board = await client.departures(fromStation.id, { duration: 18*60, results: 800 });
const list = Array.isArray(board) ? board : board?.departures || [];
const match = list.find(d =>
  TARGET.lineRegex.test(d.line?.name || '') &&
  (d.line?.fahrtNr || '').toString() === TARGET.trainNum
);
if (!match) { log(`FATAL: no ICE ${TARGET.trainNum} on board today`); process.exit(1); }
const tripId = match.tripId;
log(`Resolved: ${match.line.name} → ${match.direction}, dep ${match.plannedWhen} from platform ${match.plannedPlatform}, tripId=${tripId.slice(0,40)}...`);

// --- 2. Snapshot construction ---
async function snapshot() {
  let trip;
  try {
    trip = await client.trip(tripId);
  } catch (e) {
    return { error: e.message.split('\n')[0], pollTimestamp: new Date().toISOString() };
  }
  // hafas-client returns either { trip } or trip directly depending on version
  const t = trip.trip || trip;
  const stops = t.stopovers || [];
  const fromStop = stops.find(s => s.stop?.name === TARGET.fromName) || stops[0];
  const toStop   = stops.find(s => s.stop?.name === TARGET.toName)   || stops[stops.length-1];
  const cancelled = !!t.cancelled || !!fromStop?.cancelled;

  const now = Date.now();
  const predictedDep = fromStop?.departure || null;
  const predictedArr = toStop?.arrival || null;
  // "Has happened" = predicted timestamp is in the past. Imperfect (HAFAS keeps
  // updating predictions past actual events for a window) but adequate for POC.
  const hasDeparted = !!predictedDep && new Date(predictedDep).getTime() <= now;
  const hasArrived  = !!predictedArr && new Date(predictedArr).getTime() <= now;

  return {
    pollTimestamp: new Date().toISOString(),
    trainId: TARGET.trainNum,
    line: t.line?.name,
    cancelled,
    scheduledDeparture: fromStop?.plannedDeparture || null,
    predictedDeparture: predictedDep,
    hasDeparted,
    departureDelayMin:  fromStop?.departureDelay != null ? Math.round(fromStop.departureDelay / 60) : null,
    departurePlatform:         fromStop?.departurePlatform ?? fromStop?.platform ?? null,
    departurePlatformScheduled: fromStop?.plannedDeparturePlatform ?? null,
    scheduledArrival:   toStop?.plannedArrival || null,
    predictedArrival:   predictedArr,
    hasArrived,
    arrivalDelayMin:    toStop?.arrivalDelay != null ? Math.round(toStop.arrivalDelay / 60) : null,
    arrivalPlatform:           toStop?.arrivalPlatform ?? toStop?.platform ?? null,
    arrivalPlatformScheduled:  toStop?.plannedArrivalPlatform ?? null,
    route: stops.map(s => ({
      station: s.stop?.name,
      scheduledArr: s.plannedArrival,
      actualArr:    s.arrival,
      arrDelayMin:  s.arrivalDelay != null ? Math.round(s.arrivalDelay / 60) : null,
      scheduledDep: s.plannedDeparture,
      actualDep:    s.departure,
      depDelayMin:  s.departureDelay != null ? Math.round(s.departureDelay / 60) : null,
      platform:     s.departurePlatform ?? s.arrivalPlatform ?? s.platform ?? null,
      cancelled:    !!s.cancelled,
    })),
  };
}

// --- 3. Diff logic (mirrors PRD §9) ---
function diff(prev, curr) {
  if (!prev) {
    return [{ type: 'tracking_started', priority: 'default',
              title: `Tracking ${curr.line}`,
              body:  `${TARGET.fromName} → ${TARGET.toName}, scheduled dep ${curr.scheduledDeparture}, plat ${curr.departurePlatform ?? 'TBD'}` }];
  }
  const events = [];

  // Cancellation
  if (!prev.cancelled && curr.cancelled) {
    events.push({ type: 'cancelled', priority: 'urgent',
                  title: `${curr.line} CANCELLED`,
                  body:  `Service from ${TARGET.fromName} cancelled.` });
  }

  // Departure platform: null → value
  if (!prev.departurePlatform && curr.departurePlatform) {
    events.push({ type: 'platform_assigned', priority: 'urgent',
                  title: `${curr.line} → Platform ${curr.departurePlatform}`,
                  body:  `Departure platform ${curr.departurePlatform} at ${TARGET.fromName}.` });
  }
  // Departure platform change
  if (prev.departurePlatform && curr.departurePlatform && prev.departurePlatform !== curr.departurePlatform) {
    events.push({ type: 'platform_changed', priority: 'urgent',
                  title: `${curr.line} platform CHANGED → ${curr.departurePlatform}`,
                  body:  `Was ${prev.departurePlatform}, now ${curr.departurePlatform} at ${TARGET.fromName}.` });
  }

  // Departure delay change (≥2 min pre-departure, ≥5 in-transit per PRD §9)
  const threshold = curr.hasDeparted ? 5 : 2;
  const dPrev = prev.departureDelayMin ?? 0;
  const dCurr = curr.departureDelayMin ?? 0;
  if (Math.abs(dCurr - dPrev) >= threshold) {
    events.push({ type: 'delay_change', priority: 'high',
                  title: `${curr.line} ${dCurr >= 0 ? 'delayed' : 'earlier'} ${dCurr}min`,
                  body:  `Was +${dPrev}min, now +${dCurr}min at ${TARGET.fromName}.` });
  }

  // Arrival platform changes (Berlin)
  if (!prev.arrivalPlatform && curr.arrivalPlatform) {
    events.push({ type: 'arrival_platform_assigned', priority: 'urgent',
                  title: `${curr.line} → arrival Platform ${curr.arrivalPlatform}`,
                  body:  `Arrival platform ${curr.arrivalPlatform} at ${TARGET.toName}.` });
  }
  if (prev.arrivalPlatform && curr.arrivalPlatform && prev.arrivalPlatform !== curr.arrivalPlatform) {
    events.push({ type: 'arrival_platform_changed', priority: 'urgent',
                  title: `${curr.line} arrival platform CHANGED → ${curr.arrivalPlatform}`,
                  body:  `Was ${prev.arrivalPlatform}, now ${curr.arrivalPlatform} at ${TARGET.toName}.` });
  }

  // Arrival delay change ≥5 min
  const aPrev = prev.arrivalDelayMin ?? 0;
  const aCurr = curr.arrivalDelayMin ?? 0;
  if (Math.abs(aCurr - aPrev) >= 5) {
    events.push({ type: 'arrival_delay_change', priority: 'high',
                  title: `${curr.line} arrival delay ${aCurr}min`,
                  body:  `${TARGET.toName} arrival now +${aCurr}min (was +${aPrev}min).` });
  }

  // Arrived (transition from not-yet to past predicted arrival)
  if (!prev.hasArrived && curr.hasArrived) {
    events.push({ type: 'arrived', priority: 'default',
                  title: `${curr.line} arrived ${TARGET.toName}`,
                  body:  `Arrived ~${curr.predictedArrival}, platform ${curr.arrivalPlatform ?? '?'}. End of tracking.` });
  }
  // Departed (transition crossing scheduled/predicted departure time)
  if (!prev.hasDeparted && curr.hasDeparted) {
    events.push({ type: 'departed', priority: 'default',
                  title: `${curr.line} departed ${TARGET.fromName}`,
                  body:  `Left at ~${curr.predictedDeparture}, +${curr.departureDelayMin ?? 0}min.` });
  }

  return events;
}

function isTerminal(snap) {
  if (snap.error) return false;
  if (snap.cancelled) return true;
  if (snap.hasArrived) {
    // Stay alive for a few minutes past arrival to capture the final delay/platform state.
    const arrivedAt = new Date(snap.predictedArrival).getTime();
    if (Date.now() > arrivedAt + 5*60*1000) return true;
  }
  if (snap.scheduledArrival) {
    const cutoff = new Date(snap.scheduledArrival).getTime() + 30*60*1000;
    if (Date.now() > cutoff && !snap.hasArrived) return true; // grace expired
  }
  return false;
}

// --- 4. Loop ---
let prev = null;
let pollIdx = 0;
let consecutiveErrors = 0;

log('Tracking loop started. Snapshots → snapshots.jsonl, events → events.jsonl');
log(`Poll interval: ${POLL_INTERVAL_MS/1000}s`);

while (true) {
  pollIdx++;
  const snap = await snapshot();
  appendJsonl(SNAP_LOG, { idx: pollIdx, ...snap });

  if (snap.error) {
    consecutiveErrors++;
    log(`poll #${pollIdx} ERROR (${consecutiveErrors} consecutive): ${snap.error}`);
    if (consecutiveErrors >= 6) {
      const evt = { pollTimestamp: snap.pollTimestamp, type: 'tracking_lost', priority: 'urgent',
                    title: `Lost tracking for ICE ${TARGET.trainNum}`, body: `6 consecutive poll failures. Last error: ${snap.error}` };
      appendJsonl(EVT_LOG, evt);
      log(`EVENT urgent: tracking_lost — ${snap.error}`);
      break;
    }
  } else {
    consecutiveErrors = 0;
    const events = diff(prev, snap);
    for (const e of events) {
      const evt = { pollTimestamp: snap.pollTimestamp, ...e };
      appendJsonl(EVT_LOG, evt);
      log(`EVENT ${e.priority}: ${e.type} — ${e.title}`);
      log(`        body: ${e.body}`);
    }
    if (events.length === 0) {
      const platSrc = snap.departurePlatform ?? '–';
      const dly = snap.departureDelayMin ?? 0;
      log(`poll #${pollIdx} unchanged: dep=${snap.scheduledDeparture}, plat=${platSrc}, depDelay=+${dly}min, arrPlat=${snap.arrivalPlatform ?? '–'}`);
    }
    prev = snap;
    if (isTerminal(snap)) {
      log(snap.cancelled ? 'Train cancelled. Stopping.' : (snap.actualArrival ? 'Arrived. Stopping.' : 'Past arrival grace window with no data. Stopping.'));
      break;
    }
  }

  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
}

log('Done.');
