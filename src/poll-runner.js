// Poll-runner daemon. Scans state/active/*.json each tick; for each file
// where shouldPollNow() is true, runs poll(), atomic-writes the updated
// record, appends events to logs/push.jsonl, and moves the file to state/done/
// when isTerminal().
//
// Two entry points:
//   tick({ stateDir, logDir, getClient, now })  — one pass; testable
//   run({ stateDir, logDir, getClient, intervalMs })  — loops forever
//
// The client is dependency-injected via getClient(endpointName) so tests can
// supply fakes and so primary/fallback can be swapped at runtime.

import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, unlinkSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { poll, shouldPollNow, isTerminal } from './poll.js';
import { dispatch } from './push.js';
import { senderHash } from './users.js';

// 10 attempts × 30s minimum cadence ≈ 5 min retry window. Long enough to
// ride out a postfix restart / nodemailer hiccup, short enough that a real
// outage pages the operator within minutes (see operatorAlert below).
const MAX_DELIVERY_ATTEMPTS = 10;

function ensureDirs(stateDir, logDir) {
  // Only `active/` is needed long-term. Terminal records are deleted, not
  // moved to `done/`. Malformed records are deleted with a log line, not
  // archived to `errors/`. Privacy: nothing per-trip survives a trip ending.
  mkdirSync(join(stateDir, 'active'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// One pass over state/active/. Returns a summary (helpful for tests + logs).
//
//   stateDir       path
//   logDir         path
//   getClient      (endpointName: string) → hafasClient
//   now            ms (defaults to Date.now())
//   transport?     { sendEmail, sendNtfy } — when present, events are
//                  ALSO dispatched to the user via push.dispatch.
//                  When absent (default), only the audit log is written.
//   getUserChannel?  (sender: string) → 'email'|'ntfy'|'both'
//                  Required if transport is provided. Looks up per-user pref.
//
export async function tick({ stateDir, logDir, getClient, now = Date.now(), transport = null, getUserChannel = null, operatorEmail = null, ntfyEnabled = false }) {
  ensureDirs(stateDir, logDir);
  const activeDir = join(stateDir, 'active');
  const pushLog = join(logDir, 'push.jsonl');
  const deliveryErrLog = join(logDir, 'delivery-errors.log');

  const summary = { polled: 0, skipped: 0, events: 0, terminal: 0, errors: 0 };

  let files;
  try { files = readdirSync(activeDir).filter(f => f.endsWith('.json')); }
  catch { return summary; }

  for (const f of files) {
    const path = join(activeDir, f);
    const record = readJson(path);
    if (!record) {
      // Malformed record. Log + delete; we can't recover anything from it
      // and we don't archive (privacy: no orphan records sitting around).
      summary.errors++;
      console.error(`[poll-runner] dropping malformed record ${f}`);
      try { unlinkSync(path); } catch { /* race with another tick — fine */ }
      continue;
    }

    // Evict stale terminal records that shouldPollNow refuses to re-poll.
    // Without this, an arrived record where the eviction path didn't fire on
    // the first arrived-tick (e.g., now - predictedArrival was still under the
    // 5-min linger) sticks around forever — phase=terminal blocks shouldPollNow,
    // which blocks the eviction check below. Run isTerminal independently here.
    if (isTerminal(record, now)) {
      try { unlinkSync(path); } catch { /* race — fine */ }
      summary.terminal++;
      continue;
    }

    if (!shouldPollNow(record, now)) {
      summary.skipped++;
      continue;
    }

    const endpoint = record.state?.endpointInUse || record.resolved?.endpoint || 'oebb';
    const client = getClient(endpoint);
    if (!client) {
      summary.errors++;
      continue;
    }

    let result;
    try {
      result = await poll({ activeRecord: record, client, now });
    } catch (e) {
      summary.errors++;
      const err = { ...record, state: { ...record.state, lastError: e.message } };
      atomicWrite(path, err);
      continue;
    }

    summary.polled++;
    summary.events += result.events.length;

    // Append events to push log (one JSON per line per PRD §11).
    // Hash the sender — push.jsonl is long-lived and we don't want plaintext
    // emails accumulating in a log file. The hash is enough to attribute /
    // debug per-user delivery without retaining contact info.
    for (const evt of result.events) {
      appendFileSync(pushLog, JSON.stringify({
        msgid: record.msgid,
        senderHash: senderHash(record.sender),
        trainNum: record.request.trainNum,
        ...evt,
        at: result.snapshot?.pollTimestamp || new Date(now).toISOString(),
      }) + '\n');
    }

    // Optional delivery: if a transport was provided, dispatch the events
    // through push.dispatch. The audit log above is independent of delivery
    // success — it always records what *would* have been sent.
    //
    // Retry semantics: events whose email/ntfy send fails are stashed in
    // record.state.pendingDeliveries and re-attempted on the next tick. Each
    // event has its own attempt counter; after MAX_DELIVERY_ATTEMPTS we drop
    // it with a loud error log (the audit row in push.jsonl already exists).
    let updatedRecord = result.updatedRecord;
    const pending = (record.state?.pendingDeliveries || []);
    const eventsToSend = [...pending.map(p => p.event), ...result.events];
    if (transport && getUserChannel && eventsToSend.length > 0) {
      // ntfy is deferred. `ntfyEnabled` (default false) is the single source of
      // truth for the pause: dispatch strips ntfy from EVERY result, including
      // the critical-event override that would otherwise publish cancellations
      // to the public, email-derivable ntfy topic. To un-pause, set
      // NTFY_ENABLED=true at the CLI — the per-user channel preference below
      // then takes effect again.
      const userChannel = ntfyEnabled ? (getUserChannel(record.sender) || 'email') : 'email';
      const dispatchResults = await dispatch({
        events: eventsToSend,
        sender: record.sender,
        userChannel,
        line: record.resolved?.line,
        trainNum: record.request.trainNum,
        trip: record.resolved?.trip,
        scheduledIso: record.resolved?.mode === 'A'
          ? record.resolved?.schedule?.scheduledArrival
          : record.resolved?.schedule?.scheduledDeparture,
        confirmationMsgid: record.confirmationMsgid,
        transport,
        ntfyFailureCounter: record.state?.ntfyFailureCounter || 0,
        ntfyEnabled,
      });

      const newPending = [];
      for (let i = 0; i < dispatchResults.length; i++) {
        const dr = dispatchResults[i];
        const wasPending = i < pending.length;
        const priorAttempts = wasPending ? pending[i].attempts : 0;
        const failed = dr.results.filter(r => !r.ok);
        if (failed.length === 0) continue;
        const attempts = priorAttempts + 1;
        const sh = senderHash(record.sender);
        for (const fail of failed) {
          const line = `[${new Date(now).toISOString()}] delivery FAILED trainNum=${record.request.trainNum} senderHash=${sh} type=${dr.event.type} channel=${fail.channel} attempt=${attempts} error=${fail.error}`;
          console.error(`[poll-runner] ${line}`);
          try { appendFileSync(deliveryErrLog, line + '\n'); } catch { /* best-effort */ }
        }
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          const giveUp = `[${new Date(now).toISOString()}] GAVE UP after ${attempts} attempts trainNum=${record.request.trainNum} senderHash=${sh} type=${dr.event.type} channels=${failed.map(x => x.channel).join(',')} lastError=${failed[0]?.error}`;
          console.error(`[poll-runner] ${giveUp}`);
          try { appendFileSync(deliveryErrLog, giveUp + '\n'); } catch { /* best-effort */ }
          // Page the operator. Sent through the same SMTP — if SMTP is the
          // thing that's broken, this also fails (and gets logged), but we
          // don't have a second channel to fall back to.
          if (operatorEmail && transport?.sendEmail) {
            try {
              await transport.sendEmail({
                from: 'latefyi <noreply@late.fyi>',
                to: operatorEmail,
                subject: `[late.fyi] dropped ${dr.event.type} for ${record.request.trainNum}`,
                body: `${giveUp}\n\nUser event was dropped after ${MAX_DELIVERY_ATTEMPTS} retries.\nCheck logs/delivery-errors.log and journalctl -u latefyi-poller.\n`,
                headers: {},
              });
            } catch (e) {
              console.error(`[poll-runner] operator-alert SEND FAILED: ${e.message}`);
            }
          }
          continue;
        }
        newPending.push({ event: dr.event, attempts });
      }

      const lastStreak = dispatchResults.length ? dispatchResults[dispatchResults.length - 1].ntfyFailStreak : 0;
      updatedRecord = {
        ...updatedRecord,
        state: {
          ...updatedRecord.state,
          ntfyFailureCounter: lastStreak,
          pendingDeliveries: newPending,
        },
      };
      summary.delivered = (summary.delivered || 0) + dispatchResults.length;
      summary.deliveryFailures = (summary.deliveryFailures || 0) + (eventsToSend.length - dispatchResults.filter(r => r.results.every(x => x.ok)).length);
    }

    // Atomic write back (still in active/).
    atomicWrite(path, updatedRecord);

    // Delete on terminal (arrival, STOP, cancellation, tracking-lost). No
    // archive, no scrub-and-move — the record is simply gone. Aggregate
    // operator metrics live in state/users/<hash>.json (counters) and
    // logs/push.jsonl (event audit, senderHash only).
    if (isTerminal(result.updatedRecord, now)) {
      unlinkSync(path);
      summary.terminal++;
    }
  }

  return summary;
}

// Long-running entry point. Calls tick() at intervalMs cadence.
export async function run({ stateDir, logDir, getClient, intervalMs = 5_000, signal, transport = null, getUserChannel = null, operatorEmail = null, now = null, ntfyEnabled = false }) {
  while (!signal?.aborted) {
    try {
      const s = await tick({ stateDir, logDir, getClient, transport, getUserChannel, operatorEmail, ntfyEnabled, now: now ?? Date.now() });
      if (s.polled || s.events || s.terminal || s.errors) {
        console.log(`[poll-runner] ${new Date().toISOString()} polled=${s.polled} events=${s.events} terminal=${s.terminal} errors=${s.errors} skipped=${s.skipped}`);
      }
    } catch (e) {
      console.error(`[poll-runner] tick error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// CLI entry: `node src/poll-runner.js`. Wires up real hafas-client.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createClient } = await import('hafas-client');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, '..');
  const stateDir = process.env.STATE_DIR || join(root, 'state');
  const logDir   = process.env.LOG_DIR   || join(root, 'logs');

  const profiles = {};
  for (const name of ['oebb', 'pkp']) {
    try {
      const mod = await import(`hafas-client/p/${name}/index.js`);
      profiles[name] = createClient(mod.profile || mod.default, 'latefyi/0.11.0');
    } catch (e) {
      console.error(`failed to load profile ${name}: ${e.message}`);
    }
  }
  const getClient = (name) => profiles[name] || null;

  // Compose transports: SMTP for email pushes, ntfy for push pushes.
  // Either may be absent (dry-run for missing leg).
  let transport = null;
  let getUserChannel = null;
  const sendEmailFn = async () => { throw new Error('email not configured'); };
  const sendNtfyFn = async () => { throw new Error('ntfy not configured'); };
  let smtp = null, ntfy = null;
  if (process.env.SMTP_HOST) {
    const { createSmtpTransport } = await import('./smtp-transport.js');
    smtp = createSmtpTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromAddress: process.env.SMTP_FROM || 'noreply@late.fyi',
    });
    console.log(`[poll-runner] SMTP: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
  }
  {
    const { createNtfyTransport } = await import('./ntfy-transport.js');
    ntfy = createNtfyTransport({ baseUrl: process.env.NTFY_BASE_URL || 'https://ntfy.sh' });
    console.log(`[poll-runner] ntfy: ${process.env.NTFY_BASE_URL || 'https://ntfy.sh'}`);
  }
  transport = {
    sendEmail: smtp ? smtp.sendEmail.bind(smtp) : sendEmailFn,
    sendNtfy: ntfy ? ntfy.sendNtfy.bind(ntfy) : sendNtfyFn,
  };

  // Per-user channel preference lookup.
  const { getOrCreate } = await import('./users.js');
  getUserChannel = (sender) => getOrCreate(sender, stateDir).channel || 'email';

  const operatorEmail = process.env.OPERATOR_EMAIL || null;
  if (operatorEmail) console.log(`[poll-runner] operator alerts → ${operatorEmail}`);
  else console.warn('[poll-runner] OPERATOR_EMAIL not set — dropped events will only be visible in logs');

  // ntfy push is paused unless explicitly enabled. While off, NO event —
  // including cancellations — is published to the public ntfy topic.
  const ntfyEnabled = (process.env.NTFY_ENABLED || '').toLowerCase() === 'true';
  console.log(`[poll-runner] ntfy push: ${ntfyEnabled ? 'ENABLED' : 'paused (NTFY_ENABLED!=true)'}`);

  console.log(`[poll-runner] starting; stateDir=${stateDir} logDir=${logDir}`);
  await run({ stateDir, logDir, getClient, transport, getUserChannel, operatorEmail, ntfyEnabled });
}
