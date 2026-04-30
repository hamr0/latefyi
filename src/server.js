// Inbound-email orchestrator. Takes the raw email payload (Cloudflare Email
// Worker → /ingest, or any other source), runs parse → resolve → schedule,
// and returns the reply email to send. The transport actually sends it.
//
// PRD §10 (state machine), §13 modules wired together.
//
// Pure of network details: hafas-clients and the email transport are
// dependency-injected, so tests use fakes.

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';
import { resolve as resolveTrip } from './resolve.js';
import { schedule, readPending } from './schedule.js';
import {
  getOrCreate, setChannel, incrementTrainCount, ntfyTopic, scrubSender,
  checkRateLimit, recordRequest, DEFAULT_LIMITS,
} from './users.js';
import {
  confirmationReply, missingContextReply, trainNotFoundReply,
  stationNotOnRouteReply, ambiguousStationReply, alreadyArrivedReply,
  unauthorizedSenderReply, stopReply, ntfyOptInReply, genericErrorReply,
  rateLimitedReply, tooManyActiveReply,
} from './reply.js';

const DOMAIN = 'late.fyi';

// ---- helpers ----

function newMsgid() {
  return `<${randomBytes(8).toString('hex')}@${DOMAIN}>`;
}

function isAllowlisted(sender, allowlist) {
  if (!allowlist || allowlist.length === 0) return true; // no allowlist = open (single-tenant default)
  return allowlist.includes(sender.toLowerCase());
}

// Scan active/+pending/ records and filter by predicate. Used for STOP scopes.
function findRecordsForSender(stateDir, sender, predicate) {
  const matches = [];
  for (const sub of ['active', 'pending']) {
    const dir = join(stateDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const path = join(dir, f);
      let rec;
      try { rec = JSON.parse(readFileSync(path, 'utf8')); }
      catch { continue; }
      if (rec.sender !== sender) continue;
      if (predicate(rec)) matches.push({ rec, path, sub });
    }
  }
  return matches;
}

// Scrub-and-move: read the active record, replace plaintext sender with its
// hash, write atomically to done/, then unlink active. Privacy claim: no
// plaintext email survives in done/, ever.
function moveToDone(matchPath, stateDir, fname) {
  const dest = join(stateDir, 'done', fname);
  const rec = JSON.parse(readFileSync(matchPath, 'utf8'));
  const scrubbed = scrubSender(rec);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(scrubbed, null, 2));
  renameSync(tmp, dest);
  unlinkSync(matchPath);
  return dest;
}

// ---- handlers ----

async function handleTrack({ email, parsed, stateDir, primaryClient, fallbackClient, aliases, limits = DEFAULT_LIMITS, now = Date.now() }) {
  if (parsed.mode === 'MISSING') {
    return missingContextReply({
      trainNum: parsed.trainNum, sender: email.from,
      incomingMsgid: email.msgid, ourMsgid: newMsgid(),
    });
  }

  // Rate-limit BEFORE resolving — saves HAFAS calls on rejected senders.
  const userRecord = getOrCreate(email.from, stateDir);
  const rl = checkRateLimit(userRecord, now, limits);
  if (!rl.allowed) {
    return rateLimitedReply({
      reason: rl.reason, retryAt: rl.retryAt,
      sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
    });
  }

  // Active-cap: count this sender's pending+active records. Cheap (small dirs).
  const activeCount = findRecordsForSender(stateDir, email.from, () => true).length;
  if (activeCount >= limits.maxActiveTrains) {
    return tooManyActiveReply({
      count: activeCount, max: limits.maxActiveTrains,
      sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
    });
  }

  const r = await resolveTrip({ parsed, primaryClient, fallbackClient, aliases });

  if (r.kind === 'error') {
    if (r.code === 'train_not_found') {
      return trainNotFoundReply({ trainNum: parsed.trainNum, sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid() });
    }
    if (r.code === 'station_no_match' || r.code === 'station_not_on_route') {
      return stationNotOnRouteReply({
        trainNum: parsed.trainNum, line: parsed.trainNum,
        station: r.userText || parsed.from || parsed.to,
        route: r.details?.route || [],
        suggestion: r.details?.suggestion,
        sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
      });
    }
    return genericErrorReply({
      trainNum: parsed.trainNum, code: r.code, message: r.message,
      sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
    });
  }

  if (r.kind === 'disambiguation_needed') {
    // Park the partial state and send the numbered reply. The full
    // §7a "park in AWAITING_DISAMBIGUATION + accept reply" flow ships
    // in Phase 7 hardening; for now we send the reply, and a re-send
    // with the chosen station resolves the request fresh.
    const ourMsgid = newMsgid();
    return ambiguousStationReply({
      trainNum: parsed.trainNum, line: r.partial.line || parsed.trainNum,
      station: parsed[r.field],
      candidates: r.candidates,
      sender: email.from, incomingMsgid: email.msgid, ourMsgid,
    });
  }

  // Happy path: resolved, schedule and confirm. Record the request now (after
  // resolve passes, so a hard error doesn't count against the rate budget).
  const ourMsgid = newMsgid();
  schedule({
    msgid: email.msgid, sender: email.from, parsed, resolved: r, stateDir,
    confirmationMsgid: ourMsgid,
  });
  recordRequest(email.from, stateDir, now);
  incrementTrainCount(email.from, stateDir);

  return confirmationReply({
    resolved: r, sender: email.from, channel: userRecord.channel,
    incomingMsgid: email.msgid, ourMsgid,
  });
}

