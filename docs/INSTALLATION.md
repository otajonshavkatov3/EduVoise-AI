# Installation

Two supported paths:

- **[A] Windows 11 + WSL2 + Docker Desktop** — the development setup, and the
  exact sequence used on this machine.
- **[B] Ubuntu 24.04 LTS VPS** — production, driven by `scripts/deploy.sh`
  (see [DEPLOYMENT.md](./DEPLOYMENT.md) for the full story).

---

## A. Windows 11 + WSL2 + Docker Desktop

### A.0 What was already true on this machine

- `VirtualMachinePlatform` was **already enabled** (a previous hypervisor
  install had turned it on). Check yours:

  ```powershell
  dism.exe /online /Get-FeatureInfo /FeatureName:VirtualMachinePlatform
  ```

  If `State : Disabled`, enable it and reboot:

  ```powershell
  # elevated PowerShell
  dism.exe /online /Enable-Feature /FeatureName:VirtualMachinePlatform /All /NoRestart
  dism.exe /online /Enable-Feature /FeatureName:Microsoft-Windows-Subsystem-Linux /All /NoRestart
  Restart-Computer
  ```

- The Docker **CLI** was installed but Docker Desktop would not start, because
  no WSL2 kernel was present. That is the state `LOCAL_DEV.md` documents.
- MicroSIP was installed and holds **5060/udp+tcp** and RTP **10010–10012**.
  This is why the whole platform is configured for SIP on **5070** and RTP on
  **12000–12049**.

### A.1 Install standalone WSL (via winget)

The Store/`wsl --install` path needs the optional-feature dance; the standalone
package from winget installs the kernel and the `wsl.exe` distribution manager
in one step.

```powershell
winget install --id Microsoft.WSL -e --accept-source-agreements --accept-package-agreements
wsl --version          # expect: WSL version 2.x, Kernelversion 5.15+ / 6.x
```

If `wsl --version` still errors after install, reboot once.

### A.2 Install Ubuntu 24.04

```powershell
wsl --list --online                  # confirm Ubuntu-24.04 is offered
wsl --install -d Ubuntu-24.04
wsl --set-default-version 2
wsl --set-default Ubuntu-24.04
wsl --status                         # Default Version: 2
```

The first launch asks for a UNIX username and password. Nothing in this project
runs *inside* the distro — it exists only to back Docker Desktop's engine.

### A.3 Install Docker Desktop and point it at WSL2

```powershell
winget install --id Docker.DockerDesktop -e
```

Then in Docker Desktop → **Settings**:

- **General** → *Use the WSL 2 based engine* — on.
- **Resources → WSL integration** → enable for `Ubuntu-24.04`.
- Apply & restart, then verify from PowerShell:

  ```powershell
  docker version          # Server section must be present
  docker compose version
  docker run --rm hello-world
  ```

> Docker Desktop must be **running** before any `docker compose` command. It
> does not auto-start unless you tick *Start Docker Desktop when you sign in*.

### A.4 Get the code and install dependencies

```powershell
git clone <repo-url> call_center
cd call_center
bun install
```

Bun is required (the repo is a Bun workspace and `CLAUDE.md` forbids npm/yarn/pnpm
for it).

### A.5 Data stores: pick one

**Option 1 — containers (now possible with WSL2 present):**

```powershell
docker compose up -d postgres redis
```

The base `docker-compose.yml` publishes `${POSTGRES_PORT}` and `${REDIS_PORT}`.

**Option 2 — the native portable services already set up here.** On this machine
ports 5432/5433 hold other PostgreSQL instances and 6379 holds another Redis, so
the project uses **5434** and **6380** with binaries under `.localdev/`:

```powershell
./scripts/dev-services.ps1 start     # also: status | stop | restart
```

These are not registered as Windows services, so they must be started again
after every reboot. Redis must be **≥ 6** — `Bun.RedisClient` speaks RESP3
(`HELLO 3`) and Redis 5.x answers `ERR unknown command HELLO`. `.localdev/` has
Redis 8.0.2.

### A.6 Create `.env`

```powershell
Copy-Item .env.example .env
```

Then fill it in. Minimum for the CRM alone:

