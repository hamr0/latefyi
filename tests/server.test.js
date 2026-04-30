// Behavior tests for src/server.js — the inbound-email orchestrator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleInbound } from '../src/server.js';

// ---- shared fakes ----

const ICE145_TRIP = {
  line: { name: 'ICE 145', fahrtNr: '145' },
  stopovers: [
    { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '8b' },
    { stop: { name: 'Hannover Hbf' },        plannedArrival:   '2026-04-29T11:30:00Z' },
    { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T14:02:00Z', plannedArrivalPlatform: '2' },
  ],
};

const fakeOebb = () => ({
  async locations(q) {
    if (/Amsterdam/i.test(q)) return [{ id: '8400058', name: 'Amsterdam Centraal', type: 'station' }];
    if (/Berlin/i.test(q))   return [{ id: '8010255', name: 'Berlin Ostbahnhof', type: 'station' }];
    return [];
  },
  async departures(id) {
    if (id === '8400058') {
      return [{
        line: { name: 'ICE 145', fahrtNr: '145' },
        direction: 'Berlin Ostbahnhof', tripId: 'TRIP_ICE145',
        plannedWhen: '2026-04-29T08:00:00Z', plannedPlatform: '8b',
      }];
    }
    return [];
  },
  async arrivals(id) {
    if (id === '8010255') {
      return [{
        line: { name: 'ICE 145', fahrtNr: '145' },
        direction: 'Berlin Ostbahnhof', tripId: 'TRIP_ICE145',
        plannedWhen: '2026-04-29T14:02:00Z', plannedPlatform: '2',
      }];
    }
    return [];
  },
  async trip(id) {
    if (id === 'TRIP_ICE145') return ICE145_TRIP;
    throw new Error(`unknown trip ${id}`);
  },
});

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-server-'));
  for (const sub of ['active', 'pending', 'done', 'errors', 'users']) {
    mkdirSync(join(stateDir, sub), { recursive: true });
  }
  return { stateDir };
}

const baseEmail = (over = {}) => ({
  from: 'amr@example.com',
  to: 'ICE145@late.fyi',
  subject: '',
  body: '',
  msgid: '<inbound-1@example.com>',
  headers: {},
  ...over,
});

// ===== Allowlist =====

test('allowlist: non-allowlisted sender → null (silent drop)', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ from: 'stranger@x.com', subject: 'From: A, To: B' }),
    stateDir, primaryClient: fakeOebb(),
    allowlist: ['amr@example.com'],
  });
  assert.equal(r, null);
});

test('allowlist: empty/null = open (single-tenant default)', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
    allowlist: null,
  });
  assert.ok(r);
  assert.equal(r.from, 'noreply@late.fyi');
});

// ===== Track happy path =====

test('track happy path: resolves, schedules, returns confirmation', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Tracking ICE 145/);
  assert.match(r.body, /Amsterdam Centraal → Berlin Ostbahnhof/);

  // Pending file written
  const pending = readdirSync(join(stateDir, 'pending'));
  assert.equal(pending.length, 1);
  const rec = JSON.parse(readFileSync(join(stateDir, 'pending', pending[0]), 'utf8'));
  assert.equal(rec.confirmationMsgid, r.headers['Message-ID']);
  assert.equal(rec.resolved.tripId, 'TRIP_ICE145');

  // User record created with default email channel
  const userFiles = readdirSync(join(stateDir, 'users'));
  assert.equal(userFiles.length, 1);
  const user = JSON.parse(readFileSync(join(stateDir, 'users', userFiles[0]), 'utf8'));
  assert.equal(user.channel, 'email');
  assert.equal(user.trains_tracked_count, 1);
});

test('track: confirmation reply uses the user\'s stored channel', async () => {
  const { stateDir } = setup();
  // Pre-create user with ntfy channel
  await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS ntfy' }),
    stateDir, primaryClient: fakeOebb(),
  });
  // Now track
  const r = await handleInbound({
    email: baseEmail({ subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.body, /via ntfy/);
});

// ===== Track errors =====

test('track: bare email (no headers) → missing-context reply', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ subject: '', body: '' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Need more info for ICE145/);
  assert.deepEqual(readdirSync(join(stateDir, 'pending')), []); // not scheduled
});

