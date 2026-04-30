// Behavior tests for resolve(). Uses fake hafas-clients with canned responses,
// so tests are deterministic, offline, and fast. Each test wires up the data
// shape it cares about — no shared global fixtures, no test ordering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../src/resolve.js';

// ---- fake hafas-client builder ----

function fakeClient({ stations = {}, departures = {}, arrivals = {}, trips = {} } = {}) {
  return {
    async locations(query) {
      const key = query.toLowerCase();
      for (const [k, v] of Object.entries(stations)) {
        if (k.toLowerCase() === key || k.toLowerCase().includes(key)) return v;
      }
      return [];
    },
    async departures(stationId) {
      return departures[stationId] || [];
    },
    async arrivals(stationId) {
      return arrivals[stationId] || [];
    },
    async trip(tripId) {
      if (trips[tripId]) return trips[tripId];
      throw new Error(`unknown tripId ${tripId}`);
    },
  };
}

// ---- happy-path data: ICE 145 Amsterdam → Berlin, on ÖBB ----

const ICE145_TRIP = {
  line: { name: 'ICE 145', fahrtNr: '145' },
  stopovers: [
    { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T10:00:00+02:00', plannedDeparturePlatform: '8b' },
    { stop: { name: 'Hilversum' },           plannedArrival:   '2026-04-29T10:25:00+02:00' },
    { stop: { name: 'Hannover Hbf' },        plannedArrival:   '2026-04-29T13:30:00+02:00' },
    { stop: { name: 'Berlin Hbf' },          plannedArrival:   '2026-04-29T15:50:00+02:00' },
    { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T16:02:00+02:00', plannedArrivalPlatform: '2' },
  ],
};

const ICE145_DEPARTURE = {
  line: { name: 'ICE 145', fahrtNr: '145' },
  direction: 'Berlin Ostbahnhof',
  tripId: 'TRIP_ICE145',
  plannedWhen: '2026-04-29T10:00:00+02:00',
  plannedPlatform: '8b',
};

const oebbHappy = () => fakeClient({
  stations: {
    'Amsterdam Centraal': [{ id: '8400058', name: 'Amsterdam Centraal', type: 'station' }],
    'Berlin Ostbahnhof':  [{ id: '8010255', name: 'Berlin Ostbahnhof', type: 'station' }],
  },
  departures: { '8400058': [ICE145_DEPARTURE] },
  arrivals:   { '8010255': [{ ...ICE145_DEPARTURE, plannedWhen: '2026-04-29T16:02:00+02:00' }] },
  trips:      { TRIP_ICE145: ICE145_TRIP },
});

// ===== Mode B happy path =====

test('Mode B: ICE145 from Amsterdam to Berlin Ostbahnhof → resolved on oebb', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof', trip: null, channels: null, inReplyTo: null },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.endpoint, 'oebb');
  assert.equal(r.tripId, 'TRIP_ICE145');
  assert.equal(r.from, 'Amsterdam Centraal');
  assert.equal(r.to, 'Berlin Ostbahnhof');
  assert.equal(r.line, 'ICE 145');
  assert.equal(r.schedule.scheduledDeparture, '2026-04-29T10:00:00+02:00');
  assert.equal(r.schedule.scheduledArrival, '2026-04-29T16:02:00+02:00');
});

test('Mode B: From only (no To) → resolves To as terminus', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: null, trip: null, channels: null },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.from, 'Amsterdam Centraal');
  assert.equal(r.to, 'Berlin Ostbahnhof'); // last stop
});

// ===== Mode A happy path =====

test('Mode A: ICE145 picking up at Berlin Ostbahnhof', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'A', from: null, to: 'Berlin Ostbahnhof', trip: null, channels: null },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.from, null);
  assert.equal(r.to, 'Berlin Ostbahnhof');
});

// ===== Aliases / fuzzy matching =====

test('alias: user types "Berlin" → resolves uniquely on this route to Berlin Ostbahnhof? — actually ambiguous', async () => {
  // Route has both Berlin Hbf and Berlin Ostbahnhof, so "Berlin" is genuinely ambiguous.
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin', trip: null, channels: null },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'disambiguation_needed');
  assert.equal(r.field, 'to');
  assert.deepEqual(r.candidates.sort(), ['Berlin Hbf', 'Berlin Ostbahnhof']);
  // Already-resolved field is preserved
  assert.equal(r.partial.from, 'Amsterdam Centraal');
});

test('typo on the To: field within Levenshtein → resolves silently via matchStation', async () => {
  // Anchor station "Amsterdam Centraal" goes through HAFAS locations() (out of
  // our scope; we trust HAFAS to be fuzzy there). The To: field goes through
  // matchStation against the route. "Berlin Osthbanhof" is a 1-char swap of
  // "Berlin Ostbahnhof" → token-level Lev fixes it.
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Osthbanhof', trip: null, channels: null },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.to, 'Berlin Ostbahnhof');
});

// ===== Errors =====

test('train not found on either endpoint → train_not_found', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE999', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof' },
    primaryClient: oebbHappy(),
    fallbackClient: oebbHappy(),
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'train_not_found');
});

test('station not on route → station_not_on_route with route detail', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Roma Termini' },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'station_no_match');
  assert.ok(r.details.route.includes('Berlin Ostbahnhof'));
});

test('mode MISSING → error', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'MISSING', from: null, to: null },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'missing_context');
});

test('non-track parsed input → error', async () => {
  const r = await resolve({
    parsed: { kind: 'stop', scope: 'all' },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'invalid_parsed');
});

// ===== Fallback endpoint =====

test('primary returns nothing, fallback finds train → endpoint=pkp', async () => {
  const empty = fakeClient({});
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof' },
    primaryClient: empty,
    fallbackClient: oebbHappy(),
  });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.endpoint, 'pkp');
});

// ===== Trip tag and channels carry through =====

test('parsed.trip and parsed.channels are preserved on resolved result', async () => {
  const r = await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof', trip: 'rome-2026', channels: 'both' },
    primaryClient: oebbHappy(),
  });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.trip, 'rome-2026');
  assert.equal(r.channels, 'both');
});

test('parsed.onDate passes when=<Date> through to client.departures', async () => {
  let capturedOpts = null;
  const client = {
    async locations() { return [{ id: 'AMS', name: 'Amsterdam Centraal', type: 'stop' }]; },
    async departures(_id, opts) {
      capturedOpts = opts;
      return [];
    },
    async arrivals() { return []; },
    async trip() { throw new Error('not reached'); },
  };
  await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof', onDate: '2026-05-04' },
    primaryClient: client,
  });
  assert.ok(capturedOpts.when instanceof Date, 'when should be a Date');
  assert.equal(capturedOpts.when.toISOString(), '2026-05-04T00:00:00.000Z');
});

test('parsed.onDate absent → no when in opts (HAFAS uses now)', async () => {
  let capturedOpts = null;
  const client = {
    async locations() { return [{ id: 'AMS', name: 'Amsterdam Centraal', type: 'stop' }]; },
    async departures(_id, opts) { capturedOpts = opts; return []; },
    async arrivals() { return []; },
    async trip() { throw new Error('not reached'); },
  };
  await resolve({
    parsed: { kind: 'track', trainNum: 'ICE145', mode: 'B', from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof' },
    primaryClient: client,
  });
  assert.equal(capturedOpts.when, undefined);
});
