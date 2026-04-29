// Behavior tests for reply templates. Each function returns
// { from, to, subject, body, headers } — assertions are on those.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOOTER, confirmationReply, missingContextReply, trainNotFoundReply,
  stationNotOnRouteReply, ambiguousStationReply, alreadyArrivedReply,
  unauthorizedSenderReply, stopReply, ntfyOptInReply, pushReply,
  genericErrorReply,
} from '../src/reply.js';

const sampleResolved = (over = {}) => ({
  trainNum: 'ICE145', line: 'ICE 145',
  from: 'Amsterdam Centraal', to: 'Berlin Ostbahnhof',
  trip: null,
  schedule: { scheduledDeparture: '2026-04-29T08:00:00Z', scheduledArrival: '2026-04-29T14:02:00Z' },
  ...over,
});

// ===== footer =====

test('every reply ends with FOOTER', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b' });
  assert.ok(r.body.endsWith(FOOTER));
});

test('FOOTER mentions late.fyi format and STOP variants', () => {
  assert.match(FOOTER, /late\.fyi/);
  assert.match(FOOTER, /STOP/);
  assert.match(FOOTER, /Trip:/);
});

// ===== from / to / threading =====

test('reply.from is noreply@late.fyi', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b' });
  assert.equal(r.from, 'noreply@late.fyi');
});

test('reply.to is the original sender', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'amr@example.com' });
  assert.equal(r.to, 'amr@example.com');
});

test('In-Reply-To header is set when incomingMsgid provided', () => {
  const r = confirmationReply({
    resolved: sampleResolved(), sender: 'a@b',
    incomingMsgid: '<incoming@late.fyi>',
  });
  assert.equal(r.headers['In-Reply-To'], '<incoming@late.fyi>');
});

// ===== confirmation: channel-aware blurb =====

test('confirmation: default email channel mentions email + nudge to ntfy', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b' });
  assert.match(r.body, /by email/i);
  assert.match(r.body, /CHANNELS ntfy/);
});

test('confirmation: ntfy channel says push starts T-30, offers email switch', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b', channel: 'ntfy' });
  assert.match(r.body, /Push starts T-30/);
  assert.match(r.body, /CHANNELS email/);
});

test('confirmation: both channel mentions both', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b', channel: 'both' });
  assert.match(r.body, /both email and ntfy/);
});

test('confirmation: T-30 time computed from scheduledDeparture', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b' });
  // 08:00Z dep → T-30 = 07:30Z
  assert.match(r.body, /07:30/);
});

test('confirmation: trip line included when present', () => {
  const r = confirmationReply({ resolved: sampleResolved({ trip: 'rome-2026' }), sender: 'a@b' });
  assert.match(r.body, /Trip: rome-2026/);
});

test('confirmation: subject contains route', () => {
  const r = confirmationReply({ resolved: sampleResolved(), sender: 'a@b' });
  assert.match(r.subject, /ICE 145/);
  assert.match(r.subject, /Amsterdam Centraal/);
  assert.match(r.subject, /Berlin Ostbahnhof/);
});

// ===== error templates =====

test('missing context: hints at From/To headers + example', () => {
  const r = missingContextReply({ trainNum: 'ICE145', sender: 'a@b' });
  assert.match(r.subject, /Need more info for ICE145/);
  assert.match(r.body, /From:/);
  assert.match(r.body, /To:/);
  assert.match(r.body, /Example:/);
});

