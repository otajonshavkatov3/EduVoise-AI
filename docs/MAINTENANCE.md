# Maintenance

Routine operation of a deployed CallCenter "Aqlli Shahar": what to check and how
often, where the logs are, what rotates them, and how to upgrade each moving
part.

---

## 1. Routine schedule

### Automated (nothing to do)

| When | What | Where it is defined |
|------|------|---------------------|
| 02:15 daily | Verified backup: dump + restore-check + recordings mirror + prune + metrics | `/etc/cron.d/callcenter-backup` |
| 03:27 & 15:27 daily | `certbot renew`, nginx reloaded only on success | same file |
| Weekly | logrotate on the three cron logs, 8 compressed copies | `/etc/logrotate.d/callcenter` |
| Continuous | Docker json-file log rotation, 10 MB × 5 per container | `/etc/docker/daemon.json` + `logging:` in compose |
| Continuous | fail2ban bans (SIP, nginx rate limit, bot search, recidive) | `/etc/fail2ban/jail.local` |

### Daily (2 minutes)

```bash
# Everything up and healthy?
docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env ps

# Last night's backup
tail -20 /var/log/callcenter-backup.log
cat /var/lib/node_exporter/textfile_collector/callcenter_backup.prom | grep success

# The platform's own view
curl -s -H "Authorization: Bearer $TOKEN" https://$DOMAIN/api/asterisk/status | jq \
  '.data | {reachable, ari:.ari.ok, ami:.ami.ok, stream:.eventStream.running, channels:.channels.active}'
curl -s -H "Authorization: Bearer $TOKEN" https://$DOMAIN/api/ai-assistant/status | jq \
  '.data | {provider, available, detail}'

# Disk (recordings grow monotonically)
df -h /
```

Also glance at Prometheus → **Alerts** (`ssh -L 9090:127.0.0.1:9090`).

### Weekly

