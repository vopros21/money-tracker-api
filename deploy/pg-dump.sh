#!/usr/bin/env bash
# Weekly logical dump of money_tracker. Run as postgres by money-tracker-backup.timer
# (Saturday 12:00, after the weekly balance update). restic then copies $OUT to R2
# and the Mac pulls it (deploy/mac/sync-money-backups.sh).
#
# Retention is count-based: keep the newest $KEEP dumps. Age-based pruning would
# delete everything if the Pi missed a few weeks; this never does.
#
# $OUT must exist: install -d -o postgres -g mike -m 2750 /var/backups/money-tracker
# (setgid + group mike, so mike's restic job and the Mac's rsync can read the dumps).
set -euo pipefail

OUT=${OUT:-/var/backups/money-tracker}
DB=${DB:-money_tracker}
KEEP=${KEEP:-8}

umask 027
stamp=$(date +%Y-%m-%dT%H%M)
final="$OUT/money_tracker-$stamp.dump"
tmp="$OUT/.money_tracker-$stamp.dump.partial"   # hidden: never picked up by rsync/retention
trap 'rm -f "$tmp"' EXIT

pg_dump -Fc "$DB" > "$tmp"
pg_restore --list "$tmp" > /dev/null             # the archive must be readable
chmod 640 "$tmp"
mv "$tmp" "$final"

# Names sort chronologically (ISO timestamp), so this keeps the newest $KEEP.
ls -1 "$OUT"/money_tracker-*.dump | sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -f --

echo "wrote $final ($(stat -c %s "$final") bytes); $(ls -1 "$OUT"/money_tracker-*.dump | wc -l) dumps kept"
