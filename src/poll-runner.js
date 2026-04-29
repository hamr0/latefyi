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

import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { poll, shouldPollNow, isTerminal } from './poll.js';
import { dispatch } from './push.js';

function ensureDirs(stateDir, logDir) {
  for (const sub of ['active', 'done', 'errors']) mkdirSync(join(stateDir, sub), { recursive: true });
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
export async function tick({ stateDir, logDir, getClient, now = Date.now(), transport = null, getUserChannel = null }) {
  ensureDirs(stateDir, logDir);
  const activeDir = join(stateDir, 'active');
  const doneDir = join(stateDir, 'done');
  const errorsDir = join(stateDir, 'errors');
  const pushLog = join(logDir, 'push.jsonl');

  const summary = { polled: 0, skipped: 0, events: 0, terminal: 0, errors: 0 };

  let files;
  try { files = readdirSync(activeDir).filter(f => f.endsWith('.json')); }
  catch { return summary; }

  for (const f of files) {
    const path = join(activeDir, f);
    const record = readJson(path);
    if (!record) {
      summary.errors++;
      try { renameSync(path, join(errorsDir, f)); } catch { /* ignore */ }
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
    for (const evt of result.events) {
      appendFileSync(pushLog, JSON.stringify({
        msgid: record.msgid,
        sender: record.sender,
        trainNum: record.request.trainNum,
        ...evt,
        at: result.snapshot?.pollTimestamp || new Date(now).toISOString(),
      }) + '\n');
    }

    // Optional delivery: if a transport was provided, dispatch the events
    // through push.dispatch. The audit log above is independent of delivery
    // success — it always records what *would* have been sent.
    let updatedRecord = result.updatedRecord;
    if (transport && getUserChannel && result.events.length > 0) {
      const userChannel = getUserChannel(record.sender) || 'email';
      const dispatchResults = await dispatch({
        events: result.events,
        sender: record.sender,
        userChannel,
        line: record.resolved?.line,
        trainNum: record.request.trainNum,
        confirmationMsgid: record.confirmationMsgid,
        transport,
        ntfyFailureCounter: record.state?.ntfyFailureCounter || 0,
      });
      // Persist the rolling ntfy failure streak across polls.
      const lastStreak = dispatchResults.length ? dispatchResults[dispatchResults.length - 1].ntfyFailStreak : 0;
      updatedRecord = {
        ...updatedRecord,
        state: { ...updatedRecord.state, ntfyFailureCounter: lastStreak },
      };
      summary.delivered = (summary.delivered || 0) + dispatchResults.length;
    }

    // Atomic write back (still in active/).
    atomicWrite(path, updatedRecord);

    // Move to done/ if terminal.
    if (isTerminal(result.updatedRecord, now)) {
      const dest = join(doneDir, f);
      renameSync(path, dest);
      summary.terminal++;
    }
  }

  return summary;
}

// Long-running entry point. Calls tick() at intervalMs cadence.
export async function run({ stateDir, logDir, getClient, intervalMs = 5_000, signal }) {
  while (!signal?.aborted) {
    try {
      const s = await tick({ stateDir, logDir, getClient });
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
      profiles[name] = createClient(mod.profile || mod.default, 'latefyi/0.3.0');
    } catch (e) {
      console.error(`failed to load profile ${name}: ${e.message}`);
    }
  }
  const getClient = (name) => profiles[name] || null;
  console.log(`[poll-runner] starting; stateDir=${stateDir} logDir=${logDir}`);
  await run({ stateDir, logDir, getClient });
}
