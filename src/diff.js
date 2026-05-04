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

import { fmtTime, fmtDatetime } from './time-fmt.js';

const DEFAULT_OPTS = {
  delayPreAnchorMin: 2,
  delayInTransitMin: 5,
};

function plat(p) { return p ?? '–'; }
function delay(d) { return `+${d ?? 0}min`; }

// Unified rich body — same shape as the original confirmation reply.
//
//   headline  — sentence-form opener that mirrors the event's title verb
//               so the body is self-contained when read in isolation
//               (notification preview, forwarded mail, archive snippet).
//               e.g. 'Tracking ECD 9536, Amsterdam → Bruxelles.' for the
//               T-30 push, 'ECD 9536 platform CHANGED → 16b — Amsterdam
//               → Bruxelles.' for a platform-change event.
//   marks     — Set of row keys that changed since last snapshot:
//                 'time'    — schedule row (delays / time edits)
//                 'depPlat' — departure platform
//                 'arrPlat' — arrival platform
//               Each marked row gets a leading "> " so the user can
//               spot what's new without scanning the whole block.
//               Inline annotations on the changed field add the delta
//               (e.g. " (+5min)" on a delayed time, " (was 15a)" on a
//               re-platformed train).
function richBody(curr, prev, { headline, marks = new Set() } = {}) {
  const line = curr.line || curr.trainNum;
  const fromName = curr.fromName ?? '?';
  const toName = curr.toName ?? '?';
  const isPickup = curr.mode === 'A';

  const arrDelay = curr.arrivalDelayMin ?? 0;
  const arrDelayTag = arrDelay ? ` (+${arrDelay}min)` : '';
  const arrPlatStr = curr.arrivalPlatform   || 'TBC';
  const arrPlatWas = (prev && prev.arrivalPlatform && prev.arrivalPlatform !== curr.arrivalPlatform)
    ? ` (was ${prev.arrivalPlatform})` : '';

  const mark = (key) => marks.has(key) ? '> ' : '';

  // Pickup users don't board, so the body collapses to arrival-only:
  // no dep line, no departure-platform field. Mirrors the confirmation
  // reply shape (src/reply.js confirmationReply branch on resolved.mode).
  if (isPickup) {
    return [
      headline || `Picking up ${line} at ${toName}.`,
      `${mark('time')}Scheduled arrival: ${fmtDatetime(curr.scheduledArrival)} ${toName}${arrDelayTag}.`,
      `${mark('arrPlat')}Arrival platform: ${arrPlatStr}${arrPlatWas}`,
    ].join('\n');
  }

  const depDelay = curr.departureDelayMin ?? 0;
  const depDelayTag = depDelay ? ` (+${depDelay}min)` : '';
  const depPlatStr = curr.departurePlatform || 'TBC';
  const depPlatWas = (prev && prev.departurePlatform && prev.departurePlatform !== curr.departurePlatform)
    ? ` (was ${prev.departurePlatform})` : '';

  return [
    headline || `${line}, ${fromName} → ${toName}.`,
    `${mark('time')}Scheduled: dep ${fmtDatetime(curr.scheduledDeparture)} ${fromName}${depDelayTag}, arr ${fmtDatetime(curr.scheduledArrival)} ${toName}${arrDelayTag}.`,
    `${mark('depPlat')}Departure platform: ${depPlatStr}${depPlatWas}    ${mark('arrPlat')}Arrival platform: ${arrPlatStr}${arrPlatWas}`,
  ].join('\n');
}

