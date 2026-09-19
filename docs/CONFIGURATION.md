# Configuration

All configuration is environment variables in a single `.env` at the repository
root. Bun loads `.env` automatically (`CLAUDE.md`: no `dotenv`), and the backend
validates its own slice of it once at boot through `getServerEnv()` in
`shared/src/env.ts`.

Three consumers read the same file:

| Consumer | How |
|----------|-----|
| Backend (Bun) | `bun --env-file=../../.env` in dev; `env_file: .env` in compose. Validated by `serverEnvSchema` (zod v4) — an invalid value throws at boot with a formatted error. |
| Frontend (Vite) | Only `VITE_*` variables, baked into the bundle at build time. Validated by `clientEnvSchema`. |
| Docker Compose / Asterisk entrypoint | `${VAR}` interpolation in the compose files, and `envsubst` with an explicit whitelist in `asterisk/scripts/entrypoint.sh`. |

**Secrets never leave `.env`.** `deploy.sh` writes it `chmod 600`. `.env` is
gitignored; `.env.example` carries placeholders only. The API surface never
returns a secret: `GET /api/ai-assistant/config` reports
`apiKeyConfigured: true|false`, never the key, and `GET /api/asterisk/status`
strips credentials from the ARI URL before returning it.

Everything below marked **required** has no default and the process fails
without it.

---

## 1. Runtime

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `NODE_ENV` | `development` \| `production` \| `test`. Controls pino pretty-printing and log level (`debug` in dev, `info` in prod). | `development` | no |
| `PORT` | Backend HTTP port. | `4000` | no |
| `HOST` | Backend bind address. | `0.0.0.0` | no |

## 2. Database and cache

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `DATABASE_URL` | Postgres connection URL used by the backend and drizzle-kit. Must be a valid URL. | **required** | **yes** (embeds the password) |
| `REDIS_URL` | Redis connection URL. Redis must be ≥ 6 — `Bun.RedisClient` speaks RESP3 (`HELLO 3`). | **required** | **yes** |
| `POSTGRES_USER` | Compose only: Postgres role created in the container. | `myapp` (dev) / `callcenter` (deploy.sh) | no |
| `POSTGRES_PASSWORD` | Compose only. Compose errors out if unset. | **required** | **yes** |
| `POSTGRES_DB` | Compose only: database name. | `myapp` / `callcenter` | no |
| `POSTGRES_PORT` | Compose only: published host port. `5434` on this machine because 5432 and 5433 are taken. | `5432` (compose) / `5434` (deploy.sh) | no |
| `REDIS_PASSWORD` | Compose only: `--requirepass`. Compose errors out if unset. | **required** | **yes** |
| `REDIS_PORT` | Compose only: published host port. `6380` here because 6379 is taken. | `6379` / `6380` | no |

> In production, `docker-compose.prod.yml` overrides `DATABASE_URL` and
> `REDIS_URL` for the containers to use service names (`postgres:5432`,
> `redis:6379`). The values in `.env` stay host-side so `psql`,
> `drizzle-kit studio` and `backup.sh` work from the host.

## 3. Authentication

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `JWT_SECRET` | Access-token signing key. Minimum 32 characters (enforced). | **required** | **yes** |
| `JWT_EXPIRES_IN` | Access-token lifetime. | `15m` | no |
| `JWT_REFRESH_SECRET` | Refresh-token signing key. Minimum 32 characters. | **required** | **yes** |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh-token lifetime; also the Redis TTL. | `7d` | no |

## 4. Asterisk ARI (call control)

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `ASTERISK_ARI_URL` | ARI REST base. Dev `http://localhost:8088/ari`; prod `http://asterisk:8088/ari`. | `http://localhost:8088/ari` | no |
| `ASTERISK_ARI_WS_URL` | ARI event WebSocket. Derived from `ASTERISK_ARI_URL` if unset. | `ws://localhost:8088/ari/events` | no |
| `ASTERISK_ARI_APP` | Stasis application name. Must match `Stasis(...)` in `extensions.conf` (`callcenter-ai`) and the Prometheus/dialplan globals. | `callcenter-ai` | no |
| `ASTERISK_ARI_USERNAME` | ARI user. Rendered into `ari.conf` as the section name. | `""` (voice layer disabled) | no |
| `ASTERISK_ARI_PASSWORD` | ARI password. Also used by the Prometheus scrape job for Asterisk `/metrics`. | `""` | **yes** |

