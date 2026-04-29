// Integration test for scripts/wake.sh. Sets up a tmp state dir with synthetic
// pending files (one due, one not), runs the script, and asserts the right
// files moved. Skips if jq isn't available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'wake.sh');

function hasJq() {
  try { execSync('command -v jq', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function pendingRecord(msgid, pollStartIso) {
  return {
    msgid,
    sender: 'amr@example.com',
    schedule: { poll_start_time: pollStartIso, poll_end_time: null },
    state: { phase: 'SCHEDULED' },
  };
}

test('wake.sh activates due files, leaves future ones in pending', { skip: !hasJq() && 'jq not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'latefyi-wake-'));
  for (const sub of ['pending', 'active', 'done', 'errors']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  // One file due (5 min ago), one file not due (1h in the future)
  const now = Date.now();
  writeFileSync(
    join(dir, 'pending', 'due.json'),
    JSON.stringify(pendingRecord('<due@late.fyi>', new Date(now - 5*60*1000).toISOString()))
  );
  writeFileSync(
    join(dir, 'pending', 'future.json'),
    JSON.stringify(pendingRecord('<future@late.fyi>', new Date(now + 60*60*1000).toISOString()))
  );

  // Run wake.sh with STATE_DIR pointed at our tmp dir
  const out = execSync(SCRIPT, {
    env: { ...process.env, STATE_DIR: dir, LOG_DIR: join(dir, 'logs'), POLL_RUNNER: '/nope' },
    encoding: 'utf8',
  });

  const pending = readdirSync(join(dir, 'pending'));
  const active = readdirSync(join(dir, 'active'));

  assert.deepEqual(pending, ['future.json'], `pending should keep future, got: ${pending}\nout:\n${out}`);
  assert.deepEqual(active, ['due.json'], `active should have due, got: ${active}\nout:\n${out}`);
});

test('wake.sh handles malformed pending file without crashing', { skip: !hasJq() && 'jq not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'latefyi-wake-'));
  for (const sub of ['pending', 'active', 'done', 'errors']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, 'pending', 'broken.json'), '{ not json');

  // Should not throw
  execSync(SCRIPT, {
    env: { ...process.env, STATE_DIR: dir, LOG_DIR: join(dir, 'logs'), POLL_RUNNER: '/nope' },
    encoding: 'utf8',
  });

  // Broken file stays in pending (safer than moving forward with bad data)
  assert.ok(existsSync(join(dir, 'pending', 'broken.json')));
});
