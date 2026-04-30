// Train resolver: takes a parsed track request and returns a fully-resolved
// trip object (or an error / disambiguation-needed result).
//
// PRD §13.2 (revised). Endpoint strategy: ÖBB primary, PKP fallback. No
// per-operator routing; the ÖBB HAFAS endpoint serves as a universal
// European query gateway (validated in the POC, see docs/01-product/).
//
// Pure of network details: all hafas-client interaction goes through
// `primaryClient` / `fallbackClient` parameters, so tests inject fakes
// rather than monkey-patching modules.

import { matchStation } from './stations.js';

// ---- helpers ----

const TRAIN_NUM_DIGITS_RE = /(\d+)/g;

function digitsOf(s) {
  if (!s) return null;
  const parts = s.toString().match(TRAIN_NUM_DIGITS_RE);
  return parts ? parts.join('') : null;
}

// Decide whether a HAFAS departure/arrival entry corresponds to the user's train.
// Matches by `line.fahrtNr` (the canonical train number HAFAS exposes) OR by the
// trailing digits of `line.name`. Letter prefix (ICE/TGV/EUR) is informational
// and we don't gatekeep on it — the digits are what HAFAS guarantees.
function entryMatchesTrain(entry, requestedTrainNum) {
  const wantDigits = digitsOf(requestedTrainNum);
  if (!wantDigits) return false;
  const fahrt = entry.line?.fahrtNr;
  if (fahrt && fahrt.toString() === wantDigits) return true;
  const lineDigits = digitsOf(entry.line?.name || '');
  if (lineDigits && lineDigits === wantDigits) return true;
  return false;
}

function asArray(boardResult, key) {
  if (Array.isArray(boardResult)) return boardResult;
  if (boardResult && Array.isArray(boardResult[key])) return boardResult[key];
  return [];
}

// Try to resolve a single station-name string to a HAFAS station id.
// Returns { id, name } or null.
async function resolveStationId(client, query) {
  if (!query) return null;
  let locs;
  try {
    locs = await client.locations(query, { results: 3 });
  } catch {
    return null;
  }
  if (!Array.isArray(locs) || locs.length === 0) return null;
  const stop = locs.find(l => l.type === 'stop' || l.type === 'station') || locs[0];
  return { id: stop.id, name: stop.name };
}

// Find the user's train on `client` by anchoring the search at the given station.
// `mode === "B"` searches departures; `mode === "A"` searches arrivals.
// Returns { tripId, sample } or null.
async function findOnClient(client, anchorStation, trainNum, mode, durationMin, when) {
  const opts = { duration: durationMin, results: 800 };
  // For advance-planned requests (On: <date>), anchor the board search to
  // start-of-day UTC of that date. With duration = 24h, we cover the whole
  // day. Without `when`, HAFAS uses "now" → today's nearest run.
  if (when) opts.when = when;
  let board;
  try {
    if (mode === 'A') board = await client.arrivals(anchorStation.id, opts);
    else              board = await client.departures(anchorStation.id, opts);
  } catch {
    return null;
  }
  const list = asArray(board, mode === 'A' ? 'arrivals' : 'departures');
  const match = list.find(e => entryMatchesTrain(e, trainNum));
  return match ? { tripId: match.tripId, sample: match } : null;
}

// Pull the full trip and return the canonical stop-name list + scheduled times.
async function fetchTrip(client, tripId) {
  let res;
  try { res = await client.trip(tripId); }
  catch (e) { return { error: e.message || 'trip fetch failed' }; }
  const trip = res?.trip || res;
  const stopovers = trip?.stopovers || [];
  return {
    line: trip.line?.name || null,
    routeStopNames: stopovers.map(s => s?.stop?.name).filter(Boolean),
    stopovers,
  };
}

// ---- main ----

