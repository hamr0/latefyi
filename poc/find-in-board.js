// Realistic lookup: query a major hub's departure board over a wide
// time window and grep for the train number in line names.
// This is how the production resolver should actually work.

import { createClient } from 'hafas-client';

const HUBS = [
  'Hamburg Hbf', 'München Hbf', 'Frankfurt Hbf', 'Berlin Hbf',
  'Paris Nord', 'Paris Gare de Lyon', 'Lille Flandres',
  'Bruxelles Midi', 'Amsterdam Centraal', 'Roma Termini', 'Milano Centrale',
  'London St Pancras', 'Zürich HB',
];

const NEEDLES = ['741', '48453', '19725', '2812', '9310', '6611'];
const DURATION_MIN = 360; // 6h window

const mod = await import('hafas-client/p/oebb/index.js');
const client = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');

for (const hub of HUBS) {
  try {
    const locs = await client.locations(hub, { results: 1 });
    if (!locs?.length) { console.log(`${hub}: no station`); continue; }
    const station = locs[0];
    const res = await Promise.race([
      client.departures(station.id, { duration: DURATION_MIN, results: 400 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]);
    const list = Array.isArray(res) ? res : res?.departures || [];
    const hits = list.filter(d => {
      const hay = `${d.line?.name || ''} ${d.line?.id || ''} ${d.line?.fahrtNr || ''}`;
      return NEEDLES.some(n => hay.includes(n));
    });
    console.log(`${hub.padEnd(22)} (${station.name}) total=${list.length} hits=${hits.length}`);
    for (const h of hits.slice(0, 10)) {
      console.log(`   ${h.line?.name?.padEnd(14) || '?'.padEnd(14)} fahrtNr=${h.line?.fahrtNr ?? '?'} → ${h.direction}  when=${h.when}  plat=${h.platform ?? 'null'}`);
    }
  } catch (e) {
    console.log(`${hub.padEnd(22)} ERROR: ${e.message.split('\n')[0]}`);
  }
}