```env
DATABASE_URL=postgresql://myapp:<password>@localhost:5434/myapp
REDIS_URL=redis://:<password>@localhost:6380
JWT_SECRET=<32+ chars>
JWT_REFRESH_SECRET=<32+ chars>
VITE_API_URL=http://localhost:4000
```

Additionally required by the Asterisk container's entrypoint — it refuses to
boot if any is empty, and names all of them at once:

```env
ASTERISK_SIP_PORT=5070
ASTERISK_RTP_START=12000
ASTERISK_RTP_END=12049
ASTERISK_ARI_USERNAME=callcenter-ari
ASTERISK_ARI_PASSWORD=<32 chars>
ASTERISK_AMI_USERNAME=callcenter-ami
ASTERISK_AMI_PASSWORD=<32 chars>
SIP_EXT_101_PASSWORD=<24 chars>
SIP_EXT_102_PASSWORD=<24 chars>
SIP_EXT_103_PASSWORD=<24 chars>
SIP_EXT_104_PASSWORD=<24 chars>
VOICEMAIL_PIN_101=100000
VOICEMAIL_PIN_102=100000
VOICEMAIL_PIN_103=100000
VOICEMAIL_PIN_104=100000
```

Generate secrets:

```powershell
# any of these; the important part is length, and no / + = if it goes in a URL
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
```

Full reference: [CONFIGURATION.md](./CONFIGURATION.md).

### A.7 Migrate and seed

```powershell
cd apps/backend
bun run db:migrate        # applies migrations 0000-0003
bun run db:seed           # admin user: +998900000000 / admin123
bun run db:seed:sip       # sip_extensions mirror: 101-104 + 900 (AI)
cd ../..
```

Change the seeded password before exposing anything.

### A.8 Start Asterisk

```powershell
docker compose up -d asterisk
docker compose logs -f asterisk
```

Expect the entrypoint to log `rendered pjsip.conf`, `rendered ari.conf`, …, then
`starting asterisk (foreground)`. Verify:

```powershell
docker exec callcenter-asterisk asterisk -rx "core show version"
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoints"
docker exec callcenter-asterisk asterisk -rx "dialplan show from-internal"
```

The `recordings` bind mount arrives root-owned on a Windows host; the entrypoint
checks writability and logs a **WARNING** if MixMonitor would fail. See
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md#7-recording-files-never-appear).

### A.9 Run the applications

```powershell
bun run dev              # backend + frontend
# or: bun run dev:backend / bun run dev:frontend
```

| What | URL |
|------|-----|
| Backend API | http://localhost:4000/api |
| Health | http://localhost:4000/api/health |
| OpenAPI JSON | http://localhost:4000/doc |
| Scalar API UI | http://localhost:4000/reference |
| Frontend | http://localhost:3000 (Vite takes the next free port — 3001, 3002 … — read the terminal) |

Vite does not use `strictPort`, so the frontend port moves if 3000 is busy.

### A.10 Prove the telephony path

1. Register MicroSIP on extension 101 against `127.0.0.1:5070`
   → [MICROSIP.md](./MICROSIP.md).
2. Dial **600** (echo), **601** (playback), **602** (music on hold). If you hear
   audio, SIP signalling, RTP and codec negotiation all work.
3. Dial **900** to reach the AI agent. With no realtime entitlement on the API
   key you will hear "one moment please" and then be rung through to an
   operator — that is the fallback IVR working as designed, not a failure.
   → [AI_PROVIDER.md](./AI_PROVIDER.md).

### A.11 Known Windows-specific limits

- `apps/frontend/src/modules/calls/config/sip.config.ts` still carries the
  legacy FreePBX defaults (`192.168.3.59:8088`, extension 201, `autoConnect:
  true`). On a different subnet the browser softphone retries forever and floods
  the console. Disable it without touching code:

  ```js
  localStorage.setItem("sip_config", JSON.stringify({ autoConnect: false, debug: false }))
  ```

- `apps/frontend`'s `build` script has no `--env-file`, so a production build
  from Windows leaves `VITE_API_URL` undefined. The production image
  (`deploy/frontend.Dockerfile`) passes it as a build arg, so this only affects
  hand-run local builds.
- Keep `ASTERISK_RTP_END` small on Docker Desktop. Every published UDP port gets
  its own userland proxy process; 50 ports (= 25 concurrent calls) already makes
  `docker compose up` noticeably slow.