test('track: train not found → train-not-found reply', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ to: 'XYZ999@late.fyi', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Can't find train XYZ999/);
});

test('track: station not on route → station-not-on-route reply', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ subject: 'From: Amsterdam Centraal, To: Roma Termini' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Roma Termini not on/);
  assert.match(r.body, /Amsterdam Centraal → Hannover Hbf → Berlin Ostbahnhof/);
});

// ===== Config =====

test('config: CHANNELS ntfy first time → ntfy opt-in reply with QR', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS ntfy' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /ntfy enabled/);
  assert.match(r.body, /https:\/\/ntfy\.sh\/latefyi-/);
});

test('config: CHANNELS email after ntfy opt-in → simple confirmation, no QR', async () => {
  const { stateDir } = setup();
  await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS ntfy' }),
    stateDir, primaryClient: fakeOebb(),
  });
  const r = await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS email' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Channel updated to email/);
  assert.equal(/ntfy\.sh/.test(r.body), false);
});

// ===== STOP variants =====

test('stop ALL: clears all this sender\'s active+pending records', async () => {
  const { stateDir } = setup();
  // Track 3 trains first
  for (let i = 0; i < 3; i++) {
    await handleInbound({
      email: baseEmail({ msgid: `<m${i}@x>`, subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
      stateDir, primaryClient: fakeOebb(),
    });
  }
  assert.equal(readdirSync(join(stateDir, 'pending')).length, 3);

  const r = await handleInbound({
    email: baseEmail({ to: 'stop@late.fyi', subject: 'STOP ALL' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Stopped all tracking/);
  assert.match(r.body, /Cleared 3 active trains/);
  assert.deepEqual(readdirSync(join(stateDir, 'pending')), []);
  assert.equal(readdirSync(join(stateDir, 'done')).length, 3);
});

test('stop TRIP: only the matching trip is cleared', async () => {
  const { stateDir } = setup();
  // 2 trains in trip "rome", 1 train without trip
  await handleInbound({
    email: baseEmail({ msgid: '<a@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof, Trip: rome' }),
    stateDir, primaryClient: fakeOebb(),
  });
  await handleInbound({
    email: baseEmail({ msgid: '<b@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof, Trip: rome' }),
    stateDir, primaryClient: fakeOebb(),
  });
  await handleInbound({
    email: baseEmail({ msgid: '<c@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });

  const r = await handleInbound({
    email: baseEmail({ to: 'stop@late.fyi', subject: 'STOP TRIP rome' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.body, /Cleared 2 trains.*rome/);
  assert.equal(readdirSync(join(stateDir, 'pending')).length, 1); // the non-rome one
});

test('stop single: STOP <TRAINNUM> moves only that one', async () => {
  const { stateDir } = setup();
  await handleInbound({
    email: baseEmail({ msgid: '<a@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });

  const r = await handleInbound({
    email: baseEmail({ to: 'stop@late.fyi', subject: 'STOP ICE145' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Stopped tracking ICE145/);
  assert.deepEqual(readdirSync(join(stateDir, 'pending')), []);
});

test('STOP scrubs plaintext sender from done record (privacy claim)', async () => {
  const { stateDir } = setup();
  await handleInbound({
    email: baseEmail({ msgid: '<a@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });
  await handleInbound({
    email: baseEmail({ to: 'stop@late.fyi', subject: 'STOP ICE145' }),
    stateDir, primaryClient: fakeOebb(),
  });
  const doneFiles = readdirSync(join(stateDir, 'done')).filter(f => f.endsWith('.json'));
  assert.equal(doneFiles.length, 1);
  const rec = JSON.parse(readFileSync(join(stateDir, 'done', doneFiles[0]), 'utf8'));
  assert.equal(rec.sender, undefined, 'plaintext sender must not survive in done/');
  assert.match(rec.senderHash, /^[a-f0-9]{16}$/);
  // Other fields should still be there for diagnostics.
  assert.equal(rec.request.trainNum, 'ICE145');
});
