#!/usr/bin/env node
// Growth metrics for the pulselog weekly digest (see pulselog.config.json →
// digest.metricsCommand). Prints ONE flat JSON object of named integers to
// stdout and exits 0. This is the only app-specific code in the observability
// setup; pulselog turns these absolute counters into a week-over-week table.
//
//   node bin/stats.js --metrics-json
//   → {"users":128,"trains":2310,"completed":1980,"active_trains":6,"active_users":4}
//
// Privacy: counts only — nothing here that wasn't already a row we keep for
// product reasons (user preference files + the push audit log). No plaintext
// sender ever touches this output; active users are counted by senderHash.
// Mirrors scripts/stats.sh, in Node so the digest needs no jq/bash and reads
// every number in a single process.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.STATE_DIR || join(root, 'state');

// A missing STATE_DIR means misconfiguration (wrong path / not deployed), not
// "zero users" — exit non-zero so pulselog records null rather than a silent 0.
// An existing-but-empty state tree is a legitimate zero and returns normally.
if (!existsSync(stateDir)) {
  process.stderr.write(`stats: STATE_DIR not found: ${stateDir}\n`);
  process.exit(1);
}

function jsonFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
  } catch {
    return []; // subdir absent = genuinely nothing there yet
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const usersDir = join(stateDir, 'users');
const activeDir = join(stateDir, 'active');

// Total customers ever — one file per senderHash.
const userFiles = jsonFiles(usersDir);
const users = userFiles.length;

// Per-user cumulative counters, summed across all user files:
//   trains    — trips ever scheduled  (incrementTrainCount on each track request)
//   completed — trips that ran to a terminal end (incrementCompletedCount in the
//               poll-runner). "works ran" in the weekly digest.
let trains = 0;
let completed = 0;
for (const f of userFiles) {
  const u = readJson(join(usersDir, f));
  const t = Number(u?.trains_tracked_count);
  if (Number.isFinite(t)) trains += t;
  const c = Number(u?.trains_completed_count);
  if (Number.isFinite(c)) completed += c;
}

// Currently tracked, and distinct users behind them (by senderHash only).
const activeFiles = jsonFiles(activeDir);
const active_trains = activeFiles.length;
const activeHashes = new Set();
for (const f of activeFiles) {
  const r = readJson(join(activeDir, f));
  if (r?.senderHash) activeHashes.add(r.senderHash);
}
const active_users = activeHashes.size;

process.stdout.write(
  JSON.stringify({ users, trains, completed, active_trains, active_users }) + '\n'
);
