# Deployment

Target: a single **Ubuntu 24.04 LTS** VPS running the whole stack in Docker
behind nginx. Two scripts do all the work:

| Script | Role |
|--------|------|
| `scripts/deploy.sh` | **First-time provisioning.** Host packages, Docker, `.env` with generated secrets, nginx render, bootstrap TLS, firewall, fail2ban, backup cron. Then hands off to `update.sh --initial`. |
| `scripts/update.sh` | **Every deploy after the first.** Pull, build, migrate, restart, smoke-test, and roll back automatically if the smoke test fails. |

Both are idempotent, both take an `flock` on `/var/lock/callcenter-deploy.lock`
so provisioning and updating can never interleave, and both log to
`/var/log/callcenter-deploy.log`.

---

## 1. Prerequisites

| Item | Requirement |
|------|-------------|
| OS | Ubuntu 24.04 LTS (the script warns on anything else and continues) |
| Access | root |
| RAM | ≥ 1.6 GB (warns below; add swap or resize — below that the OOM killer starts on Postgres, which looks like random data loss later) |
| Disk | ≥ 20 GB free on `/` (warns below; recordings fill this fast) |
| DNS | `A` record `DOMAIN` → the VPS, **before** requesting a certificate |
| Timezone | set to `Asia/Tashkent` by the script (`HOST_TIMEZONE` overrides) — recordings and RTP are timing sensitive, and a wrong clock also breaks JWT expiry and TLS validation |

---

## 2. First deploy

```bash
ssh root@<vps>
apt-get update && apt-get install -y git
git clone <repo-url> /opt/callcenter
cd /opt/callcenter

export DOMAIN=callcenter.example.uz
export REPO_URL=git@github.com:aqlli-shahar/callcenter.git
export LETSENCRYPT_EMAIL=admin@example.uz
export OPENAI_API_KEY=sk-...          # optional; omit and every call goes to a human
bash scripts/deploy.sh
```

Options: `--domain`, `--repo`, `--branch`, `--skip-apt`, `--skip-firewall`,
`--skip-fail2ban`.
Exit codes: `0` success, `1` failure, `2` usage error, `3` another run in
progress.

### What it does, step by step

1. **Host checks** — root, `DOMAIN` present, OS, RAM, disk, timezone.
2. **Packages** — `ca-certificates curl gnupg git rsync openssl ufw fail2ban
   cron jq bc postgresql-client`. No compilers: every build happens in a
   container. `postgresql-client` is for ad-hoc `psql` **on the host only** —
   dumps and restores run the *container's* binaries, because Ubuntu 24.04 ships
   client 16 while the container is Postgres 17 and `pg_dump` refuses to talk to
   a newer server.
