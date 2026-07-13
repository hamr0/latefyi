// Diagnostic: list distinct RJ/IC line names departing Wien Hbf right now,
// across oebb and pkp. Throwaway, complements poc-multi-source.js.
import { createClient } from 'hafas-client';

for (const name of ['oebb', 'pkp']) {
  const mod = await import(`hafas-client/p/${name}/index.js`);
  const client = createClient(mod.profile || mod.default, 'latefyi-poc/0');
  const locs = await client.locations('Wien Hbf', { results: 3 });
  const station = locs.find(l => l.type === 'stop' || l.type === 'station') || locs[0];
  const board = await client.departures(station.id, { duration: 360, results: 200 });
  const deps = board.departures || board;
  const rjs = deps
    .filter(d => /^(RJ|RJX|IC|EC|NJ)/.test(d.line?.name || ''))
    .slice(0, 10)
    .map(d => `${d.line?.name}  →  ${d.direction || '?'}`);
  console.log(`[${name}] ${station.name} — ${deps.length} departures, sample long-distance:`);
  for (const r of rjs) console.log('  ' + r);
  console.log('');
}
