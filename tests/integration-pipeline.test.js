// Integration test: a synthetic email goes through parse → resolve → schedule
// and lands in state/pending/ with a correct T-30 poll_start_time. wake.sh
// (via isDue + activate) then promotes it. Validates Phases 1+2 compose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';
import { schedule, isDue, activate } from '../src/schedule.js';
import { tick } from '../src/poll-runner.js';

// Same ICE 145 fixture as resolve.test.js
const ICE145_TRIP = {
  line: { name: 'ICE 145', fahrtNr: '145' },
  stopovers: [
    { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T10:00:00+02:00', plannedDeparturePlatform: '8b' },
    { stop: { name: 'Hannover Hbf' },        plannedArrival:   '2026-04-29T13:30:00+02:00' },
    { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T16:02:00+02:00', plannedArrivalPlatform: '2' },
  ],
};

const fakeOebb = () => ({
  async locations(q) {
    if (/Amsterdam/i.test(q)) return [{ id: '8400058', name: 'Amsterdam Centraal', type: 'station' }];
    return [];
  },
  async departures() {
    return [{
      line: { name: 'ICE 145', fahrtNr: '145' },
      direction: 'Berlin Ostbahnhof',
      tripId: 'TRIP_ICE145',
      plannedWhen: '2026-04-29T10:00:00+02:00',
      plannedPlatform: '8b',
    }];
  },
  async arrivals() { return []; },
  async trip(id) {
    if (id === 'TRIP_ICE145') return ICE145_TRIP;
    throw new Error('unknown trip');
  },
});

test('email → parse → resolve → schedule → wake-style activate', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-pipeline-'));

  // 1. Inbound email
  const email = {
    from: 'amr@example.com',
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof, Trip: rome-2026',
    body: '',
    msgid: '<test-pipeline@late.fyi>',
    headers: {},
  };

  // 2. Parse
  const parsed = parse(email);
  assert.equal(parsed.kind, 'track');
  assert.equal(parsed.trainNum, 'ICE145');
  assert.equal(parsed.from, 'Amsterdam Centraal');
  assert.equal(parsed.to, 'Berlin Ostbahnhof');
  assert.equal(parsed.trip, 'rome-2026');

  // 3. Resolve (uses fake ÖBB)
  const resolved = await resolve({ parsed, primaryClient: fakeOebb() });
  assert.equal(resolved.kind, 'resolved');
  assert.equal(resolved.endpoint, 'oebb');
  assert.equal(resolved.line, 'ICE 145');

  // 4. Schedule — writes state/pending/<msgid>.json with poll_start_time at T-30
  const rec = schedule({
    msgid: email.msgid,
    sender: email.from,
    parsed,
    resolved,
    stateDir,
  });
  // T-30 for 10:00+02:00 dep = 09:30 CEST = 07:30:00Z
  assert.equal(rec.schedule.poll_start_time, '2026-04-29T07:30:00.000Z');
  // grace = +30min past 16:02+02:00 arr = 14:32:00Z
  assert.equal(rec.schedule.poll_end_time, '2026-04-29T14:32:00.000Z');
  assert.equal(rec.request.trip, 'rome-2026');

  // 5. wake-style gating: not due 1ms before T-30, due exactly at T-30
  const t30 = new Date('2026-04-29T07:30:00.000Z').getTime();
  assert.equal(isDue(rec, t30 - 1), false, 'should not be due 1ms before T-30');
  assert.equal(isDue(rec, t30),     true,  'should be due exactly at T-30');

  // 6. activate — pending → active rename
  const newPath = activate(rec._path, stateDir);
  assert.match(newPath, /\/active\//);
  assert.deepEqual(readdirSync(join(stateDir, 'pending')), []);
  assert.equal(readdirSync(join(stateDir, 'active')).length, 1);

  // The on-disk record after activation still has all the data Phase 3's poll-runner will need
  const onDisk = JSON.parse(readFileSync(newPath, 'utf8'));
  assert.equal(onDisk.resolved.tripId, 'TRIP_ICE145');
  assert.equal(onDisk.resolved.endpoint, 'oebb');
  assert.deepEqual(onDisk.resolved.route, ['Amsterdam Centraal', 'Hannover Hbf', 'Berlin Ostbahnhof']);
});

// Full end-to-end: email → parse → resolve → schedule → activate → tick (Phase 3)
// produces tracking_started in logs/push.jsonl. Uses the same fake client.
test('email → parse → resolve → schedule → activate → tick → push log', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-e2e-'));
  const logDir   = mkdtempSync(join(tmpdir(), 'latefyi-e2e-log-'));

  const email = {
    from: 'amr@example.com',
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof',
    body: '',
    msgid: '<e2e@late.fyi>',
    headers: {},
  };
  const parsed = parse(email);
  const resolved = await resolve({ parsed, primaryClient: fakeOebb() });
  const rec = schedule({ msgid: email.msgid, sender: email.from, parsed, resolved, stateDir });

  // wake.sh equivalent: activate the pending file at T-30
  const t30 = new Date('2026-04-29T07:30:00Z').getTime();
  assert.equal(isDue(rec, t30), true);
  activate(rec._path, stateDir);

  // poll-runner tick at T-30 — should fire tracking_started
  const summary = await tick({
    stateDir, logDir,
    getClient: () => fakeOebb(),
    now: t30,
  });
  assert.equal(summary.polled, 1);
  assert.equal(summary.events, 1);

  const pushLog = readFileSync(join(logDir, 'push.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(pushLog.length, 1);
  const evt = JSON.parse(pushLog[0]);
  assert.equal(evt.type, 'tracking_started');
  assert.equal(evt.trainNum, 'ICE145');
  assert.equal(evt.msgid, '<e2e@late.fyi>');
});
