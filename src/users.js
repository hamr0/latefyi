// Per-user state: channel preference, derived ntfy topic, opt-in tracking.
//
// PRD §6 (channels), §12 (storage schema), §13.7a (this module).
//
// Hash is sha256(email)[:16] — stable, doesn't reveal the email but
// derives the ntfy topic deterministically. Files: state/users/<hash>.json.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function senderHash(email) {
  if (!email) throw new Error('senderHash: email required');
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

// Strip PII from a tracking record before it lands in done/.
// Replaces the plaintext `sender` with `senderHash`; everything else is kept
// (train number, route, schedule, events, state) for diagnostics. Done records
// then contain no contact info — no list of users that could ever be emailed.
export function scrubSender(rec) {
  if (!rec || !rec.sender) return rec;
  const { sender, ...rest } = rec;
  return { ...rest, senderHash: senderHash(sender) };
}

export function ntfyTopic(email, prefix = 'latefyi-') {
  return `${prefix}${senderHash(email)}`;
}

function userPath(stateDir, email) {
  return join(stateDir, 'users', `${senderHash(email)}.json`);
}

function ensureUsersDir(stateDir) {
  mkdirSync(join(stateDir, 'users'), { recursive: true });
}

// Atomic write: write to <path>.tmp then rename. Filesystem rename is atomic
// on POSIX, so a crash never leaves a half-written user file.
function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function defaultRecord(email) {
  const hash = senderHash(email);
  const now = new Date().toISOString();
  return {
    sender_hash: hash,
    sender_email: email,
    channel: 'email',
    ntfy_topic: `latefyi-${hash}`,
    ntfy_opt_in_sent_at: null,
    first_seen_at: now,
    last_seen_at: now,
    trains_tracked_count: 0,
  };
}

// Load a user record, or create one with defaults if it doesn't exist.
// Always persists on creation so the side-effect lines up with the read.
export function getOrCreate(email, stateDir) {
  ensureUsersDir(stateDir);
  const path = userPath(stateDir, email);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  const rec = defaultRecord(email);
  atomicWrite(path, rec);
  return rec;
}

// Update channel preference. Returns { record, wasFirstNtfyOptIn } so the
// caller can decide whether to send the QR opt-in reply (only on first time).
export function setChannel(email, channel, stateDir) {
  if (!['email', 'ntfy', 'both'].includes(channel)) {
    throw new Error(`setChannel: invalid channel "${channel}"`);
  }
  const rec = getOrCreate(email, stateDir);
  const wasFirstNtfyOptIn = (channel === 'ntfy' || channel === 'both') && rec.ntfy_opt_in_sent_at === null;
  rec.channel = channel;
  if (wasFirstNtfyOptIn) rec.ntfy_opt_in_sent_at = new Date().toISOString();
  rec.last_seen_at = new Date().toISOString();
  atomicWrite(userPath(stateDir, email), rec);
  return { record: rec, wasFirstNtfyOptIn };
}

// Bump train counter + last_seen. Called after a successful track request.
export function incrementTrainCount(email, stateDir) {
  const rec = getOrCreate(email, stateDir);
  rec.trains_tracked_count = (rec.trains_tracked_count || 0) + 1;
  rec.last_seen_at = new Date().toISOString();
  atomicWrite(userPath(stateDir, email), rec);
  return rec;
}
