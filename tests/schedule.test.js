// Behavior tests for schedule.js. Uses tmp dirs and synthetic resolved
// objects — schedule.js is filesystem + computation only, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  schedule, isDue, activate, readPending, buildPendingRecord,
} from '../src/schedule.js';

const td = () => mkdtempSync(join(tmpdir(), 'latefyi-sched-'));

const resolvedFixture = (overrides = {}) => ({
  kind: 'resolved',
  endpoint: 'oebb',
  tripId: 'TRIP_ICE145',
  line: 'ICE 145',
  trainNum: 'ICE145',
  mode: 'B',
  from: 'Amsterdam Centraal',
  to: 'Berlin Ostbahnhof',
  trip: null,
  channels: null,
  route: ['Amsterdam Centraal', 'Hilversum', 'Hannover Hbf', 'Berlin Hbf', 'Berlin Ostbahnhof'],
  schedule: {
    scheduledDeparture: '2026-04-29T10:00:00+02:00',
    scheduledArrival:   '2026-04-29T16:02:00+02:00',
  },
  ...overrides,
});

const parsedFixture = (overrides = {}) => ({
  kind: 'track',
  trainNum: 'ICE145',
  mode: 'B',
  from: 'Amsterdam Centraal',
  to: 'Berlin Ostbahnhof',
  trip: null,
  channels: null,
  inReplyTo: null,
  ...overrides,
});

const args = (over = {}) => ({
  msgid: '<m1@late.fyi>',
  sender: 'amr@example.com',
  parsed: parsedFixture(),
  resolved: resolvedFixture(),
  stateDir: over.stateDir,
  ...over,
});

// ===== happy path =====

test('writes pending/<msgid>.json with poll_start_time = depTime - 30min (default)', () => {
  const dir = td();
  const rec = schedule(args({ stateDir: dir }));
  assert.equal(rec.schedule.poll_start_time, '2026-04-29T07:30:00.000Z'); // 10:00 +02:00 → 08:00Z, -30min → 07:30Z
  // Plus 30min grace past 16:02+02:00 → 14:32Z
  assert.equal(rec.schedule.poll_end_time, '2026-04-29T14:32:00.000Z');
  assert.ok(existsSync(rec._path));
});

test('large terminal in From: → poll_start_time = depTime - 45min', () => {
  const dir = td();
  const rec = schedule(args({
    stateDir: dir,
    opts: { large_terminals: ['Amsterdam Centraal'] },
  }));
  assert.equal(rec.schedule.poll_start_time, '2026-04-29T07:15:00.000Z');
});

test('Mode A anchors poll_start_time on scheduledArrival - 30min', () => {
  const dir = td();
  const parsed = parsedFixture({ mode: 'A', from: null, to: 'Berlin Ostbahnhof' });
  const resolved = resolvedFixture({ mode: 'A', from: null });
  const rec = schedule(args({ stateDir: dir, parsed, resolved }));
  // 16:02+02:00 → 14:02Z, -30min → 13:32Z
  assert.equal(rec.schedule.poll_start_time, '2026-04-29T13:32:00.000Z');
});

// ===== record shape =====

test('record shape matches PRD §12 (request, resolved, schedule, state, pushes)', () => {
  const dir = td();
  const rec = schedule(args({ stateDir: dir }));
  assert.equal(rec.msgid, '<m1@late.fyi>');
  assert.equal(rec.sender, 'amr@example.com');
  assert.equal(rec.request.trainNum, 'ICE145');
  assert.equal(rec.request.mode, 'B');
  assert.equal(rec.resolved.endpoint, 'oebb');
  assert.equal(rec.resolved.tripId, 'TRIP_ICE145');
  assert.deepEqual(rec.resolved.route, ['Amsterdam Centraal', 'Hilversum', 'Hannover Hbf', 'Berlin Hbf', 'Berlin Ostbahnhof']);
  assert.equal(rec.state.phase, 'SCHEDULED');
  assert.equal(rec.state.endpointInUse, 'oebb');
  assert.equal(rec.state.consecutivePollFailures, 0);
  assert.deepEqual(rec.pushes, []);
});

test('trip and channels carried through to record.request', () => {
  const dir = td();
  const rec = schedule(args({
    stateDir: dir,
    parsed: parsedFixture({ trip: 'rome-2026', channels: 'both' }),
  }));
  assert.equal(rec.request.trip, 'rome-2026');
  assert.equal(rec.request.channels, 'both');
});

// ===== file safety =====

test('msgid with shell-unsafe chars produces sanitized filename', () => {
  const dir = td();
  const rec = schedule(args({ stateDir: dir, msgid: '<a/b c?d@late.fyi>' }));
  assert.match(rec._path, /pending\/[A-Za-z0-9._@-]+\.json$/);
  assert.ok(existsSync(rec._path));
});

test('idempotent: re-scheduling same msgid overwrites atomically', () => {
  const dir = td();
  const r1 = schedule(args({ stateDir: dir }));
  const r2 = schedule(args({
    stateDir: dir,
    parsed: parsedFixture({ trip: 'updated' }),
  }));
  assert.equal(r1._path, r2._path);
  const onDisk = JSON.parse(readFileSync(r2._path, 'utf8'));
  assert.equal(onDisk.request.trip, 'updated');
});

// ===== isDue / activate =====

test('isDue: false before poll_start_time, true after', () => {
  const dir = td();
  const rec = schedule(args({ stateDir: dir }));
  const startMs = new Date(rec.schedule.poll_start_time).getTime();
  assert.equal(isDue(rec, startMs - 1), false);
  assert.equal(isDue(rec, startMs), true);
  assert.equal(isDue(rec, startMs + 1000), true);
});

test('activate moves file pending → active', () => {
  const dir = td();
  const rec = schedule(args({ stateDir: dir }));
  const newPath = activate(rec._path, dir);
  assert.match(newPath, /\/active\//);
  assert.ok(existsSync(newPath));
  assert.ok(!existsSync(rec._path));
});

test('readPending returns null for missing file', () => {
  assert.equal(readPending('/does/not/exist.json'), null);
});

// ===== validation =====

test('schedule throws if resolved.kind !== "resolved"', () => {
  const dir = td();
  assert.throws(() =>
    schedule(args({ stateDir: dir, resolved: { kind: 'error' } })),
    /resolved\.kind/
  );
});

test('buildPendingRecord can be called as a pure helper (no I/O)', () => {
  const r = buildPendingRecord({
    msgid: '<x@y>', sender: 'a@b',
    parsed: parsedFixture(), resolved: resolvedFixture(),
    receivedAt: '2026-04-29T08:00:00Z',
  });
  assert.equal(r.received_at, '2026-04-29T08:00:00Z');
  assert.equal(r.state.phase, 'SCHEDULED');
});