- **Restore drill** — [BACKUP_RESTORE.md § 6](./BACKUP_RESTORE.md#6-verification-procedures).
  TZ.md requires weekly verification, and it needs a written record.
- **Registrations**: `asterisk -rx "pjsip show contacts"` — every extension an
  operator uses should have a contact.
- **fail2ban**: `fail2ban-client status` on each jail. A jump in
  `asterisk-security` bans means a scan campaign; a jump in `nginx-limit-req`
  means credential stuffing.
- **Grafana dashboard** (`ssh -L 3002:127.0.0.1:3002`): call volume, missed-call
  ratio, AI session outcomes, API latency.
- **Recording growth**:
  `du -sh /opt/callcenter/apps/backend/uploads/call-recordings`.
- `docker system df` — reclaimable space.

### Monthly

- **Host packages**: `apt-get update && apt-get upgrade` (see §5 for ordering).
- **Base images**: rebuild to pick up `ubuntu:24.04`, `postgres:17-alpine`,
  `redis:7-alpine`, `nginx:1.27-alpine` security updates.
- **Certificate expiry**:
  `certbot certificates` — renewal should have happened well before 30 days out.
- **Secret review**: nothing in `.env` still a placeholder; `.env` is `chmod 600`.
- **Postgres housekeeping** (§4).
- **Audit log review**: `GET /api/audit-logs?from=…&to=…` (supervisor/admin) —
  who changed users, roles and AI configuration.

### Quarterly

- Rotate `JWT_SECRET` / `JWT_REFRESH_SECRET` (forces re-login), the ARI/AMI
  passwords and the SIP extension passwords. Procedure and caveats:
  [CONFIGURATION.md § 14](./CONFIGURATION.md#14-secret-inventory).
- Full DR rehearsal on a throwaway VPS — the only way to know the RTO is real.
- Review retention against actual disk growth
  (`DB_RETENTION_DAYS`, `RECORDING_RETENTION_DAYS`).
- Capacity review (§6).

---

## 2. Log locations

### Application

| Log | Where | Notes |
|-----|-------|-------|
| Backend | `docker compose logs backend` | pino. JSON at `info` in production, pretty at `debug` in development. Named children: `asterisk:ari-client`, `asterisk:ari-events`, `asterisk:ami`, `ai:openai-realtime`, `ai:gemini-live`, `ai:fallback-ivr`, `ai:provider-factory`, `integrations:notification-monitor`, `telephony:orchestrator`, `telephony:transfer`. |
| Frontend | `docker compose logs frontend` | Static server only. |
| nginx | `${NGINX_LOG_DIR}/access.log`, `error.log` (bind-mounted so fail2ban can read them) | `error.log` at `warn` is where `limit_req` messages appear. |

Useful filters:

```bash
docker compose -p callcenter logs backend | grep telephony:orchestrator
docker compose -p callcenter logs backend | grep -E '"level":50|"level":60'   # error/fatal
docker compose -p callcenter logs --since 30m backend
```

### Asterisk

`logger.conf` sends everything of interest to stdout **and** to files.

| Target | Levels | Use |
|--------|--------|-----|
| `docker compose logs asterisk` | notice, warning, error, verbose | day-to-day |
| `/var/log/asterisk/messages` | notice, warning, error | operational, without per-frame noise |
| `/var/log/asterisk/full` | + verbose, **dtmf** | the file to read when a call behaved strangely — the only place DTMF and verbose land together |
| `/var/log/asterisk/security` | security | failed registrations and auth attempts; **fail2ban tails this** |
| `/var/log/asterisk/queue_log` | — | `queue_log = yes` |

```bash
docker exec callcenter-asterisk tail -f /var/log/asterisk/full
docker exec callcenter-asterisk tail -50 /var/log/asterisk/security
```

In production the directory is a **bind mount**
(`${ASTERISK_LOG_DIR}:/var/log/asterisk`) replacing the base file's named volume,
because fail2ban runs on the host and cannot tail a named volume.

### Host

| Log | Contents |
|-----|----------|
| `/var/log/callcenter-deploy.log` | every `deploy.sh` / `update.sh` run |
| `/var/log/callcenter-backup.log` | nightly backup |
| `/var/log/callcenter-certbot.log` | renewal attempts |
| `/var/log/fail2ban.log` | bans and unbans (the `recidive` jail reads it) |
| `journalctl -u docker` | engine problems |

---

## 3. Log rotation

Three independent mechanisms, all already configured:

1. **Docker** — `json-file`, `max-size 10m`, `max-file 5` per container, both in
   `/etc/docker/daemon.json` and in each compose service's `logging:`. That
   caps container logs at ~50 MB each. Uncapped json-file logs are the classic
   way a VPS runs out of disk.
2. **logrotate** — `/etc/logrotate.d/callcenter` handles the three cron logs:
   weekly, 8 rotations, compressed, `delaycompress`, `notifempty`, recreated
   `0640 root adm`.
3. **Asterisk's own files** — **not** rotated by default. `logger.conf` writes
   `messages`, `full`, `security` and `queue_log` with no size cap. `full` is the
   one that grows: it includes verbose and DTMF, so a busy day is hundreds of
   megabytes. Add a logrotate rule:

   ```
   # /etc/logrotate.d/asterisk-callcenter
   /var/log/asterisk/messages /var/log/asterisk/full /var/log/asterisk/queue_log {
       daily
       rotate 14
       compress
       delaycompress
       missingok
       notifempty
       copytruncate
   }
   ```

   `copytruncate` avoids needing `logger reload` inside the container. **Do not
   include `security`** in a rule that renames the file — fail2ban tails it by
   path, and rotation with `create` can leave the jail watching a deleted inode.
   If you must rotate `security`, use `copytruncate` and restart fail2ban in a
   `postrotate` hook.

Check sizes:

```bash
docker exec callcenter-asterisk du -sh /var/log/asterisk/*
du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail
```

---

## 4. Database housekeeping

Postgres autovacuums by default. What still needs attention:

```bash
DC="docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml --env-file .env"

# Size by table - call_transcripts is the fastest grower
$DC exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;"

# Bloat / vacuum health
$DC exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
  FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;"

# Connections against max_connections
$DC exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT count(*), (SELECT setting FROM pg_settings WHERE name='max_connections') FROM pg_stat_activity;"

# Long-running transactions (alerted on as PostgresLongRunningTransaction)
$DC exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT pid, now()-xact_start age, state, left(query,60)
  FROM pg_stat_activity WHERE xact_start IS NOT NULL
  ORDER BY xact_start LIMIT 10;"
```

Growth expectations: `call_transcripts` grows fastest (several rows per minute of
conversation, plus throttled interim rows), then `calls`, `ai_sessions` and
`audit_logs`. Nothing is pruned automatically — the CRM soft-deletes
(`isDeleted`) rather than removing rows, deliberately, because tickets and calls
are the record of a citizens' hotline. If a retention policy is ever agreed, it
belongs in a scheduled job, not in the request path.

`ANALYZE` after any bulk import; a manual `VACUUM (VERBOSE, ANALYZE)` on
`call_transcripts` occasionally is harmless.

---

## 5. Upgrades

Order matters: application first (it is reversible), then base images, then the
host, then Asterisk (the only one that drops calls).

### 5.1 Application code

```bash
cd /opt/callcenter
./scripts/update.sh
```

Pull → build → `backup.sh --db-only` → migrate → restart → smoke test, with
automatic rollback to the previous image tag on failure. **Migrations are
forward-only**: a schema change that breaks the app needs
`scripts/restore.sh`, which is exactly why the pre-migration dump exists.

Roll back: `./scripts/update.sh --rollback`.

### 5.2 Dependencies

```bash
bun update --dry-run          # review first
bun update
bun run check                 # Biome: tabs, double quotes, semicolons
```

Constraints from `CLAUDE.md`, which the AI voice layer obeys throughout: no
`express`, no `dotenv`, no `ws`, no `pg` client in new code. Redis goes through
`Bun.RedisClient`; Postgres goes through Drizzle. Zod is v4, imported as
`zod/v4`. A dependency added in violation of these will look fine locally and
break the Bun-native assumptions.

### 5.3 Base images

```bash
cd /opt/callcenter
docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env pull postgres redis nginx prometheus grafana node-exporter postgres-exporter
./scripts/update.sh --no-pull
```

Postgres **major** upgrades (17 → 18) are not a `pull`: the data directory is
version-specific. Procedure: `backup.sh`, stop, change the image tag, remove the
`postgres_data` volume, start, `restore.sh --latest --yes`. Rehearse on a
throwaway host first.

### 5.4 Asterisk

The image is built from the distro package, so an Asterisk upgrade is an image
rebuild:

```bash
docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env build --pull asterisk
docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env up -d asterisk
```

**This drops every live call** — do it in a maintenance window. The build asserts
the required modules exist (`res_audiosocket`, `app_audiosocket`,
`chan_audiosocket`, the ARI set, `app_mixmonitor`, `chan_pjsip`) and **fails
loudly** if a package change removed one, which is far better than discovering it
on the first call.

Afterwards:

```bash
docker exec callcenter-asterisk asterisk -rx "core show version"
docker exec callcenter-asterisk asterisk -rx "module show like audiosocket"
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoints"
# then dial 600 and 900
```

Config-only changes:

| Change | Apply with |
|--------|-----------|
| `pjsip.conf.template`, `voicemail.conf.template`, `rtp.conf.template`, `ari.conf.template`, `manager.conf.template`, `http.conf.template` | `docker compose up -d --force-recreate asterisk` (templates are rendered at container start) |
| `extensions.conf`, `modules.conf`, `logger.conf`, `musiconhold.conf`, `prometheus.conf` | `docker compose build asterisk` then `up -d` (baked into the image) |
| Already-rendered config, no restart wanted | `asterisk -rx "pjsip reload"` / `"dialplan reload"` / `"core reload"` |

### 5.5 Host

```bash
apt-get update && apt-get upgrade
# kernel or libc updated?
needrestart -r l 2>/dev/null || echo "reboot recommended"
reboot
```

`restart: unless-stopped` and `live-restore` bring everything back after a
reboot. Verify with the daily checklist afterwards, and dial 600 to confirm RTP
still works.

---

## 6. Capacity

| Limit | Value | Consequence when reached | Where to change it |
|-------|-------|--------------------------|--------------------|
| Concurrent calls | **~25** | New calls fail to get media. Alerts: `LiveChannelsNearRtpCapacity` (>20), `LiveChannelsAtRtpCapacity` (≥25) | Widen `ASTERISK_RTP_START/END`, update the compose port range **and** the ufw rule — all three must match |
| Asterisk file descriptors | 65535 | Call setup fails under load | `ulimits.nofile` in `docker-compose.prod.yml` |
| Asterisk resources | 2 CPU / 1 GB | Transcoding and MixMonitor stall; RTP drops | `deploy.resources` |
| Backend resources | 2 CPU / 1 GB | Slow API, dropped WebSockets | `deploy.resources` |
| Postgres connections | image default | `PostgresConnectionsNearLimit` | `max_connections`, or pool the backend |
| Disk | 20 GB minimum | `RecordingDiskFillingUp`, then `RecordingDiskCriticallyLow`, then Asterisk cannot record **and Postgres cannot commit** | add disk, or shorten `RECORDING_RETENTION_DAYS` |

Rough storage arithmetic: MixMonitor writes WAV, so a mixed 8 kHz 16-bit mono
recording is about **1 MB per minute**. 200 calls/day averaging 3 minutes ≈
600 MB/day ≈ **18 GB/month**, and the 90-day mirror doubles the footprint of
anything under retention. Plan disk from real call volume, not from the default.

---

## 7. Monitoring

`monitoring/` provisions Prometheus (15 s scrape, 10 s for the backend job),
Grafana (dashboard `callcenter.json`), node-exporter and postgres-exporter. Both
UIs are loopback-only:

```bash
ssh -L 9090:127.0.0.1:9090 -L 3002:127.0.0.1:3002 root@<vps>
```

`alerts.yml` defines 33 rules across availability, telephony, AI, API, disk, host
and Postgres, with a deliberate severity convention: **critical** = wake somebody
up, calls are being lost right now; **warning** = fix during the working day;
**info** = context only, never paged. Notable ones:

| Alert | Reads |
|-------|-------|
| `BackendDown`, `PostgresDown`, `RedisDown`, `AsteriskDown` | `up{}` / `pg_up` / `callcenter_dependency_up{...}` |
| `AriEventStreamDisconnected` (critical), `AmiDisconnected` (warning) | `callcenter_ari_connected`, `callcenter_ami_connected` — if the ARI stream is down, **no inbound call is noticed at all** |
| `SipRegistrationLost`, `AllSipExtensionsUnregistered` | `callcenter_sip_extension_registered` |
| `NoCallsAnsweredDuringBusinessHours`, `NoInboundCallsDuringBusinessHours`, `HighMissedCallRatio` | call counters |
| `AiSessionFailureRateHigh`, `AiSessionsAllFailing`, `AiSessionsNeverStart` | AI session counters |
| `LiveChannelsNearRtpCapacity`, `LiveChannelsAtRtpCapacity` | `callcenter_active_channels` |
| `BackupTooOld`, `BackupMetricMissing` | the textfile-collector metrics `backup.sh` writes |
| `RecordingDiskFillingUp`, `RecordingDiskCriticallyLow`, `DiskWillFillWithinSixHours` | node-exporter filesystem metrics |
| `AsteriskMetricsEndpointDown` (**warning only**) | `up{job="asterisk"}` — kept non-critical on purpose, because `res_prometheus` may not be present |

### Two honest caveats

1. **The backend does not expose `/metrics` yet.** Every
   `callcenter_*` rule above depends on it, so those alerts will not fire and the
   Grafana panels that read them stay empty. The metric contract is documented at
   the top of `monitoring/prometheus/prometheus.yml`; implement against it and
   keep the two in sync — a renamed metric turns an alert into silence, which is
   worse than a noisy alert. `update.sh`'s smoke test warns about the missing
   route instead of failing the deploy.
2. **No Alertmanager is deployed.** Firing alerts are visible in the Prometheus
   UI (`/alerts`) and in Grafana's alert list, but nothing delivers them. Add an
   `alertmanager` service and uncomment the `alerting.alertmanagers` target in
   `prometheus.yml` to get Telegram/e-mail. Until then, someone has to look.

**Separate from Prometheus**, the backend runs its own alert watchdog
(`lib/integrations/notifications/monitor.ts`, started from `src/index.ts`,
logged as `integrations:notification-monitor`). It polls every few minutes and
raises two conditions over Telegram or e-mail: an `ai_sessions` row that ended
`failed`, and no answered call during business hours. It is **off by default** —
turn on `notifications.enabled` on the Settings page and fill in a channel. The
first tick after a restart is a baseline that alerts on nothing, so yesterday's
failures are not replayed.

Reload rules without restarting Prometheus:

```bash
curl -X POST http://127.0.0.1:9090/-/reload
```

---

## 8. Operational task recipes

### Add an operator

1. Create the user (`POST /api/auth/register` creates a `manager`; a supervisor
   can adjust the role via `PATCH /api/users/{id}`).
2. Create the operator profile with the extension:
   `POST /api/operator-profiles` (supervisor).
3. If the extension does not exist in Asterisk yet, add it —
   [ASTERISK.md § 6](./ASTERISK.md#6-adding-an-extension).
4. `POST /api/asterisk/extensions/sync` (supervisor) to refresh the mirror.
5. Configure their softphone — [MICROSIP.md](./MICROSIP.md).

### Turn the AI off in a hurry

```bash
curl -X PATCH https://$DOMAIN/api/ai-assistant/config \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

Takes effect on the **next** call; calls in progress continue. Every subsequent
caller goes through the fallback IVR to a human. No deploy, no restart. Reverse
it with `{"enabled": true}`.

### Change the AI voice

```bash
curl -X PATCH https://$DOMAIN/api/ai-assistant/config \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"voice": "Callirrhoe"}'
```

Effective next call, and stored - it survives a restart. The name must be one of
the ACTIVE provider's own voices (`knownVoices` in `GET /config`); the other
vendor's name is refused with a 400 instead of being silently replaced. The same
endpoint takes `language`, `dialect`, `model`, `maxCallSeconds`,
`silenceHangupMs`, `greetingDelayMs`, `transferExtensions` and the `gemini`
speech block - all effective on the next call, none needing a restart.

### Drop a stuck call

```bash
curl -X POST https://$DOMAIN/api/asterisk/hangup \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"callId":"<uuid>","reason":"stuck"}'
```

`source: "orchestrator"` also tears the AI session down. As a last resort:
`docker exec callcenter-asterisk asterisk -rx "channel request hangup <channel>"`.

### Free disk quickly

```bash
docker system prune -f                      # dangling images/containers
find /var/backups/callcenter/postgres -name '*.dump.gz' -mtime +14 -delete   # careful
docker exec callcenter-asterisk sh -c ': > /var/log/asterisk/full'           # truncate, do not delete
```

Never delete from `apps/backend/uploads/call-recordings/` without checking
`call_recordings` — the rows would keep claiming `isAvailable = true`.

### Restart one service

```bash
DC="docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml --env-file .env"
$DC restart backend       # drops WebSockets and finalises live AI calls cleanly
$DC restart nginx         # brief connection reset
$DC restart asterisk      # DROPS EVERY LIVE CALL
```

`CallOrchestrator.stop()` finalises live calls rather than abandoning them: the
AudioSocket listener closing makes Asterisk's `AudioSocket()` return, the
dialplan hangs the caller up, so the call really is over and the row must say so.

---

## 9. Things that are deliberately not automated

| Not automated | Why, and what to do instead |
|---------------|------------------------------|
| Off-host backup copies | No credentials for an off-site target are configured. [BACKUP_RESTORE.md § 7](./BACKUP_RESTORE.md#7-known-gaps) has the `rsync`/`rclone` line to add. |
| Backup encryption | Same. Add before shipping anything off-host. |
| Recording archival after 90 days | They are deleted, not archived. TZ.md § 10.2 asks for archival; move them to cold storage before the prune if the requirement is legal. |
| Alert delivery | No Alertmanager, no MTA on the box. |
| Secret rotation | Rotating ARI/AMI/SIP secrets recreates the Asterisk container and drops calls, so it needs a window. |
| Postgres major upgrades | Data-directory migration; rehearse it. |
| Pruning `call_transcripts` / `audit_logs` | No retention policy has been agreed for hotline records. |
