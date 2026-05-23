#!/usr/bin/env bash
set -euo pipefail

SSH_HOST=$(pass latefyi/ssh/host)
SSH_USER=$(pass latefyi/ssh/user)

KEYFILE=$(mktemp)
chmod 600 "$KEYFILE"
trap 'rm -f "$KEYFILE"' EXIT

pass latefyi/ssh/private_key \
  | grep "^username: " \
  | sed 's/^username: //' \
  | base64 -d \
  | base64 -w 70 \
  | { echo "-----BEGIN OPENSSH PRIVATE KEY-----"; cat; echo "-----END OPENSSH PRIVATE KEY-----"; } \
  > "$KEYFILE"

ssh -i "$KEYFILE" -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" \
  'git config --global --add safe.directory /opt/latefyi 2>/dev/null || true
   cd /opt/latefyi
   git pull
   # Install runtime deps from the lockfile when it changed (node_modules is
   # gitignored). Without this a dependency bump — e.g. the nodemailer 6→8
   # security upgrade — never reaches the running services. `npm ci` is
   # deterministic (clean install from package-lock); if it fails, set -e on
   # the local side aborts before the restart so we never run half-installed.
   npm ci --omit=dev --no-audit --no-fund
   systemctl restart latefyi-ingest latefyi-poller
   # systemctl reports "active" the moment the unit starts; a node process
   # that crashes ~1s later (config-load EACCES, syntax error, port bind
   # race) will still pass the immediate check. Soak for 3s, then re-check.
   # 2026-05-04: caught a real EACCES regression that the immediate check missed.
   sleep 3
   systemctl is-active latefyi-ingest latefyi-poller
   # Show recent log lines unconditionally so a successful "active" pair
   # still surfaces any startup warnings worth a human glance.
   journalctl -u latefyi-ingest -u latefyi-poller --since "5 seconds ago" --no-pager | tail -20'
