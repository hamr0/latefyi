// Behavior tests for parse(email).
// Uses node:test (built-in, no external dep). Tests fixtures end-to-end —
// each test sets up a realistic email payload and asserts the parsed shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseOnDate } from '../src/parse.js';

// ---- helpers ----
const email = (over = {}) => ({
  from: 'amr@example.com',
  to: 'ICE145@late.fyi',
  subject: '',
  body: '',
  msgid: '<test@local>',
  headers: {},
  ...over,
});

// ===== Mode A (pickup) =====

test('Mode A: To: only in subject → pickup mode', () => {
  const r = parse(email({ to: 'TGV9876@late.fyi', subject: 'To: Lille Flanders' }));
  assert.equal(r.kind, 'track');
  assert.equal(r.trainNum, 'TGV9876');
  assert.equal(r.mode, 'A');
  assert.equal(r.from, null);
  assert.equal(r.to, 'Lille Flanders');
});

test('Mode A: To: in body when subject empty', () => {
  const r = parse(email({ to: 'tgv9876@late.fyi', body: 'To: Amsterdam Centraal' }));
  assert.equal(r.kind, 'track');
  assert.equal(r.mode, 'A');
  assert.equal(r.to, 'Amsterdam Centraal');
});

// ===== Mode B (boarding) =====

test('Mode B: From: alone (ride to terminus)', () => {
  const r = parse(email({ to: 'ICE104@late.fyi', subject: 'From: Frankfurt Hbf' }));
  assert.equal(r.kind, 'track');
  assert.equal(r.mode, 'B');
  assert.equal(r.from, 'Frankfurt Hbf');
  assert.equal(r.to, null);
});

test('Mode B: From + To in subject, comma-separated', () => {
  const r = parse(email({
    to: 'RE19750@late.fyi',
    subject: 'From: Amiens, To: Lille Flanders',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.mode, 'B');
  assert.equal(r.from, 'Amiens');
  assert.equal(r.to, 'Lille Flanders');
});

test('Mode B with trip tag', () => {
  const r = parse(email({
    to: 'EUR9316@late.fyi',
    subject: 'From: Amsterdam, To: Paris Nord, Trip: rome-2026',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.trip, 'rome-2026');
});

// ===== Case insensitivity =====

test('header keys are case-insensitive', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'FROM: Amsterdam, tO: Berlin Ostbahnhof',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.mode, 'B');
  assert.equal(r.from, 'Amsterdam');
  assert.equal(r.to, 'Berlin Ostbahnhof');
});

test('local-part is uppercased regardless of input case', () => {
  const r = parse(email({ to: 'ice145@late.fyi', subject: 'From: Amsterdam' }));
  assert.equal(r.trainNum, 'ICE145');
});

// ===== Missing context =====

test('bare email (no From, no To) → mode MISSING', () => {
  const r = parse(email({ to: 'ICE145@late.fyi', subject: '', body: '' }));
  assert.equal(r.kind, 'track');
  assert.equal(r.mode, 'MISSING');
  assert.equal(r.from, null);
  assert.equal(r.to, null);
});

// ===== Channels override =====

test('per-request Channels: header parses', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: A, To: B, Channels: ntfy',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.channels, 'ntfy');
});

test('per-request Channels: rejects invalid value', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: A, To: B, Channels: telegram',
  }));
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'invalid_channels');
});

// ===== Train number validation =====

test('invalid train number (no digits) → error', () => {
  const r = parse(email({ to: 'hello@late.fyi', subject: 'From: A' }));
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'invalid_trainnum');
});

test('valid train numbers across operators', () => {
  for (const num of ['ICE145', 'EUR9316', 'TGV6611', 'RE19750', 'IC2812', '9876']) {
    const r = parse(email({ to: `${num}@late.fyi`, subject: 'From: A' }));
    assert.equal(r.kind, 'track', `expected track for ${num}, got ${r.kind}: ${r.message || ''}`);
    assert.equal(r.trainNum, num);
  }
});

// ===== Trip tag validation =====

