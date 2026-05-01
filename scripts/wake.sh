#!/usr/bin/env bash
#
# wake.sh — cron-driven activator + housekeeping.
# PRD §13.8.
#
# Run every minute via cron:
#   * * * * * /opt/latefyi/scripts/wake.sh >> /opt/latefyi/logs/wake.log 2>&1
#
# Responsibilities:
#   1. Move pending/*.json whose poll_start_time has arrived → active/
#   2. Ensure the poll-runner daemon is alive (start if not)
#
# Dependencies: bash, jq, date(GNU coreutils), find, pgrep.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${STATE_DIR:-$ROOT/state}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
POLL_RUNNER="${POLL_RUNNER:-$ROOT/src/poll-runner.js}"

mkdir -p "$STATE_DIR/pending" "$STATE_DIR/active" "$LOG_DIR"

NOW_TS=$(date -u +%s)
ACTIVATED=0

# 1. Activate due pending requests.
shopt -s nullglob
for f in "$STATE_DIR"/pending/*.json; do
  # jq exits non-zero on malformed JSON; treat that the same as missing field
  # so a corrupt file doesn't take down the whole activation pass.
  poll_start=$(jq -r '.schedule.poll_start_time // empty' "$f" 2>/dev/null || true)
  if [ -z "$poll_start" ]; then
    echo "$(date -u +%FT%TZ) skip (no poll_start_time / parse error): $(basename "$f")"
    continue
  fi
  start_ts=$(date -u -d "$poll_start" +%s 2>/dev/null || true)
  if [ -z "$start_ts" ]; then
    echo "$(date -u +%FT%TZ) skip (bad timestamp): $(basename "$f")"
    continue
  fi
  if [ "$start_ts" -le "$NOW_TS" ]; then
    mv "$f" "$STATE_DIR/active/$(basename "$f")"
    echo "$(date -u +%FT%TZ) activated: $(basename "$f")"
    ACTIVATED=$((ACTIVATED + 1))
  fi
done

# 2. Ensure poll-runner is running (only if it exists; Phase 3 introduces it).
if [ -f "$POLL_RUNNER" ]; then
  if ! pgrep -f "node $POLL_RUNNER" >/dev/null 2>&1; then
    nohup node "$POLL_RUNNER" >> "$LOG_DIR/poller.log" 2>&1 &
    echo "$(date -u +%FT%TZ) poll-runner started (pid $!)"
  fi
fi

[ "$ACTIVATED" -gt 0 ] && echo "$(date -u +%FT%TZ) wake.sh: activated $ACTIVATED"
exit 0
