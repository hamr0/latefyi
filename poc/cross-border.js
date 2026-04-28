// Probe whether ÖBB / VBB / DB-affiliated profiles can return data for
// trains operated by other countries. The PRD assumes per-operator
// endpoints; if a single endpoint covers cross-border, the design simplifies.

import { createClient } from 'hafas-client';

const PROFILES = ['oebb', 'vbb', 'rmv', 'nvv', 'pkp', 'rejseplanen', 'mobiliteit-lu'];
// Stations from countries where the *native* profile is dead/missing.
const TEST_STATIONS = [
  { country: 'FR',  query: 'Paris Gare du Nord' },
  { country: 'FR',  query: 'Lille Flandres' },
  { country: 'CH',  query: 'Zürich HB' },
  { country: 'NL',  query: 'Amsterdam Centraal' },
  { country: 'IT',  query: 'Roma Termini' },
  { country: 'BE',  query: 'Brussels Midi' },
  { country: 'DE',  query: 'Frankfurt Hbf' },
  { country: 'UK',  query: 'London St Pancras' },
];

async function tryProfile(name) {
  console.log(`\n=== Profile: ${name} ===`);
  const mod = await import(`hafas-client/p/${name}/index.js`);
  const profile = mod.profile || mod.default;
  const client = createClient(profile, 'latefyi-poc/0.1');

  for (const t of TEST_STATIONS) {
    try {
      const locs = await Promise.race([
        client.locations(t.query, { results: 2 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
      ]);
      if (!locs?.length) {
        console.log(`  ${t.country} ${t.query.padEnd(24)} → no station match`);
        continue;
      }
      const station = locs.find(l => l.type === 'stop' || l.type === 'station') || locs[0];
      // Try departures so we know it's actually a live station
      let depCount = 0, sample = null;
      try {
        const deps = await Promise.race([
          client.departures(station.id, { duration: 30, results: 3 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
        ]);
        const list = Array.isArray(deps) ? deps : deps?.departures || [];
        depCount = list.length;
        sample = list[0];
      } catch (e) {
        console.log(`  ${t.country} ${t.query.padEnd(24)} → station="${station.name}" but departures FAILED: ${e.message.split('\n')[0]}`);
        continue;
      }
      const s = sample ? `${sample.line?.name || '?'} → ${sample.direction || '?'}` : '(no departures)';
      console.log(`  ${t.country} ${t.query.padEnd(24)} → "${station.name}" deps=${depCount} ${s}`);
    } catch (e) {
      console.log(`  ${t.country} ${t.query.padEnd(24)} → ERROR: ${e.message.split('\n')[0]}`);
    }
  }
}

for (const p of PROFILES) {
  try { await tryProfile(p); }
  catch (e) { console.log(`profile ${p} init failed: ${e.message}`); }
}
