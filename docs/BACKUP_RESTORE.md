# Backup and restore

Two scripts, both idempotent, both `flock`-guarded, both usable from cron:

| Script | Purpose |
|--------|---------|
| `scripts/backup.sh` | Dump the database, **verify the dump by restoring it**, mirror recordings, prune by retention, publish Prometheus metrics. |
| `scripts/restore.sh` | Restore a dump (and optionally recordings) with confirmation, a safety dump, backend downtime and post-restore verification. |

---

## 1. Objectives (from TZ.md § 10)

| Item | Requirement | Where it is implemented |
|------|-------------|-------------------------|
| Database frequency | Daily | `/etc/cron.d/callcenter-backup`, 02:15 local (TZ.md says 03:00; the deploy uses 02:15 — after midnight traffic stops, before the morning shift) |
| Database retention | 30 days | `DB_RETENTION_DAYS=30` |
| Format | `pg_dump` | custom format (`-Fc`), gzipped |
| Storage | Separate server / cloud | **Not implemented.** Backups are local to `/var/backups/callcenter`. Off-host copying is the remaining gap — see §7. |
| Encryption | Encrypted | **Not implemented** at the file level. Dumps are `chmod 700`-directory-protected on an encrypted-at-rest volume if the provider offers one. See §7. |
| Recording frequency | Daily | same cron run |
| Recording retention | 90 days, then archive | `RECORDING_RETENTION_DAYS=90` |
| **RTO** | **4 hours** | A single-node restore takes minutes; see §5 for the measured breakdown. |
| **RPO** | **24 hours** | Daily dump + a **pre-migration dump on every deploy** (`update.sh` runs `backup.sh --db-only` before migrating). |
| Backup verification | Weekly | Every run verifies itself (§3). A weekly *restore drill* is still a human task — §6. |

---

## 2. Layout

```
/var/backups/callcenter/            (chmod 700)
  postgres/
    callcenter_20260804T021500Z.dump.gz
    latest.dump.gz -> callcenter_20260804T021500Z.dump.gz
  recordings/                       rsync mirror of the live directory
  logs/
  pre-restore/                      safety dumps taken by restore.sh
/var/log/callcenter-backup.log      cron output (logrotate: weekly, 8 copies)
/var/lib/node_exporter/textfile_collector/callcenter_backup.prom
```

Overridable from the environment: `PROJECT_DIR`, `BACKUP_ROOT`, `DUMP_DIR`,
`RECORDINGS_MIRROR`, `LOG_DIR`, `TEXTFILE_DIR`, `DB_RETENTION_DAYS`,
`RECORDING_RETENTION_DAYS`, `GZIP_LEVEL`.

### Why the container's `pg_dump`

`backup.sh` auto-detects its mode:

- **docker** — a running `postgres` container exists → run `pg_dump` /
  `pg_restore` / `psql` **inside it**.
- **local** — no container, but `pg_dump` is on `PATH` → talk to `DATABASE_URL`
  directly.

Docker mode is preferred because Ubuntu 24.04 ships PostgreSQL **client 16**
while the container is PostgreSQL **17**, and `pg_dump` refuses to talk to a
newer server. `deploy.sh` still installs `postgresql-client` — for ad-hoc `psql`
on the host, not for dumps.

Dump flags: `-Fc` (custom format, so selective and parallel restore stay
possible), `-Z0` (no internal compression — `gzip -9` does it better in the
pipe), `--no-owner --no-privileges` (so a restore into a differently-named role
works).

---

## 3. What a backup run does

```bash
/opt/callcenter/scripts/backup.sh
```

Options: `--db-only`, `--recordings-only`, `--no-verify` (not recommended).
Exit codes: `0` success, `1` failure, `2` usage, `3` another run in progress.

1. **Lock** — `flock` on `/var/lock/callcenter-backup.lock`; concurrent runs
   exit 3.
