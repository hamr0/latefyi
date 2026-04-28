// One-screen morning report for the overnight ICE 145 tracker.
// Usage: node summary.js

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP = join(__dirname, 'logs/snapshots.jsonl');
const EVT  = join(__dirname, 'logs/events.jsonl');
const STD  = join(__dirname, 'logs/track.stdout.log');

const readJsonl = (p) => existsSync(p)
  ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const snaps = readJsonl(SNAP);
const events = readJsonl(EVT);

let alive = false;
try {
  const out = execSync('pgrep -af "node track.js"', { encoding: 'utf8' });
  alive = !!out.trim();
} catch { alive = false; }

console.log('═══ ICE 145 overnight tracker — morning report ═══\n');

console.log(`Process:      ${alive ? '🟢 still running' : '🔴 not running (check stdout log for cause)'}`);
console.log(`Snapshots:    ${snaps.length}`);
console.log(`Events fired: ${events.length}`);

if (snaps.length) {
  const first = snaps[0];
  const last  = snaps[snaps.length - 1];
  const errs  = snaps.filter(s => s.error);
  console.log(`First poll:   ${first.pollTimestamp || first.idx ? snaps[0].pollTimestamp : '?'}`);
  console.log(`Last poll:    ${last.pollTimestamp}`);
  console.log(`Poll errors:  ${errs.length}${errs.length ? ` (last: ${errs[errs.length-1].error})` : ''}`);
}

console.log('\n--- final state ---');
const lastGood = [...snaps].reverse().find(s => !s.error);
if (lastGood) {
  console.log(`  line:               ${lastGood.line}`);
  console.log(`  cancelled:          ${lastGood.cancelled}`);
  console.log(`  hasDeparted:        ${lastGood.hasDeparted}`);
  console.log(`  hasArrived:         ${lastGood.hasArrived}`);
  console.log(`  scheduled dep:      ${lastGood.scheduledDeparture}`);
  console.log(`  predicted dep:      ${lastGood.predictedDeparture} (delay +${lastGood.departureDelayMin ?? 0}min)`);
  console.log(`  dep platform:       ${lastGood.departurePlatform} (planned: ${lastGood.departurePlatformScheduled})`);
  console.log(`  scheduled arr:      ${lastGood.scheduledArrival}`);
  console.log(`  predicted arr:      ${lastGood.predictedArrival} (delay +${lastGood.arrivalDelayMin ?? 0}min)`);
  console.log(`  arr platform:       ${lastGood.arrivalPlatform} (planned: ${lastGood.arrivalPlatformScheduled})`);
} else {
  console.log('  (no successful snapshot yet)');
}

console.log('\n--- event timeline ---');
if (!events.length) console.log('  (none)');
for (const e of events) {
  console.log(`  ${e.pollTimestamp}  [${e.priority.padEnd(7)}] ${e.type.padEnd(28)} ${e.title}`);
}

console.log('\n--- diff event counts by type ---');
const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(28)} ${n}`);
}

console.log('\nFiles:');
for (const p of [SNAP, EVT, STD]) {
  if (existsSync(p)) {
    const s = statSync(p);
    console.log(`  ${p.replace(__dirname + '/', '')}  ${s.size} bytes`);
  }
}
