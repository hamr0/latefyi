// Behavior tests for diff.js — pure function, no fixtures or mocks needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff } from '../src/diff.js';

const baseSnap = (over = {}) => ({
  pollTimestamp: '2026-04-29T07:30:00Z',
  trainNum: 'ICE145', line: 'ICE 145', mode: 'B',
  cancelled: false, replaced: false,
  hasDeparted: false, hasArrived: false,
  scheduledDeparture: '2026-04-29T08:00:00Z',
  predictedDeparture: '2026-04-29T08:00:00Z',
  departureDelayMin: 0,
  departurePlatform: '8b', departurePlatformScheduled: '8b',
  scheduledArrival: '2026-04-29T14:02:00Z',
  predictedArrival: '2026-04-29T14:02:00Z',
  arrivalDelayMin: 0,
  arrivalPlatform: '2', arrivalPlatformScheduled: '2',
  fromName: 'Amsterdam Centraal', toName: 'Berlin Ostbahnhof',
  stopoversCancelled: {},
  ...over,
});

// ===== Window 1: tracking start =====

test('first snapshot ever → tracking_started event', () => {
  const events = diff(null, baseSnap());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tracking_started');
  assert.equal(events[0].priority, 'default');
});

// ===== Suppression: unchanged state → no events =====

test('unchanged snapshot → no events', () => {
  const s = baseSnap();
  assert.deepEqual(diff(s, s), []);
});

// ===== Anchor platform (Mode B = departure) =====

test('Mode B: dep platform null → value', () => {
  const prev = baseSnap({ departurePlatform: null });
  const curr = baseSnap({ departurePlatform: '7' });
  const e = diff(prev, curr);
  assert.equal(e.length, 1);
  assert.equal(e[0].type, 'platform_assigned');
  assert.match(e[0].title, /Platform 7/);
});

test('Mode B: dep platform changed', () => {
  const prev = baseSnap({ departurePlatform: '7' });
  const curr = baseSnap({ departurePlatform: '8b' });
  const e = diff(prev, curr);
  assert.equal(e.length, 1);
  assert.equal(e[0].type, 'platform_changed');
  assert.match(e[0].title, /CHANGED.*8b/);
});

// ===== Anchor platform (Mode A = arrival) =====

test('Mode A: arr platform null → value at To: triggers platform_assigned', () => {
  const prev = baseSnap({ mode: 'A', arrivalPlatform: null });
  const curr = baseSnap({ mode: 'A', arrivalPlatform: '4' });
  const e = diff(prev, curr);
  assert.equal(e.length, 1);
  assert.equal(e[0].type, 'platform_assigned');
});

test('Mode A: arr platform changed', () => {
  const prev = baseSnap({ mode: 'A', arrivalPlatform: '2' });
  const curr = baseSnap({ mode: 'A', arrivalPlatform: '4' });
  const e = diff(prev, curr);
  assert.ok(e.find(x => x.type === 'platform_changed'));
});

// ===== Delay thresholds =====

test('Mode B pre-departure: delay change ≥2min fires high-priority event', () => {
  const prev = baseSnap({ departureDelayMin: 0 });
  const curr = baseSnap({ departureDelayMin: 3 });
  const e = diff(prev, curr);
  const d = e.find(x => x.type === 'delay_change');
  assert.ok(d);
  assert.equal(d.priority, 'high');
});

test('Mode B pre-departure: delay change <2min suppressed', () => {
  const prev = baseSnap({ departureDelayMin: 0 });
  const curr = baseSnap({ departureDelayMin: 1 });
  const e = diff(prev, curr);
  assert.equal(e.find(x => x.type === 'delay_change'), undefined);
});

test('Mode B in-transit: delay change <5min suppressed (looser threshold)', () => {
  const prev = baseSnap({ hasDeparted: true, departureDelayMin: 5, arrivalDelayMin: 5 });
  const curr = baseSnap({ hasDeparted: true, departureDelayMin: 7, arrivalDelayMin: 5 });
  // Anchor (dep) delta = 2 — below in-transit threshold of 5 → no anchor delay event
  const e = diff(prev, curr);
  assert.equal(e.find(x => x.type === 'delay_change'), undefined);
});

