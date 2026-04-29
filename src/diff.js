// Pure diff: (prev: Snapshot|null, curr: Snapshot, opts?) → PushEvent[]
//
// Implements PRD §9 diff table + the unified notification taxonomy.
// No I/O, no time, no state. Tests exercise this directly.
//
// Snapshot shape (built by poll.js from hafas-client trip data):
//   {
//     pollTimestamp,
//     trainNum, line, mode: 'A'|'B',
//     cancelled, replaced,
//     hasDeparted, hasArrived,
//     scheduledDeparture, predictedDeparture, departureDelayMin,
//     departurePlatform, departurePlatformScheduled,
//     scheduledArrival, predictedArrival, arrivalDelayMin,
//     arrivalPlatform, arrivalPlatformScheduled,
//     fromName, toName,
//     stopoversCancelled: { [stopName]: true } // for terminating-short detection
//   }
//
// PushEvent shape:
//   { type, priority: 'urgent'|'high'|'default', title, body, tags? }

const DEFAULT_OPTS = {
  delayPreAnchorMin: 2,
  delayInTransitMin: 5,
};

function fmtTime(iso) {
  if (!iso) return '?';
  return new Date(iso).toISOString().replace(/^.+T(\d{2}:\d{2}).+$/, '$1');
}
function plat(p) { return p ?? '–'; }
function delay(d) { return `+${d ?? 0}min`; }

function startedBody(curr) {
  const lines = [
    `${curr.fromName ?? '?'} → ${curr.toName ?? '?'}`,
    `Scheduled: dep ${fmtTime(curr.scheduledDeparture)}, arr ${fmtTime(curr.scheduledArrival)}`,
  ];
  if (curr.departurePlatform) lines.push(`Departure platform: ${curr.departurePlatform}`);
  if (curr.arrivalPlatform)   lines.push(`Arrival platform: ${curr.arrivalPlatform}`);
  if (curr.departureDelayMin) lines.push(`Currently +${curr.departureDelayMin}min`);
  return lines.join('\n');
}

