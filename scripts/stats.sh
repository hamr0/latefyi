#!/usr/bin/env bash
# Daily metrics snapshot for late.fyi.
#
# Once a day (cron), append a JSON line with absolute counters to
# state/stats/daily.jsonl. Privacy: counts only — no per-user, no per-trip
# detail. The numbers come from state we keep for product reasons (user
# preference files + push log), not from any retention added for stats.
#
# Idempotent: if today's row is already written, exits without rewriting.
# Run daily via cron, e.g. at 00:05 UTC:
#   5 0 * * * /opt/latefyi/scripts/stats.sh
#
# Inspect:
#   tail -1 state/stats/daily.jsonl | jq .         # latest snapshot
#   cat state/stats/daily.jsonl | jq -s 'last'     # same, more readable
#   cat state/stats/daily.jsonl                    # full history

set -euo pipefail

ROOT="${LATEFYI_ROOT:-/opt/latefyi}"
STATE="${LATEFYI_STATE_DIR:-$ROOT/state}"
LOG_DIR="${LATEFYI_LOG_DIR:-$ROOT/logs}"

OUT_DIR="$STATE/stats"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/daily.jsonl"

DATE=$(date -u +%Y-%m-%d)

# Skip if today's row already written. cron may double-fire on slow nodes
# or after a manual run earlier in the day.
if [[ -f "$OUT_FILE" ]] && grep -q "\"date\":\"$DATE\"" "$OUT_FILE"; then
  exit 0
fi

# Total customers ever — one file per senderHash.
USERS_TOTAL=$(find "$STATE/users" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l)

# Total trips ever — sum trains_tracked_count across all user files.
# (incrementTrainCount() bumps this on every successful schedule.)
TRIPS_TOTAL=0
if [[ -d "$STATE/users" ]]; then
  TRIPS_TOTAL=$(find "$STATE/users" -maxdepth 1 -name '*.json' -type f -print0 2>/dev/null \
    | xargs -0 -r jq -r '.trains_tracked_count // 0' 2>/dev/null \
    | awk '{s+=$1} END {print s+0}')
fi

# Active right now — currently tracked.
ACTIVE_TRIPS=$(find "$STATE/active" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l)
# Count distinct active users by senderHash (never touch plaintext sender).
ACTIVE_USERS=$(find "$STATE/active" -maxdepth 1 -name '*.json' -type f -print0 2>/dev/null \
  | xargs -0 -r jq -r '.senderHash // empty' 2>/dev/null \
  | sort -u | wc -l)

# Events fired ever — push.jsonl is append-only audit (senderHash, never plaintext).
EVENTS_TOTAL=0
if [[ -f "$LOG_DIR/push.jsonl" ]]; then
  EVENTS_TOTAL=$(wc -l < "$LOG_DIR/push.jsonl")
fi

printf '{"date":"%s","users_total":%d,"trips_total":%d,"active_users":%d,"active_trips":%d,"events_total":%d}\n' \
  "$DATE" "$USERS_TOTAL" "$TRIPS_TOTAL" "$ACTIVE_USERS" "$ACTIVE_TRIPS" "$EVENTS_TOTAL" \
  >> "$OUT_FILE"
