#!/usr/bin/env node
// POC — sequential multi-source fallback (oebb → pkp → sbb).
// Per AGENT_RULES: ~15min, hardcoded, no tests, NEVER SHIP.
// Goal: validate that (a) all three profiles load, (b) sequential
// fallback works, (c) SBB actually returns Austrian/Polish trains
// (if not, the chain shape is wrong).
//
// Usage:
//   node scripts/poc-multi-source.js                      # default train, all sources
//   node scripts/poc-multi-source.js "RJ 73"              # custom train name
//   node scripts/poc-multi-source.js "RJ 73" oebb         # skip oebb (force pkp first)
//   node scripts/poc-multi-source.js "RJ 73" oebb,pkp     # skip both (force sbb)

import { createClient } from 'hafas-client';

// SBB intentionally absent: hafas-client v6 has no sbb profile (POC finding).
// Third slot left empty — see end-of-file notes.
const SOURCES = ['oebb', 'pkp'];
const STATION_QUERY = 'Wien Hbf';
const TRAIN_NAME = process.argv[2] || 'RJ 854';
const SKIP = (process.argv[3] || '').split(',').filter(Boolean);

async function loadProfile(name) {
  const mod = await import(`hafas-client/p/${name}/index.js`);
  return createClient(mod.profile || mod.default, 'latefyi-poc/0');
}

async function resolveOnSource(name) {
  const t0 = Date.now();
  const client = await loadProfile(name);

  const locs = await client.locations(STATION_QUERY, { results: 3 });
  if (!locs?.length) throw new Error(`no station match for "${STATION_QUERY}"`);
  const station = locs.find(l => l.type === 'stop' || l.type === 'station') || locs[0];

  const board = await client.departures(station.id, {
    duration: 720, // next 12h — wide enough for any RJ
    results: 200,
  });
  const departures = board.departures || board;
  const match = departures.find(d => {
    const ln = d.line?.name || '';
    return ln.replace(/\s+/g, '').toLowerCase() === TRAIN_NAME.replace(/\s+/g, '').toLowerCase();
  });
  if (!match) throw new Error(`no departure matching "${TRAIN_NAME}" from ${station.name} (scanned ${departures.length})`);

  const trip = await client.trip(match.tripId);
  const ms = Date.now() - t0;
  return { name, ms, station: station.name, tripId: match.tripId, trip };
}

function summarize(r) {
  // hafas-client v6: client.trip() returns { trip, realtimeDataUpdatedAt } on
  // some profiles, the trip object directly on others. Normalize.
  const t = r.trip?.trip ?? r.trip;
  const stops = t.stopovers?.length ?? 0;
  const origin = t.stopovers?.[0]?.stop?.name ?? '?';
  const dest = t.stopovers?.[stops - 1]?.stop?.name ?? '?';
  const delay = t.departureDelay ?? t.arrivalDelay ?? null;
  console.log(`  via station: ${r.station}`);
  console.log(`  tripId:      ${r.tripId}`);
  console.log(`  line:        ${t.line?.name} (${t.line?.product || '?'})`);
  console.log(`  route:       ${origin} → ${dest} (${stops} stopovers)`);
  console.log(`  delay seen:  ${delay === null ? 'none/null' : delay + 's'}`);
}

async function main() {
  console.log(`POC multi-source: train="${TRAIN_NAME}" station="${STATION_QUERY}" skip=[${SKIP.join(',') || '-'}]`);
  console.log('---');
  for (const name of SOURCES) {
    if (SKIP.includes(name)) {
      console.log(`[${name}] SKIP (forced)`);
      continue;
    }
    try {
      const r = await resolveOnSource(name);
      console.log(`[${name}] OK in ${r.ms}ms`);
      summarize(r);
      console.log('---');
      console.log(`WIN: ${name} (sticky source for subsequent polls)`);
      return;
    } catch (e) {
      console.log(`[${name}] FAIL: ${e.message}`);
    }
  }
  console.log('---');
  console.log('EXHAUSTED: no source returned a trip');
  process.exit(2);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
