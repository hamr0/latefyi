// Single-train poll cycle: fetch trip, build snapshot, diff, return updated record + events.
//
// Pure of I/O. The hafas-client is dependency-injected. The poll-runner
// (separate module) reads/writes files; this module just decides what to do.
//
// PRD §13.5 (this module).

import { diff } from './diff.js';

// ---- snapshot construction ----

function timeMs(iso) { return iso ? new Date(iso).getTime() : null; }

// Build a TrainState snapshot from a hafas-client trip + the user's request context.
// Mirrors the shape diff.js expects.
export function buildSnapshot(trip, context, now = Date.now()) {
  const t = trip?.trip || trip || {};
  const stops = t.stopovers || [];
  const fromStop = context.fromName ? stops.find(s => s?.stop?.name === context.fromName) : stops[0];
  const toStop   = context.toName   ? stops.find(s => s?.stop?.name === context.toName)   : stops[stops.length - 1];

  const predictedDep = fromStop?.departure || null;
  const predictedArr = toStop?.arrival || null;
  const hasDeparted = !!predictedDep && timeMs(predictedDep) <= now;
  const hasArrived  = !!predictedArr && timeMs(predictedArr) <= now;

  // Cancellation: trip-level OR any stop-level on either anchor.
  const cancelled = !!t.cancelled || !!fromStop?.cancelled || !!toStop?.cancelled;
  const replaced = !!t.replaced;

  // Map of stopover name → cancelled flag, for terminating-short detection.
  const stopoversCancelled = {};
  for (const s of stops) {
    if (s?.stop?.name && s.cancelled) stopoversCancelled[s.stop.name] = true;
  }

  return {
    pollTimestamp: new Date(now).toISOString(),
    trainNum: context.trainNum,
    line: t.line?.name || context.line || null,
    mode: context.mode,
    cancelled, replaced,
    hasDeparted, hasArrived,
    scheduledDeparture: fromStop?.plannedDeparture || null,
    predictedDeparture: predictedDep,
    departureDelayMin:  fromStop?.departureDelay != null ? Math.round(fromStop.departureDelay / 60) : null,
    departurePlatform:         fromStop?.departurePlatform ?? fromStop?.platform ?? null,
    departurePlatformScheduled: fromStop?.plannedDeparturePlatform ?? null,
    scheduledArrival:   toStop?.plannedArrival || null,
    predictedArrival:   predictedArr,
    arrivalDelayMin:    toStop?.arrivalDelay != null ? Math.round(toStop.arrivalDelay / 60) : null,
    arrivalPlatform:           toStop?.arrivalPlatform ?? toStop?.platform ?? null,
    arrivalPlatformScheduled:  toStop?.plannedArrivalPlatform ?? null,
    fromName: context.fromName ?? fromStop?.stop?.name ?? null,
    toName:   context.toName   ?? toStop?.stop?.name   ?? null,
    stopoversCancelled,
  };
}

// ---- phase computation (for poll cadence and terminal detection) ----

export function computePhase(record, now = Date.now()) {
  const last = record.state?.lastPushedSnapshot;
  if (last?.cancelled) return 'terminal';
  if (last?.hasArrived) return 'terminal';
  if (last?.hasDeparted && record.request.mode === 'B') return 'in_transit';

  // T-5 to actual arrival → arrival window
  const schedArr = last?.scheduledArrival || record.resolved?.scheduledArrivalAtTo;
  if (schedArr && timeMs(schedArr) - now <= 5 * 60 * 1000 && !last?.hasArrived) {
    return 'arrival_window';
  }
  return 'pre_anchor';
}

const POLL_INTERVAL_MS = {
  pre_anchor: 30_000,
  in_transit: 60_000,
  arrival_window: 30_000,
  terminal: Infinity,
};

export function pollIntervalMs(record, now = Date.now()) {
  return POLL_INTERVAL_MS[computePhase(record, now)] ?? 30_000;
}

export function shouldPollNow(record, now = Date.now()) {
  const lastAt = record.state?.lastPolledAt ? timeMs(record.state.lastPolledAt) : 0;
  if (computePhase(record, now) === 'terminal') return false;
  return now - lastAt >= pollIntervalMs(record, now);
}

export function isTerminal(record, now = Date.now()) {
  const last = record.state?.lastPushedSnapshot;
  if (last?.cancelled) return true;
  if (last?.hasArrived) {
    // Linger 5 min past predicted arrival to capture final platform/delay state.
    const arrAt = timeMs(last.predictedArrival);
    if (arrAt && now - arrAt > 5 * 60 * 1000) return true;
  }
  // Past poll_end_time grace
  const endAt = timeMs(record.schedule?.poll_end_time);
  if (endAt && now > endAt) return true;
  return false;
}

// ---- main poll cycle ----

const MAX_CONSECUTIVE_FAILURES = 6;

export async function poll({ activeRecord, client, now = Date.now() }) {
  const tripId = activeRecord.resolved.tripId;
  let trip;
  try {
    trip = await client.trip(tripId);
  } catch (e) {
    const failures = (activeRecord.state.consecutivePollFailures || 0) + 1;
    const updatedRecord = {
      ...activeRecord,
      state: {
        ...activeRecord.state,
        lastPolledAt: new Date(now).toISOString(),
        consecutivePollFailures: failures,
      },
    };
    const events = [];
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      events.push({
        type: 'tracking_lost',
        priority: 'urgent',
        title: `Lost tracking for ${activeRecord.resolved.line || activeRecord.request.trainNum}`,
        body: `${MAX_CONSECUTIVE_FAILURES} consecutive poll failures. Last error: ${e.message}`,
      });
    }
    return { snapshot: null, events, updatedRecord, error: e.message };
  }

  const ctx = {
    trainNum: activeRecord.request.trainNum,
    mode: activeRecord.request.mode,
    fromName: activeRecord.resolved.from,
    toName: activeRecord.resolved.to,
    line: activeRecord.resolved.line,
  };
  const snap = buildSnapshot(trip, ctx, now);
  const events = diff(activeRecord.state.lastPushedSnapshot, snap);

  // Only update lastPushedSnapshot when we actually emit events — otherwise
  // the threshold debounce should compare the next poll against the same
  // baseline, not a sub-threshold drift snapshot.
  const lastPushedSnapshot = events.length ? snap : activeRecord.state.lastPushedSnapshot;

  const updatedRecord = {
    ...activeRecord,
    state: {
      ...activeRecord.state,
      lastPolledAt: new Date(now).toISOString(),
      lastPushedSnapshot,
      consecutivePollFailures: 0,
      phase: computePhase({ ...activeRecord, state: { ...activeRecord.state, lastPushedSnapshot: snap } }, now),
    },
    pushes: [
      ...(activeRecord.pushes || []),
      ...events.map(e => ({ at: snap.pollTimestamp, ...e })),
    ],
  };
  return { snapshot: snap, events, updatedRecord };
}
