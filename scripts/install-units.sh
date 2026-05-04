#!/usr/bin/env bash
# Install/refresh the systemd units on the VPS. Run from the project root on
# your laptop; uses scripts/vps.sh for SSH.
#
#   ./scripts/install-units.sh
#
# Idempotent. Safe to re-run after editing systemd/*.service.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"

for unit in latefyi-poller latefyi-ingest; do
  echo "→ uploading $unit.service"
  cat "$HERE/systemd/$unit.service" | "$HERE/scripts/vps.sh" "cat > /etc/systemd/system/$unit.service"
done

"$HERE/scripts/vps.sh" '
  systemctl daemon-reload
  # Kill any orphan instances (started outside systemd, before flock guard).
  pkill -f /opt/latefyi/src/poll-runner.js   2>/dev/null || true
  pkill -f /opt/latefyi/src/ingest-server.js 2>/dev/null || true
  sleep 1
  systemctl restart latefyi-poller latefyi-ingest
  sleep 2
  echo "--- units status ---"
  systemctl is-active latefyi-poller latefyi-ingest
  echo "--- processes ---"
  ps -ef | grep -E "node.*(poll-runner|ingest-server)" | grep -v grep
'
