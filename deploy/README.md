# Running on prazo-pi (home network only)

One Node process serves both the API and the built frontend on
**http://prazo-pi.local:3010**. Data lives in the Pi's local PostgreSQL 17
(database `money_tracker`, role `money`). Nothing is port-forwarded or tunnelled,
so the app isn't reachable from the internet. There is no login: anyone on the
home Wi-Fi can open it (deliberate).

| What | Where |
|------|-------|
| Code | `/opt/money-tracker/api`, `/opt/money-tracker/frontend` (git clones, owner mike) |
| Service | `money-tracker.service` (user `money`, `TZ=UTC`), logs: `journalctl -u money-tracker` |
| Config | `/etc/money-tracker.env` (root, 600): `DATABASE_URL`, `STATIC_DIR`, `PORT` |
| Dumps | `/var/backups/money-tracker/money_tracker-<date>T<time>.dump` (newest 8) |
| Offsite | restic → Cloudflare R2 (the Pi's existing repo), tag `money-tracker` |
| Mac copy | `~/Backups/money-db/` (90 days), LaunchAgent `eu.singledev.money-backup-sync` |

## Install (as done in November 2026)

```bash
# Node >= 20.19 (Debian trixie's nodejs 20.19.2 is fine), PostgreSQL 17 running.
sudo useradd --system --no-create-home --home-dir /opt/money-tracker --shell /usr/sbin/nologin money
sudo -u postgres psql -c "CREATE ROLE money LOGIN PASSWORD '<generated>'" -c "CREATE DATABASE money_tracker OWNER money"
psql postgresql://money:<pw>@localhost/money_tracker -f /opt/money-tracker/api/schema.sql   # fresh DB only

sudo install -d -o mike -g mike /opt/money-tracker
git clone https://github.com/vopros21/money-tracker-api /opt/money-tracker/api
git clone https://github.com/vopros21/money-tracker-frontend /opt/money-tracker/frontend
(cd /opt/money-tracker/api && npm ci --omit=dev)
(cd /opt/money-tracker/frontend && npm ci && npm run build)     # VITE_API_URL unset

sudo install -m 600 money-tracker.env.example /etc/money-tracker.env   # then fill in the password
sudo cp money-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now money-tracker
curl http://prazo-pi.local:3010/health
```

The data was migrated from Neon (PostgreSQL 18) with `pg_dump --no-owner --no-acl`
from `postgresql-client-18` (PGDG apt repo), which can read the newer server, and
restored with `psql`. The old `magic_links`/`sessions` tables were dropped.

## Updating

```bash
cd /opt/money-tracker/api && git pull && npm ci --omit=dev && sudo systemctl restart money-tracker
cd /opt/money-tracker/frontend && git pull && npm ci && npm run build   # no restart needed
```

## Backups

Data changes once a week (Saturday morning), so backups run on weekends.

1. **Dump (Pi):** `money-tracker-backup.timer`, Saturday 12:00, `Persistent=true`
   (if the Pi was off, it runs at the next boot). Runs `pg-dump.sh` as `postgres`:
   `pg_dump -Fc` into `/var/backups/money-tracker/`, keeps the **newest 8 dumps**
   (count-based). The directory is `postgres:mike`, mode `2750`, so mike can read it.
   ```bash
   sudo install -d -o postgres -g mike -m 2750 /var/backups/money-tracker
   sudo cp money-tracker-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now money-tracker-backup.timer
   sudo systemctl start money-tracker-backup.service    # dump now
   ```
2. **Offsite (Pi):** mike's existing restic job (`~/.config/systemd/user/restic-mail-backup.service`,
   repo in `~/.config/restic/r2.env`) also backs up `/var/backups/money-tracker`
   with tag `money-tracker` (`--skip-if-unchanged`; forget `--keep-last 8 --keep-monthly 12`).
   The Gmail snapshots (tag `gmail`) and their retention are unchanged. The drop-in
   `restic/restic-mail-backup.timer.d/money-tracker.conf` adds a Saturday 12:30 run;
   the daily 03:30 run also picks up anything missed.
   ```bash
   ~/bin/restic-mail snapshots --tag money-tracker
   ```