---

## B. Ubuntu 24.04 LTS VPS

### B.1 Requirements

| Resource | Minimum | Why |
|----------|---------|-----|
| OS | Ubuntu 24.04 LTS | What `deploy.sh` targets and warns about otherwise. |
| RAM | 1.6 GB (2 GB comfortable) | Below that the OOM killer starts picking on Postgres, which looks like random data loss later. |
| Disk | 20 GB free | Recordings grow monotonically. |
| Ports open inbound | 22, 80, 443, 5070/udp+tcp, 12000–12049/udp | Everything else stays closed. |
| DNS | `A` record for your domain → the VPS | Needed before Let's Encrypt can issue. |

### B.2 One command

```bash
ssh root@<vps>
apt-get update && apt-get install -y git
git clone <repo-url> /opt/callcenter
cd /opt/callcenter

export DOMAIN=callcenter.example.uz
export REPO_URL=git@github.com:aqlli-shahar/callcenter.git
export LETSENCRYPT_EMAIL=admin@example.uz
export OPENAI_API_KEY=sk-...            # optional
bash scripts/deploy.sh
```

`deploy.sh` is idempotent — re-running it is safe and expected. It:

1. sanity-checks the host (Ubuntu 24.04, root, RAM, disk, timezone
   `Asia/Tashkent`);
2. installs `docker-ce` + the compose plugin from Docker's own repo, plus git,
   rsync, ufw, fail2ban, cron, jq, bc, openssl, postgresql-client;
3. clones or reuses `/opt/callcenter`;
4. renders `.env` — **generating every placeholder secret and preserving every
   value that already exists** (so a second run cannot rotate the Postgres
   password and orphan the data volume);
5. renders the nginx vhosts, the Prometheus scrape secret and a **self-signed
   bootstrap certificate** (nginx will not start pointing at a missing cert, and
   certbot's HTTP-01 challenge needs a running nginx — this breaks the cycle);
6. applies `config/firewall/ufw-rules.sh` and installs the fail2ban jails;
7. installs `/etc/cron.d/callcenter-backup` (daily 02:15 backup + twice-daily
   certbot renewal) and `/etc/logrotate.d/callcenter`;
8. hands off to `scripts/update.sh --initial --no-pull`, which builds images,
   runs migrations, starts the stack, smoke-tests it and can roll back.

What it deliberately does **not** do: request a real certificate (DNS must exist
first — the exact `certbot` command is printed at the end), and open
8088/5038/5434/6380 to the world.

### B.3 After the first deploy

1. Point DNS at the host.
2. Issue the real certificate:

   ```bash
   certbot certonly --webroot -w /var/www/certbot \
     -d callcenter.example.uz -d www.callcenter.example.uz \
     --email admin@example.uz --agree-tos --no-eff-email
   /opt/callcenter/scripts/update.sh --reload-nginx-only
   ```

3. Uncomment the `ENABLE-AFTER-CERTS` block in `nginx/conf.d/callcenter.conf`
   to turn on the HTTP→HTTPS redirect, then `update.sh --reload-nginx-only`.
4. Point the SIP trunk at `callcenter.example.uz:5070` (udp+tcp).
5. Verify a backup end to end **before** go-live:

   ```bash
   /opt/callcenter/scripts/backup.sh
   /opt/callcenter/scripts/restore.sh --list
   ```

### B.4 Differences from the development setup

| Setting | Development | Production |
|---------|-------------|------------|
| `AUDIOSOCKET_ADVERTISE_HOST` | `host.docker.internal:9092` | `backend:9092` (compose service name) |
| `ASTERISK_ARI_URL` | `http://localhost:8088/ari` | `http://asterisk:8088/ari` |
| `ASTERISK_AMI_HOST` | `localhost` | `asterisk` |
| Postgres / Redis reach | published host ports | compose network (`postgres:5432`, `redis:6379`) |
| TLS | none | nginx + Let's Encrypt |
| Asterisk logs | named volume | bind mount `/var/log/asterisk` (fail2ban must read it) |
| `ASTERISK_RTP_END` | 12049 (Docker Desktop cost) | can be widened; iptables publishing is free on Linux |