test('Mode A: delay change ≥2min fires (uses arrivalDelayMin)', () => {
  const prev = baseSnap({ mode: 'A', arrivalDelayMin: 0 });
  const curr = baseSnap({ mode: 'A', arrivalDelayMin: 4 });
  const e = diff(prev, curr);
  assert.ok(e.find(x => x.type === 'delay_change'));
});

// ===== Mode B post-departure: arrival platform & delay propagation =====

test('Mode B post-departure: arrival platform changed → arrival_platform_changed event', () => {
  const prev = baseSnap({ hasDeparted: true, arrivalPlatform: '2' });
  const curr = baseSnap({ hasDeparted: true, arrivalPlatform: '4' });
  const e = diff(prev, curr);
  assert.ok(e.find(x => x.type === 'arrival_platform_changed'));
});

test('Mode B post-departure: arrival delay propagating ≥5min → arrival_delay_change', () => {
  const prev = baseSnap({ hasDeparted: true, arrivalDelayMin: 0 });
  const curr = baseSnap({ hasDeparted: true, arrivalDelayMin: 7 });
  const e = diff(prev, curr);
  assert.ok(e.find(x => x.type === 'arrival_delay_change'));
});

test('Mode B post-departure: arrival delay <5min suppressed', () => {
  const prev = baseSnap({ hasDeparted: true, arrivalDelayMin: 1 });
  const curr = baseSnap({ hasDeparted: true, arrivalDelayMin: 3 });
  const e = diff(prev, curr);
  assert.equal(e.find(x => x.type === 'arrival_delay_change'), undefined);
});

// ===== Terminating short =====

test('terminating_short: user toName becomes cancelled', () => {
  const prev = baseSnap({ stopoversCancelled: {} });
  const curr = baseSnap({ stopoversCancelled: { 'Berlin Ostbahnhof': true } });
  const e = diff(prev, curr);
  const t = e.find(x => x.type === 'terminating_short');
  assert.ok(t);
  assert.equal(t.priority, 'urgent');
});

test('terminating_short: not fired if a different stop is cancelled', () => {
  const prev = baseSnap();
  const curr = baseSnap({ stopoversCancelled: { 'Hannover Hbf': true } });
  const e = diff(prev, curr);
  assert.equal(e.find(x => x.type === 'terminating_short'), undefined);
});

// ===== Cancellation / replacement =====

test('cancellation short-circuits: only "cancelled" event, nothing else', () => {
  const prev = baseSnap();
  const curr = baseSnap({ cancelled: true, departurePlatform: 'X' /* ignored */ });
  const e = diff(prev, curr);
  assert.equal(e.length, 1);
  assert.equal(e[0].type, 'cancelled');
  assert.equal(e[0].priority, 'urgent');
});

test('replaced fires its own event (not short-circuited)', () => {
  const prev = baseSnap();
  const curr = baseSnap({ replaced: true, departurePlatform: '8b' /* unchanged */ });
  const e = diff(prev, curr);
  assert.ok(e.find(x => x.type === 'replaced'));
});

// ===== Departed / arrived transitions =====

test('Mode B: hasDeparted false → true fires departed event', () => {
  const prev = baseSnap({ hasDeparted: false });
  const curr = baseSnap({ hasDeparted: true });
  const e = diff(prev, curr);
  assert.ok(e.find(x => x.type === 'departed'));
});

test('Mode A: hasDeparted transition does NOT fire departed (pickup user does not care)', () => {
  const prev = baseSnap({ mode: 'A', hasDeparted: false });
  const curr = baseSnap({ mode: 'A', hasDeparted: true });
  const e = diff(prev, curr);
  assert.equal(e.find(x => x.type === 'departed'), undefined);
});

test('hasArrived false → true fires arrived (terminal, both modes)', () => {
  for (const mode of ['A', 'B']) {
    const prev = baseSnap({ mode, hasArrived: false });
    const curr = baseSnap({ mode, hasArrived: true });
    const e = diff(prev, curr);
    assert.ok(e.find(x => x.type === 'arrived'), `mode ${mode} should fire arrived`);
  }
});

// ===== Multiple simultaneous changes =====

