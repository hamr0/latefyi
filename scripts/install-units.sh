#!/usr/bin/env bash
# Install/refresh the systemd units on the VPS. Run from the project root on
# your laptop; uses scripts/vps.sh for SSH.
#
#   ./scripts/install-units.sh
#
# Idempotent. Safe to re-run after editing systemd/*.service or *.timer.
#
# Installs two long-lived daemons (poller, ingest) plus two observability
# timers (pulselog health every 15m, weekly stats digest). The pulselog config
# is RENDERED on the VPS from pulselog.config.template.json + /etc/latefyi.env
# (so $OPERATOR_EMAIL never lands in git); the rendered pulselog.config.json is
# gitignored, so deploy.sh's `git pull` never clobbers it. Assumes a deploy has
# already placed the repo (incl. the template + node_modules/pulselog) at
# /opt/latefyi — run scripts/deploy.sh first on a fresh box.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"

SERVICES="latefyi-poller latefyi-ingest latefyi-health latefyi-stats-digest"
TIMERS="latefyi-health latefyi-stats-digest"

for unit in $SERVICES; do
  echo "→ uploading $unit.service"
  "$HERE/scripts/vps.sh" "cat > /etc/systemd/system/$unit.service" < "$HERE/systemd/$unit.service"
done
for unit in $TIMERS; do
  echo "→ uploading $unit.timer"
  "$HERE/scripts/vps.sh" "cat > /etc/systemd/system/$unit.timer" < "$HERE/systemd/$unit.timer"
done

"$HERE/scripts/vps.sh" '
  set -euo pipefail

  # Render pulselog config from the committed template + /etc/latefyi.env.
  # Only ${OPERATOR_EMAIL} is substituted; every other value is literal.
  TEMPLATE=/opt/latefyi/pulselog.config.template.json
  OUT=/opt/latefyi/pulselog.config.json
  if [ ! -f "$TEMPLATE" ]; then
    echo "FATAL: $TEMPLATE missing — run scripts/deploy.sh first" >&2
    exit 1
  fi
  set -a; . /etc/latefyi.env; set +a
  : "${OPERATOR_EMAIL:?OPERATOR_EMAIL not set in /etc/latefyi.env}"
  sed "s|\${OPERATOR_EMAIL}|$OPERATOR_EMAIL|g" "$TEMPLATE" > "$OUT"
  # Ownership gate (pulselog >=0.4.0): config must be owned by the running user
  # or root and not group/world-writable, or the CLI refuses it.
  chown latefyi:latefyi "$OUT"
  chmod 644 "$OUT"
  if grep -q "\${OPERATOR_EMAIL}" "$OUT"; then
    echo "FATAL: $OUT still contains \${OPERATOR_EMAIL} after render" >&2
    exit 1
  fi
  echo "rendered $OUT"

  systemctl daemon-reload
  # Kill any orphan instances (started outside systemd, before flock guard).
  pkill -f /opt/latefyi/src/poll-runner.js   2>/dev/null || true
  pkill -f /opt/latefyi/src/ingest-server.js 2>/dev/null || true
  sleep 1
  systemctl restart latefyi-poller latefyi-ingest
  systemctl enable --now latefyi-health.timer latefyi-stats-digest.timer
  sleep 2
  echo "--- daemons ---"
  systemctl is-active latefyi-poller latefyi-ingest
  echo "--- timers ---"
  systemctl list-timers "latefyi-*" --no-pager || true
  echo "--- health check (dry, exit 0 = all green) ---"
  sudo -u latefyi /usr/bin/node /opt/latefyi/node_modules/pulselog/bin/pulselog.js --config "$OUT" && echo "health exit=0 (green)" || echo "health exit=$? (a check failed — an alert email was sent)"
'
