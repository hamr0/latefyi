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
    // Bounded timestamp array of fresh tracking requests in the last 24h.
    // Trimmed on every recordRequest() call. Used by checkRateLimit().
    recent_requests: [],
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

// ---- abuse limits ----

export const DEFAULT_LIMITS = {
  perHour: 10,
  perDay: 50,
  maxActiveTrains: 20,
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS  = 24 * ONE_HOUR_MS;

// Pure: returns { allowed, reason?, retryAt? } given a record and a clock.
// Used by server.js handleTrack BEFORE recording the request, so a denied
// request never lands in recent_requests (otherwise rejections would
// extend their own ban).
export function checkRateLimit(record, now = Date.now(), limits = DEFAULT_LIMITS) {
  const recents = (record?.recent_requests || []).map(t => Date.parse(t)).filter(t => !isNaN(t));
  const lastHour = recents.filter(t => now - t < ONE_HOUR_MS).length;
  const lastDay  = recents.filter(t => now - t < ONE_DAY_MS).length;

  if (lastHour >= limits.perHour) {
    // Earliest slot in the hour bucket frees up at oldestInHour + ONE_HOUR_MS.
    const inHour = recents.filter(t => now - t < ONE_HOUR_MS).sort((a, b) => a - b);
    const retryAt = new Date(inHour[0] + ONE_HOUR_MS).toISOString();
    return { allowed: false, reason: 'hourly', retryAt };
  }
  if (lastDay >= limits.perDay) {
    const inDay = recents.filter(t => now - t < ONE_DAY_MS).sort((a, b) => a - b);
    const retryAt = new Date(inDay[0] + ONE_DAY_MS).toISOString();
    return { allowed: false, reason: 'daily', retryAt };
  }
  return { allowed: true };
}

// Append `now` to recent_requests, trim entries older than 24h. Persists.
// Cap the array at 200 entries even if all are recent (defensive — a sender
// who somehow blows past `perDay` shouldn't grow the file unboundedly).
export function recordRequest(email, stateDir, now = Date.now()) {
  const rec = getOrCreate(email, stateDir);
  const cutoff = now - ONE_DAY_MS;
  const kept = (rec.recent_requests || [])
    .filter(t => Date.parse(t) >= cutoff)
    .concat([new Date(now).toISOString()]);
  rec.recent_requests = kept.slice(-200);
  rec.last_seen_at = new Date(now).toISOString();
  atomicWrite(userPath(stateDir, email), rec);
  return rec;
}
