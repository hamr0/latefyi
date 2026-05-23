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
  '# set -e on the REMOTE block: a failed git pull / npm ci must abort the
   # deploy, not fall through to restarting stale code. (2026-05-23: a dirty
   # package-lock.json blocked the pull, but without set -e the block kept
   # going and silently restarted the old build.)
   set -e
   git config --global --add safe.directory /opt/latefyi 2>/dev/null || true
   cd /opt/latefyi
   # package-lock.json is generated, never hand-edited — discard any local
   # drift (e.g. a stale version stamp from a past `npm install`) so it cannot
   # block a fast-forward pull.
   git checkout -- package-lock.json 2>/dev/null || true
   git pull --ff-only
   # Install runtime deps from the lockfile when it changed (node_modules is
   # gitignored). Without this a dependency bump — e.g. the nodemailer 6→8
   # security upgrade — never reaches the running services. `npm ci` is a
   # deterministic clean install from package-lock and does not rewrite it.
   npm ci --omit=dev --no-audit --no-fund
   systemctl restart latefyi-ingest latefyi-poller
   # systemctl reports "active" the moment the unit starts; a node process
   # that crashes ~1s later (config-load EACCES, syntax error, port bind
   # race) will still pass the immediate check. Soak for 3s, then re-check.
   # 2026-05-04: caught a real EACCES regression that the immediate check missed.
   sleep 3
   # Reporting only past this point — do not abort on a non-zero is-active so
   # the journalctl tail still prints for diagnosis.
   set +e
   systemctl is-active latefyi-ingest latefyi-poller
   # Show recent log lines unconditionally so a successful "active" pair
   # still surfaces any startup warnings worth a human glance.
   journalctl -u latefyi-ingest -u latefyi-poller --since "5 seconds ago" --no-pager | tail -20'
