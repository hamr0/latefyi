// Behavior tests for poll.js. Uses fake hafas-client + synthetic active records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll, buildSnapshot, computePhase, pollIntervalMs, shouldPollNow, isTerminal } from '../src/poll.js';

// ---- fixtures ----

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

const baseRecord = (over = {}) => ({
  msgid: '<m1@late.fyi>',
  sender: 'amr@example.com',
  request: { trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof' },
  resolved: { endpoint: 'oebb', tripId: 'TRIP_ICE145', line: 'ICE 145', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof', scheduledArrivalAtTo: '2026-04-29T14:02:00Z' },
  schedule: { poll_start_time: '2026-04-29T07:30:00Z', poll_end_time: '2026-04-29T14:32:00Z' },
  state: { phase: 'PRE_DEPARTURE', lastPolledAt: null, lastPushedSnapshot: null, consecutivePollFailures: 0, endpointInUse: 'oebb' },
  pushes: [],
  ...over,
});

// ===== buildSnapshot =====

test('buildSnapshot: pre-departure pulls dep + arr fields, hasDeparted=false', () => {
  const ctx = { trainNum: 'ICE145', mode: 'B', fromName: 'Amsterdam Centraal', toName: 'Berlin Ostbahnhof' };
  const now = new Date('2026-04-29T07:30:00Z').getTime();
  const s = buildSnapshot(ICE145_TRIP, ctx, now);
  assert.equal(s.line, 'ICE 145');
  assert.equal(s.fromName, 'Amsterdam Centraal');
  assert.equal(s.toName, 'Berlin Ostbahnhof');
  assert.equal(s.departurePlatform, '8b');
  assert.equal(s.arrivalPlatform, '2');
  assert.equal(s.hasDeparted, false);
  assert.equal(s.hasArrived, false);
});

test('buildSnapshot: post-departure (now after dep time) → hasDeparted=true', () => {
  const ctx = { trainNum: 'ICE145', mode: 'B', fromName: 'Amsterdam Centraal', toName: 'Berlin Ostbahnhof' };
  const now = new Date('2026-04-29T08:30:00Z').getTime();
  const s = buildSnapshot(ICE145_TRIP, ctx, now);
  assert.equal(s.hasDeparted, true);
  assert.equal(s.hasArrived, false);
});

test('buildSnapshot: post-arrival → hasArrived=true', () => {
  const ctx = { trainNum: 'ICE145', mode: 'B', fromName: 'Amsterdam Centraal', toName: 'Berlin Ostbahnhof' };
  const now = new Date('2026-04-29T15:00:00Z').getTime();
  const s = buildSnapshot(ICE145_TRIP, ctx, now);
  assert.equal(s.hasArrived, true);
});

test('buildSnapshot: collects stopoversCancelled map', () => {
  const trip = JSON.parse(JSON.stringify(ICE145_TRIP));
  trip.stopovers[2].cancelled = true; // Berlin Ostbahnhof cancelled
  const s = buildSnapshot(trip, { trainNum: 'ICE145', mode: 'B', fromName: 'Amsterdam Centraal', toName: 'Berlin Ostbahnhof' }, Date.now());
  assert.equal(s.stopoversCancelled['Berlin Ostbahnhof'], true);
});

test('buildSnapshot: Mode A picks anchor as arrival station', () => {
  const ctx = { trainNum: 'ICE145', mode: 'A', fromName: null, toName: 'Berlin Ostbahnhof' };
  const s = buildSnapshot(ICE145_TRIP, ctx, Date.now());
  assert.equal(s.toName, 'Berlin Ostbahnhof');
  assert.equal(s.arrivalPlatform, '2');
});

// ===== poll: happy path =====

test('first poll on a fresh record fires tracking_started, updates record', async () => {
  const rec = baseRecord();
  const now = new Date('2026-04-29T07:30:00Z').getTime();
  const r = await poll({ activeRecord: rec, client: fakeClient(), now });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'tracking_started');
  assert.equal(r.updatedRecord.state.lastPolledAt, '2026-04-29T07:30:00.000Z');
  assert.ok(r.updatedRecord.state.lastPushedSnapshot);
  assert.equal(r.updatedRecord.pushes.length, 1);
});

test('second poll with no changes → 0 events, lastPushedSnapshot unchanged', async () => {
  const rec = baseRecord();
  const now1 = new Date('2026-04-29T07:30:00Z').getTime();
  const r1 = await poll({ activeRecord: rec, client: fakeClient(), now: now1 });

  const now2 = new Date('2026-04-29T07:31:00Z').getTime();
  const r2 = await poll({ activeRecord: r1.updatedRecord, client: fakeClient(), now: now2 });
  assert.equal(r2.events.length, 0);
  // baseline preserved
  assert.deepEqual(
    r2.updatedRecord.state.lastPushedSnapshot,
    r1.updatedRecord.state.lastPushedSnapshot
  );
});

test('platform change between polls → platform_changed event', async () => {
  const rec = baseRecord();
  const now1 = new Date('2026-04-29T07:30:00Z').getTime();
  const r1 = await poll({ activeRecord: rec, client: fakeClient(), now: now1 });

  // Mutate the trip data: dep platform changes to 7
  const trip2 = JSON.parse(JSON.stringify(ICE145_TRIP));
  trip2.stopovers[0].departurePlatform = '7';
  trip2.stopovers[0].plannedDeparturePlatform = '8b';

  const now2 = new Date('2026-04-29T07:31:00Z').getTime();
  const r2 = await poll({ activeRecord: r1.updatedRecord, client: fakeClient({ TRIP_ICE145: trip2 }), now: now2 });
  assert.ok(r2.events.find(e => e.type === 'platform_changed'));
});

// ===== poll: failure handling =====

test('poll failure increments consecutivePollFailures', async () => {
  const failingClient = { async trip() { throw new Error('endpoint down'); } };
  const rec = baseRecord();
  const r = await poll({ activeRecord: rec, client: failingClient, now: Date.now() });
  assert.equal(r.error, 'endpoint down');
  assert.equal(r.updatedRecord.state.consecutivePollFailures, 1);
  assert.deepEqual(r.events, []);
});

test('6 consecutive failures emits tracking_lost', async () => {
  const failingClient = { async trip() { throw new Error('endpoint down'); } };
  const rec = baseRecord({ state: { ...baseRecord().state, consecutivePollFailures: 5 } });
  const r = await poll({ activeRecord: rec, client: failingClient, now: Date.now() });
  assert.equal(r.updatedRecord.state.consecutivePollFailures, 6);
  assert.ok(r.events.find(e => e.type === 'tracking_lost'));
});

test('successful poll after failures resets the counter to 0', async () => {
  const rec = baseRecord({ state: { ...baseRecord().state, consecutivePollFailures: 3 } });
  const r = await poll({ activeRecord: rec, client: fakeClient(), now: new Date('2026-04-29T07:30:00Z').getTime() });
  assert.equal(r.updatedRecord.state.consecutivePollFailures, 0);
});

// ===== phase + cadence =====

test('computePhase: pre_anchor before departure', () => {
  const rec = baseRecord();
  const now = new Date('2026-04-29T07:30:00Z').getTime();
  assert.equal(computePhase(rec, now), 'pre_anchor');
});

test('computePhase: in_transit after departure (Mode B)', () => {
  const departed = { hasDeparted: true, hasArrived: false, scheduledArrival: '2026-04-29T14:02:00Z' };
  const rec = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: departed } });
  const now = new Date('2026-04-29T10:00:00Z').getTime();
  assert.equal(computePhase(rec, now), 'in_transit');
});

