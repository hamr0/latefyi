// Behavior tests for src/ingest-server.js. Spins up the server on a
// random port and POSTs real HTTP requests via fetch().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIngestServer } from '../src/ingest-server.js';

// ---- shared fakes ----

const ICE145_TRIP = {
  line: { name: 'ICE 145', fahrtNr: '145' },
  stopovers: [
    { stop: { name: 'Amsterdam Centraal' }, plannedDeparture: '2026-04-29T08:00:00Z', plannedDeparturePlatform: '8b' },
    { stop: { name: 'Berlin Ostbahnhof' },   plannedArrival:   '2026-04-29T14:02:00Z', plannedArrivalPlatform: '2' },
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
      direction: 'Berlin Ostbahnhof', tripId: 'TRIP_ICE145',
      plannedWhen: '2026-04-29T08:00:00Z', plannedPlatform: '8b',
    }];
  },
  async arrivals() { return []; },
  async trip() { return ICE145_TRIP; },
});

function setup({ allowlist = null, transport = null } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'latefyi-ingest-'));
  for (const sub of ['active', 'pending', 'done', 'errors', 'users']) {
    mkdirSync(join(stateDir, sub), { recursive: true });
  }
  const server = createIngestServer({
    stateDir,
    primaryClient: fakeOebb(),
    allowlist,
    transport,
    ingestToken: 'TEST_TOKEN_abc123',
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ stateDir, server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function post(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const samplePayload = (over = {}) => ({
  from: 'amr@example.com',
  to: 'ICE145@late.fyi',
  subject: 'From: Amsterdam Centraal, To: Berlin Ostbahnhof',
  body: '',
  msgid: '<inbound@x>',
  headers: {},
  ...over,
});

// ===== auth =====

test('GET /health returns ok without auth', async () => {
  const { server, baseUrl } = await setup();
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), 'ok');
  server.close();
});

test('POST /ingest without bearer token → 401', async () => {
  const { server, baseUrl } = await setup();
  const r = await post(baseUrl, '/ingest', samplePayload());
  assert.equal(r.status, 401);
  server.close();
});

test('POST /ingest with wrong token → 401', async () => {
  const { server, baseUrl } = await setup();
  const r = await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer wrong' });
  assert.equal(r.status, 401);
  server.close();
});

test('POST /ingest with correct token → 200', async () => {
  const { server, baseUrl } = await setup();
  const r = await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer TEST_TOKEN_abc123' });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.ok, true);
  assert.equal(json.replied, true);
  assert.equal(json.sent, false); // no transport wired in this test
  server.close();
});

// ===== happy path =====

test('happy path: pending file written', async () => {
  const { stateDir, server, baseUrl } = await setup();
  await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer TEST_TOKEN_abc123' });
  assert.equal(readdirSync(join(stateDir, 'pending')).length, 1);
  server.close();
});

test('reply is sent via transport when wired', async () => {
  const sent = [];
  const transport = { async sendEmail(msg) { sent.push(msg); } };
  const { server, baseUrl } = await setup({ transport });
  const r = await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer TEST_TOKEN_abc123' });
  const json = await r.json();
  assert.equal(json.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Tracking ICE 145/);
  server.close();
});

test('transport failure does not 5xx the ingest call', async () => {
  const transport = { async sendEmail() { throw new Error('smtp blew up'); } };
  const { server, baseUrl } = await setup({ transport });
  const r = await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer TEST_TOKEN_abc123' });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.sent, false);
  assert.match(json.sendError, /smtp blew up/);
  server.close();
});

// ===== validation =====

test('invalid JSON → 400', async () => {
  const { server, baseUrl } = await setup();
  const r = await post(baseUrl, '/ingest', '{ not json', { authorization: 'Bearer TEST_TOKEN_abc123' });
  assert.equal(r.status, 400);
  server.close();
});

test('payload over 1MB → 413', async () => {
  const { server, baseUrl } = await setup();
  const giant = 'x'.repeat(1024 * 1024 + 100);
  const r = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer TEST_TOKEN_abc123' },
    body: giant,
  });
  assert.equal(r.status, 413);
  server.close();
});

test('unknown route → 404', async () => {
  const { server, baseUrl } = await setup();
  const r = await fetch(`${baseUrl}/random`);
  assert.equal(r.status, 404);
  server.close();
});

// ===== allowlist =====

test('allowlisted sender accepted', async () => {
  const { server, baseUrl } = await setup({ allowlist: ['amr@example.com'] });
  const r = await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer TEST_TOKEN_abc123' });
  const json = await r.json();
  assert.equal(json.replied, true);
  server.close();
});

test('non-allowlisted sender silently dropped (200, no reply)', async () => {
  const { server, baseUrl } = await setup({ allowlist: ['someone-else@example.com'] });
  const r = await post(baseUrl, '/ingest', samplePayload(), { authorization: 'Bearer TEST_TOKEN_abc123' });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.replied, false);
  server.close();
});

// ===== rejected methods =====

test('GET /ingest → 404', async () => {
  const { server, baseUrl } = await setup();
  const r = await fetch(`${baseUrl}/ingest`);
  assert.equal(r.status, 404);
  server.close();
});
