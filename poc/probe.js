// POC 1: probe every hafas-client profile.
// For each profile: try to load it, search for a well-known station,
// and pull live departures. Report what's alive vs broken vs missing.

import { createClient } from 'hafas-client';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const profilesDir = join(__dirname, 'node_modules/hafas-client/p');

const profiles = readdirSync(profilesDir).filter(name => {
  try { return statSync(join(profilesDir, name)).isDirectory(); }
  catch { return false; }
});

// A representative station query per profile. Generic terms first;
// profile-specific overrides where the generic name is too ambiguous.
const stationQueries = {
  db: 'Frankfurt Hbf',
  oebb: 'Wien Hbf',
  sncb: 'Brussels Midi',
  nahsh: 'Kiel Hbf',
  pkp: 'Warszawa Centralna',
  rejseplanen: 'København H',
  cfl: 'Luxembourg',
  bls: 'Bern',
  vbb: 'Berlin Hbf',
  bvg: 'Alexanderplatz',
  rmv: 'Frankfurt Hbf',
  nvv: 'Kassel Hbf',
  vbn: 'Bremen Hbf',
  vsn: 'Göttingen',
  insa: 'Magdeburg Hbf',
  'sbahn-muenchen': 'München Hbf',
  saarfahrplan: 'Saarbrücken Hbf',
  avv: 'Aachen Hbf',
  vrn: 'Mannheim Hbf',
  vmt: 'Erfurt Hbf',
  vvv: 'Bregenz',
  vor: 'Wien Hbf',
  vvt: 'Innsbruck Hbf',
  svv: 'Salzburg Hbf',
  ooevv: 'Linz/Donau Hbf',
  salzburg: 'Salzburg Hbf',
  ivb: 'Innsbruck',
  stv: 'Graz Hbf',
  vkg: 'Klagenfurt Hbf',
  kvb: 'Köln',
  'mobil-nrw': 'Düsseldorf Hbf',
  'db-busradar-nrw': 'Köln',
  rsag: 'Rostock Hbf',
  zvv: 'Zürich HB',
  tpg: 'Genève',
  'mobiliteit-lu': 'Luxembourg',
  'irish-rail': 'Dublin',
  vos: 'Osnabrück',
  invg: 'Ingolstadt',
  cmta: 'Austin',
  bart: 'Embarcadero',
  dart: 'Dallas',
};

async function probe(name) {
  const start = Date.now();
  let mod;
  try {
    mod = await import(`hafas-client/p/${name}/index.js`);
  } catch (e) {
    return { name, status: 'IMPORT_FAIL', error: e.message.split('\n')[0] };
  }
  const profile = mod.profile || mod.default;
  if (!profile) return { name, status: 'NO_PROFILE_EXPORT' };

  let client;
  try {
    client = createClient(profile, 'latefyi-poc/0.1');
  } catch (e) {
    return { name, status: 'CLIENT_INIT_FAIL', error: e.message.split('\n')[0] };
  }

  const query = stationQueries[name];
  if (!query) return { name, status: 'NO_QUERY_DEFINED' };

  // Step 1: locations search
  let locations;
  try {
    locations = await Promise.race([
      client.locations(query, { results: 3 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
    ]);
  } catch (e) {
    return { name, status: 'LOCATIONS_FAIL', error: e.message.split('\n')[0], ms: Date.now() - start };
  }
  if (!locations?.length) return { name, status: 'LOCATIONS_EMPTY', ms: Date.now() - start };
  const station = locations.find(l => l.type === 'stop' || l.type === 'station') || locations[0];

  // Step 2: live departures
  let deps;
  try {
    deps = await Promise.race([
      client.departures(station.id, { duration: 30, results: 5 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
    ]);
  } catch (e) {
    return { name, status: 'DEPARTURES_FAIL', error: e.message.split('\n')[0], station: station.name, ms: Date.now() - start };
  }

  const list = Array.isArray(deps) ? deps : deps?.departures || [];
  const sample = list[0];
  return {
    name,
    status: list.length ? 'OK' : 'DEPARTURES_EMPTY',
    station: station.name,
    departureCount: list.length,
    sample: sample ? {
      line: sample.line?.name,
      product: sample.line?.product,
      direction: sample.direction,
      when: sample.when,
      platform: sample.platform,
    } : null,
    ms: Date.now() - start,
  };
}

const targets = process.argv[2] ? process.argv[2].split(',') : profiles;
console.log(`Probing ${targets.length} profile(s)...\n`);

const results = [];
for (const name of targets) {
  process.stdout.write(`  ${name.padEnd(20)} `);
  const r = await probe(name);
  results.push(r);
  console.log(r.status + (r.ms ? ` (${r.ms}ms)` : '') + (r.error ? ` — ${r.error}` : ''));
}

console.log('\n=== SUMMARY ===');
const ok = results.filter(r => r.status === 'OK');
const broken = results.filter(r => r.status !== 'OK');
console.log(`OK:     ${ok.length}/${results.length}`);
console.log(`Broken: ${broken.length}/${results.length}`);
console.log('\nWorking profiles (sample departure):');
for (const r of ok) {
  const s = r.sample;
  console.log(`  ${r.name.padEnd(18)} @ ${r.station}: ${s?.line || '?'} → ${s?.direction || '?'} platform=${s?.platform ?? 'null'}`);
}
console.log('\nFailures:');
for (const r of broken) {
  console.log(`  ${r.name.padEnd(18)} ${r.status}${r.error ? ': ' + r.error : ''}`);
}