test('computePhase: arrival_window when within T-5 of scheduledArrival', () => {
  const rec = baseRecord();
  const now = new Date('2026-04-29T13:58:00Z').getTime(); // 4 min before 14:02
  assert.equal(computePhase(rec, now), 'arrival_window');
});

test('computePhase: terminal once cancelled or arrived', () => {
  const cancelled = { hasArrived: false, cancelled: true };
  const r1 = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: cancelled } });
  assert.equal(computePhase(r1, Date.now()), 'terminal');

  const arrived = { hasArrived: true, hasDeparted: true };
  const r2 = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: arrived } });
  assert.equal(computePhase(r2, Date.now()), 'terminal');
});

test('pollIntervalMs: 30s pre_anchor, 60s in_transit', () => {
  const rec = baseRecord();
  assert.equal(pollIntervalMs(rec, new Date('2026-04-29T07:30:00Z').getTime()), 30_000);

  const departed = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: { hasDeparted: true, hasArrived: false, scheduledArrival: '2026-04-29T14:02:00Z' } } });
  assert.equal(pollIntervalMs(departed, new Date('2026-04-29T10:00:00Z').getTime()), 60_000);
});

test('shouldPollNow: false if last poll was recent enough', () => {
  const rec = baseRecord({ state: { ...baseRecord().state, lastPolledAt: '2026-04-29T07:30:00Z' } });
  assert.equal(shouldPollNow(rec, new Date('2026-04-29T07:30:10Z').getTime()), false); // 10s after, threshold 30s
  assert.equal(shouldPollNow(rec, new Date('2026-04-29T07:30:31Z').getTime()), true);
});

test('shouldPollNow: false in terminal phase', () => {
  const rec = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: { hasArrived: true, hasDeparted: true, predictedArrival: '2026-04-29T13:00:00Z' } } });
  assert.equal(shouldPollNow(rec, new Date('2026-04-29T15:00:00Z').getTime()), false);
});

// ===== isTerminal =====

test('isTerminal: cancelled = terminal immediately', () => {
  const rec = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: { cancelled: true } } });
  assert.equal(isTerminal(rec, Date.now()), true);
});

test('isTerminal: arrived but within 5min linger window → not yet terminal', () => {
  const rec = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: { hasArrived: true, predictedArrival: '2026-04-29T14:02:00Z' } } });
  const now = new Date('2026-04-29T14:04:00Z').getTime(); // 2 min after
  assert.equal(isTerminal(rec, now), false);
});

test('isTerminal: arrived + linger expired → terminal', () => {
  const rec = baseRecord({ state: { ...baseRecord().state, lastPushedSnapshot: { hasArrived: true, predictedArrival: '2026-04-29T14:02:00Z' } } });
  const now = new Date('2026-04-29T14:08:00Z').getTime(); // 6 min after
  assert.equal(isTerminal(rec, now), true);
});

test('isTerminal: past poll_end_time grace → terminal', () => {
  const rec = baseRecord();
  const now = new Date('2026-04-29T15:00:00Z').getTime(); // past 14:32 end
  assert.equal(isTerminal(rec, now), true);
});
