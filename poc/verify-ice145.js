// Quick verification: is ICE 145 still on Amsterdam Centraal's board today?
// Now that the date has rolled, we want to see live status before tracking.
import { createClient } from 'hafas-client';
const mod = await import('hafas-client/p/oebb/index.js');
const client = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');

const locs = await client.locations('Amsterdam Centraal', { results: 1 });
const station = locs[0];
console.log(`Querying ${station.name} (${station.id})`);

// Wide window: today, 18 hours
const res = await client.departures(station.id, { duration: 18*60, results: 800 });
const list = Array.isArray(res) ? res : res?.departures || [];

const ice145 = list.filter(d => (d.line?.fahrtNr || '').toString() === '145' && /ICE/i.test(d.line?.name || ''));
console.log(`Board: ${list.length} entries; ICE 145 hits: ${ice145.length}`);
for (const d of ice145) {
  console.log({
    line: d.line?.name,
    fahrtNr: d.line?.fahrtNr,
    direction: d.direction,
    plannedWhen: d.plannedWhen,
    when: d.when,
    delay: d.delay,
    plannedPlatform: d.plannedPlatform,
    platform: d.platform,
    cancelled: d.cancelled,
    tripId: d.tripId,
  });
}
