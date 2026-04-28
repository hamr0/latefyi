// HAFAS tripsByName is picky about format. Try multiple variants per train.

import { createClient } from 'hafas-client';

const TRAINS = ['TER48453', 'TER19725', 'IC2812', 'EUR9310', 'TGV6611', 'ICE741'];

function variants(t) {
  const m = t.match(/^([A-Z]+)(\d+)$/);
  if (!m) return [t];
  const [, prefix, num] = m;
  return [
    t,                 // ICE741
    `${prefix} ${num}`,// ICE 741
    num,               // 741
    `${prefix}${num}`, // ICE741 (already)
  ].filter((x, i, a) => a.indexOf(x) === i);
}

const profiles = {};
for (const p of ['oebb', 'pkp']) {
  const mod = await import(`hafas-client/p/${p}/index.js`);
  profiles[p] = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');
}

for (const t of TRAINS) {
  console.log(`\n=== ${t} ===`);
  for (const v of variants(t)) {
    for (const [name, client] of Object.entries(profiles)) {
      try {
        const res = await Promise.race([
          client.tripsByName(v),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
        ]);
        const trips = Array.isArray(res) ? res : res?.trips || [];
        if (trips.length) {
          console.log(`  ${name} "${v}" → ${trips.length} match(es):`);
          for (const trip of trips.slice(0, 4)) {
            const stops = trip.stopovers || [];
            const first = stops[0], last = stops[stops.length - 1];
            console.log(`     ${trip.line?.name || '?'} ${first?.stop?.name || '?'} → ${last?.stop?.name || '?'}  dep=${first?.plannedDeparture || '?'}  plat=${first?.plannedPlatform ?? 'null'}`);
          }
        }
      } catch (e) {
        if (!/NO_MATCH/.test(e.message)) {
          console.log(`  ${name} "${v}" → ERR: ${e.message.split('\n')[0]}`);
        }
      }
    }
  }
}
