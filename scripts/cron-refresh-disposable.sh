#!/usr/bin/env bash
# Cron-driven quarterly refresh of config/disposable-domains.txt.
# Restarts latefyi-ingest if the snapshot changed (so the new domains load
# without a deploy), and emails the operator with success/failure details.
#
# Crontab (root):
#   0 6 1 1,4,7,10 * /opt/latefyi/scripts/cron-refresh-disposable.sh
#
# Note on git: this script writes the snapshot in-place inside the repo
# checkout. After it runs, `/opt/latefyi/config/disposable-domains.txt`
# will be a working-tree change vs origin until you mirror it back from
# the laptop (`git pull` on VPS picks up your laptop commits; if both
# sides changed, resolve manually). The snapshot is append-mostly data,
# so drift is harmless until you next deploy.

set -uo pipefail

ROOT='/opt/latefyi'
DEST="$ROOT/config/disposable-domains.txt"
NOTIFY='avoidaccess@gmail.com'
NOW="$(date -u +%FT%TZ)"
HOST="$(hostname -f 2>/dev/null || hostname)"

OLD_COUNT=0
[ -f "$DEST" ] && OLD_COUNT="$(wc -l < "$DEST")"
OLD_HASH="$(sha256sum "$DEST" 2>/dev/null | cut -d' ' -f1)"

# Run the refresh; capture stdout+stderr for the report.
REFRESH_OUT="$("$ROOT/scripts/refresh-disposable-domains.sh" 2>&1)"
REFRESH_EXIT=$?

NEW_COUNT=0
[ -f "$DEST" ] && NEW_COUNT="$(wc -l < "$DEST")"
NEW_HASH="$(sha256sum "$DEST" 2>/dev/null | cut -d' ' -f1)"

CHANGED='no'
[ "$OLD_HASH" != "$NEW_HASH" ] && CHANGED='yes'

RESTART_OUT=''
RESTART_EXIT=0
if [ "$REFRESH_EXIT" -eq 0 ] && [ "$CHANGED" = 'yes' ]; then
  RESTART_OUT="$(systemctl restart latefyi-ingest 2>&1)"
  RESTART_EXIT=$?
fi

if [ "$REFRESH_EXIT" -eq 0 ] && [ "$RESTART_EXIT" -eq 0 ]; then
  SUBJECT="[late.fyi] disposable-domains refresh OK ($OLD_COUNT → $NEW_COUNT)"
else
  SUBJECT="[late.fyi] disposable-domains refresh FAILED (refresh=$REFRESH_EXIT, restart=$RESTART_EXIT)"
fi

# Build the body. mail(1) isn't installed by default on minimal hosts;
# use sendmail directly so we don't add another package dependency.
{
  printf 'From: noreply@late.fyi\n'
  printf 'To: %s\n' "$NOTIFY"
  printf 'Subject: %s\n' "$SUBJECT"
  printf 'Content-Type: text/plain; charset=utf-8\n'
  printf '\n'
  printf 'When:    %s\n' "$NOW"
  printf 'Host:    %s\n' "$HOST"
  printf 'Old:     %s domains (sha256 %s)\n' "$OLD_COUNT" "${OLD_HASH:-none}"
  printf 'New:     %s domains (sha256 %s)\n' "$NEW_COUNT" "${NEW_HASH:-none}"
  printf 'Changed: %s\n' "$CHANGED"
  printf '\n--- refresh output ---\n%s\n' "$REFRESH_OUT"
  if [ -n "$RESTART_OUT" ]; then
    printf '\n--- ingest restart ---\n%s\n' "$RESTART_OUT"
  fi
  if [ "$CHANGED" = 'yes' ]; then
    printf '\nThe snapshot inside the git checkout changed.\n'
    printf 'Mirror it back to git from your laptop when convenient:\n'
    printf '  scripts/vps.sh "cat %s" > config/disposable-domains.txt\n' "$DEST"
    printf '  git commit -am "chore: refresh disposable-domains snapshot"\n'
    printf '  git push\n'
  fi
} | /usr/sbin/sendmail -t

exit 0  # never fail the cron — the email IS the failure signal