3. **Mac:** `mac/sync-money-backups.sh` → `~/scripts/`, `mac/eu.singledev.money-backup-sync.plist`
   → `~/Library/LaunchAgents/` (`launchctl bootstrap gui/$(id -u) <plist>`). Runs Sat
   13:00/15:00/18:00 and Sun 12:00, exits quietly if prazo-pi.local doesn't answer,
   rsyncs the dumps to `~/Backups/money-db/` and prunes them after 90 days. Log:
   `~/scripts/logs/sync-money-backups.log`.
4. **Monitoring (Mac):** toolhealth check `money-db-backup`: newest
   `~/Backups/money-db/money_tracker-*.dump` must be ≥ 1 KB and < 8 days old.

## Failure alerts (Telegram)

`money-tracker.service` and `money-tracker-backup.service` reuse the mail backup's
alerting (mike's `~/bin/notify-unit-failure` / `notify-unit-ok`, bot token in
`~/.config/notify/telegram.env`): "❌ <unit> failed" + last 15 log lines, at most once
per unit per 6 h, and "✅ <unit> recovered" after the next successful start/run.
System units can't trigger mike's user template, so `notify/notify-failure@.service`
is a system twin that runs the same script as mike (`NOTIFY_JOURNAL=system`).
```bash
cd /opt/money-tracker/api/deploy/notify
sudo install -m 644 notify-failure@.service /etc/systemd/system/
for u in money-tracker money-tracker-backup; do
  sudo install -D -m 644 $u.service.d/notify.conf /etc/systemd/system/$u.service.d/notify.conf
done
sudo systemctl daemon-reload
```
The app unit only becomes active once `/health` answers. A crash loop ends in
`failed` after 5 starts in 10 min (`sudo systemctl reset-failed money-tracker` then
`start` once fixed). Tested 2026-11-22 for both units: a simulated failure sent ❌,
and the restore sent ✅.

## Restore

Dumps are custom format (`pg_dump -Fc`, PostgreSQL 17 on the Pi). Restore them
**on the Pi** with `pg_restore` (the Mac's `pg_restore` 16 can't read them).

**Test a dump without touching the live DB** (done 2026-11-22 with the Mac's copy of
`money_tracker-2026-11-22T1202.dump`: same sha256 as on the Pi, all row counts and the
net worth identical to `money_tracker`):
```bash
D=$(ls -1 /var/backups/money-tracker/money_tracker-*.dump | tail -1)   # newest
sudo -u postgres createdb money_restore_test
sudo -u postgres pg_restore --no-owner --no-acl --exit-on-error -d money_restore_test "$D"
for t in users accounts account_snapshots incomes; do
  echo "$t $(sudo -u postgres psql -XAt -d money_restore_test -c "select count(*) from $t") \
     live: $(sudo -u postgres psql -XAt -d money_tracker -c "select count(*) from $t")"
done
sudo -u postgres dropdb money_restore_test
```

**Replace the live DB with a dump:**
```bash
sudo systemctl start money-tracker-backup.service   # safety dump of the current state first
sudo systemctl stop money-tracker
sudo -u postgres dropdb money_tracker
sudo -u postgres createdb -O money money_tracker
sudo -u postgres pg_restore --no-owner --no-acl --role=money --exit-on-error \
  -d money_tracker /var/backups/money-tracker/money_tracker-<date>.dump
sudo systemctl start money-tracker
curl -s http://prazo-pi.local:3010/api/dashboard/summary
```

**Dump only on the Mac or only in R2?** Get it onto the Pi first, then use the
commands above with its path:
- From the Mac: `scp ~/Backups/money-db/money_tracker-<date>.dump prazo-pi:/tmp/`
  (then `chmod 644 /tmp/money_tracker-<date>.dump` so postgres can read it).
- From R2, on the Pi: `~/bin/restic-mail snapshots --tag money-tracker`, then
  `~/bin/restic-mail restore <id|latest> --tag money-tracker --target /tmp/money-restore`
  (files land under `/tmp/money-restore/var/backups/money-tracker/`).
