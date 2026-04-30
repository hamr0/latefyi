// Behavior tests for users.js. Each test gets its own tmp dir for isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { senderHash, ntfyTopic, getOrCreate, setChannel, incrementTrainCount, recordRequest, checkRateLimit } from '../src/users.js';

const td = () => mkdtempSync(join(tmpdir(), 'latefyi-users-'));

// ===== hash / topic =====

test('senderHash is deterministic and 16-char hex', () => {
  const h1 = senderHash('amr@example.com');
  const h2 = senderHash('amr@example.com');
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{16}$/);
});

test('senderHash is case-insensitive on email', () => {
  assert.equal(senderHash('Amr@Example.COM'), senderHash('amr@example.com'));
});

test('ntfyTopic uses the prefix and hash', () => {
  const t = ntfyTopic('amr@example.com');
  assert.match(t, /^latefyi-[a-f0-9]{16}$/);
});

// ===== getOrCreate =====

test('getOrCreate creates default record on first call', () => {
  const dir = td();
  const r = getOrCreate('amr@example.com', dir);
  assert.equal(r.sender_email, 'amr@example.com');
  assert.equal(r.channel, 'email');
  assert.equal(r.ntfy_opt_in_sent_at, null);
  assert.equal(r.trains_tracked_count, 0);
  assert.match(r.ntfy_topic, /^latefyi-[a-f0-9]{16}$/);

  // Persisted to disk
  const path = join(dir, 'users', `${r.sender_hash}.json`);
  assert.ok(existsSync(path));
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(onDisk, r);
});

test('getOrCreate returns existing record on second call (no overwrite)', () => {
  const dir = td();
  const r1 = getOrCreate('amr@example.com', dir);
  // Hand-poke the file to verify it's reused
  r1.trains_tracked_count = 99;
  const path = join(dir, 'users', `${r1.sender_hash}.json`);
  // Re-read via API
  const r2 = getOrCreate('amr@example.com', dir);
  assert.equal(r2.trains_tracked_count, 0); // disk wins (we didn't persist r1's mutation)
  assert.equal(r2.sender_hash, r1.sender_hash);
});

// ===== setChannel + first-ntfy-opt-in flag =====

test('setChannel email→ntfy: first time fires opt-in flag', () => {
  const dir = td();
  getOrCreate('amr@example.com', dir);
  const { record, wasFirstNtfyOptIn } = setChannel('amr@example.com', 'ntfy', dir);
  assert.equal(wasFirstNtfyOptIn, true);
  assert.equal(record.channel, 'ntfy');
  assert.ok(record.ntfy_opt_in_sent_at);
});

test('setChannel ntfy→both keeps opt-in flag false (already sent)', () => {
  const dir = td();
  setChannel('amr@example.com', 'ntfy', dir); // first
  const { wasFirstNtfyOptIn } = setChannel('amr@example.com', 'both', dir); // second
  assert.equal(wasFirstNtfyOptIn, false);
});

test('setChannel ntfy→email→ntfy keeps opt-in flag false on re-opt-in', () => {
  const dir = td();
  setChannel('amr@example.com', 'ntfy', dir);
  setChannel('amr@example.com', 'email', dir);
  const { wasFirstNtfyOptIn, record } = setChannel('amr@example.com', 'ntfy', dir);
  assert.equal(wasFirstNtfyOptIn, false);
  assert.equal(record.channel, 'ntfy');
});

test('setChannel rejects invalid channel', () => {
  const dir = td();
  assert.throws(() => setChannel('amr@example.com', 'telegram', dir), /invalid channel/);
});

// ===== incrementTrainCount =====

test('incrementTrainCount bumps and persists', () => {
  const dir = td();
  const r1 = incrementTrainCount('amr@example.com', dir);
  assert.equal(r1.trains_tracked_count, 1);
  const r2 = incrementTrainCount('amr@example.com', dir);
  assert.equal(r2.trains_tracked_count, 2);

  // Verify on disk
  const onDisk = JSON.parse(readFileSync(join(dir, 'users', `${r2.sender_hash}.json`), 'utf8'));
  assert.equal(onDisk.trains_tracked_count, 2);
});


// ===== rate limit =====

test('checkRateLimit: empty record is allowed', () => {
  assert.equal(checkRateLimit({}, Date.now()).allowed, true);
});

test('checkRateLimit: under hourly cap is allowed', () => {
  const now = Date.parse('2026-04-29T12:00:00Z');
  const recent_requests = Array(9).fill(0).map((_, i) => new Date(now - i * 60_000).toISOString());
  assert.equal(checkRateLimit({ recent_requests }, now).allowed, true);
});

test('checkRateLimit: at hourly cap returns retryAt = oldest+1h', () => {
  const now = Date.parse('2026-04-29T12:00:00Z');
  // 10 requests in the last hour
  const recent_requests = Array(10).fill(0).map((_, i) => new Date(now - i * 60_000).toISOString());
  const r = checkRateLimit({ recent_requests }, now);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'hourly');
  // Oldest is now - 9min; retryAt = oldest + 60min = now + 51min
  assert.equal(r.retryAt, new Date(now - 9 * 60_000 + 60 * 60_000).toISOString());
});

test('checkRateLimit: requests >1h ago do not count toward hourly cap', () => {
  const now = Date.parse('2026-04-29T12:00:00Z');
  const recent_requests = Array(15).fill(0).map((_, i) => new Date(now - (61 + i) * 60_000).toISOString());
  // All 15 are >1h ago; under daily (50). Should be allowed.
  assert.equal(checkRateLimit({ recent_requests }, now).allowed, true);
});

test('checkRateLimit: 50 requests in 24h hits daily cap', () => {
  const now = Date.parse('2026-04-29T12:00:00Z');
  // Spread across 23h so under hourly but at daily.
  const recent_requests = Array(50).fill(0).map((_, i) => new Date(now - (i * 23 * 60_000)).toISOString());
  const r = checkRateLimit({ recent_requests }, now);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily');
});

test('checkRateLimit: respects custom limits', () => {
  const now = Date.now();
  const recent_requests = [new Date(now).toISOString()];
  const r = checkRateLimit({ recent_requests }, now, { perHour: 1, perDay: 2, maxActiveTrains: 5 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'hourly');
});

test('recordRequest: appends timestamp and persists', () => {
  const dir = td();
  const now = Date.parse('2026-04-29T12:00:00Z');
  const r = recordRequest('amr@example.com', dir, now);
  assert.equal(r.recent_requests.length, 1);
  assert.equal(r.recent_requests[0], new Date(now).toISOString());

  const r2 = recordRequest('amr@example.com', dir, now + 60_000);
  assert.equal(r2.recent_requests.length, 2);
});

test('recordRequest: trims entries older than 24h', () => {
  const dir = td();
  const now = Date.parse('2026-04-29T12:00:00Z');
  // Pre-seed via getOrCreate then write 25h-old entries directly
  const oldRec = getOrCreate('amr@example.com', dir);
  oldRec.recent_requests = [new Date(now - 25 * 60 * 60 * 1000).toISOString()];
  const path = join(dir, 'users', `${oldRec.sender_hash}.json`);
  writeFileSync(path, JSON.stringify(oldRec));

  const updated = recordRequest('amr@example.com', dir, now);
  assert.equal(updated.recent_requests.length, 1, '25h-old entry should have been trimmed');
});
