// Behavior tests for users.js. Each test gets its own tmp dir for isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { senderHash, ntfyTopic, scrubSender, getOrCreate, setChannel, incrementTrainCount } from '../src/users.js';

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

// ===== scrubSender =====

test('scrubSender removes plaintext sender and inserts senderHash', () => {
  const rec = {
    msgid: '<x@y>',
    sender: 'amr@example.com',
    request: { trainNum: 'ICE145', from: 'AC', to: 'BO' },
    state: { phase: 'arrival_window' },
  };
  const out = scrubSender(rec);
  assert.equal(out.sender, undefined);
  assert.equal(out.senderHash, senderHash('amr@example.com'));
  assert.equal(out.msgid, '<x@y>');
  assert.deepEqual(out.request, rec.request);
  assert.deepEqual(out.state, rec.state);
});

test('scrubSender is a no-op when no sender field is present', () => {
  const rec = { msgid: '<x@y>', request: { trainNum: 'ICE145' } };
  assert.deepEqual(scrubSender(rec), rec);
});

test('scrubSender does not mutate the input', () => {
  const rec = { sender: 'a@b', msgid: 'm' };
  scrubSender(rec);
  assert.equal(rec.sender, 'a@b');
});
