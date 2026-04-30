#!/usr/bin/env bash
# Weekly email digest of late.fyi metrics.
#
# Reads state/stats/daily.jsonl (one snapshot per day, see stats.sh), picks
# the latest snapshot from each of the last 4 ISO weeks (including this
# week), and emails a small plain-text report to LATEFYI_STATS_TO.
#
# Privacy: only aggregate counters. No per-user / per-trip data leaves
# the VPS.
#
# Run weekly via cron, e.g. Mondays at 00:07 UTC:
#   7 0 * * 1 /opt/latefyi/scripts/stats-email.sh

set -euo pipefail

ROOT="${LATEFYI_ROOT:-/opt/latefyi}"
STATE="${LATEFYI_STATE_DIR:-$ROOT/state}"
DAILY="$STATE/stats/daily.jsonl"

TO="${LATEFYI_STATS_TO:-avoidaccess@gmail.com}"
FROM="${LATEFYI_STATS_FROM:-noreply@late.fyi}"

if [[ ! -f "$DAILY" ]]; then
  echo "no daily.jsonl yet — run scripts/stats.sh first" >&2
  exit 0
fi

# Latest snapshot per ISO week, sorted ascending, last 4.
ROWS=$(jq -s '
  group_by(.date | strptime("%Y-%m-%d") | strftime("%G-W%V"))
  | map(max_by(.date))
  | sort_by(.date)
  | .[-4:]
' "$DAILY")

ROW_COUNT=$(echo "$ROWS" | jq 'length')
if [[ "$ROW_COUNT" -eq 0 ]]; then
  echo "daily.jsonl has no rows yet" >&2
  exit 0
fi

# Plain-text table.
TABLE=$(echo "$ROWS" | jq -r '
  .[] | "  \(.date)   users=\(.users_total)  trips=\(.trips_total)  active(u/t)=\(.active_users)/\(.active_trips)  events=\(.events_total)"
')

LATEST=$(echo "$ROWS"  | jq '.[-1]')
EARLIEST=$(echo "$ROWS" | jq '.[0]')

DELTA_USERS=$(jq -n --argjson a "$LATEST" --argjson b "$EARLIEST" '$a.users_total - $b.users_total')
DELTA_TRIPS=$(jq -n --argjson a "$LATEST" --argjson b "$EARLIEST" '$a.trips_total - $b.trips_total')
DELTA_EVENTS=$(jq -n --argjson a "$LATEST" --argjson b "$EARLIEST" '$a.events_total - $b.events_total')
SPAN_DAYS=$(jq -n --argjson a "$LATEST" --argjson b "$EARLIEST" \
  '(($a.date | strptime("%Y-%m-%d") | mktime) - ($b.date | strptime("%Y-%m-%d") | mktime)) / 86400 | floor')

DATE_TODAY=$(date -u +%Y-%m-%d)

sendmail -f "$FROM" -t <<EOF
From: $FROM
To: $TO
Subject: late.fyi weekly snapshot ($DATE_TODAY)

Last 4 weeks (latest snapshot in each ISO week):

$TABLE

Δ over $SPAN_DAYS days: +$DELTA_USERS users, +$DELTA_TRIPS trips, +$DELTA_EVENTS events.

— late.fyi (auto-digest, weekly Monday)
EOF