test('trip tag with disallowed chars → error', () => {
  // Trip values fail validation on chars outside [A-Za-z0-9_-]. Forgiving
  // header parsing splits on the next keyword/comma/EOL, so "foo!bar" stays
  // as a single value (no internal split) and TRIP_RE rejects the `!`.
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: A, Trip: foo!bar',
  }));
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'invalid_trip');
});

test('trip tag too long → error', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: `From: A, Trip: ${'x'.repeat(40)}`,
  }));
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'invalid_trip');
});

// ===== STOP variants =====

test('STOP alone in body, threaded reply → stop scope=this', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    body: 'STOP',
    headers: { 'In-Reply-To': '<conf-ICE145@late.fyi>' },
  }));
  assert.equal(r.kind, 'stop');
  // local-part is a valid train number → upgraded to single+target
  assert.equal(r.scope, 'single');
  assert.equal(r.target, 'ICE145');
  assert.equal(r.inReplyTo, '<conf-ICE145@late.fyi>');
});

test('STOP <TRAINNUM> from any address', () => {
  const r = parse(email({ to: 'ICE145@late.fyi', body: 'STOP TGV6611' }));
  assert.equal(r.kind, 'stop');
  assert.equal(r.scope, 'single');
  assert.equal(r.target, 'TGV6611');
});

test('STOP TRIP <name>', () => {
  const r = parse(email({ to: 'stop@late.fyi', subject: 'STOP TRIP rome' }));
  assert.equal(r.kind, 'stop');
  assert.equal(r.scope, 'trip');
  assert.equal(r.target, 'rome');
});

test('STOP ALL', () => {
  const r = parse(email({ to: 'stop@late.fyi', body: 'stop all' }));
  assert.equal(r.kind, 'stop');
  assert.equal(r.scope, 'all');
});

// ===== Reserved local-parts =====

test('config@ + CHANNELS ntfy → config kind', () => {
  const r = parse(email({ to: 'config@late.fyi', subject: 'CHANNELS ntfy' }));
  assert.equal(r.kind, 'config');
  assert.equal(r.field, 'channels');
  assert.equal(r.value, 'ntfy');
});

test('config@ without CHANNELS → error', () => {
  const r = parse(email({ to: 'config@late.fyi', subject: 'hello' }));
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'config_unrecognized');
});

test('help@ → help kind', () => {
  const r = parse(email({ to: 'help@late.fyi', subject: '' }));
  assert.equal(r.kind, 'help');
});

// ===== Disambiguation reply =====

test('reply with In-Reply-To, non-train local-part → reply kind', () => {
  const r = parse(email({
    to: 'noreply@late.fyi', // came back to our reply, not a fresh track
    subject: '',
    body: '2',
    headers: { 'In-Reply-To': '<disamb-abc@late.fyi>' },
  }));
  assert.equal(r.kind, 'reply');
  assert.equal(r.answer, '2');
  assert.equal(r.inReplyTo, '<disamb-abc@late.fyi>');
});

test('reply with In-Reply-To, valid train local-part → still treated as fresh track', () => {
  // User re-sends to ICE145@ instead of replying to noreply@: parser
  // returns a track request, not a reply, since the address signals intent.
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam, To: Berlin Ostbahnhof',
    headers: { 'In-Reply-To': '<disamb-abc@late.fyi>' },
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.inReplyTo, '<disamb-abc@late.fyi>');
});

// ===== Robustness =====

test('null/garbage email returns error not throw', () => {
  assert.equal(parse(null).kind, 'error');
  assert.equal(parse(undefined).kind, 'error');
  assert.equal(parse('not an object').kind, 'error');
});

test('extra unknown header in subject is ignored', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam, X-Something: ignore-me, To: Berlin',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'Amsterdam');
  assert.equal(r.to, 'Berlin');
});

test('headers in body when subject contains junk', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'Re: tracking',
    body: 'From: Amsterdam, To: Berlin',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'Amsterdam');
  assert.equal(r.to, 'Berlin');
});

test('first occurrence of a header wins (subject beats body)', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam',
    body: 'From: Berlin',
  }));
  assert.equal(r.from, 'Amsterdam');
});

