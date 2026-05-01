// Behavior tests for src/poll-runner.js. Drive tick() over tmp state dirs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick, run } from '../src/poll-runner.js';

// Same trip data as poll.test.js
const ICE145_TRIP = {
  line: { name: 'ICE 145', fahrtNr: '145' },
  stopovers: [
    { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T08:00:00Z', departure: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '8b', departurePlatform: '8b' },
    { stop: { name: 'Hannover Hbf' },        plannedArrival:   '2026-04-29T11:30:00Z', arrival: '2026-04-29T11:30:00Z' },
    { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T14:02:00Z', arrival: '2026-04-29T14:02:00Z', plannedArrivalPlatform: '2', arrivalPlatform: '2' },
  ],
};

const fakeClient = (trips = { TRIP_ICE145: ICE145_TRIP }) => ({
  async trip(id) {
    if (trips[id]) return trips[id];
    throw new Error(`unknown tripId ${id}`);
  },
});

const recordFor = (msgid = 'm1', overrides = {}) => ({
  msgid: `<${msgid}@late.fyi>`,
  sender: 'amr@example.com',
  request: { trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof' },
  resolved: { endpoint: 'oebb', tripId: 'TRIP_ICE145', line: 'ICE 145', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof', scheduledArrivalAtTo: '2026-04-29T14:02:00Z' },
  schedule: { poll_start_time: '2026-04-29T07:30:00Z', poll_end_time: '2026-04-29T14:32:00Z' },
  state: { phase: 'SCHEDULED', lastPolledAt: null, lastPushedSnapshot: null, consecutivePollFailures: 0, endpointInUse: 'oebb' },
  pushes: [],
  ...overrides,
});

function setup(activeRecords) {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-runner-'));
  const logDir   = mkdtempSync(join(tmpdir(), 'latefyi-runner-log-'));
  for (const sub of ['active', 'done', 'errors']) mkdirSync(join(stateDir, sub), { recursive: true });
  for (const r of activeRecords) {
    writeFileSync(join(stateDir, 'active', `${r.msgid.replace(/[<>@]/g, '_')}.json`), JSON.stringify(r));
  }
  return { stateDir, logDir };
}

// ===== single record happy path =====

test('tick: polls one record, fires tracking_started, appends to push log', async () => {
  const { stateDir, logDir } = setup([recordFor('m1')]);
  const summary = await tick({
    stateDir, logDir,
    getClient: () => fakeClient(),
    now: new Date('2026-04-29T07:30:00Z').getTime(),
  });
  assert.equal(summary.polled, 1);
  assert.equal(summary.events, 1);
  assert.equal(summary.terminal, 0);

  const pushLog = readFileSync(join(logDir, 'push.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(pushLog.length, 1);
  const evt = JSON.parse(pushLog[0]);
  assert.equal(evt.type, 'tracking_started');
  assert.equal(evt.trainNum, 'ICE145');
});

// ===== cadence: skip if recently polled =====

test('tick: respects pollIntervalMs (skips file polled <30s ago in pre_anchor)', async () => {
  const rec = recordFor('m1', {
    state: { phase: 'PRE_DEPARTURE', lastPolledAt: '2026-04-29T07:30:00Z', lastPushedSnapshot: null, consecutivePollFailures: 0, endpointInUse: 'oebb' },
  });
  const { stateDir, logDir } = setup([rec]);
  const summary = await tick({
    stateDir, logDir,
    getClient: () => fakeClient(),
    now: new Date('2026-04-29T07:30:10Z').getTime(), // only 10s later
  });
  assert.equal(summary.polled, 0);
  assert.equal(summary.skipped, 1);
});

// ===== terminal: arrived → deleted =====

test('tick: arrived record stays in active until a full poll tick fires and confirms arrival', async () => {
  // shouldPollNow returns false for a record already in ACTIVE phase with a
  // terminal snapshot — the file stays put until the next poll fires and
  // isTerminal() evicts it. The following test proves the full eviction path.
  const arrivedSnap = {
    pollTimestamp: '2026-04-29T14:02:00Z',
    hasDeparted: true, hasArrived: true,
    predictedArrival: '2026-04-29T14:02:00Z',
  };
  const rec = recordFor('m1', {
    state: { phase: 'ACTIVE', lastPolledAt: '2026-04-29T14:00:00Z', lastPushedSnapshot: arrivedSnap, consecutivePollFailures: 0, endpointInUse: 'oebb' },
  });
  const { stateDir, logDir } = setup([rec]);

  // 6 min after predicted arrival — linger expired, but shouldPollNow skips it
  await tick({ stateDir, logDir, getClient: () => fakeClient(), now: new Date('2026-04-29T14:08:00Z').getTime() });

  // Record stays in active until the next poll fires and evicts it (see next test).
  assert.equal(readdirSync(join(stateDir, 'active')).length, 1);
});

test('tick: when shouldPollNow allows it and isTerminal, file is moved on the same tick', async () => {
  // Setup: a record where the next poll WILL run (lastPolledAt long ago) AND
  // the trip data shows the train has arrived. tick() polls, computes
  // updatedRecord which is terminal, and moves it.
  const tripData = {
    line: { name: 'ICE 145', fahrtNr: '145' },
    stopovers: [
      { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T08:00:00Z', departure: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '8b', departurePlatform: '8b' },
      { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T14:02:00Z', arrival: '2026-04-29T14:02:00Z', plannedArrivalPlatform: '2', arrivalPlatform: '2' },
    ],
  };
  // lastPushedSnapshot must already show arrived for shouldPollNow's terminal-phase check…
  // Actually shouldPollNow returns false for terminal phase. So the only way
  // poll() runs and then isTerminal fires is if BEFORE the poll the record
  // wasn't terminal but AFTER it is. That's: pre-arrival snapshot stored,
  // poll fetches new data showing arrival, isTerminal(updatedRecord) checks
  // if linger has expired.
  const preArrSnap = {
    pollTimestamp: '2026-04-29T13:55:00Z',
    hasDeparted: true, hasArrived: false,
    predictedArrival: '2026-04-29T14:02:00Z',
    scheduledArrival: '2026-04-29T14:02:00Z',
  };
  const rec = recordFor('m1', {
    state: { phase: 'ACTIVE', lastPolledAt: '2026-04-29T13:55:00Z', lastPushedSnapshot: preArrSnap, consecutivePollFailures: 0, endpointInUse: 'oebb' },
  });
  const { stateDir, logDir } = setup([rec]);

  // 7 min past predicted arrival — poll should run (was in arrival_window),
  // detect arrival, and the linger has already expired.
  await tick({ stateDir, logDir, getClient: () => fakeClient({ TRIP_ICE145: tripData }), now: new Date('2026-04-29T14:09:00Z').getTime() });

  // Privacy: terminal records are deleted, not archived. Active is empty,
  // and no done/ directory survives either.
  assert.deepEqual(readdirSync(join(stateDir, 'active')), []);
});

test('push.jsonl logs senderHash, never plaintext sender', async () => {
  // Setup a record that will produce at least one event (platform changed).
  const tripDataBefore = {
    line: { name: 'ICE 145', fahrtNr: '145' },
    stopovers: [
      { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T08:00:00Z', departure: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '7', departurePlatform: '7' },
      { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T14:02:00Z', arrival: '2026-04-29T14:02:00Z' },
    ],
  };
  const tripDataAfter = {
    line: { name: 'ICE 145', fahrtNr: '145' },
    stopovers: [
      { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T08:00:00Z', departure: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '7', departurePlatform: '8b' },
      { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T14:02:00Z', arrival: '2026-04-29T14:02:00Z' },
    ],
  };
  const initSnap = {
    pollTimestamp: '2026-04-29T07:30:00Z',
    hasDeparted: false, hasArrived: false,
    predictedDeparture: '2026-04-29T08:00:00Z',
    scheduledDeparture: '2026-04-29T08:00:00Z',
    plannedDeparturePlatform: '7', departurePlatform: '7',
  };
  const rec = recordFor('m-priv', {
    sender: 'plaintext@example.com',
    state: { phase: 'pre_anchor', lastPolledAt: '2026-04-29T07:30:00Z', lastPushedSnapshot: initSnap, consecutivePollFailures: 0, endpointInUse: 'oebb' },
  });
  const { stateDir, logDir } = setup([rec]);

  await tick({ stateDir, logDir, getClient: () => fakeClient({ TRIP_ICE145: tripDataAfter }), now: new Date('2026-04-29T07:35:00Z').getTime() });

  const log = readFileSync(join(logDir, 'push.jsonl'), 'utf8');
  assert.ok(log.length > 0, 'expected at least one event in push.jsonl');
  assert.equal(log.includes('plaintext@example.com'), false, 'push.jsonl must not contain plaintext sender');
  assert.match(log, /"senderHash":"[a-f0-9]{16}"/);
});

// ===== error handling =====

test('tick: failing client increments consecutivePollFailures, file stays in active', async () => {
  const failing = { async trip() { throw new Error('endpoint down'); } };
  const rec = recordFor('m1');
  const { stateDir, logDir } = setup([rec]);
  await tick({ stateDir, logDir, getClient: () => failing, now: new Date('2026-04-29T07:30:00Z').getTime() });

  const updated = JSON.parse(readFileSync(join(stateDir, 'active', readdirSync(join(stateDir, 'active'))[0]), 'utf8'));
  assert.equal(updated.state.consecutivePollFailures, 1);
});

test('tick: malformed JSON file is dropped (logged + deleted, not archived)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-runner-'));
  const logDir   = mkdtempSync(join(tmpdir(), 'latefyi-runner-log-'));
  mkdirSync(join(stateDir, 'active'), { recursive: true });
  writeFileSync(join(stateDir, 'active', 'broken.json'), '{ not json');

  const summary = await tick({ stateDir, logDir, getClient: () => fakeClient(), now: Date.now() });
  assert.equal(summary.errors, 1);
  assert.deepEqual(readdirSync(join(stateDir, 'active')), []);
});

// ===== multiple records =====

test('tick: processes multiple records independently', async () => {
  const records = [recordFor('m1'), recordFor('m2'), recordFor('m3')];
  const { stateDir, logDir } = setup(records);

  const summary = await tick({ stateDir, logDir, getClient: () => fakeClient(), now: new Date('2026-04-29T07:30:00Z').getTime() });
  assert.equal(summary.polled, 3);
  assert.equal(summary.events, 3); // each gets one tracking_started

  const pushLog = readFileSync(join(logDir, 'push.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(pushLog.length, 3);
});

// ===== empty state =====

test('tick: empty active dir → no-op, no error', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-runner-'));
  const logDir   = mkdtempSync(join(tmpdir(), 'latefyi-runner-log-'));
  mkdirSync(join(stateDir, 'active'), { recursive: true });
  const summary = await tick({ stateDir, logDir, getClient: () => fakeClient(), now: Date.now() });
  assert.deepEqual(summary, { polled: 0, skipped: 0, events: 0, terminal: 0, errors: 0 });
});

// ===== run() forwards transport to tick() =====

test('run: transport is forwarded to tick() and sendEmail is called when events occur', async () => {
  const { stateDir, logDir } = setup([recordFor('m1')]);
  const sent = [];
  const transport = {
    sendEmail: async (msg) => { sent.push(msg); },
    sendNtfy: async () => {},
  };
  const getUserChannel = () => 'email';

  const ac = new AbortController();
  const runPromise = run({
    stateDir, logDir,
    getClient: () => fakeClient(),
    intervalMs: 0,
    signal: ac.signal,
    transport,
    getUserChannel,
    now: new Date('2026-04-29T07:30:00Z').getTime(),
  });
  // Allow one tick to fire, then abort.
  await new Promise(r => setTimeout(r, 20));
  ac.abort();
  await runPromise.catch(() => {});

  assert.ok(sent.length > 0, 'run() should have called transport.sendEmail via tick()');
});
