// Dump line-name + product distribution at major hubs to see what's surfaced.
import { createClient } from 'hafas-client';
const mod = await import('hafas-client/p/oebb/index.js');
const client = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');

const HUBS = ['Frankfurt Hbf', 'Paris Nord', 'Bruxelles Midi', 'London St Pancras', 'Hamburg Hbf', 'Lille Flandres'];

for (const hub of HUBS) {
  const locs = await client.locations(hub, { results: 1 });
  if (!locs?.length) { console.log(`\n${hub}: no station\n`); continue; }
  const res = await client.departures(locs[0].id, { duration: 720, results: 500 });
  const list = Array.isArray(res) ? res : res?.departures || [];
  console.log(`\n=== ${hub} (${locs[0].name}) — ${list.length} entries / 12h window ===`);
  const byProduct = {};
  for (const d of list) {
    const p = d.line?.product || '(none)';
    byProduct[p] = (byProduct[p] || 0) + 1;
  }
  console.log('  product counts:', byProduct);
  // Show 10 samples of long-distance trains specifically
  const longDistance = list.filter(d => /national|long|highspeed|express|inter/i.test(d.line?.product || '') || /^(ICE|TGV|EUR|IC|EC|NJ|RJ|TER|ES)/.test(d.line?.name || ''));
  console.log(`  long-distance samples (${longDistance.length}):`);
  for (const d of longDistance.slice(0, 8)) {
    console.log(`    ${(d.line?.name || '?').padEnd(16)} fahrtNr=${(d.line?.fahrtNr ?? '?').toString().padEnd(6)} prod=${(d.line?.product || '?').padEnd(14)} → ${d.direction}`);
  }
}
