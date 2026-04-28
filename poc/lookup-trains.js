// Lookup specific train numbers via ÖBB (primary) and PKP (fallback).
// Uses tripsByName() which is the HAFAS train-number search.

import { createClient } from 'hafas-client';

const TRAINS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['TER48453', 'TER19725', 'IC2812', 'EUR9310', 'TGV6611', 'ICE741'];

const PROFILES = ['oebb', 'pkp'];

async function lookup(profileName, query) {
  const mod = await import(`hafas-client/p/${profileName}/index.js`);
  const profile = mod.profile || mod.default;
  const client = createClient(profile, 'latefyi-poc/0.1');
  if (typeof client.tripsByName !== 'function') {
    return { error: 'tripsByName not supported on this profile' };
  }
  try {
    const res = await Promise.race([
      client.tripsByName(query),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ]);
    const trips = Array.isArray(res) ? res : res?.trips || [];
    return { trips };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  }
}

function describe(trip) {
  const line = trip.line?.name || trip.line?.id || '?';
  const operator = trip.line?.operator?.name || trip.line?.admin || '?';
  const product = trip.line?.product || '?';
  const stops = trip.stopovers || [];
  const first = stops[0];
  const last = stops[stops.length - 1];
  const date = first?.plannedDeparture || first?.departure || trip.plannedDeparture || trip.departure;
  return {
    line, product, operator,
    from: first?.stop?.name,
    to: last?.stop?.name,
    when: date,
    stopCount: stops.length,
    plannedPlatform: first?.plannedPlatform || first?.platform || null,
  };
}

for (const t of TRAINS) {
  console.log(`\n=== ${t} ===`);
  for (const p of PROFILES) {
    const r = await lookup(p, t);
    if (r.error) {
      console.log(`  ${p.padEnd(6)} ERROR: ${r.error}`);
      continue;
    }
    if (!r.trips.length) {
      console.log(`  ${p.padEnd(6)} no matches`);
      continue;
    }
    console.log(`  ${p.padEnd(6)} ${r.trips.length} match(es):`);
    for (const trip of r.trips.slice(0, 5)) {
      const d = describe(trip);
      console.log(`         ${d.line} (${d.product}, ${d.operator}) ${d.from || '?'} → ${d.to || '?'}  ${d.when || ''}  stops=${d.stopCount} plat=${d.plannedPlatform ?? 'null'}`);
    }
  }
}