3. **Docker** — `docker-ce` + compose plugin from Docker's own repository
   (Ubuntu's `docker.io` lags and ships no compose plugin). Writes
   `/etc/docker/daemon.json` with `json-file` log rotation (10 MB × 5) and
   `live-restore` — uncapped json-file logs are the classic way a VPS runs out
   of disk.
4. **Source** — clones into `/opt/callcenter`, or accepts an existing tree
   (warning that `update.sh` then cannot `git pull` or tag by commit).
5. **`.env`** — copies `.env.example` if absent, then fills in every value.
   **Rules: an existing value is never overwritten** (rotating the Postgres
   password on a second deploy would orphan the data volume), a *placeholder* is
   replaced with a real secret, and secrets are URL-safe (`openssl rand -base64`
   filtered to `A-Za-z0-9`) so they can be embedded in `postgresql://` and
   `redis://` URLs. `chmod 600`.

   Production topology values it sets explicitly:

   ```
   AUDIOSOCKET_ADVERTISE_HOST=backend:9092    # not host.docker.internal
   ASTERISK_SIP_PORT=5070                     # do not "normalise" to 5060
   ASTERISK_RTP_START=12000  ASTERISK_RTP_END=12049
   POSTGRES_PORT=5434  REDIS_PORT=6380        # host-side only, firewalled
   VITE_API_URL=https://$DOMAIN
   ```

6. **Host directories** — `/var/backups/callcenter/{postgres,recordings,logs,pre-restore}`
   (`chmod 700`), the node-exporter textfile dir (`755` — the exporter runs
   unprivileged and must list it), the ACME webroot, nginx and Asterisk log
   dirs, `nginx/conf.d.rendered/`.

   Recordings get special treatment: **three** parties share that one directory
   — Asterisk (MixMonitor, as the container's `asterisk` user), the backend
   (uid 1000 = `bun` in the `oven/bun` image) and nginx (read-only). Without a
   shared group and the setgid bit, files created by one are unreadable by the
   other and the uploads route starts returning 403 for exactly the newest
   calls. So: `chown -R 1000:1000` and `chmod 2775`.

7. **nginx render** — `sed s/__DOMAIN__/$DOMAIN/g` from `nginx/conf.d/` into
   `nginx/conf.d.rendered/`, wiping the target first so a stale vhost for an old
   domain cannot keep answering.
8. **Bootstrap TLS** — a 30-day self-signed pair at
   `/etc/letsencrypt/live/$DOMAIN/`. nginx refuses to start when
   `ssl_certificate` points at a missing file, and certbot's HTTP-01 challenge
   needs a running nginx; this breaks the cycle. Certbot replaces it on first
   issuance. Existing real certificates are left alone.
9. **Monitoring secret** — writes `ASTERISK_ARI_PASSWORD` to
   `monitoring/prometheus/secrets/asterisk_password` (`644`, because Prometheus
   runs as `nobody`). Prometheus cannot expand environment variables in
   `prometheus.yml`, so the scrape password has to exist as a file.
10. **Firewall** — `config/firewall/ufw-rules.sh` (§4).
11. **fail2ban** — jails, filter and the `docker-user` action (§5).
12. **Cron** — `/etc/cron.d/callcenter-backup` (§6) and
    `/etc/logrotate.d/callcenter`.
13. **Application** — `update.sh --initial --no-pull`.

It deliberately does **not** request a real certificate (DNS must exist first;
the exact command is printed at the end) and does **not** open 8088/5038/5434/6380.

---

## 3. TLS with Let's Encrypt

After DNS resolves to the host:

```bash
certbot certonly --webroot -w /var/www/certbot \
  -d callcenter.example.uz -d www.callcenter.example.uz \
  --email admin@example.uz --agree-tos --no-eff-email

/opt/callcenter/scripts/update.sh --reload-nginx-only
```

nginx already serves the ACME webroot on both `:80` and `:443`
(`location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }`), so no
downtime and no `--standalone`.

Then enable the redirect: uncomment the `ENABLE-AFTER-CERTS` block in
`nginx/conf.d/callcenter.conf` (the `location /` that 301s to HTTPS) and delete
or comment the plain-HTTP proxy locations under it, then
`update.sh --reload-nginx-only` again.

**Renewal is automatic**, from the cron entry `deploy.sh` installs:

```cron
27 3,15 * * * root certbot renew --quiet --webroot -w /var/www/certbot \
  --deploy-hook '/opt/callcenter/scripts/update.sh --reload-nginx-only' \
  >> /var/log/callcenter-certbot.log 2>&1
```

Twice a day as Let's Encrypt asks; the deploy hook reloads nginx **inside the
container** only after a successful renewal. Dry-run it:

```bash
certbot renew --dry-run
openssl s_client -connect callcenter.example.uz:443 -servername callcenter.example.uz </dev/null 2>/dev/null | openssl x509 -noout -dates
```

### What the vhost does

`nginx/conf.d/callcenter.conf`, one file, `__DOMAIN__` substituted at deploy
time (it is a syntactically valid `server_name`, so an unrendered copy still
parses — but the TLS paths would point at a directory that does not exist).

| Location | Behaviour |
|----------|-----------|
| `/.well-known/acme-challenge/` | ACME webroot, on both ports. |
| `= /nginx-health` | `ok`, no upstream touched. The first smoke-test step. |
| `= /api/auth/login` | Proxy to the backend with a **stricter rate limit** (the `login` `limit_req` zone). fail2ban's `nginx-limit-req` jail bans anyone who survives it. |
| `/api/ws` | Proxy with WebSocket upgrade headers and a long read timeout. |
| `/api/uploads` | Proxy with its own limits, for recording playback. |
| `/api/` | Proxy to `callcenter_backend`, `X-Forwarded-Proto` set so the backend emits `https://` URLs. |
| `~ ^/(doc\|reference)$` | OpenAPI JSON and Scalar UI (mounted at the server root, not under `/api`). |
| `/recordings/` | `internal` + `alias /var/www/recordings/` — **unreachable from outside**, usable only via `X-Accel-Redirect` from the backend. |
| `= /metrics` | Blocked. |
| `^~ /ari` | Blocked, belt-and-braces: nothing forwards to 8088/5038 anywhere in the file. |
| `/assets/`, `= /index.html`, `/` | The SPA. |

Security headers include HSTS, a strict CSP
(`connect-src 'self' https://__DOMAIN__ wss://__DOMAIN__`, `frame-ancestors
'none'`, `object-src 'none'`) and `Permissions-Policy` allowing only
`microphone=(self)` — that one is needed for a future browser softphone; camera,
geolocation, payment and USB are all denied.

---

## 4. Firewall

`config/firewall/ufw-rules.sh` (`--dry-run` prints without changing anything).

Policy: `deny incoming` / `allow outgoing` / `deny routed`, logging at `low`
(`full` fills the disk on a continuously SIP-scanned box).

**Open to the internet:**

| Port | Purpose |
|------|---------|
| 22/tcp | SSH, **rate limited** (`ufw limit`: 6 attempts / 30 s per source) — blunts brute forcing before fail2ban even sees it |
| 80/tcp | ACME challenge + redirect |
| 443/tcp | Dashboard and API |
| 5070/udp+tcp | SIP signalling — **not** 5060; the platform is configured for 5070 end to end |
| 12000–12049/udp | RTP media. Must match `ASTERISK_RTP_START/END` **exactly**: Asterisk writes those port numbers into its SDP, so a closed port here means a connected call with no audio |

SSH is allowed **first**, before the default-deny policy is set — the opposite
order locks you out of the box.

**Never open** (and asserted at the end of the script): 8088 (ARI — full call
control), 5038 (AMI — full PBX control), 5434 (Postgres — every citizen's data),
6380 (Redis — sessions, trivially abusable), 9090/9100/9187/3002
(Prometheus/exporters/Grafana — reach them over
`ssh -L 3002:127.0.0.1:3002 root@host`).

### The Docker caveat — the important part

`ports:` in docker-compose creates DNAT rules evaluated **before** ufw's `INPUT`
chain, so **a published container port is reachable from the internet even with
`ufw default deny incoming`.** The base `docker-compose.yml` publishes Postgres
and Redis on `0.0.0.0` (5434/6380), which on a public VPS would be a full data
breach.

The script therefore also installs explicit **DROP rules in the `DOCKER-USER`
chain** — which *is* honoured for container traffic — for
`8088 5038 5434 6380 9090 9100 9187 3002 9092`, and verifies them at the end.

If the SIP trunk provider publishes fixed source addresses, tighten SIP to them
and essentially all scanner noise disappears:

```bash
ufw delete allow 5070/udp
ufw allow from <provider-ip> to any port 5070 proto udp comment 'SIP trunk'
```

Verify:

```bash
ufw status verbose
iptables -L DOCKER-USER -n --line-numbers
ss -tulpn | grep -E '5070|12000|8088|5038|5434|6380'
```

---

## 5. fail2ban

Installed to `/etc/fail2ban/jail.local` (never `jail.conf` — that belongs to the
package and is replaced on upgrade), plus
`filter.d/asterisk-security.conf` and `action.d/docker-user.conf`.

Defaults: `bantime 1h`, `findtime 10m`, `maxretry 5`, escalating bans
(×2 up to 5 weeks, ±10 min jitter so a botnet cannot time retries around the
expiry), `usedns = no` (slow, leaks lookups to the attacker's DNS, and Asterisk
gives literal addresses anyway).

`ignoreip` covers loopback **and the Docker bridge ranges** — a banned `172.x`
address would cut the containers off from each other. **Add the office static IP
before go-live**: an operator who fat-fingers a password five times should not
lock the whole office out of the dashboard.

| Jail | Log | Trigger | Ban action |
|------|-----|---------|-----------|
| `sshd` | `%(sshd_log)s` | 3 in 10 m | `ufw` (host service) |
| `asterisk-security` | `/var/log/asterisk/security` + `messages` | 5 in 10 m | **`docker-user`** |
| `nginx-limit-req` | `/var/log/nginx/error.log` | 20 in 5 m | `docker-user` |
| `nginx-botsearch` | `/var/log/nginx/access.log` | 5 in 10 m, ban 4 h | `docker-user` |
| `nginx-http-auth` | — | **disabled** on purpose (this app uses JWT, so the stock jail would never match; left visible so nobody wonders whether it was forgotten) | — |
| `recidive` | `/var/log/fail2ban.log` | 5 bans in 1 day → 1 week, all ports | `docker-user` |

### Why `banaction = docker-user` and not `ufw`

The same Docker problem as above: `banaction = ufw` (and `iptables-multiport`,
and `nftables-*`) **does not block** an attacker hammering Asterisk on 5070. The
ban shows up in `fail2ban-client status`, the attacker keeps working, and nobody
notices. Host services (`sshd`) use `ufw`; every jail protecting a **container**
port uses `docker-user`, which inserts DROP rules at the top of `DOCKER-USER`
for all ports of the banned address.

The `asterisk-security` jail needs Asterisk's log **on the host**, which is why
`docker-compose.prod.yml` bind-mounts `${ASTERISK_LOG_DIR}:/var/log/asterisk`
instead of using a named volume, and why `logger.conf` has `security => security`.

IPv6: the `DOCKER-USER` chain only exists for `ip6tables` if the daemon was
started with ip6tables enabled. With no IPv6 SIP traffic (the normal case here),
silence the ban errors in `/etc/fail2ban/fail2ban.local`:

```ini
[Definition]
allowipv6 = no
```

Verify:

```bash
fail2ban-client status
fail2ban-client status asterisk-security
fail2ban-client set asterisk-security unbanip <ip>
tail -f /var/log/fail2ban.log
```

---

## 6. Scheduled jobs

`/etc/cron.d/callcenter-backup` (rewritten on every deploy):

```cron
15 2 * * * root /opt/callcenter/scripts/backup.sh >> /var/log/callcenter-backup.log 2>&1
27 3,15 * * * root certbot renew --quiet --webroot -w /var/www/certbot \
  --deploy-hook '/opt/callcenter/scripts/update.sh --reload-nginx-only' \
  >> /var/log/callcenter-certbot.log 2>&1
```

02:15 local: after midnight traffic has stopped, before the morning shift.
`MAILTO` is `LETSENCRYPT_EMAIL` (or root). A `/etc/cron.d` entry rather than a
user crontab: declarative, survives user changes, and re-running `deploy.sh`
simply rewrites it. See [BACKUP_RESTORE.md](./BACKUP_RESTORE.md).

`/etc/logrotate.d/callcenter` rotates the three cron logs weekly, keeping 8
compressed copies.

---

## 7. Routine deploys

```bash
cd /opt/callcenter
./scripts/update.sh
```

Sequence: acquire lock → `git pull` → resolve `IMAGE_TAG` (git short SHA) →
render nginx vhosts → build `backend`/`frontend` (and `asterisk` if its image is
missing) → start `postgres`+`redis` and wait for healthy → **pre-migration
`backup.sh --db-only`** → `drizzle-kit migrate` via
`compose run --rm --no-deps -T backend` → `compose up -d` → wait for healthy →
smoke test → record state → prune old images.

Options:

```
--initial              first deploy: no git pull, no rollback target
--no-pull              skip git pull
--no-build             reuse images already tagged for this commit
--skip-migrations      do not run drizzle migrations
--tag TAG              use TAG instead of the git short SHA
--rollback [TAG]       immediately redeploy the previous (or given) tag
--no-rollback          on failure, leave the broken deploy up for inspection
--reload-nginx-only    re-render vhosts, nginx -t, nginx -s reload, exit
```

Compose is always invoked as
`docker compose -p callcenter -f docker-compose.yml -f docker-compose.prod.yml --env-file .env`.
Run it the same way by hand, or the prod overrides silently do not apply.

### The smoke test

1. `http://127.0.0.1/nginx-health` → `ok` (nginx alone, no upstream).
2. `http://127.0.0.1/api/health` → contains `"status"` (proxy + backend +
   dependency wiring in one request).
3. `http://127.0.0.1/` → the SPA shell.
4. `backend:4000/metrics` from inside the container — **tolerated if absent**,
   with a warning that the Prometheus `backend` job will be down. It currently
   *is* absent (see [API.md § 6](./API.md#6-not-implemented)).
5. `asterisk -rx "core show version"` — **fatal if it fails**. A container that
   is "running" but whose PBX never finished loading modules is a real failure
   mode.
6. ARI `/asterisk/info` from inside the Asterisk container — warning only, since
   `curl` may be missing there.
7. `https://127.0.0.1/nginx-health` with `-k` — informational while the
   bootstrap certificate is in place.

### Rollback

Images are tagged with the git short SHA and the last two successful tags are
remembered in `.deploy-state`. If a health check or the smoke test fails,
`update.sh` brings the previous tag back up and exits 1.

```bash
./scripts/update.sh --rollback            # previous tag
./scripts/update.sh --rollback <sha>      # a specific tag
IMAGE_TAG=<sha> docker compose -p callcenter \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d
```

**Database migrations are not rolled back.** Drizzle migrations are
forward-only, so a schema change that breaks the app needs
`scripts/restore.sh`. That is exactly why migrations run **before** the new
containers start but **after** a backup point exists.

---

## 8. What runs in production

`docker-compose.yml` + `docker-compose.prod.yml`:

| Service | Image | Published | Notes |
|---------|-------|-----------|-------|
| `postgres` | `postgres:17-alpine` | `${POSTGRES_PORT}` (firewalled) | healthcheck `pg_isready` |
| `redis` | `redis:7-alpine` | `${REDIS_PORT}` (firewalled) | `--requirepass`, AOF on |
| `asterisk` | built from `docker/asterisk.Dockerfile` | 5070 udp+tcp, 12000–12049/udp, 8088+5038 on loopback | 2 CPU / 1 GB, `nofile 65535` (each channel costs several descriptors: SIP socket, 2 RTP sockets, MixMonitor file, AudioSocket), logs bind-mounted for fail2ban |
| `backend` | `callcenter-backend:${IMAGE_TAG}` | none — `expose` 4000, 9092 | 2 CPU / 1 GB, health `GET /api/health`. `depends_on` asterisk is `service_started`, **not** `service_healthy`: the backend retries ARI with backoff, and blocking the API on the PBX would mean no dashboard at all during an Asterisk problem |
| `frontend` | `callcenter-frontend:${IMAGE_TAG}` | none — `expose` 3001 | static SPA, `/healthz` |
| `nginx` | `nginx:1.27-alpine` | 80, 443 | rendered vhosts + `/etc/letsencrypt` read-only |
| `prometheus` | `prom/prometheus:v2.55.1` | `127.0.0.1:9090` | |
| `grafana` | `grafana/grafana:11.3.1` | `127.0.0.1:3002` | provisioned dashboard `callcenter.json` |
| `node-exporter` | `prom/node-exporter:v1.8.2` | internal | reads the backup textfile collector |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter:v0.16.0` | `127.0.0.1:9187` | |

Grafana is loopback-only by design; reach it with
`ssh -L 3002:127.0.0.1:3002 root@host`. Exposing it under
`https://DOMAIN/grafana/` would need an nginx location plus
`GF_SERVER_SERVE_FROM_SUB_PATH=true` and is intentionally not done.

---

## 9. Post-deploy checklist

```
[ ] DNS resolves to the VPS
[ ] Real certificate issued; HTTP->HTTPS redirect enabled
[ ] https://DOMAIN loads the SPA; /api/health returns {"status":"ok"}
[ ] Seeded admin password changed (default +998900000000 / admin123)
[ ] bun run db:seed:sip executed, or POST /api/asterisk/extensions/sync called
[ ] GET /api/asterisk/status -> reachable, ari.ok, ami.ok, eventStream.running
[ ] GET /api/ai-assistant/status -> the provider you expect (see AI_PROVIDER.md)
[ ] SIP trunk registered: pjsip show registrations
[ ] A test call reaches the AI or the fallback, and writes a calls row
[ ] Recording appears as <callId>.wav and is playable through /api/uploads
[ ] ufw status verbose matches section 4; DOCKER-USER DROP rules present
[ ] fail2ban-client status shows sshd + asterisk-security + nginx jails
[ ] Office static IP added to fail2ban ignoreip
[ ] scripts/backup.sh runs clean and restore.sh --list shows the dump
[ ] Grafana reachable over the SSH tunnel; Prometheus targets reviewed
    (the `backend` job will be DOWN until /metrics is implemented)
[ ] .env is chmod 600 and contains no remaining placeholder values
```

---

## 10. Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `deploy.sh` exits 3 | Another deploy/update holds the lock | Wait, or check for a stuck run. |
| `deploy.sh` fails after provisioning | Application step failed | Host provisioning **is** complete. Fix the cause and re-run only `scripts/update.sh`. |
| nginx will not start | `ssl_certificate` missing | The bootstrap certificate should exist; re-run `deploy.sh` (idempotent) or regenerate it. |
| Smoke test fails on step 5 | Asterisk container up, PBX not loaded | `docker compose logs asterisk`. Usually a missing required env var — the entrypoint names them all. |
| Prometheus `backend` target down | `/metrics` not implemented | Expected today. See [API.md § 6](./API.md#6-not-implemented). |
| Asterisk unreachable from the internet on 5070 | Firewall, or the port was "normalised" to 5060 | `ufw status`, and confirm `ASTERISK_SIP_PORT=5070` everywhere. |
| Calls connect but have no audio | RTP range not open, or host≠container port mapping | See [TROUBLESHOOTING.md § 1](./TROUBLESHOOTING.md#1-one-way-audio). |