export function diff(prev, curr, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const events = [];

  // ---- Window 1: tracking start (T-30 mandatory push). ----
  if (!prev) {
    events.push({
      type: 'tracking_started',
      priority: 'default',
      title: `Tracking ${curr.line || curr.trainNum}`,
      body: startedBody(curr),
    });
    return events;
  }

  // ---- Cancellation / replacement: short-circuit, single loud message. ----
  if (!prev.cancelled && curr.cancelled) {
    events.push({
      type: 'cancelled',
      priority: 'urgent',
      title: `${curr.line || curr.trainNum} CANCELLED`,
      body: `${curr.line || curr.trainNum} (${curr.fromName ?? '?'} → ${curr.toName ?? '?'}) is cancelled.`,
    });
    return events;
  }
  if (!prev.replaced && curr.replaced) {
    events.push({
      type: 'replaced',
      priority: 'urgent',
      title: `${curr.line || curr.trainNum} replacement service`,
      body: `${curr.line || curr.trainNum} replaced — check operator app for the substitute service.`,
    });
  }

  // ---- Anchor platform (dep for Mode B, arr for Mode A). ----
  const anchorIsArr = curr.mode === 'A';
  const prevAnchorPlat = anchorIsArr ? prev.arrivalPlatform : prev.departurePlatform;
  const currAnchorPlat = anchorIsArr ? curr.arrivalPlatform : curr.departurePlatform;
  const anchorStation = anchorIsArr ? curr.toName : curr.fromName;

  if (!prevAnchorPlat && currAnchorPlat) {
    events.push({
      type: 'platform_assigned',
      priority: 'urgent',
      title: `${curr.line || curr.trainNum} → Platform ${currAnchorPlat}`,
      body: `${anchorIsArr ? 'Arrival' : 'Departure'} platform ${currAnchorPlat} at ${anchorStation ?? '?'}.`,
    });
  } else if (prevAnchorPlat && currAnchorPlat && prevAnchorPlat !== currAnchorPlat) {
    events.push({
      type: 'platform_changed',
      priority: 'urgent',
      title: `${curr.line || curr.trainNum} platform CHANGED → ${currAnchorPlat}`,
      body: `Was ${prevAnchorPlat}, now ${currAnchorPlat} at ${anchorStation ?? '?'}.`,
    });
  }

  // ---- Anchor delay (threshold tightens pre-anchor, loosens in-transit). ----
  const inTransit = !!curr.hasDeparted && !curr.hasArrived;
  const delayThreshold = inTransit ? cfg.delayInTransitMin : cfg.delayPreAnchorMin;
  const prevAnchorDelay = (anchorIsArr ? prev.arrivalDelayMin : prev.departureDelayMin) ?? 0;
  const currAnchorDelay = (anchorIsArr ? curr.arrivalDelayMin : curr.departureDelayMin) ?? 0;
  if (Math.abs(currAnchorDelay - prevAnchorDelay) >= delayThreshold) {
    events.push({
      type: 'delay_change',
      priority: 'high',
      title: `${curr.line || curr.trainNum} ${delay(currAnchorDelay)}`,
      body: `${anchorIsArr ? 'Arrival' : 'Departure'} delay at ${anchorStation ?? '?'}: was ${delay(prevAnchorDelay)}, now ${delay(currAnchorDelay)}.`,
    });
  }

  // ---- Mode B post-departure: arrival platform + arrival delay propagation. ----
  if (curr.mode === 'B' && curr.hasDeparted) {
    if (!prev.arrivalPlatform && curr.arrivalPlatform) {
      events.push({
        type: 'arrival_platform_assigned',
        priority: 'urgent',
        title: `${curr.line || curr.trainNum} → arrival Platform ${curr.arrivalPlatform}`,
        body: `Arrival platform ${curr.arrivalPlatform} at ${curr.toName ?? '?'}.`,
      });
    } else if (prev.arrivalPlatform && curr.arrivalPlatform && prev.arrivalPlatform !== curr.arrivalPlatform) {
      events.push({
        type: 'arrival_platform_changed',
        priority: 'urgent',
        title: `${curr.line || curr.trainNum} arrival platform CHANGED → ${curr.arrivalPlatform}`,
        body: `Was ${prev.arrivalPlatform}, now ${curr.arrivalPlatform} at ${curr.toName ?? '?'}.`,
      });
    }
    const prevArrDelay = prev.arrivalDelayMin ?? 0;
    const currArrDelay = curr.arrivalDelayMin ?? 0;
    if (Math.abs(currArrDelay - prevArrDelay) >= cfg.delayInTransitMin) {
      events.push({
        type: 'arrival_delay_change',
        priority: 'high',
        title: `${curr.line || curr.trainNum} arrival ${delay(currArrDelay)}`,
        body: `${curr.toName ?? '?'} arrival now ${delay(currArrDelay)} (was ${delay(prevArrDelay)}).`,
      });
    }
  }

  // ---- Terminating short: user's destination stop is now cancelled. ----
  const prevToCancelled = !!prev.stopoversCancelled?.[curr.toName];
  const currToCancelled = !!curr.stopoversCancelled?.[curr.toName];
  if (curr.toName && !prevToCancelled && currToCancelled) {
    events.push({
      type: 'terminating_short',
      priority: 'urgent',
      title: `${curr.line || curr.trainNum} TERMINATING before ${curr.toName}`,
      body: `Train will not reach ${curr.toName}. Check operator app for onward connection.`,
    });
  }

  // ---- Departed (Mode B only — Mode A users don't care about the departure). ----
  if (curr.mode === 'B' && !prev.hasDeparted && curr.hasDeparted) {
    events.push({
      type: 'departed',
      priority: 'default',
      title: `${curr.line || curr.trainNum} departed ${curr.fromName ?? '?'}`,
      body: `Left at ~${fmtTime(curr.predictedDeparture)}, ${delay(curr.departureDelayMin)}.`,
    });
  }

  // ---- Arrived (terminal). ----
  if (!prev.hasArrived && curr.hasArrived) {
    events.push({
      type: 'arrived',
      priority: 'default',
      title: `${curr.line || curr.trainNum} arrived ${curr.toName ?? '?'}`,
      body: `Arrived ~${fmtTime(curr.predictedArrival)}, platform ${plat(curr.arrivalPlatform)}. Tracking ended.`,
    });
  }

  return events;
}
