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

ssh -i "$KEYFILE" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
  'git config --global --add safe.directory /opt/latefyi 2>/dev/null || true
   cd /opt/latefyi
   git pull
   systemctl restart latefyi-ingest latefyi-poller
   systemctl is-active latefyi-ingest latefyi-poller'