// ===== On: header (advance planning) =====

const NOW_2026_04_29 = Date.parse('2026-04-29T12:00:00Z');

test('parseOnDate accepts ISO YYYY-MM-DD', () => {
  assert.deepEqual(parseOnDate('2026-05-04', NOW_2026_04_29), { ok: true, date: '2026-05-04' });
});

test('parseOnDate accepts "5 May 2026"', () => {
  assert.deepEqual(parseOnDate('5 May 2026', NOW_2026_04_29), { ok: true, date: '2026-05-05' });
});

test('parseOnDate accepts "05-May-26"', () => {
  assert.deepEqual(parseOnDate('05-May-26', NOW_2026_04_29), { ok: true, date: '2026-05-05' });
});

test('parseOnDate accepts month-name case-insensitively', () => {
  assert.deepEqual(parseOnDate('5-MAY-2026', NOW_2026_04_29), { ok: true, date: '2026-05-05' });
  assert.deepEqual(parseOnDate('5 may 2026', NOW_2026_04_29), { ok: true, date: '2026-05-05' });
});

test('parseOnDate rejects pure numeric (US/EU ambiguous)', () => {
  const r = parseOnDate('05/04/26', NOW_2026_04_29);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_date_format');
});

test('parseOnDate rejects past dates', () => {
  const r = parseOnDate('2026-04-01', NOW_2026_04_29);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'date_in_past');
});

test('parseOnDate rejects dates >90 days out', () => {
  const r = parseOnDate('2026-09-01', NOW_2026_04_29);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'date_too_far');
});

test('parseOnDate accepts today', () => {
  assert.deepEqual(parseOnDate('2026-04-29', NOW_2026_04_29), { ok: true, date: '2026-04-29' });
});

test('parseOnDate rejects malformed', () => {
  assert.equal(parseOnDate('next tuesday', NOW_2026_04_29).ok, false);
  assert.equal(parseOnDate('2026-13-01', NOW_2026_04_29).ok, false);
  assert.equal(parseOnDate('5 Smarch 2026', NOW_2026_04_29).ok, false);
});

test('parse() exposes onDate on track requests', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof, On: 2099-01-01',
  }));
  // 2099 is way past the 90-day cutoff → error
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 'date_too_far');
});

test('parse() returns onDate=null when On: absent', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.onDate, null);
});

// ===== Forgiving syntax (no colons, no commas) =====

test('forgiving: "from amsterdam to berlin" without colons or commas', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'from amsterdam to berlin ostbahnhof',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'amsterdam');
  assert.equal(r.to, 'berlin ostbahnhof');
});

test('forgiving: "from X to Y on DATE" all bare', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'from amsterdam to paris nord on 2026-05-06',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'amsterdam');
  assert.equal(r.to, 'paris nord');
  assert.equal(r.onDate, '2026-05-06');
});

test('forgiving: mixed colon and bare (e.g. From: X, to Y)', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam, to Berlin Ostbahnhof',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'Amsterdam');
  assert.equal(r.to, 'Berlin Ostbahnhof');
});

test('forgiving: bare ISO date is auto-tagged as on', () => {
  const r = parse(email({
    to: 'EUR9316@late.fyi',
    subject: 'from amsterdam to paris nord 2026-05-06',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'amsterdam');
  assert.equal(r.to, 'paris nord');
  assert.equal(r.onDate, '2026-05-06');
});

test('forgiving: bare named-month date is auto-tagged as on', () => {
  const r = parse(email({
    to: 'EUR9316@late.fyi',
    subject: 'from amsterdam to paris nord 5 May 2026',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.from, 'amsterdam');
  assert.equal(r.to, 'paris nord');
  assert.equal(r.onDate, '2026-05-05');
});

test('forgiving: explicit On: still wins (no double-injection)', () => {
  const r = parse(email({
    to: 'ICE145@late.fyi',
    subject: 'From: Amsterdam, To: Berlin, On: 2026-05-04',
  }));
  assert.equal(r.kind, 'track');
  assert.equal(r.onDate, '2026-05-04');
});
