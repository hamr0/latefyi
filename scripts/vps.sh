#!/usr/bin/env bash
# Run a command on the latefyi VPS using credentials from `pass`.
#   scripts/vps.sh                        # interactive shell
#   scripts/vps.sh 'tail -n50 /opt/latefyi/logs/poller.log'
#   scripts/vps.sh -- scp file root@host:/path   # arbitrary ssh-family commands
set -euo pipefail

KEY="${LATEFYI_SSH_KEY:-/tmp/latefyi_key}"
HOST="$(pass latefyi/ssh/host)"
USER="$(pass latefyi/ssh/user)"

if [ ! -s "$KEY" ] || ! ssh-keygen -y -f "$KEY" >/dev/null 2>&1; then
  {
    echo '-----BEGIN OPENSSH PRIVATE KEY-----'
    pass latefyi/ssh/private_key | grep -oP '(?<=username: ).*' | fold -w 70
    echo '-----END OPENSSH PRIVATE KEY-----'
  } > "$KEY"
  chmod 600 "$KEY"
fi

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes)

if [ "${1:-}" = "--" ]; then
  shift
  exec "$@" "${SSH_OPTS[@]}"
fi

if [ $# -eq 0 ]; then
  exec ssh "${SSH_OPTS[@]}" "$USER@$HOST"
else
  exec ssh "${SSH_OPTS[@]}" "$USER@$HOST" "$@"
fi