## 5. Asterisk AMI (endpoint state, Redirect)

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `ASTERISK_AMI_HOST` | AMI host. Dev `localhost`; prod `asterisk`. | `localhost` | no |
| `ASTERISK_AMI_PORT` | AMI port. | `5038` | no |
| `ASTERISK_AMI_USERNAME` | AMI account, rendered into `manager.conf`. | `""` | no |
| `ASTERISK_AMI_PASSWORD` | AMI secret. | `""` | **yes** |

## 6. SIP and RTP

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `ASTERISK_SIP_PORT` | SIP signalling port, bound **inside** the container too (so Via/Contact advertise the port callers actually reach). `5070` and not 5060 because MicroSIP owns 5060 on the dev host. | `5070` | no |
| `ASTERISK_RTP_START` | First RTP port. `12000` because MicroSIP's own RTP occupies 10010–10012. | `12000` | no |
| `ASTERISK_RTP_END` | Last RTP port. Host and container ports must be **equal** — Asterisk writes these numbers into its SDP. 50 ports ≈ 25 concurrent calls. Keep small on Docker Desktop (one userland proxy per published UDP port); widen on Linux. | `12049` | no |

## 7. AudioSocket

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `AUDIOSOCKET_HOST` | Bind address of the backend's TCP audio listener. | `0.0.0.0` | no |
| `AUDIOSOCKET_PORT` | Its port. One port serves every concurrent call. | `9092` | no |
| `AUDIOSOCKET_ADVERTISE_HOST` | `host:port` written into the channel variable `AS_HOST`, i.e. what Asterisk is told to dial back to. Docker Desktop: `host.docker.internal:9092`. Production compose: `backend:9092`. **Never `localhost`** — that would be the Asterisk container itself. | `host.docker.internal:9092` | no |

## 8. OpenAI

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `OPENAI_API_KEY` | Optional. Absent or empty ⇒ the fallback IVR handles every call (a safe default, not an error). | *(unset)* | **yes** |
| `OPENAI_REALTIME_MODEL` | Realtime model requested in the WebSocket query string. | `gpt-realtime` | no |
| `OPENAI_REALTIME_VOICE` | GA Realtime voice (`alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`). Starting value of the `ai.openai.voice` setting; `PATCH /api/ai-assistant/config` then stores the change (in the active business profile when there is one) and this variable stops deciding. | `alloy` | no |
| `OPENAI_TRANSCRIBE_MODEL` | Input-audio transcription model inside the Realtime session. | `whisper-1` | no |
| `OPENAI_ANALYSIS_MODEL` | Post-call summary/sentiment model (text chat completions). Used **whichever voice provider ran** — analysis is an OpenAI text call even after a Gemini conversation. | `gpt-4o-mini` | no |

## 8a. Gemini Live

The second speech-to-speech provider, and the one this deployment currently
uses. See [AI_PROVIDER.md](./AI_PROVIDER.md).

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `AI_VOICE_PROVIDER` | `gemini` ⇒ Gemini Live. Anything else (or unset) ⇒ OpenAI Realtime. Checked before the OpenAI key, so a Gemini deployment needs no OpenAI key to answer calls. | *(unset)* | no |
| `GOOGLE_AI_API_KEY` | Google AI key. `GEMINI_API_KEY` is accepted as an alias. Missing while `AI_VOICE_PROVIDER=gemini` ⇒ fallback IVR, never a dropped call. | *(unset)* | **yes** |
| `GEMINI_LIVE_MODEL` | Live model id. | `gemini-3.1-flash-live-preview` | no |
| `GEMINI_LIVE_VOICE` | One of Gemini's own 30 voices. The full list with each voice's character is in `lib/ai/gemini-live.ts` (`GEMINI_VOICE_CATALOG`) and is what the AI yordamchi page shows; all 30 were verified accepted by `gemini-3.1-flash-live-preview`. **Not** an OpenAI voice name — one of those kills the session, so an unrecognised name warns and falls back to the default. | `Callirrhoe` | no |

## 9. AI agent behaviour

**These are starting values, not the last word.** Every variable in this section
(plus `AI_VOICE_PROVIDER`, `GEMINI_LIVE_*`, `OPENAI_REALTIME_*`,
`OPENAI_TRANSCRIBE_MODEL` and `OPENAI_ANALYSIS_MODEL`) is registered as a setting
in the `ai` category of `lib/settings/registry.ts`, and the registered default IS
the value read from `.env` at boot. So the precedence is:

    a stored row in system_settings  >  .env  >  the built-in default

