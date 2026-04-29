// Scheduler: writes a resolved tracking request to state/pending/<msgid>.json
// with computed poll_start_time and poll_end_time. wake.sh activates due files.
//
// PRD §10 (state machine), §12 (storage schema), §13.4 (this module).

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_POLLING = {
  default_pre_t30_minutes: 30,
  large_terminal_pre_t_minutes: 45,
  grace_minutes: 30,
};

function ensureStateDirs(stateDir) {
  for (const sub of ['pending', 'active', 'done', 'errors', 'users']) {
    mkdirSync(join(stateDir, sub), { recursive: true });
  }
}

// Sanitize msgid for filesystem use. Email Message-IDs typically look like
// "<random@domain>" — keep it stable but filesystem-safe.
function safeFileName(msgid) {
  return msgid
    .replace(/^<|>$/g, '')
    .replace(/[^A-Za-z0-9._@-]+/g, '_')
    .slice(0, 200);
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

// Compute poll_start_time. Default = scheduledDeparture - 30min.
// For Mode A (pickup), anchor on scheduledArrival - 30min.
// Large terminals get an extra 15min lead to compensate for late platform announcements.
function computePollStart(resolved, opts) {
  const cfg = { ...DEFAULT_POLLING, ...(opts.polling || {}) };
  const largeTerminals = new Set(opts.large_terminals || []);

  const anchorTime = resolved.mode === 'A'
    ? resolved.schedule.scheduledArrival
    : resolved.schedule.scheduledDeparture;

  if (!anchorTime) {
    throw new Error(`schedule: no anchor time on resolved.schedule (mode=${resolved.mode})`);
  }

  const anchorStation = resolved.mode === 'A' ? resolved.to : resolved.from;
  const lead = largeTerminals.has(anchorStation)
    ? cfg.large_terminal_pre_t_minutes
    : cfg.default_pre_t30_minutes;

  return new Date(new Date(anchorTime).getTime() - lead * 60 * 1000).toISOString();
}

// Compute poll_end_time. End at scheduled arrival + grace, or for Mode A
// at the same anchor + grace.
function computePollEnd(resolved, opts) {
  const cfg = { ...DEFAULT_POLLING, ...(opts.polling || {}) };
  const endAnchor = resolved.schedule.scheduledArrival || resolved.schedule.scheduledDeparture;
  if (!endAnchor) throw new Error('schedule: no arrival/departure anchor for poll_end_time');
  return new Date(new Date(endAnchor).getTime() + cfg.grace_minutes * 60 * 1000).toISOString();
}

// Build the on-disk record per PRD §12.
//   confirmationMsgid (optional): Message-ID of the outbound confirmation
//   reply, used by the poller to thread subsequent update emails into the
//   same mail-client conversation (PRD §6).
export function buildPendingRecord({ msgid, sender, parsed, resolved, receivedAt, confirmationMsgid = null }) {
  return {
    msgid,
    confirmationMsgid,
    received_at: receivedAt || new Date().toISOString(),
    sender,
    request: {
      trainNum: parsed.trainNum,
      mode: parsed.mode,
      from: parsed.from,
      to: parsed.to,
      trip: parsed.trip || null,
      channels: parsed.channels || null,
    },
    resolved: {
      endpoint: resolved.endpoint,
      tripId: resolved.tripId,
      line: resolved.line,
      from: resolved.from,
      to: resolved.to,
      route: resolved.route,
      scheduledDeparture: resolved.schedule.scheduledDeparture,
      scheduledArrivalAtTo: resolved.schedule.scheduledArrival,
    },
    schedule: {
      poll_start_time: null, // filled below
      poll_end_time: null,
    },
    state: {
      phase: 'SCHEDULED',
      lastPolledAt: null,
      lastPushedSnapshot: null,
      consecutivePollFailures: 0,
      endpointInUse: resolved.endpoint,
    },
    pushes: [],
  };
}

// Main entry. Writes pending/<msgid>.json. Returns the on-disk record.
//
//   { msgid, sender, parsed, resolved, stateDir, opts? }
//
// `opts` accepts:
//   - polling: override of DEFAULT_POLLING
//   - large_terminals: array of station names that get extra lead time
//
// Idempotent: re-calling with the same msgid overwrites the same file
// atomically (last write wins).
export function schedule({ msgid, sender, parsed, resolved, stateDir, receivedAt, confirmationMsgid = null, opts = {} }) {
  if (!msgid) throw new Error('schedule: msgid required');
  if (!sender) throw new Error('schedule: sender required');
  if (!resolved || resolved.kind !== 'resolved') {
    throw new Error('schedule: expects resolved.kind === "resolved"');
  }
  ensureStateDirs(stateDir);

  const record = buildPendingRecord({ msgid, sender, parsed, resolved, receivedAt, confirmationMsgid });
  record.schedule.poll_start_time = computePollStart(resolved, opts);
  record.schedule.poll_end_time = computePollEnd(resolved, opts);

  const path = join(stateDir, 'pending', `${safeFileName(msgid)}.json`);
  atomicWrite(path, record);
  return { ...record, _path: path };
}

// Used by wake.sh's JS analogue and by tests: is this record due to activate?
export function isDue(record, now = Date.now()) {
  if (!record?.schedule?.poll_start_time) return false;
  return new Date(record.schedule.poll_start_time).getTime() <= now;
}

// Move a pending file to active/. Atomic rename. Returns the new path.
export function activate(pendingPath, stateDir) {
  const fname = pendingPath.split('/').pop();
  const dest = join(stateDir, 'active', fname);
  renameSync(pendingPath, dest);
  return dest;
}

// Read a pending file (helper for callers and tests).
export function readPending(pendingPath) {
  if (!existsSync(pendingPath)) return null;
  return JSON.parse(readFileSync(pendingPath, 'utf8'));
}