2. **Dump** — `pg_dump -Fc -Z0 | gzip -9` → `callcenter_<UTC timestamp>.dump.gz`,
   then `latest.dump.gz` is repointed with `ln -sfn`.
3. **Verify — the step that makes it a backup rather than a file.**
   - Create a scratch database `verify_<timestamp>`.
   - `pg_restore` the archive into it.
   - Compare the **table count** against live; **0 tables or a mismatch fails
     the run**.
   - Compare exact `count(*)` on the tables whose emptiness would make the
     platform unusable: `users`, `operator_profiles`, `contacts`, `calls`,
     `tickets`. A restored count **lower** than live is expected (rows written
     between the dump and the comparison); **higher is impossible** and fails
     the run.
   - Drop the scratch database — always, including on failure, via the exit trap.
4. **Prune** dumps older than `DB_RETENTION_DAYS`.
5. **Mirror recordings** — `rsync -a` into `recordings/`. Deliberately **without
   `--delete`**: the mirror keeps files for 90 days even after the live directory
   prunes them, which is the entire point. `-a` preserves mtimes because
   retention depends on them. `--partial-dir=.rsync-partial` keeps a
   half-transferred WAV out of the mirror root.
6. **Prune recordings** older than `RECORDING_RETENTION_DAYS`, then remove the
   empty directory skeleton.
7. **Disk report** — warns below 10 % free on the backup volume. A backup run
   that fills the disk is worse than no backup run.
8. **Metrics** → `$TEXTFILE_DIR/callcenter_backup.prom`:

   ```
   callcenter_backup_success                          1|0
   callcenter_backup_duration_seconds
   callcenter_backup_size_bytes
   callcenter_backup_recordings_bytes
   callcenter_backup_verified_tables
   callcenter_backup_last_success_timestamp_seconds   (only on success)
   ```

   Written on failure too (`success 0`), via the error trap.

### Alerts that read those metrics

| Alert | Expression | Severity |
|-------|-----------|----------|
| `BackupTooOld` | `time() - callcenter_backup_last_success_timestamp_seconds > 26*3600` for 30 m | warning |
| `BackupMetricMissing` | `absent(callcenter_backup_last_success_timestamp_seconds)` for 6 h | warning |

26 hours, not 24: a daily job plus jitter must not alert on a normal day.

### Expected output

```
=== ...
2026-08-04T02:15:01Z [INFO ] postgres mode: docker
2026-08-04T02:15:02Z [INFO ] dumping database 'callcenter'
2026-08-04T02:15:09Z [INFO ] dump written: .../callcenter_20260804T021500Z.dump.gz (12M)
2026-08-04T02:15:09Z [INFO ] verifying dump by restoring into scratch database 'verify_20260804T021500Z'
2026-08-04T02:15:14Z [INFO ] restored database: 18 tables
2026-08-04T02:15:14Z [INFO ]   users: 7 rows match
2026-08-04T02:15:14Z [INFO ]   contacts: 1043 rows match
2026-08-04T02:15:14Z [INFO ]   calls: 5821 rows match
2026-08-04T02:15:15Z [INFO ] mirroring recordings: ... -> /var/backups/callcenter/recordings
2026-08-04T02:15:31Z [INFO ] free space on backup volume: 62%
```

---

## 4. Restoring

```bash
/opt/callcenter/scripts/restore.sh --list                       # what is available
/opt/callcenter/scripts/restore.sh --latest --yes                # full DR restore
/opt/callcenter/scripts/restore.sh --file /var/backups/callcenter/postgres/x.dump.gz \
                                   --target-db callcenter_dr     # dry run, live untouched
/opt/callcenter/scripts/restore.sh --latest --recordings --yes    # database + recordings
/opt/callcenter/scripts/restore.sh --recordings-only --yes
```

