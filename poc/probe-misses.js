// Re-check the three misses against more origins.
import { createClient } from 'hafas-client';
const mod = await import('hafas-client/p/oebb/index.js');
const client = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');

const tomorrow = new Date();
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
tomorrow.setUTCHours(5, 0, 0, 0);

const TRIES = [
  { label: 'ICE 141',   num: '141',  origins: ['Amsterdam Centraal', 'Frankfurt Hbf', 'Berlin Hbf', 'Köln Hbf'] },
  { label: 'RJX 167',   num: '167',  origins: ['Wien Hbf', 'München Hbf', 'Frankfurt Hbf', 'Salzburg Hbf', 'Graz Hbf'] },
  { label: 'TGV 9523',  num: '9523', origins: ['Paris Gare de Lyon', 'Paris Nord', 'Lyon Part-Dieu', 'Milano Centrale', 'Marseille St-Charles'] },
];

for (const t of TRIES) {
  console.log(`\n=== ${t.label} ===`);
  for (const origin of t.origins) {
    try {
      const locs = await client.locations(origin, { results: 1 });
      if (!locs?.length) { console.log(`  ${origin}: no station`); continue; }
      const res = await client.departures(locs[0].id, { when: tomorrow, duration: 18*60, results: 800 });
      const list = Array.isArray(res) ? res : res?.departures || [];
      const hits = list.filter(d => (d.line?.fahrtNr || '').toString() === t.num);
      console.log(`  ${origin.padEnd(24)} board=${list.length} hits=${hits.length}`);
      for (const h of hits.slice(0, 3)) {
        console.log(`     ✓ ${h.line?.name} → ${h.direction}  ${h.plannedWhen || h.when}  plat=${h.platform ?? h.plannedPlatform ?? 'null'}`);
      }
    } catch (e) {
      console.log(`  ${origin}: ERROR ${e.message.split('\n')[0]}`);
    }
  }
}