A supervisor changes them on the **AI yordamchi** page; the change is stored,
survives a restart, and is re-read at the top of every call, so it reaches the
next caller. `.env` is never rewritten - it stays the baseline a deployment ships
with, and deleting the stored row falls back to it.

Four of them - voice, language, `maxCallSeconds`, `silenceHangupMs` - are stored
in the active `ai_agent_profiles` row instead whenever one exists, because that
row is what the orchestrator and the provider actually read on a call. The config
endpoint reports which of the two homes each value came from in `sources`.

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `AI_AGENT_ENABLED` | `true`/`1` ⇒ try the provider `AI_VOICE_PROVIDER` selects. Anything else ⇒ fallback IVR. Starting value of the `ai.enabled` setting; a change made on the AI page is stored and takes effect on the next call. | `true` | no |
| `AI_AGENT_EXTENSION` | Dialplan extension that reaches the agent. Reported by the status/config endpoints and seeded into `sip_extensions` as `kind = ai`. | `900` | no |
| `AI_AGENT_LANGUAGE` | Prompt language when the business profile does not set one. Starting value of the `ai.language` setting; read per call now, so a change takes effect on the next caller with no restart. | `uz` | no |
| `AI_AGENT_GREETING_DELAY_MS` | Pause between "session ready" and the greeting. Not part of the zod env schema: it is the starting value of the `ai.greetingDelayMs` setting, which validates it (0–10000) and falls back to the built-in default if `.env` holds something unusable. | `400` | no |
| `AI_AGENT_MAX_CALL_SECONDS` | Hard cap on an AI-handled call. Minimum 30 (enforced). Starting value of `ai.maxCallSeconds`; the active business profile's own limit wins when it is greater than 0. | `900` | no |
| `AI_AGENT_SILENCE_HANGUP_MS` | Hang up after this much continuous silence. Minimum 1000 (enforced). Starting value of `ai.silenceHangupMs`; the business profile's own value wins when it is greater than 0. | `20000` | no |
| `AI_TRANSFER_EXTENSIONS` | Comma-separated operator extensions the AI may transfer to. Starting value of `ai.transferExtensions`, which is read per transfer. | `101,102,103,104` | no |

## 10. Recordings

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `ASTERISK_RECORDINGS_DIR` | Path **inside the Asterisk container** where MixMonitor writes `<callId>.wav`. Must match the dialplan global `RECORDINGS_DIR` in `extensions.conf` and the container side of the bind mount. | `/var/spool/asterisk/recordings` | no |
| `RECORDINGS_DIR` | Where the **backend** reads the same bind-mounted files from. Repo-relative in dev; absolute (`/app/apps/backend/uploads/call-recordings`) in the production container. | `./apps/backend/uploads/call-recordings` | no |

## 11. SIP extension and voicemail secrets

Consumed **only** by the Asterisk container entrypoint, which substitutes them
into `pjsip.conf` and `voicemail.conf` and then fails fast, naming every missing
variable at once, rather than booting with an empty SIP password.

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `SIP_EXT_101_PASSWORD` … `SIP_EXT_104_PASSWORD` | PJSIP auth password for extensions 101–104. 24 characters generated by `deploy.sh`. | **required** | **yes** |
| `VOICEMAIL_PIN_101` … `VOICEMAIL_PIN_104` | Voicemail PINs (mailbox `1xx@default`). 6 digits generated by `deploy.sh`. | **required** | **yes** |