| Option | Effect |
|--------|--------|
| `--list` | Available dumps, newest first. |
| `--latest` | Use `latest.dump.gz`. |
| `--file PATH` | A specific archive. |
| `--target-db NAME` | Restore into `NAME` instead of the live database (creates it). **The live database is left untouched** — this is how you rehearse. |
| `--recordings` / `--recordings-only` | Also / only restore recordings from the mirror. |
| `--overwrite-recordings` | Let mirrored files replace **newer** live files. Off by default. |
| `--no-stop` | Do not stop the backend during the restore. |
| `--no-safety-dump` | Skip the pre-restore dump. |
| `-y`, `--yes` | Non-interactive; required from cron. |

Exit codes: `0` success, `1` failure, `2` usage, `3` another run in progress.

### Safety properties

The dangerous part of a restore is not speed but accidents, so the script:

1. **Refuses to touch the live database without explicit confirmation** — you
   type the database name, or pass `--yes`.
2. **Takes a safety dump first** into `pre-restore/`, and `gzip -t`s it. If that
   integrity check fails it **aborts before touching anything**, and it prints the
   exact command to undo the restore you are about to perform.
3. **Stops the backend** while the database is replaced, so a half-restored
   schema cannot be written to.
4. **Recreates the target database** cleanly (dropping connections first —
   `pg_restore` can leave a session behind after a hard failure).
5. **Verifies the result** (table and row counts) before declaring success.
6. **Restores recordings without overwriting a newer live file** unless you pass
   `--overwrite-recordings`.
7. Restarts the backend, whatever happened.

---

## 5. Disaster recovery against the 4-hour RTO

Scenario: the VPS is gone. You have the repository, the latest dump and the
recordings mirror.

