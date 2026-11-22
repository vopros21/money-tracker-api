#!/usr/bin/env bash
# Mac-side copy of the Pi's money_tracker dumps. Installed as ~/scripts/sync-money-backups.sh,
# run by the LaunchAgent eu.singledev.money-backup-sync (Sat 13:00/15:00/18:00, Sun 12:00;
# the Pi dumps on Saturday 12:00). Modeled on ~/scripts/sync-parking-backups.sh.
#
# - prazo-pi.local doesn't answer within a few seconds (laptop away from home): one log
#   line, exit 0. Not an error.
# - Pulls only money_tracker-*.dump (never the Pi's in-progress .partial files), no --delete:
#   the Pi keeps 8 dumps, the Mac keeps 90 days.
# - Prunes (> 90 days) only after a successful rsync that brought a dump younger than 8 days.
# - Freshness is monitored by toolhealth (check money-db-backup), so no alerts from here.
# The SYNC_* variables exist only for tests.
set -uo pipefail

REMOTE=${SYNC_REMOTE:-prazo-pi}                    # ~/.ssh/config alias (user mike)
REMOTE_DIR=${SYNC_REMOTE_DIR:-/var/backups/money-tracker/}
LOCAL_DIR=${SYNC_LOCAL_DIR:-$HOME/Backups/money-db/}
LOG_FILE=${SYNC_LOG_FILE:-$HOME/scripts/logs/sync-money-backups.log}
PATTERN='money_tracker-*.dump'
FRESH_MIN=$((8 * 24 * 60))
KEEP_DAYS=90
# Reach the Pi by its mDNS name with a short timeout. HostKeyAlias = the alias's
# HostName from ~/.ssh/config, so the existing known_hosts entry verifies the key.
KNOWN_AS=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" {print $2; exit}')
SSH_CMD="ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o HostName=prazo-pi.local -o HostKeyAlias=${KNOWN_AS:-$REMOTE}"

log() { echo "[$(date '+%F %T')] $*"; }

mkdir -p "$(dirname "$LOG_FILE")" "$LOCAL_DIR"
exec >>"$LOG_FILE" 2>&1

if ! probe=$($SSH_CMD "$REMOTE" true 2>&1); then
  log "prazo-pi.local not reachable, skipping ($(printf '%s' "$probe" | tail -1 | cut -c1-120))"
  exit 0
fi

log "--- sync start ---"
if ! rsync -az --itemize-changes --include="$PATTERN" --exclude='*' -e "$SSH_CMD" \
    "$REMOTE:$REMOTE_DIR" "$LOCAL_DIR"; then
  log "FAILED: rsync error although the Pi answered. Nothing pruned."
  exit 1
fi

# rsync -a keeps the Pi's mtimes, so this is the age of the newest dump the Pi made.
NEWEST=$(find "$LOCAL_DIR" -maxdepth 1 -type f -name "$PATTERN" -exec stat -f '%m %N' {} + 2>/dev/null \
  | sort -n | tail -1 | cut -d' ' -f2-)
if [ -z "$NEWEST" ] || [ -z "$(find "$NEWEST" -mmin -"$FRESH_MIN")" ]; then
  log "FAILED: no dump newer than 8 days on the Pi (money-tracker-backup.timer not running?). Nothing pruned."
  exit 1
fi

find "$LOCAL_DIR" -maxdepth 1 -type f -name "$PATTERN" -mtime +"$KEEP_DAYS" -delete
log "OK. Newest dump: $(basename "$NEWEST") ($(stat -f %z "$NEWEST") bytes)"
