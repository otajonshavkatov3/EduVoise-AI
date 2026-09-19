# CallCenter "Aqlli Shahar" — documentation

This directory documents the CallCenter CRM **and** the AI voice layer that was
added to it (Asterisk 20 + ARI + AudioSocket + a speech-to-speech model).

Everything here describes what is actually in this repository. Where a feature
is configured but not yet reachable — the backend `/metrics` endpoint, the
`VITE_SIP_*` variables — the document says so explicitly instead of describing
an intention.

## Read in this order

| # | Document | What it answers |
|---|----------|-----------------|
| 1 | [ARCHITECTURE.md](./ARCHITECTURE.md) | What the components are, the exact inbound call flow, why AudioSocket instead of ARI `externalMedia`, why `calls.id` is the AudioSocket UUID, and the data model. |
| 2 | [INSTALLATION.md](./INSTALLATION.md) | Getting it running: the Windows 11 + WSL2 + Docker Desktop path used on this machine, and the Ubuntu 24.04 VPS path. |
| 3 | [CONFIGURATION.md](./CONFIGURATION.md) | Every environment variable: purpose, default, and whether it is a secret. |
| 4 | [ASTERISK.md](./ASTERISK.md) | Dialplan contexts, what each extension does, PJSIP endpoints, adding an extension, ARI/AMI, and why SIP is on 5070 with RTP 12000–12049. |
| 5 | [MICROSIP.md](./MICROSIP.md) | Pointing the MicroSIP softphone at this Asterisk and proving two-way audio with 600/601/602. |
| 6 | [API.md](./API.md) | Every HTTP endpoint, existing and new, with authentication and role requirements. The legacy `/api/webhooks/freepbx` endpoints are retained. |
| 7 | [AI_PROVIDER.md](./AI_PROVIDER.md) | The voice-provider abstraction, the two speech-to-speech providers (OpenAI Realtime and Gemini Live, the one currently selected), the GA-vs-beta Realtime wire shape, and how to grant an OpenAI key access to a realtime model. |
| 8 | [DEPLOYMENT.md](./DEPLOYMENT.md) | `scripts/deploy.sh`, TLS with Let's Encrypt, ufw, fail2ban, updates and rollback. |
| 9 | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Real symptoms with real fixes: one-way audio, failed registration, ARI 401, AudioSocket never connecting, Docker Desktop refusing to start, missing recordings, `model_not_found`. |
| 10 | [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) | `backup.sh` / `restore.sh`, retention, RTO/RPO from TZ.md, and how to verify. |
| 11 | [MAINTENANCE.md](./MAINTENANCE.md) | Routine tasks, log locations, rotation, upgrades, capacity. |

## Repository landmarks

```
apps/backend/src/
  lib/asterisk/     ARI REST client, ARI event WebSocket, AMI client
  lib/ai/           AudioSocket server, G.711 codec, prompts, tools,
                    OpenAI Realtime + Gemini Live providers, fallback IVR,
                    provider factory
  lib/telephony/    contracts, contact matcher, CRM writer, transfer,
                    call orchestrator (the state machine)
  lib/ws/registry.ts  WebSocket fan-out (per user, per role, live-call events)
  routes/           HTTP route groups (see API.md)
  db/schema/        Drizzle schema; aiVoice.ts holds the new tables
asterisk/etc/       dialplan + config templates rendered at container start
asterisk/scripts/   entrypoint.sh (envsubst whitelist, permission checks)
docker/             asterisk.Dockerfile
deploy/             backend.Dockerfile, frontend.Dockerfile
nginx/              production vhost (TLS, CSP, rate limits, /api proxy)
config/firewall/    ufw-rules.sh (+ the DOCKER-USER caveat)
config/fail2ban/    jail.local, asterisk-security filter, docker-user action
monitoring/         Prometheus scrape config, alerts, Grafana provisioning
scripts/            deploy.sh, update.sh, backup.sh, restore.sh,
                    dev-services.ps1 (Windows native Postgres/Redis)
```

## Project-level documents outside this directory

- `README.md` — the original monorepo template README (Bun/Hono/React stack).
- `TZ.md` — the Uzbek-language technical specification: requirements,
  acceptance criteria, backup policy, RTO/RPO.
- `LOCAL_DEV.md` — how this machine was set up **before** WSL2 existed on it:
  native portable Postgres/Redis on ports 5434/6380. Still valid, and still the
  fastest way to run the CRM without Docker.
- `CLAUDE.md` — the Bun-first rules the codebase obeys (no express, no dotenv,
  no `ws`, no `pg` client in new code).
