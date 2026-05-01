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
  for (const sub of ['active', 'pending', 'pending-disambig', 'users']) {
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
  assert.match(r.from, /^latefyi <[a-z0-9]+@late\.fyi>$/i);
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

test('track: confirmation reply is email-only while ntfy is paused', async () => {
  const { stateDir } = setup();
  // Even if user previously asked for ntfy, the system pins them to email.
  await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS ntfy' }),
    stateDir, primaryClient: fakeOebb(),
  });
  const r = await handleInbound({
    email: baseEmail({ subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.doesNotMatch(r.body, /ntfy/i);
  assert.match(r.body, /Updates by email/);
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

test('config: CHANNELS ntfy → paused notice (ntfy is deferred)', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS ntfy' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /paused/i);
  assert.doesNotMatch(r.body, /ntfy\.sh/);
});

test('config: CHANNELS email → simple confirmation', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ to: 'config@late.fyi', subject: 'CHANNELS email' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.match(r.subject, /Channel updated to email/);
  assert.doesNotMatch(r.body, /ntfy/i);
  assert.match(r.from, /config@late\.fyi/);
  assert.match(r.body, /late\.fyi/); // FOOTER present
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
  // STOP deletes the records — nothing per-trip is retained anywhere.
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

test('STOP deletes the record entirely (privacy claim — no per-trip retention)', async () => {
  const { stateDir } = setup();
  await handleInbound({
    email: baseEmail({ msgid: '<a@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });
  await handleInbound({
    email: baseEmail({ to: 'stop@late.fyi', subject: 'STOP ICE145' }),
    stateDir, primaryClient: fakeOebb(),
  });
  // Nothing in pending/active/done — record is gone. The user file
  // (state/users/<hash>.json) keeps a passive counter and channel pref;
  // that's the only thing that survives.
  assert.deepEqual(readdirSync(join(stateDir, 'pending')), []);
  assert.deepEqual(readdirSync(join(stateDir, 'active')), []);
});

// ===== Abuse limits =====

test('rate limit: 11th request in same hour gets rateLimitedReply', async () => {
  const { stateDir } = setup();
  // Tight limits to keep the test fast: 2/hour, 5/day, 5 active.
  const limits = { perHour: 2, perDay: 5, maxActiveTrains: 5 };
  for (let i = 0; i < 2; i++) {
    await handleInbound({
      email: baseEmail({ msgid: `<m${i}@x>`, subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
      stateDir, primaryClient: fakeOebb(), limits,
    });
  }
  // The 3rd hits the cap.
  const r = await handleInbound({
    email: baseEmail({ msgid: '<m3@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(), limits,
  });
  assert.match(r.subject, /Too many tracking requests/);
  assert.match(r.body, /last hour/);
});

test('rate limit: failed resolves do not consume the budget', async () => {
  const { stateDir } = setup();
  const limits = { perHour: 2, perDay: 5, maxActiveTrains: 5 };
  // Send a request with bad station — fails to resolve, should NOT count.
  const failClient = {
    async locations() { return []; },
    async departures() { return []; },
    async arrivals() { return []; },
    async trip() { throw new Error('not found'); },
  };
  for (let i = 0; i < 3; i++) {
    await handleInbound({
      email: baseEmail({ msgid: `<bad${i}@x>`, subject: 'From: Mars, To: Pluto' }),
      stateDir, primaryClient: failClient, limits,
    });
  }
  // After 3 hard fails, a real request should still go through.
  const r = await handleInbound({
    email: baseEmail({ msgid: '<good@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(), limits,
  });
  assert.match(r.subject, /Tracking ICE 145/);
});

test('active cap: sender at max gets tooManyActiveReply', async () => {
  const { stateDir } = setup();
  const limits = { perHour: 100, perDay: 100, maxActiveTrains: 2 };
  for (let i = 0; i < 2; i++) {
    await handleInbound({
      email: baseEmail({ msgid: `<m${i}@x>`, subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
      stateDir, primaryClient: fakeOebb(), limits,
    });
  }
  // 3rd should hit the active cap, not the rate limit.
  const r = await handleInbound({
    email: baseEmail({ msgid: '<m3@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(), limits,
  });
  assert.match(r.subject, /Too many active trains/);
  assert.match(r.body, /STOP/);
});

// ===== Disambiguation reply completion =====

const AMBIGUOUS_TRIP = {
  line: { name: 'EUR 9316', fahrtNr: '9316' },
  stopovers: [
    { stop: { name: 'Brussels Midi' },     plannedDeparture: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '1' },
    { stop: { name: 'Brussels Nord' },     plannedArrival:   '2026-04-29T08:05:00Z' },
    { stop: { name: 'Amsterdam Centraal' }, plannedArrival:   '2026-04-29T11:30:00Z', plannedArrivalPlatform: '4' },
  ],
};

const ambiguousOebb = () => ({
  async locations() { return [{ id: 'BRU', name: 'Brussels Midi', type: 'station' }]; },
  async departures() {
    return [{
      line: { name: 'EUR 9316', fahrtNr: '9316' }, direction: 'Amsterdam', tripId: 'TRIP_EUR9316',
      plannedWhen: '2026-04-29T08:00:00Z', plannedPlatform: '1',
    }];
  },
  async arrivals() { return []; },
  async trip(id) {
    if (id === 'TRIP_EUR9316') return AMBIGUOUS_TRIP;
    throw new Error(`unknown ${id}`);
  },
});

test('disambig: ambiguous From: parks state and replies with numbered list', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({ to: 'EUR9316@late.fyi', msgid: '<inb-1@x>', subject: 'From: Brussels, To: Amsterdam Centraal' }),
    stateDir, primaryClient: ambiguousOebb(),
  });
  assert.match(r.body, /Brussels Midi/);
  assert.equal(readdirSync(join(stateDir, 'pending-disambig')).length, 1);
});

test('disambig: digit reply resolves and schedules', async () => {
  const { stateDir } = setup();
  const r1 = await handleInbound({
    email: baseEmail({ to: 'EUR9316@late.fyi', msgid: '<inb-1@x>', subject: 'From: Brussels, To: Amsterdam Centraal' }),
    stateDir, primaryClient: ambiguousOebb(),
  });
  const ourMsgid = r1.headers['Message-ID'];
  assert.ok(ourMsgid);

  const r2 = await handleInbound({
    email: baseEmail({
      to: 'EUR9316@late.fyi', msgid: '<inb-2@x>',
      body: '1', subject: '',
      headers: { 'in-reply-to': ourMsgid },
    }),
    stateDir, primaryClient: ambiguousOebb(),
  });
  assert.match(r2.subject, /Tracking/);
  assert.deepEqual(readdirSync(join(stateDir, 'pending-disambig')), []);
});

test('disambig: out-of-range digit re-sends the numbered list (state preserved)', async () => {
  const { stateDir } = setup();
  const r1 = await handleInbound({
    email: baseEmail({ to: 'EUR9316@late.fyi', msgid: '<inb-1@x>', subject: 'From: Brussels, To: Amsterdam Centraal' }),
    stateDir, primaryClient: ambiguousOebb(),
  });
  const ourMsgid = r1.headers['Message-ID'];
  const r2 = await handleInbound({
    email: baseEmail({
      to: 'EUR9316@late.fyi', msgid: '<inb-2@x>',
      body: '99', subject: '',
      headers: { 'in-reply-to': ourMsgid },
    }),
    stateDir, primaryClient: ambiguousOebb(),
  });
  assert.match(r2.body, /Brussels Midi/);
  assert.equal(readdirSync(join(stateDir, 'pending-disambig')).length, 1);
});

test('stop: bare STOP to stop@ with no train number treats as STOP ALL, not "Stopped tracking null"', async () => {
  const { stateDir } = setup();
  // Track one train so STOP ALL has something to clear.
  await handleInbound({
    email: baseEmail({ msgid: '<a@x>', subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof' }),
    stateDir, primaryClient: fakeOebb(),
  });

  const r = await handleInbound({
    email: baseEmail({ to: 'stop@late.fyi', subject: 'STOP' }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.doesNotMatch(r.subject, /null/);
  assert.doesNotMatch(r.body, /null/);
  // Treated as STOP ALL — clears the record.
  assert.equal(readdirSync(join(stateDir, 'pending')).length, 0);
});

test('disambig: reply with unknown In-Reply-To is silently dropped', async () => {
  const { stateDir } = setup();
  const r = await handleInbound({
    email: baseEmail({
      to: 'ICE145@late.fyi', msgid: '<orphan@x>',
      body: '2', subject: '',
      headers: { 'in-reply-to': '<no-such-parent@late.fyi>' },
    }),
    stateDir, primaryClient: fakeOebb(),
  });
  assert.equal(r, null);
});