test('multiple simultaneous changes produce multiple events', () => {
  const prev = baseSnap({ departurePlatform: '7', departureDelayMin: 0 });
  const curr = baseSnap({ departurePlatform: '8b', departureDelayMin: 5 });
  const e = diff(prev, curr);
  const types = e.map(x => x.type);
  assert.ok(types.includes('platform_changed'));
  assert.ok(types.includes('delay_change'));
});

// ===== Mode A pickup body shape =====

const pickupSnap = (over = {}) => baseSnap({
  mode: 'A',
  fromName: null,
  // Pickup users only supply To:; resolve.js leaves dep schedule unset.
  scheduledDeparture: null, predictedDeparture: null, departureDelayMin: 0,
  departurePlatform: null, departurePlatformScheduled: null,
  toName: 'Paris Nord',
  scheduledArrival: '2026-05-04T12:40:00Z',
  predictedArrival: '2026-05-04T12:40:00Z',
  arrivalDelayMin: 0,
  arrivalPlatform: null, arrivalPlatformScheduled: null,
  ...over,
});

test('Mode A T-30: title + body use Picking up verb, no origin', () => {
  const e = diff(null, pickupSnap());
  assert.equal(e.length, 1);
  assert.equal(e[0].type, 'tracking_started');
  assert.equal(e[0].title, 'Picking up ICE 145');
  assert.match(e[0].body, /^Picking up ICE 145 at Paris Nord\./);
  assert.doesNotMatch(e[0].body, /→/);
  assert.doesNotMatch(e[0].body, /\bdep\b/);
  assert.doesNotMatch(e[0].body, /Departure platform/);
});

test('Mode A T-30: body shows Scheduled arrival only (no dep line)', () => {
  const e = diff(null, pickupSnap());
  assert.match(e[0].body, /Scheduled arrival: .* Paris Nord\./);
  assert.match(e[0].body, /Arrival platform: TBC/);
});

test('Mode A platform_assigned: headline says arrival platform at <to>', () => {
  const prev = pickupSnap({ arrivalPlatform: null });
  const curr = pickupSnap({ arrivalPlatform: '5' });
  const e = diff(prev, curr);
  const ev = e.find(x => x.type === 'platform_assigned');
  assert.ok(ev);
  assert.match(ev.body, /^ICE 145 arrival platform: 5, at Paris Nord\./);
  assert.doesNotMatch(ev.body, /\? →/);
  assert.doesNotMatch(ev.body, /Departure platform/);
});

test('Mode A delay_change: headline reads "<line> arrival +Nmin, at <to>"', () => {
  const prev = pickupSnap({ arrivalDelayMin: 0 });
  const curr = pickupSnap({ arrivalDelayMin: 6 });
  const e = diff(prev, curr);
  const ev = e.find(x => x.type === 'delay_change');
  assert.ok(ev);
  assert.match(ev.body, /^ICE 145 arrival \+6min, at Paris Nord\./);
});

test('Mode A terminating_short: drops route tail (no "at X, at X")', () => {
  const prev = pickupSnap({ stopoversCancelled: {} });
  const curr = pickupSnap({ stopoversCancelled: { 'Paris Nord': true } });
  const e = diff(prev, curr);
  const ev = e.find(x => x.type === 'terminating_short');
  assert.ok(ev);
  assert.match(ev.body, /^ICE 145 TERMINATING before Paris Nord\./);
  assert.doesNotMatch(ev.body, /at Paris Nord, at Paris Nord/);
});

test('Mode A arrived: drops route tail (no "arrived X, at X")', () => {
  const prev = pickupSnap({ hasArrived: false });
  const curr = pickupSnap({ hasArrived: true, arrivalPlatform: '5' });
  const e = diff(prev, curr);
  const ev = e.find(x => x.type === 'arrived');
  assert.ok(ev);
  assert.match(ev.body, /^ICE 145 arrived Paris Nord\./);
  assert.doesNotMatch(ev.body, /arrived Paris Nord, at Paris Nord/);
});

test('Mode B regression: T-30 body still says "Tracking <line>, A → B."', () => {
  const e = diff(null, baseSnap());
  assert.match(e[0].body, /^Tracking ICE 145, Amsterdam Centraal → Berlin Ostbahnhof\./);
  assert.match(e[0].body, /Departure platform:/);
});