| Step | Action | Typical time |
|------|--------|--------------|
| 1 | Provision a new Ubuntu 24.04 VPS | 5–15 min |
| 2 | `git clone` + `bash scripts/deploy.sh` (Docker, `.env`, firewall, fail2ban, images, migrations, start) | 15–30 min |
| 3 | Copy the dump and the recordings mirror onto the new host | depends on size and link |
| 4 | `scripts/restore.sh --file <dump> --recordings --yes` | 2–10 min |
| 5 | Point DNS at the new IP; `certbot certonly …`; `update.sh --reload-nginx-only` | 5–10 min + DNS TTL |
| 6 | Repoint the SIP trunk at the new IP:5070 | provider-dependent |
| 7 | Post-deploy checklist in [DEPLOYMENT.md § 9](./DEPLOYMENT.md#9-post-deploy-checklist) | 10 min |

Comfortably inside 4 hours **provided step 3 is possible**. The two things that
can blow the RTO are both outside these scripts: the DNS TTL, and the fact that
the backups are currently stored on the same host (§7). **Lower the DNS TTL to
300 s before go-live**, and get an off-host copy in place.

RPO is 24 hours by policy. In practice it is better: `update.sh` takes a
`--db-only` dump before every migration, so a deploy-related failure loses
nothing.

---

## 6. Verification procedures

### Automatic, every run

The restore-into-scratch check in §3.3. If it fails, the run exits non-zero,
`callcenter_backup_success` goes to `0`, and cron mails `MAILTO`.

### Weekly restore drill (TZ.md requires weekly verification)

```bash
# 1. Restore last night's dump into a throwaway database. Live is untouched.
/opt/callcenter/scripts/restore.sh --latest --target-db callcenter_drill --yes

# 2. Sanity-check the data.
docker compose -p callcenter exec -T postgres \
  psql -U "$POSTGRES_USER" -d callcenter_drill -c "
    SELECT 'users' t, count(*) FROM users
    UNION ALL SELECT 'contacts', count(*) FROM contacts
    UNION ALL SELECT 'calls', count(*) FROM calls
    UNION ALL SELECT 'tickets', count(*) FROM tickets
    UNION ALL SELECT 'ai_sessions', count(*) FROM ai_sessions
    UNION ALL SELECT 'call_transcripts', count(*) FROM call_transcripts
    UNION ALL SELECT 'call_recordings', count(*) FROM call_recordings;"

# 3. Most recent call present?
docker compose -p callcenter exec -T postgres \
  psql -U "$POSTGRES_USER" -d callcenter_drill -c \
  "SELECT id, started_at, status FROM calls ORDER BY started_at DESC LIMIT 5;"

# 4. Spot-check that a recording referenced by the restored data exists.
docker compose -p callcenter exec -T postgres \
  psql -U "$POSTGRES_USER" -d callcenter_drill -tAc \
  "SELECT file_name FROM call_recordings ORDER BY created_at DESC LIMIT 1;" \
  | xargs -I{} ls -l /var/backups/callcenter/recordings/{}

# 5. Clean up.
docker compose -p callcenter exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -c 'DROP DATABASE callcenter_drill;'
```

### Integrity of the archives themselves

```bash
ls -lh /var/backups/callcenter/postgres/
for f in /var/backups/callcenter/postgres/*.dump.gz; do gzip -t "$f" && echo "OK $f"; done
```

### Monitoring

```bash
cat /var/lib/node_exporter/textfile_collector/callcenter_backup.prom
tail -50 /var/log/callcenter-backup.log
```

In Prometheus: `callcenter_backup_success`,
`time() - callcenter_backup_last_success_timestamp_seconds`.

### Log the drill

Keep a short record — date, dump used, table/row counts, anomalies, who ran it.
TZ.md's acceptance criteria include "Backup/Restore test muvaffaqiyatli"
(successful), which needs evidence, and a drill nobody wrote down did not happen.

---

## 7. Known gaps

Documented rather than glossed over.

1. **Backups are local.** Everything is under `/var/backups/callcenter` on the
   same host as the database. A disk or host loss takes the backups with it.
   Add off-host replication, e.g. as a second cron line:

   ```cron
   45 3 * * * root rsync -az --delete /var/backups/callcenter/ backup@offsite:/srv/callcenter/
   ```

   or an S3-compatible sync (`rclone sync`, `aws s3 sync`). TZ.md § 10.1 asks for
   "Alohida server/cloud" — this is the outstanding item.

2. **Dumps are not encrypted at rest.** TZ.md § 10.1 asks for encryption. The
   directory is `chmod 700` and root-owned, which protects against other local
   users but not against disk theft or an untrusted off-site target. Add
   encryption **before** shipping anything off-host:

   ```bash
   gpg --encrypt --recipient backup@aqllishahar.uz latest.dump.gz
   # or: age -r age1... -o latest.dump.gz.age latest.dump.gz
   ```

   Whatever you choose, store the key somewhere other than this server, and add
   the decrypt step to the drill — an unopenable backup is not a backup.

3. **No archive tier for recordings.** TZ.md § 10.2 says "3 oydan keyin arxivga"
   (archive after three months). Today they are simply **deleted** from the
   mirror after 90 days. If the retention policy is legal rather than
   operational, move them to cold storage before the prune instead.

4. **Redis is not backed up**, deliberately: it holds only refresh tokens.
   Losing it forces everyone to log in again and nothing else. The container does
   run with `--appendonly yes`, so a restart alone does not drop sessions.

5. **`.env` is not in any backup**, deliberately — it is the secret store, and
   `backup.sh` never reads secrets into a dump. Keep an encrypted copy in a
   password manager. Without it a restored database is unusable: `JWT_SECRET`,
   the Postgres password and the SIP secrets all live there.

6. **Asterisk configuration is not backed up separately** because it does not
   need to be: `asterisk/etc/*` is in git and every secret is rendered from
   `.env` at container start. Voicemail messages, however, live in the
   `asterisk_voicemail` **named volume** and are not in any backup. Add it if
   voicemail content matters:

   ```bash
   docker run --rm -v callcenter_asterisk_voicemail:/vm -v /var/backups/callcenter:/b \
     alpine tar czf /b/voicemail_$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /vm .
   ```