export function diff(prev, curr, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const events = [];

  const line = curr.line || curr.trainNum;
  const fromN = curr.fromName ?? '?';
  const toN = curr.toName ?? '?';
  const isPickup = curr.mode === 'A';
  // Pickup bodies don't have an origin to anchor a "X → Y" route — collapse
  // to "at <to>" so push event headlines read naturally for the meeter.
  const route = isPickup ? `at ${toN}` : `${fromN} → ${toN}`;

  // ---- Window 1: tracking start (T-30 mandatory push). ----
  if (!prev) {
    const startTitle = isPickup ? `Picking up ${line}` : `Tracking ${line}`;
    const startHead  = isPickup ? `Picking up ${line} at ${toN}.` : `Tracking ${line}, ${route}.`;
    events.push({
      type: 'tracking_started',
      priority: 'default',
      title: startTitle,
      body: richBody(curr, null, { headline: startHead }),
    });
    return events;
  }

  // ---- Cancellation / replacement: short-circuit, single loud message. ----
  if (!prev.cancelled && curr.cancelled) {
    events.push({
      type: 'cancelled',
      priority: 'urgent',
      title: `${line} CANCELLED`,
      body: `${line} CANCELLED, ${route}.\nThis service is cancelled.`,
    });
    return events;
  }
  if (!prev.replaced && curr.replaced) {
    events.push({
      type: 'replaced',
      priority: 'urgent',
      title: `${line} replacement service`,
      body: `${line} REPLACED, ${route}.\nCheck operator app for the substitute service.`,
    });
  }

  // ---- Anchor platform (dep for Mode B, arr for Mode A). ----
  const anchorIsArr = curr.mode === 'A';
  const prevAnchorPlat = anchorIsArr ? prev.arrivalPlatform : prev.departurePlatform;
  const currAnchorPlat = anchorIsArr ? curr.arrivalPlatform : curr.departurePlatform;
  const anchorPlatMark = anchorIsArr ? 'arrPlat' : 'depPlat';
  const anchorWord = anchorIsArr ? 'arrival' : 'departure';

  if (!prevAnchorPlat && currAnchorPlat) {
    events.push({
      type: 'platform_assigned',
      priority: 'urgent',
      title: `${line} → Platform ${currAnchorPlat}`,
      body: richBody(curr, prev, {
        headline: `${line} ${anchorWord} platform: ${currAnchorPlat}, ${route}.`,
        marks: new Set([anchorPlatMark]),
      }),
    });
  } else if (prevAnchorPlat && currAnchorPlat && prevAnchorPlat !== currAnchorPlat) {
    events.push({
      type: 'platform_changed',
      priority: 'urgent',
      title: `${line} platform CHANGED → ${currAnchorPlat}`,
      body: richBody(curr, prev, {
        headline: `${line} ${anchorWord} platform CHANGED → ${currAnchorPlat} (was ${prevAnchorPlat}), ${route}.`,
        marks: new Set([anchorPlatMark]),
      }),
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
      title: `${line} ${delay(currAnchorDelay)}`,
      body: richBody(curr, prev, {
        headline: `${line} ${anchorWord} ${delay(currAnchorDelay)}, ${route}.`,
        marks: new Set(['time']),
      }),
    });
  }

  // ---- Mode B post-departure: arrival platform + arrival delay propagation. ----
  if (curr.mode === 'B' && curr.hasDeparted) {
    if (!prev.arrivalPlatform && curr.arrivalPlatform) {
      events.push({
        type: 'arrival_platform_assigned',
        priority: 'urgent',
        title: `${line} → arrival Platform ${curr.arrivalPlatform}`,
        body: richBody(curr, prev, {
          headline: `${line} arrival platform: ${curr.arrivalPlatform}, ${route}.`,
          marks: new Set(['arrPlat']),
        }),
      });
    } else if (prev.arrivalPlatform && curr.arrivalPlatform && prev.arrivalPlatform !== curr.arrivalPlatform) {
      events.push({
        type: 'arrival_platform_changed',
        priority: 'urgent',
        title: `${line} arrival platform CHANGED → ${curr.arrivalPlatform}`,
        body: richBody(curr, prev, {
          headline: `${line} arrival platform CHANGED → ${curr.arrivalPlatform} (was ${prev.arrivalPlatform}), ${route}.`,
          marks: new Set(['arrPlat']),
        }),
      });
    }
    const prevArrDelay = prev.arrivalDelayMin ?? 0;
    const currArrDelay = curr.arrivalDelayMin ?? 0;
    if (Math.abs(currArrDelay - prevArrDelay) >= cfg.delayInTransitMin) {
      events.push({
        type: 'arrival_delay_change',
        priority: 'high',
        title: `${line} arrival ${delay(currArrDelay)}`,
        body: richBody(curr, prev, {
          headline: `${line} arrival ${delay(currArrDelay)}, ${route}.`,
          marks: new Set(['time']),
        }),
      });
    }
  }

  // ---- Terminating short: user's destination stop is now cancelled. ----
  const prevToCancelled = !!prev.stopoversCancelled?.[curr.toName];
  const currToCancelled = !!curr.stopoversCancelled?.[curr.toName];
  if (curr.toName && !prevToCancelled && currToCancelled) {
    // Mode A: "TERMINATING before X, at X" reads tautologically; drop the
    // route tail in pickup mode since toName is already in the headline.
    const tail = isPickup ? '' : `, ${route}`;
    events.push({
      type: 'terminating_short',
      priority: 'urgent',
      title: `${line} TERMINATING before ${curr.toName}`,
      body: `${line} TERMINATING before ${curr.toName}${tail}.\nTrain will not reach ${curr.toName}. Check operator app for onward connection.`,
    });
  }

  // ---- Departed (Mode B only — Mode A users don't care about the departure). ----
  if (curr.mode === 'B' && !prev.hasDeparted && curr.hasDeparted) {
    events.push({
      type: 'departed',
      priority: 'default',
      title: `${line} departed ${fromN}`,
      body: `${line} departed ${fromN}, ${route}.\nLeft at ~${fmtTime(curr.predictedDeparture)}, ${delay(curr.departureDelayMin)}.`,
    });
  }

  // ---- Arrived (terminal). ----
  if (!prev.hasArrived && curr.hasArrived) {
    // Same redundancy avoidance as terminating_short: "arrived X, at X" is
    // tautological for pickup mode where toName is also the route anchor.
    const tail = isPickup ? '' : `, ${route}`;
    events.push({
      type: 'arrived',
      priority: 'default',
      title: `${line} arrived ${toN}`,
      body: `${line} arrived ${toN}${tail}.\nArrived ~${fmtTime(curr.predictedArrival)}, platform ${plat(curr.arrivalPlatform)}. Tracking ended.`,
    });
  }

  return events;
}