export async function resolve({ parsed, primaryClient, fallbackClient, aliases = {}, durationMin = 24 * 60 }) {
  if (!parsed || parsed.kind !== 'track') {
    return { kind: 'error', code: 'invalid_parsed', message: 'resolve() expects a parsed track request' };
  }
  if (parsed.mode === 'MISSING') {
    return { kind: 'error', code: 'missing_context', message: 'need From: or To: to anchor the search' };
  }

  const anchorName = parsed.mode === 'A' ? parsed.to : parsed.from;
  if (!anchorName) {
    return { kind: 'error', code: 'missing_anchor', message: `mode ${parsed.mode} requires ${parsed.mode === 'A' ? 'To:' : 'From:'} field` };
  }

  // 1+2+3: try primary, then fallback. Whichever finds it wins.
  const attempts = [
    { name: 'oebb', client: primaryClient },
    { name: 'pkp',  client: fallbackClient },
  ].filter(a => a.client);

  // If user supplied On: <date>, anchor the board search at start-of-day UTC.
  const when = parsed.onDate ? new Date(`${parsed.onDate}T00:00:00Z`) : undefined;

  let endpoint = null, anchorStation = null, found = null;
  for (const { name, client } of attempts) {
    const station = await resolveStationId(client, anchorName);
    if (!station) continue;
    const hit = await findOnClient(client, station, parsed.trainNum, parsed.mode, durationMin, when);
    if (hit) {
      endpoint = name;
      anchorStation = station;
      found = hit;
      break;
    }
  }

  if (!found) {
    return { kind: 'error', code: 'train_not_found',
             message: `no train ${parsed.trainNum} found at ${anchorName} on either endpoint` };
  }

  // 6: pull the full trip from the same endpoint we found it on.
  const winningClient = endpoint === 'oebb' ? primaryClient : fallbackClient;
  const trip = await fetchTrip(winningClient, found.tripId);
  if (trip.error) {
    return { kind: 'error', code: 'trip_fetch_failed', message: trip.error };
  }
  if (!trip.routeStopNames.length) {
    return { kind: 'error', code: 'empty_route', message: 'trip returned no stopovers' };
  }

  // 7: validate from/to against the route.
  const validation = {};
  for (const field of ['from', 'to']) {
    const userText = parsed[field];
    if (!userText) { validation[field] = null; continue; }
    const m = matchStation(userText, trip.routeStopNames, aliases);
    if (m.status === 'unique') {
      validation[field] = { resolved: m.match };
    } else if (m.status === 'ambiguous') {
      validation[field] = { ambiguous: true, candidates: m.candidates };
    } else if (m.status === 'not_on_route') {
      return { kind: 'error', code: 'station_not_on_route',
               field, userText,
               message: `${userText} is not a stop on ${trip.line || parsed.trainNum}`,
               details: { route: trip.routeStopNames, suggestion: m.suggestion } };
    } else {
      return { kind: 'error', code: 'station_no_match',
               field, userText,
               message: `couldn't match "${userText}" against any stop on ${trip.line || parsed.trainNum}`,
               details: { route: trip.routeStopNames } };
    }
  }

  // If either field is ambiguous, the caller (router) needs to send the §7a
  // numbered reply and park the request in AWAITING_DISAMBIGUATION.
  for (const field of ['from', 'to']) {
    const v = validation[field];
    if (v?.ambiguous) {
      return {
        kind: 'disambiguation_needed',
        field,
        candidates: v.candidates,
        partial: {
          endpoint,
          tripId: found.tripId,
          line: trip.line,
          route: trip.routeStopNames,
          // Already-resolved fields preserved so the caller doesn't re-ask
          from: validation.from?.resolved ?? null,
          to:   validation.to?.resolved ?? null,
          parsed,
        },
      };
    }
  }

  // Both fields either resolved or null (mode A had only `to`, mode B may have only `from`).
  // For mode B without an explicit `to`, default to terminus (last stop).
  const fromName = validation.from?.resolved || null;
  const toName   = validation.to?.resolved   || (parsed.mode === 'B' ? trip.routeStopNames[trip.routeStopNames.length - 1] : null);

  const fromStop = trip.stopovers.find(s => s?.stop?.name === fromName);
  const toStop   = trip.stopovers.find(s => s?.stop?.name === toName);

  return {
    kind: 'resolved',
    endpoint,
    tripId: found.tripId,
    line: trip.line,
    trainNum: parsed.trainNum,
    mode: parsed.mode,
    from: fromName,
    to: toName,
    trip: parsed.trip || null,
    channels: parsed.channels || null,
    route: trip.routeStopNames,
    schedule: {
      scheduledDeparture: fromStop?.plannedDeparture || null,
      scheduledArrival:   toStop?.plannedArrival   || null,
    },
  };
}
