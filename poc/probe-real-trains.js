// Probe specific real trains the user might track.
// Strategy: query each train's likely origin station's departure board
// over a wide window starting tomorrow 05:00 UTC, look for line + fahrtNr match.

import { createClient } from 'hafas-client';

const TARGETS = [
  { num: '141',   line: 'ICE',  origin: 'Amsterdam Centraal', label: 'ICE 141 Amsterdam→Berlin' },
  { num: '145',   line: 'ICE',  origin: 'Amsterdam Centraal', label: 'ICE 145 Amsterdam→Berlin' },
  { num: '1255',  line: 'ICE',  origin: 'Amsterdam Centraal', label: 'ICE 1255 Amsterdam→...→Vienna' },
  { num: '211',   line: 'ICE',  origin: 'Frankfurt Hbf',      label: 'ICE 211 (likely Frankfurt→Munich/Wien)' },
  { num: '167',   line: 'RJX',  origin: 'München Hbf',        label: 'RJX 167 (Munich→Wien?)' },
  { num: '9316',  line: 'EUR',  origin: 'Amsterdam Centraal', label: 'EUR 9316 Amsterdam→Paris' },
  { num: '9523',  line: 'TGV',  origin: 'Paris Gare de Lyon', label: 'TGV 9523 (Paris→Milan?)' },
  { num: '9681',  line: 'FR',   origin: 'Milano Centrale',    label: 'FR 9681 (Frecciarossa →Rome?)' },
];

const profiles = {};
for (const p of ['oebb', 'pkp']) {
  const mod = await import(`hafas-client/p/${p}/index.js`);
  profiles[p] = createClient(mod.profile || mod.default, 'latefyi-poc/0.1');
}

// Anchor: tomorrow 05:00 UTC (≈ 06:00–07:00 local across Europe)
const tomorrow = new Date();
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
tomorrow.setUTCHours(5, 0, 0, 0);
const DURATION_MIN = 18 * 60; // 05:00 → 23:00 UTC

console.log(`Window: ${tomorrow.toISOString()} + ${DURATION_MIN}min\n`);

function lineMatches(d, line, num) {
  const name = (d.line?.name || '').toUpperCase();
  const fahrt = (d.line?.fahrtNr || '').toString();
  if (fahrt === num) return true;
  if (name.includes(line.toUpperCase()) && (name.includes(num) || fahrt === num)) return true;
  // Some profiles encode line as e.g. "TGV 9523" or "EUR 9303"; trailing digits
  const trailing = name.match(/(\d+)/g);
  if (trailing && trailing.includes(num)) return true;
  return false;
}

for (const t of TARGETS) {
  console.log(`=== ${t.label} ===`);
  for (const [pname, client] of Object.entries(profiles)) {
    try {
      const locs = await client.locations(t.origin, { results: 1 });
      if (!locs?.length) { console.log(`  ${pname}: no station "${t.origin}"`); continue; }
      const station = locs[0];
      const res = await Promise.race([
        client.departures(station.id, { when: tomorrow, duration: DURATION_MIN, results: 800 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
      ]);
      const list = Array.isArray(res) ? res : res?.departures || [];
      const hits = list.filter(d => lineMatches(d, t.line, t.num));
      console.log(`  ${pname.padEnd(5)} @${station.name.padEnd(22)} board=${list.length.toString().padEnd(4)} hits=${hits.length}`);
      for (const h of hits.slice(0, 4)) {
        const planned = h.plannedWhen || h.when;
        console.log(`     ✓ ${(h.line?.name || '?').padEnd(14)} fahrtNr=${(h.line?.fahrtNr ?? '?').toString().padEnd(6)} → ${h.direction}  ${planned}  plat=${h.platform ?? h.plannedPlatform ?? 'null'}`);
      }
    } catch (e) {
      console.log(`  ${pname}: ERROR ${e.message.split('\n')[0]}`);
    }
  }
  console.log('');
}