test('train not found: lists common confusions + reset-daily warning', () => {
  const r = trainNotFoundReply({ trainNum: 'XYZ999', sender: 'a@b' });
  assert.match(r.subject, /Can't find train XYZ999/);
  assert.match(r.body, /Numbers reset daily/);
  assert.match(r.body, /Eurostar/);
});

test('station not on route: shows full route with arrows', () => {
  const r = stationNotOnRouteReply({
    trainNum: 'ICE145', line: 'ICE 145', station: 'Roma Termini',
    route: ['Amsterdam Centraal', 'Hannover Hbf', 'Berlin Ostbahnhof'],
    sender: 'a@b',
  });
  assert.match(r.body, /Amsterdam Centraal → Hannover Hbf → Berlin Ostbahnhof/);
  assert.match(r.body, /Roma Termini/);
});

test('station not on route: includes suggestion if provided', () => {
  const r = stationNotOnRouteReply({
    trainNum: 'ICE145', line: 'ICE 145', station: 'Munich',
    route: ['Amsterdam', 'Berlin'], suggestion: 'München Hbf', sender: 'a@b',
  });
  assert.match(r.body, /Closest match: München Hbf/);
});

// ===== ambiguous: numbered list =====

test('ambiguous station: numbered list, accepts number or name in reply', () => {
  const r = ambiguousStationReply({
    trainNum: 'TGV6611', line: 'TGV 6611', station: 'Paris',
    candidates: ['Paris Gare de Lyon', 'Paris Bercy'],
    sender: 'a@b',
  });
  assert.match(r.subject, /Which Paris for TGV 6611/);
  assert.match(r.body, /1\. Paris Gare de Lyon/);
  assert.match(r.body, /2\. Paris Bercy/);
  assert.match(r.body, /the number/);
  assert.match(r.body, /the full name/);
});

// ===== STOP variants =====

test('stopReply single-train', () => {
  const r = stopReply({ scope: 'single', target: 'ICE145', sender: 'a@b' });
  assert.match(r.subject, /Stopped tracking ICE145/);
  assert.match(r.body, /no more updates for ICE145/);
});

test('stopReply trip with train list', () => {
  const r = stopReply({
    scope: 'trip', target: 'rome', count: 3,
    trains: [
      { line: 'EUR 9316', from: 'Amsterdam', to: 'Paris Nord' },
      { line: 'TGV 9523', from: 'Paris', to: 'Milano' },
      { line: 'FR 9681', from: 'Milano', to: 'Roma Termini' },
    ],
    sender: 'a@b',
  });
  assert.match(r.subject, /Stopped trip "rome"/);
  assert.match(r.body, /Cleared 3 trains/);
  assert.match(r.body, /EUR 9316.*Amsterdam → Paris Nord/);
});

test('stopReply all', () => {
  const r = stopReply({ scope: 'all', count: 5, sender: 'a@b' });
  assert.match(r.subject, /Stopped all tracking/);
  assert.match(r.body, /Cleared 5 active trains/);
});

// ===== ntfy opt-in =====

test('ntfy opt-in includes topic URL + setup steps', () => {
  const r = ntfyOptInReply({
    topic: 'latefyi-abc123def456', sender: 'a@b',
  });
  assert.match(r.body, /https:\/\/ntfy\.sh\/latefyi-abc123def456/);
  assert.match(r.body, /Install ntfy/);
});

test('ntfy opt-in respects custom baseUrl (self-hosted)', () => {
  const r = ntfyOptInReply({
    topic: 'latefyi-abc', sender: 'a@b', baseUrl: 'https://ntfy.example.com',
  });
  assert.match(r.body, /https:\/\/ntfy\.example\.com\/latefyi-abc/);
});

// ===== push reply (per-event update) =====

test('pushReply uses event.title as subject and body', () => {
  const r = pushReply({
    event: {
      type: 'platform_changed',
      title: 'ICE 145 platform CHANGED → 8b',
      body: 'Was 7, now 8b at Amsterdam Centraal.',
      priority: 'urgent',
    },
    line: 'ICE 145', trainNum: 'ICE145', sender: 'a@b',
    confirmationMsgid: '<conf-1@late.fyi>',
  });
  assert.equal(r.subject, 'ICE 145 platform CHANGED → 8b');
  assert.match(r.body, /Was 7, now 8b/);
  // Threaded to the original confirmation
  assert.equal(r.headers['In-Reply-To'], '<conf-1@late.fyi>');
  assert.equal(r.headers['References'], '<conf-1@late.fyi>');
});

// ===== generic error & unauthorized sender =====

test('genericErrorReply surfaces code + message', () => {
  const r = genericErrorReply({
    trainNum: 'ICE145', code: 'something_failed', message: 'database is sad', sender: 'a@b',
  });
  assert.match(r.body, /database is sad/);
  assert.match(r.body, /something_failed/);
});

test('unauthorizedSenderReply names the sender + how to fix', () => {
  const r = unauthorizedSenderReply({ sender: 'stranger@x.com' });
  assert.match(r.body, /stranger@x\.com/);
  assert.match(r.body, /allowed_senders/);
});
