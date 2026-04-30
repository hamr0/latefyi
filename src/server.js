// Inbound-email orchestrator. Takes the raw email payload (Cloudflare Email
// Worker → /ingest, or any other source), runs parse → resolve → schedule,
// and returns the reply email to send. The transport actually sends it.
//
// PRD §10 (state machine), §13 modules wired together.
//
// Pure of network details: hafas-clients and the email transport are
// dependency-injected, so tests use fakes.

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';
import { resolve as resolveTrip } from './resolve.js';
import { schedule, readPending } from './schedule.js';
import { parkDisambig, readDisambig, removeDisambig } from './disambig.js';
import { resolveDisambiguation } from './stations.js';
import {
  getOrCreate, setChannel, incrementTrainCount, ntfyTopic,
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

// Delete the record. Privacy claim: when a trip ends (arrival, STOP,
// cancellation), nothing per-trip is retained — only the sender's
// pseudonymous user file (state/users/<hash>.json) keeps a counter and
// channel preference. Aggregate operator metrics derive from those.
function dropTerminalRecord(matchPath) {
  unlinkSync(matchPath);
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
      return trainNotFoundReply({ trainNum: parsed.trainNum, sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(), onDate: parsed.onDate });
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
    // Park the partial parsed state keyed on our outbound Message-ID, then
    // send the numbered reply. When the user replies (parser returns
    // kind: 'reply'), we look up by In-Reply-To and apply the answer.
    const ourMsgid = newMsgid();
    parkDisambig(stateDir, {
      ourMsgid,
      sender: email.from,
      incomingMsgid: email.msgid,
      parsed,                  // entire parsed track request, mutated below on resolve
      ambiguousField: r.field, // 'from' or 'to'
      candidates: r.candidates,
      line: r.partial.line || parsed.trainNum,
    });
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
    incomingMsgid: email.msgid, ourMsgid, trainNum: parsed.trainNum,
  });
}

// User answered an ambiguousStationReply (e.g. "2" or "Brussels Midi").
// Look up the parked partial state by In-Reply-To, apply the answer,
// resolve fresh, schedule. Silent drop if no parked state matches.
async function handleDisambigReply({ email, parsed, stateDir, primaryClient, fallbackClient, aliases, limits, now }) {
  if (!parsed.inReplyTo) return null;
  const parked = readDisambig(stateDir, parsed.inReplyTo, now);
  if (!parked) return null;  // expired or never existed — drop silently

  // candidates are already station-name strings (from matchStation's ambiguous
  // result), not objects.
  const r = resolveDisambiguation(parsed.answer, parked.candidates);
  if (r.status !== 'resolved') {
    // Keep the parked state; just nudge the user. Reuse ambiguousStationReply
    // so they get the numbered list again with a fresh ourMsgid (which
    // becomes the new lookup key).
    const ourMsgid = newMsgid();
    parkDisambig(stateDir, { ...parked, ourMsgid });
    removeDisambig(stateDir, parked.ourMsgid);
    return ambiguousStationReply({
      trainNum: parked.parsed.trainNum, line: parked.line,
      station: parked.parsed[parked.ambiguousField],
      candidates: parked.candidates,
      sender: email.from, incomingMsgid: email.msgid, ourMsgid,
    });
  }

  // Reconstruct a parsed track request with the chosen station and resolve fresh.
  const fixedParsed = { ...parked.parsed, [parked.ambiguousField]: r.match };
  removeDisambig(stateDir, parked.ourMsgid);
  // We carry the original sender's email forward — the user replied from the
  // same address, but we use the parked sender to be safe (no spoofing).
  return handleTrack({
    email: { ...email, from: parked.sender },
    parsed: fixedParsed,
    stateDir, primaryClient, fallbackClient, aliases, limits, now,
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
    dropTerminalRecord(m.path);
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
    // ntfy is paused — accept the request but force email-only and tell the
    // user. Code path is intact for re-enable; just no user-facing surface.
    if (parsed.value !== 'email') {
      setChannel(email.from, 'email', stateDir);
      return {
        from: `noreply@${DOMAIN}`,
        to: email.from,
        subject: `ntfy delivery is paused`,
        body: `Push notifications via ntfy are temporarily disabled while we work on a smoother setup. You'll keep getting train updates by email.\n\nNo action needed.`,
        headers: { 'In-Reply-To': email.msgid, 'Message-ID': newMsgid() },
      };
    }
    setChannel(email.from, 'email', stateDir);
    return {
      from: `noreply@${DOMAIN}`,
      to: email.from,
      subject: `Channel updated to email`,
      body: `Your delivery channel is now: email.`,
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
      return handleDisambigReply({ email, parsed, stateDir, primaryClient, fallbackClient, aliases, limits, now });
    case 'error':
    default:
      return genericErrorReply({
        trainNum: '(unknown)', code: parsed.code || 'unknown', message: parsed.message || 'unrecognized email',
        sender: email.from, incomingMsgid: email.msgid, ourMsgid: newMsgid(),
      });
  }
}