function handleStop({ email, parsed, stateDir }) {
  let matches, count;
  if (parsed.scope === 'all') {
    matches = findRecordsForSender(stateDir, email.from, () => true);
  } else if (parsed.scope === 'trip') {
    matches = findRecordsForSender(stateDir, email.from,
      r => (r.request?.trip || '').toLowerCase() === parsed.target.toLowerCase());
  } else if (parsed.scope === 'single' || parsed.scope === 'this') {
    matches = findRecordsForSender(stateDir, email.from,
      r => r.request?.trainNum === parsed.target);
  } else {
    matches = [];
  }
  count = matches.length;
  for (const m of matches) {
    moveToDone(m.path, stateDir, m.path.split('/').pop());
  }
  const trains = matches.map(m => ({
    line: m.rec.resolved?.line || m.rec.request?.trainNum,
    trainNum: m.rec.request?.trainNum,
    from: m.rec.resolved?.from || m.rec.request?.from,
    to: m.rec.resolved?.to || m.rec.request?.to,
  }));
  return stopReply({
    scope: parsed.scope === 'this' ? 'single' : parsed.scope,
    target: parsed.target, count, trains,
    sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
  });
}

function handleConfig({ email, parsed, stateDir }) {
  if (parsed.field === 'channels') {
    const { record, wasFirstNtfyOptIn } = setChannel(email.from, parsed.value, stateDir);
    if (wasFirstNtfyOptIn) {
      return ntfyOptInReply({
        topic: record.ntfy_topic,
        sender: email.from,
        incomingMsgid: email.msgid, ourMsgid: newMsgid(),
      });
    }
    // Plain confirmation that channel changed — keep using the confirmation
    // template since the user just expects a "got it, now using X" reply.
    return {
      from: `noreply@${DOMAIN}`,
      to: email.from,
      subject: `Channel updated to ${parsed.value}`,
      body: `Your delivery channel is now: ${parsed.value}.\n\nReply CHANNELS email | ntfy | both at any time to change.`,
      headers: { 'In-Reply-To': email.msgid, 'Message-ID': newMsgid() },
    };
  }
  return null;
}

// ---- main entry ----

// handleInbound returns either a reply email object (to send via transport),
// or null if the email was dropped silently (allowlist, unhandled "reply"
// kind, etc.). Caller is responsible for sending the reply.
//
// Args:
//   email           { from, to, subject, body, msgid, headers }
//   stateDir        path to project state/
//   primaryClient   hafas-client (oebb)
//   fallbackClient? hafas-client (pkp)
//   aliases?        from config/aliases.json
//   allowlist?      string[] of allowed lowercase senders; null = open
//
export async function handleInbound({ email, stateDir, primaryClient, fallbackClient, aliases = {}, allowlist = null, limits = DEFAULT_LIMITS, now = Date.now() }) {
  // Allowlist: silent drop (no backscatter to spoofed senders, per §13.9).
  if (!isAllowlisted((email.from || '').toLowerCase(), allowlist)) {
    return null;
  }

  const parsed = parse(email);

  switch (parsed.kind) {
    case 'track':
      return handleTrack({ email, parsed, stateDir, primaryClient, fallbackClient, aliases, limits, now });
    case 'stop':
      return handleStop({ email, parsed, stateDir });
    case 'config':
      return handleConfig({ email, parsed, stateDir });
    case 'help':
      // Static help reply; reuses missing-context body since it's the same teaching moment.
      return missingContextReply({ trainNum: 'help', sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid() });
    case 'reply':
      // Disambiguation completion — full implementation is Phase 7. For now,
      // silently drop replies we can't correlate (caller can re-send a fresh
      // request with the corrected station name).
      return null;
    case 'error':
    default:
      return genericErrorReply({
        trainNum: '(unknown)', code: parsed.code || 'unknown', message: parsed.message || 'unrecognized email',
        sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
      });
  }
}
