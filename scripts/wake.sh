#!/usr/bin/env bash
#
# wake.sh — cron-driven pending-request activator.
#
# Run every minute via cron:
#   * * * * * /opt/latefyi/scripts/wake.sh >> /opt/latefyi/logs/wake.log 2>&1
#
# Responsibility:
#   Move pending/*.json whose poll_start_time has arrived → active/
#
# The poll-runner daemon is owned by systemd (latefyi-poller.service) — do
# NOT start it here. This script used to spawn it via nohup whenever pgrep
# missed systemd's process (different argv path), which produced a duplicate
# daemon every minute that ran with no env vars (no SMTP_HOST → sends failed
# silently). May 2026 incident with EUR9316: the orphan beat the systemd
# process to events and dropped them.
#
# Dependencies: bash, jq, date(GNU coreutils).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${STATE_DIR:-$ROOT/state}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"

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

[ "$ACTIVATED" -gt 0 ] && echo "$(date -u +%FT%TZ) wake.sh: activated $ACTIVATED"
exit 0