Adding an extension means adding both variables **and** the entrypoint's
`SUBST_VARS`/`REQUIRED_VARS` lists — see
[ASTERISK.md § adding an extension](./ASTERISK.md#6-adding-an-extension).

## 12. Frontend

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `VITE_API_URL` | API base baked into the bundle. Must be a valid URL (enforced). Production uses `/` (same origin), which is also what keeps the CSP's `connect-src 'self'` sufficient. | **required** | no |
| `VITE_SIP_WS_URL`, `VITE_SIP_EXTENSION`, `VITE_SIP_PASSWORD`, `VITE_SIP_REALM` | **Declared in `.env.example` but not read by any code today.** The browser softphone still takes its defaults from `apps/frontend/src/modules/calls/config/sip.config.ts` (legacy FreePBX values) with a `localStorage` override. Browser calling also needs a `wss` transport and DTLS certificates on Asterisk, which are not configured. | — | `VITE_SIP_PASSWORD` would be **yes** — and note that any `VITE_*` value is shipped to the browser, so a real SIP password must never go here. |

## 13. Production-only (compose, nginx, monitoring)

Read by `docker-compose.prod.yml`, the nginx render step and `deploy.sh`. Not
part of the backend schema.

| Variable | Purpose | Default | Secret |
|----------|---------|---------|--------|
| `DOMAIN` | Public hostname. Substituted for `__DOMAIN__` in the nginx vhosts and used for the certificate path. | **required by deploy.sh** | no |
| `LETSENCRYPT_EMAIL` | ACME contact; also cron's `MAILTO`. | *(unset)* | no |
| `IMAGE_TAG` | Tag for `callcenter-backend` / `callcenter-frontend`. `update.sh` sets it to the git short SHA; rollback is `IMAGE_TAG=<old sha> docker compose up -d`. | `latest` | no |
| `LETSENCRYPT_DIR` | Host path mounted read-only into nginx. | `/etc/letsencrypt` | no |
| `CERTBOT_WEBROOT` | HTTP-01 challenge webroot. | `/var/www/certbot` | no |
| `NGINX_LOG_DIR` | Host path for nginx logs, so fail2ban can tail them. | `/var/log/nginx` | no |
| `ASTERISK_LOG_DIR` | Host path bind-mounted at `/var/log/asterisk`. Required for fail2ban's `asterisk-security` jail — a named volume cannot be tailed from the host. | `/var/log/asterisk` | no |
| `TEXTFILE_DIR` | node-exporter textfile-collector directory. `backup.sh` writes its metrics here; `BackupTooOld` reads them. | `/var/lib/node_exporter/textfile_collector` | no |
| `GRAFANA_ADMIN_USER` | Grafana admin login. | `admin` | no |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password. Compose errors out if unset. | **required** | **yes** |
| `GRAFANA_ROOT_URL` | Grafana root URL. Loopback-only by design — reach it over `ssh -L 3002:127.0.0.1:3002`. | `http://127.0.0.1:3002/` | no |

---

## 14. Secret inventory

Rotate these and nothing else; everything above not listed is topology, not a
credential.

```
JWT_SECRET               JWT_REFRESH_SECRET
POSTGRES_PASSWORD        DATABASE_URL         (contains the same password)
REDIS_PASSWORD           REDIS_URL            (contains the same password)
ASTERISK_ARI_PASSWORD    ASTERISK_AMI_PASSWORD
SIP_EXT_101..104_PASSWORD
VOICEMAIL_PIN_101..104
OPENAI_API_KEY
GRAFANA_ADMIN_PASSWORD
```

Rotation notes:

- **Postgres/Redis passwords** appear twice (raw and inside the URL). Change
  both, or the app authenticates with a stale URL. Changing `POSTGRES_PASSWORD`
  after the volume exists does **not** change the role's password — do that in
  SQL (`ALTER ROLE ... PASSWORD ...`) and then update `.env`. `deploy.sh`
  deliberately never overwrites an existing value for this reason.
- **ARI/AMI/SIP/voicemail** live in rendered config, so the Asterisk container
  must be recreated: `docker compose up -d --force-recreate asterisk`.
- **`JWT_SECRET`** invalidates every access token immediately;
  `JWT_REFRESH_SECRET` forces every user to log in again.
- **`OPENAI_API_KEY`** takes effect on the next call; run
  `GET /api/ai-assistant/status?force=true`-style refresh by waiting out the
  30 s health cache, or restart the backend.

## 15. Precedence

1. Variables set in the shell / systemd / compose `environment:` win.
2. Then `env_file: .env` (compose) or `--env-file` (Bun).
3. Then the zod schema defaults in `shared/src/env.ts`.

`docker-compose.prod.yml` uses `environment:` for `DATABASE_URL`, `REDIS_URL`,
`ASTERISK_ARI_URL`, `ASTERISK_ARI_WS_URL`, `ASTERISK_AMI_HOST`,
`ASTERISK_AMI_PORT`, `AUDIOSOCKET_*` and `RECORDINGS_DIR` precisely so the
container-network values override the host-side ones in `.env`.
