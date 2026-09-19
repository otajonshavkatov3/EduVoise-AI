# Troubleshooting

Real symptoms seen while building and running this platform, with the fix that
actually resolved each one. Start with [§0](#0-triage-in-60-seconds).

---

## 0. Triage in 60 seconds

```bash
# Is the PBX alive and has it finished loading?
docker exec callcenter-asterisk asterisk -rx "core show version"

# What does the backend think?
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/asterisk/status | jq
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/ai-assistant/status | jq

# Are the endpoints registered?
docker exec callcenter-asterisk asterisk -rx "pjsip show contacts"

# Live channels?
docker exec callcenter-asterisk asterisk -rx "core show channels verbose"

# Logs
docker compose logs --tail=100 asterisk
docker exec callcenter-asterisk tail -100 /var/log/asterisk/full
docker exec callcenter-asterisk tail -50 /var/log/asterisk/security
```

`GET /api/asterisk/status` answers most "where is it broken" questions in one
request: ARI reachable, AMI reachable, event stream running, channel counts,
active AI calls, orchestrator running.

---

## 1. One-way audio

**Symptom.** The call connects, signalling is clean, but only one direction has
sound. Usually you hear Asterisk (601, 602, MoH) and Asterisk hears nothing from
you — or the reverse.

### Confirm which direction is missing

Dial **601** (playback): if you hear "hello world", Asterisk → you works.
Dial **600** (echo): if you hear the prompts but no echo, you → Asterisk is
broken. That is the classic case.

```bash
docker exec callcenter-asterisk asterisk -rx "rtp set debug on"
docker compose logs -f asterisk        # then place a call
```

You will see `Got  RTP packet from …` (inbound) and `Sent RTP packet to …`
(outbound). Whichever line is missing is the broken direction.

### Cause A — RTP ports not published, or remapped

Asterisk writes the **actual port numbers** it chose into its SDP. If the host
mapping shifts them, media is sent to a port nothing listens on.

```bash
docker compose ps asterisk        # must show 12000-12049->12000-12049/udp
ss -ulpn | grep -E '1200[0-9]|120[1-4][0-9]'
```

The host and container ranges must be **identical**, and must match
`ASTERISK_RTP_START` / `ASTERISK_RTP_END` in `.env` (which is what `rtp.conf`
is rendered from) **and** the ufw rule. Fix any mismatch and recreate:

```bash
docker compose up -d --force-recreate asterisk
```

### Cause B — NAT: `rtp_symmetric` / `force_rport` / `rewrite_contact` missing

A softphone behind NAT advertises a private address in its SDP and `Contact`.
Without these options Asterisk politely sends media to that unreachable address.
Every endpoint in `pjsip.conf.template` already sets all three:

```ini
rtp_symmetric = yes     ; send RTP back where it actually came from
force_rport = yes       ; same idea for signalling
rewrite_contact = yes   ; trust the source address over the Contact header
```

PJSIP has **no template inheritance across sections**, so a hand-added endpoint
that omits them will show exactly this symptom while its neighbours work.

```bash
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoint 101" \
  | grep -Ei 'rtp_symmetric|force_rport|rewrite_contact|direct_media'
```

### Cause C — `direct_media` left on

With `direct_media = yes` Asterisk tries to get out of the media path and let
the endpoints talk to each other. Across Docker NAT they cannot, and MixMonitor
and AudioSocket would see nothing anyway. Every endpoint here has
`direct_media = no`, and it must stay that way.

### Cause D — Codec mismatch

`disallow = all` / `allow = ulaw,alaw,slin,slin16`. A softphone offering only
Opus or G.722 either fails to negotiate or negotiates something that transcodes
badly. Force **PCMU** first in the softphone (see
[MICROSIP.md § 1](./MICROSIP.md#codecs)).

```bash
docker exec callcenter-asterisk asterisk -rx "core show channel <chan>" | grep -i codec
```

### Cause E — Host firewall

On Windows, the first inbound UDP to a new port range triggers a Windows Firewall
prompt that may have been dismissed. Allow UDP 12000–12049 for the Docker
backend process. On the VPS, `ufw status verbose` must list
`12000:12049/udp ALLOW`.

### Cause F — `stunaddr` / ICE

`rtp.conf` sets `icesupport = no` and an empty `stunaddr` deliberately. Enabling
STUN makes Asterisk advertise a public reflexive address that is wrong for a
container behind Docker NAT. If a softphone has STUN on and audio is one-way,
turn STUN **off** in the softphone.

---

## 2. Endpoint will not register

**Symptom.** The softphone shows "Registration failed", "Forbidden" or stays
offline; `pjsip show contacts` is empty.

### Read the actual reason first

```bash
docker exec callcenter-asterisk tail -50 /var/log/asterisk/security
docker exec callcenter-asterisk asterisk -rx "pjsip set logger on"
docker compose logs -f asterisk
```

| Log line | Meaning | Fix |
|----------|---------|-----|
| `InvalidPassword` | Right extension, wrong secret | The softphone password must equal `SIP_EXT_1xx_PASSWORD` in `.env` — **not** the voicemail PIN. |
| `InvalidAccountID` | No such endpoint | Extension is not in `pjsip.conf`, or the container was not recreated after the template changed. |
| `ChallengeSent` and nothing after | The reply never arrived | Wrong port (see below), or a firewall dropping the response. |
| Nothing at all in the log | The REGISTER never reached Asterisk | Port/host problem. |

### Cause A — Wrong port (the most common one here)

SIP is on **5070**, not 5060, because MicroSIP owns 5060 on this host. A
softphone configured with just `127.0.0.1` talks to **itself**. The server field
must be `127.0.0.1:5070`.

```bash
docker compose ps asterisk        # 5070->5070/udp AND /tcp
# On Windows, see who really owns 5060:
netstat -ano | findstr :5060
```

### Cause B — The password placeholder was never substituted

If `SIP_EXT_101_PASSWORD` is missing from the entrypoint's `SUBST_VARS`
whitelist, `envsubst` leaves the literal string in the file and no password can
ever match:

```bash
docker exec callcenter-asterisk grep -A3 '\[auth101\]' /etc/asterisk/pjsip.conf
# a literal ${SIP_EXT_101_PASSWORD} here is the bug
```

Add it to **both** `SUBST_VARS` and `REQUIRED_VARS` in
`asterisk/scripts/entrypoint.sh`, rebuild, recreate. See
[ASTERISK.md § 6](./ASTERISK.md#6-adding-an-extension).

### Cause C — The container never started

The entrypoint fails fast, naming **every** missing variable at once, rather than
booting with an empty SIP password:

```bash
docker compose logs asterisk | head -30
# [entrypoint] FATAL: missing required environment variables: SIP_EXT_103_PASSWORD ...
```

Fill them in `.env` and `docker compose up -d asterisk`.

### Cause D — fail2ban banned you

Five failed registrations in ten minutes is enough, and the ban applies to **all
ports** (`banaction_allports = docker-user`), so the dashboard goes dark too.

```bash
fail2ban-client status asterisk-security
fail2ban-client set asterisk-security unbanip <your-ip>
```

Add the office static IP to `ignoreip` in `/etc/fail2ban/jail.local` and restart
fail2ban.

### Cause E — Config edited but not applied

`pjsip.conf` is **rendered at container start**. Editing the template does
nothing until:

```bash
docker compose up -d --force-recreate asterisk
# or, for a config-only change already inside the container:
docker exec callcenter-asterisk asterisk -rx "pjsip reload"
```

---

## 3. ARI 401 Unauthorized

**Symptom.** Backend log shows `AriRequestError ... 401`, or
`GET /api/asterisk/status` returns `ari.ok: false` with a 401 message, or the
event WebSocket connects and immediately closes.

### Cause A — Credential mismatch between `.env` and `ari.conf`

`ari.conf` is rendered from `.env`, so the two normally agree — unless `.env`
changed and the container was not recreated, or the backend reads a different
`.env`.

```bash
# What Asterisk actually has:
docker exec callcenter-asterisk grep -A4 '^\[' /etc/asterisk/ari.conf | tail -8

# Prove the credentials from outside:
curl -i -u "$ASTERISK_ARI_USERNAME:$ASTERISK_ARI_PASSWORD" \
  http://localhost:8088/ari/asterisk/info
```

`401` here ⇒ Asterisk's rendered credentials differ from your `.env`.
Recreate the container: `docker compose up -d --force-recreate asterisk`.

### Cause B — Empty credentials

`ASTERISK_ARI_USERNAME` / `ASTERISK_ARI_PASSWORD` default to `""` in the zod
schema (deliberately: the backend must still boot for the CRM routes when the
telephony stack is not configured). An empty username produces a nameless
`ari.conf` section and every request 401s. Set both.

### Cause C — The WebSocket needs the credentials in the query string

REST uses HTTP Basic. The **event socket** takes `api_key=user:pass`:

```
ws://localhost:8088/ari/events?app=callcenter-ai&api_key=user:pass
```

A URL-encoding problem in the password shows up as an immediate close. This is
another reason `deploy.sh` generates alphanumeric-only secrets.

### Cause D — Wrong host

Development: `http://localhost:8088/ari` (8088 is published to `127.0.0.1`).
Production: `http://asterisk:8088/ari` — the compose service name, set via
`environment:` in `docker-compose.prod.yml` so it overrides the host-side value
in `.env`. Using `localhost` from inside the backend container reaches the
backend container.

### Cause E — ARI is disabled or the HTTP server is not listening

```bash
docker exec callcenter-asterisk asterisk -rx "http show status"
docker exec callcenter-asterisk asterisk -rx "ari show apps"
docker exec callcenter-asterisk asterisk -rx "module show like res_ari"
```

`http.conf` needs `enabled = yes` and `bindaddr = 0.0.0.0` (the backend is
outside the container).

### And check AMI while you are there

Same credential mechanics, different file (`manager.conf`). AMI additionally has
an ACL: `deny 0.0.0.0/0` plus `permit` for loopback and the RFC1918 ranges. A
backend on an unexpected network is refused **after** authenticating.

```bash
docker exec callcenter-asterisk sh -c 'echo | nc 127.0.0.1 5038' | head -1
# Asterisk Call Manager/9.0.0
```

---

## 4. AudioSocket never connects

**Symptom.** The call is answered, `[ai-bridge]` is entered, but no TCP
connection arrives at the backend. The caller hears silence and then the call
ends. Backend log has no "AudioSocket session" line.

This is almost always `AUDIOSOCKET_ADVERTISE_HOST`.

### Cause A — `localhost` instead of `host.docker.internal`

`AS_HOST` is what **Asterisk** dials, and Asterisk is inside the container. So
`localhost:9092` means "the Asterisk container itself", where nothing listens.

| Environment | Correct value |
|-------------|---------------|
| Docker Desktop (Windows/macOS) | `host.docker.internal:9092` |
| Plain Linux Docker, backend on the host | `host.docker.internal:9092` **and** `extra_hosts: host.docker.internal:host-gateway` (already in `docker-compose.yml`) |
| Production compose (backend is a service) | `backend:9092` |

Verify resolution and reachability from inside the container:

```bash
docker exec callcenter-asterisk getent hosts host.docker.internal
docker exec callcenter-asterisk sh -c 'nc -zv host.docker.internal 9092'
```

### Cause B — The listener is not running

The AudioSocket server is bound by `CallOrchestrator.start()`. If the
orchestrator never started, nothing is listening:

```bash
# host
ss -tlpn | grep 9092          # Linux
netstat -ano | findstr 9092   # Windows
```

Backend log should contain `call orchestrator started` with the AudioSocket
address, the advertised host, the ARI app and the AI flags. Also check
`GET /api/asterisk/status` → `eventStream.running` and
`aiCalls.orchestratorRunning`.

### Cause C — `AS_UUID` / `AS_HOST` not set on the channel

`[ai-bridge]` guards against this and jumps to `missing,1`, plays
`technical-difficulties` and hangs up. In the Asterisk log:

```
NoOp(AS_UUID or AS_HOST not set - backend did not prepare the channel)
```

That means the orchestrator's `setVariable` calls failed (ARI 401? wrong channel
id?) yet `continueInDialplan` still happened. Look for the ARI error immediately
before it in the backend log.

### Cause D — `AUDIOSOCKET_HOST` bound to loopback

`AUDIOSOCKET_HOST=127.0.0.1` makes the listener unreachable from the container
even when the hostname resolves. Use `0.0.0.0`.

### Cause E — Host firewall blocking inbound TCP 9092

On Windows, allow the Bun process on TCP 9092 for the Docker/WSL network. On the
VPS this never applies: the connection stays on the compose network, and
`ufw-rules.sh` explicitly DROPs 9092 from outside.

### Cause F — The module is missing

The Docker build asserts `res_audiosocket.so`, `app_audiosocket.so` and
`chan_audiosocket.so` exist, so this should be impossible — but on a hand-built
image:

```bash
docker exec callcenter-asterisk asterisk -rx "module show like audiosocket"
```

### Diagnosing further

```bash
docker exec callcenter-asterisk asterisk -rx "dialplan show ai-bridge"
docker compose logs asterisk | grep -i audiosocket
# the dialplan logs AUDIOSOCKETSTATUS when it ends
```

A connection that arrives and is then dropped **by the backend** is a different
problem: the first packet must be type `0x01` with 16 raw UUID bytes, and the
backend rejects a malformed handshake with an `AudioSocketError` of kind
`protocol`.

---

## 5. Docker Desktop will not start (WSL)

**Symptom.** Docker Desktop hangs on "Starting…", or `docker version` shows only
the client, or you get
`error during connect: ... docker_engine: The system cannot find the file specified`.

This was the original state of this machine and is what `LOCAL_DEV.md`
documents: the Docker CLI was installed but no WSL2 kernel was present.

### Fix, in order

1. **Is WSL there at all?**

   ```powershell
   wsl --version      # must print "WSL version 2.x" and a kernel version
   wsl --status
   ```

   Missing or erroring ⇒ install the standalone WSL package:

   ```powershell
   winget install --id Microsoft.WSL -e --accept-source-agreements --accept-package-agreements
   ```

   Then reboot.

2. **Is `VirtualMachinePlatform` enabled?** (It already was on this machine.)

   ```powershell
   dism.exe /online /Get-FeatureInfo /FeatureName:VirtualMachinePlatform
   # State : Enabled
   ```

   If disabled — needs **administrator** rights, which is precisely why the
   original workaround existed:

   ```powershell
   dism.exe /online /Enable-Feature /FeatureName:VirtualMachinePlatform /All /NoRestart
   dism.exe /online /Enable-Feature /FeatureName:Microsoft-Windows-Subsystem-Linux /All /NoRestart
   Restart-Computer
   ```

3. **Is virtualisation enabled in the BIOS/UEFI?** Task Manager →
   Performance → CPU → *Virtualization: Enabled*. If not, enable
   Intel VT-x / AMD-V in firmware. Nested virtualisation conflicts (VMware,
   VirtualBox, an old Hyper-V state) also break WSL2.

4. **Is a distribution installed?**

   ```powershell
   wsl --list --verbose
   wsl --install -d Ubuntu-24.04
   wsl --set-default-version 2
   ```

5. **Reset the engine.** Docker Desktop → **Troubleshoot** →
   *Clean / Purge data*, or:

   ```powershell
   wsl --shutdown
   wsl --unregister docker-desktop
   wsl --unregister docker-desktop-data   # if present; this deletes images
   ```

   Then start Docker Desktop again.

6. **Update WSL:** `wsl --update`.

### The escape hatch

If Docker Desktop cannot be made to work (no admin rights, for example), the CRM
still runs fully without it: `scripts/dev-services.ps1 start` brings up the
portable Postgres and Redis in `.localdev/` on ports **5434** and **6380**. What
you lose is Asterisk, and therefore all telephony. Everything else —
authentication, users, contacts, calls, tickets, audit logs, dashboard — works.

> Redis must be **≥ 6**. `Bun.RedisClient` speaks RESP3, and Redis 5.x answers
> `ERR unknown command HELLO`. `.localdev/` has Redis 8.0.2.

---

## 6. Backend will not boot

**Symptom.** `Invalid server environment variables:` followed by a formatted zod
error, and the process exits.

`getServerEnv()` validates everything at boot. The message names each offending
variable. Frequent causes:

| Message | Fix |
|---------|-----|
| `JWT_SECRET: Too small: expected string to have >=32 characters` | Use a 32+ character secret. |
| `DATABASE_URL: Invalid URL` | Must be a full `postgresql://user:pass@host:port/db`. |
| `REDIS_URL: Invalid URL` | `redis://:password@host:port` — note the leading colon when there is no username. |
| `AI_AGENT_MAX_CALL_SECONDS: Too small: expected number to be >=30` | Minimum 30. |
| `AI_AGENT_SILENCE_HANGUP_MS: ... >=1000` | Minimum 1000. |
| `VITE_API_URL: Invalid URL` | Frontend-side; must be a valid URL. |

Other boot failures:

- `Cannot find package 'bcryptjs'` — run `bun install`. (`password.ts` imports
  `bcryptjs`, the pure-JS variant, so Windows needs no native build tools.)
- `ERR unknown command HELLO` — Redis 5.x. Upgrade.
- `ECONNREFUSED 127.0.0.1:5434` — Postgres is not running.
  `./scripts/dev-services.ps1 start`, or `docker compose up -d postgres`.

---

## 7. Recording files never appear

**Symptom.** `apps/backend/uploads/call-recordings/` stays empty after AI calls,
or `GET /api/uploads/call-recordings/<callId>.wav` returns 404, or
`call_recordings.isAvailable` is false.

### Cause A — Bind-mount permissions (the usual one)

The directory is bind-mounted from the host and arrives **root-owned**, so
MixMonitor — running as the container's unprivileged `asterisk` user — cannot
write to it. The entrypoint checks exactly this at startup and warns rather than
dying:

```
[entrypoint] WARNING: /var/spool/asterisk/recordings is not writable by asterisk
[entrypoint]          MixMonitor recording will fail; check the bind mount owner.
```

Check and fix:

```bash
docker exec callcenter-asterisk ls -ld /var/spool/asterisk/recordings
docker exec callcenter-asterisk su -s /bin/sh asterisk \
  -c 'touch /var/spool/asterisk/recordings/.probe && echo WRITABLE'
```

On Linux/production — **three** parties share this directory (Asterisk as
`asterisk`, the backend as uid 1000 = `bun`, nginx read-only), so it needs a
shared group and the setgid bit, which is what `deploy.sh` sets:

```bash
chown -R 1000:1000 /opt/callcenter/apps/backend/uploads/call-recordings
chmod 2775          /opt/callcenter/apps/backend/uploads/call-recordings
docker compose restart asterisk
```

Without the setgid bit, files created by one process are unreadable by the
other and the uploads route starts returning 403 for exactly the **newest**
calls — an especially confusing failure.

On Windows/Docker Desktop, make sure the drive is shared in
Docker Desktop → Settings → Resources → File sharing.

### Cause B — Only `[ai-bridge]` records

MixMonitor runs in `[ai-bridge]` only. Calls that never get there are **not**
recorded, by design:

- 600 / 601 / 602 / 700 test extensions;
- internal `1XX` ↔ `1XX` calls;
- AI calls that took the **fallback** path — those stay in Stasis and never
  enter `[ai-bridge]`, so there is no MixMonitor and no recording. An empty
  recordings directory while every call is being transferred to a human is
  expected, not a bug.

### Cause C — Path mismatch between the two sides

Three values must line up:

| Where | Value |
|-------|-------|
| `extensions.conf` global `RECORDINGS_DIR` | `/var/spool/asterisk/recordings` |
| `.env` `ASTERISK_RECORDINGS_DIR` (backend's view of the container path) | `/var/spool/asterisk/recordings` |
| `.env` `RECORDINGS_DIR` (where the backend reads from) | `./apps/backend/uploads/call-recordings` (dev) / `/app/apps/backend/uploads/call-recordings` (prod container) |

The container path and the backend path must be **two views of the same bind
mount**. `crm-writer` translates one to the other; a mismatch produces a
`call_recordings` row pointing at a file the backend cannot open.

### Cause D — The file is there but not served

```bash
ls -la apps/backend/uploads/call-recordings/
docker exec callcenter-asterisk asterisk -rx "mixmonitor list"
```

`mixmonitor list` shows active recordings. In production, nginx serves
recordings through an `internal` location (`/recordings/`) reachable only via
`X-Accel-Redirect` from the backend — requesting `/recordings/x.wav` directly is
supposed to fail.

### Cause E — Disk full

`RecordingDiskFillingUp` is one of the sharpest alerts in
`monitoring/alerts.yml` for good reason: a full disk stops Asterisk writing new
recordings **and** stops Postgres committing.

```bash
df -h /
du -sh /opt/callcenter/apps/backend/uploads/call-recordings
```

---

## 8. OpenAI: `model_not_found`

**Symptom.** The AI never speaks while OpenAI is the selected provider.
`GET /api/ai-assistant/status` shows `provider: "fallback-ivr"` and a `detail`
mentioning `model_not_found`. `ai_sessions` rows have
`status = failed` and the error in `error_message`. Every caller hears
"one moment please" and is transferred to a human.

**No longer the state of this project's key.** This section used to record that
every realtime model answered `model_not_found` on this account. Re-verified
since: `gpt-realtime`, `gpt-4o-transcribe` and `gpt-4o-mini` all return 200, and
the probe negotiates a Realtime session. The recipe below is kept for a key that
*does* still lack access.

**Before working through it, check which provider you are actually running.**
`AI_VOICE_PROVIDER=gemini` means no OpenAI Realtime session is opened at all, so
`model_not_found` cannot be your symptom — see section 8a.

**It is not a code bug and it is not a crash.** The provider is written correctly
against the GA wire shape and fails *gracefully*: terminal error codes are never
retried, `start()` raises `VoiceProviderUnavailableError`, and the orchestrator
falls back to the IVR while the caller is still on the line.

### The remedy, exactly

Realtime access is a **project-level model permission**, not a subscription.

1. Find the project the key belongs to (dashboard → **Settings → API keys**, or
   `curl https://api.openai.com/v1/models -H "Authorization: Bearer $KEY"`).
2. Switch the dashboard's project selector to that project.
3. **Settings → Project → Limits** (a.k.a. *Model permissions*) → enable
   `gpt-realtime` (and `gpt-realtime-mini`). Keep `gpt-4o-mini` enabled —
   post-call analysis needs it. Save; it applies within a minute or two, with
   nothing to redeploy.
4. If that changes nothing, work through: **organisation verification**
   (Settings → Organization → General — some audio/realtime models require it),
   **billing** (a positive balance or active payment method), **key
   restrictions** (a restricted key may not carry the model/inference scope), and
   **region/tier** availability.
5. Put the key in `.env`, set `AI_AGENT_ENABLED=true`, restart the backend.

### Verify

```bash
# 1. Does the key see the model?
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" \
  | grep -o '"id": *"[^"]*realtime[^"]*"'

# 2. Does the handshake succeed? (expect session.created)
#    Full script: docs/AI_PROVIDER.md section 6.2

# 3. Does the platform agree?
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/ai-assistant/status | jq
```

Full walkthrough: [AI_PROVIDER.md § 5–6](./AI_PROVIDER.md).

### Related OpenAI errors

| Code | Meaning | Action |
|------|---------|--------|
| `beta_api_shape_disabled` | An `OpenAI-Beta: realtime=v1` header was sent. The beta wire shape is **dead**. | Send only `Authorization: Bearer <key>`. |
| `invalid_api_key` | Wrong or revoked key. | Replace it. |
| `insufficient_quota` | Billing. | Top up / fix the payment method. |
| `invalid_model` | Typo in `OPENAI_REALTIME_MODEL`. | `gpt-realtime`. |
| Closes with 1006, no event | Network/proxy blocking `wss://api.openai.com`. | Check egress from the host and from the container. |

Note that `available: false` immediately after fixing the entitlement can simply
be the **30-second health cache**. Wait, or restart the backend.

---

## 8a. Gemini Live: the status card, the voice, or no audio

`AI_VOICE_PROVIDER=gemini` selects Gemini Live. Three symptoms are specific to
it.

**The status card names the wrong provider.** If `GET /api/ai-assistant/status`
says `openai-realtime` while `ai_sessions.provider` on recent calls says
`gemini-live`, you are running a build from before the probe was made
provider-aware. The probe now branches on `AI_VOICE_PROVIDER` through the shared
`selectedVoiceProviderName()`; there is no configuration that produces the
mismatch any more.

**Every caller reaches the IVR.** Check the detail string. `GOOGLE_AI_API_KEY is
not set` means exactly that — `GEMINI_API_KEY` also works as an alias. Anything
else is the reply to `GET /v1beta/models/<model>`, which names the model and the
HTTP status: a 404 is a model id that this key cannot see (check
`GEMINI_LIVE_MODEL`), a 403 is the key.

**The agent speaks in the wrong voice.** The two vendors' voice names are
disjoint. Setting an OpenAI name such as `cedar` on the Gemini path is refused
with a warning in the log (`that voice is not a Gemini voice`) and the default
`Callirrhoe` is used — a session that accepted it would die with
`1007 No matching speaker voice found for name: cedar`, i.e. a dropped call.
Pick from the fifteen names in
[AI_PROVIDER.md § 2](./AI_PROVIDER.md). The dashboard dropdown offers the
selected provider's list, so a stale browser tab is the usual cause.

**Post-call analysis still needs OpenAI.** The summary, sentiment and categories
come from `OPENAI_ANALYSIS_MODEL` (a text chat completion) whichever voice
provider ran. A Gemini-only deployment with no OpenAI key gets working calls and
empty `ai_analyses` rows.

---

## 9. Other things that have actually gone wrong

### The AI answers but the CRM has no rows

Check the backend log for a database error inside a tool handler. Tool arguments
are zod-validated first, so an invalid argument produces a validation error, not
a bad row. `ai_sessions` should exist even for a failed session — if it does not,
`createAiSession()` failed and the error is in the log.

### Duplicate `calls` rows for one call

The AI path and the legacy FreePBX path are independent. If something still posts
to `/api/webhooks/freepbx/call-start` for a call Asterisk is also handling
through Stasis, you get two rows. Stop the legacy poster for AI-handled ranges;
the endpoint is retained for genuinely legacy PBX traffic.

### The transfer rings nobody

```bash
docker exec callcenter-asterisk asterisk -rx "pjsip show contacts"
```

`AI_TRANSFER_EXTENSIONS` must list extensions that are actually registered.
`chooseTransferTarget()` prefers an operator that is online and not on a call; if
none of the listed extensions has a contact, the transfer fails and
`call_transfers.status` becomes `failed`.

### ARI 409 on a channel

Expected, and handled: a channel executing a dialplan application (i.e. inside
`AudioSocket()`) is **not** under Stasis control, so ARI refuses `moh`, `bridge`
and `addChannel`. That is exactly why `transfer.ts` switches to the
`ami-redirect` strategy in that state.

### Frontend console flooded with SIP reconnect errors

`apps/frontend/src/modules/calls/config/sip.config.ts` still carries the legacy
FreePBX defaults (`192.168.3.59:8088`, extension 201, `autoConnect: true`) and
retries every second. No code change needed:

```js
localStorage.setItem("sip_config", JSON.stringify({ autoConnect: false, debug: false }))
```

### Prometheus `backend` target is down

Expected today: the backend does not expose `/metrics`.
`monitoring/prometheus/prometheus.yml` documents the metric contract to
implement. `update.sh`'s smoke test warns about this instead of failing.

### `docker compose up` is slow, or the machine runs out of RAM

Docker Desktop creates one userland proxy process per published **UDP** port.
Keep `ASTERISK_RTP_END` at 12049 (50 ports ≈ 25 concurrent calls) in
development; widen it only on a real Linux host.

### A call ends by itself after ~60 seconds of silence

`rtp.conf` sets `rtptimeout = 60`, deliberately: a crashed softphone must not
leave a channel — and an OpenAI Realtime session — up forever. Separately,
`AI_AGENT_SILENCE_HANGUP_MS` (default 20 s) ends an AI call after continuous
silence, and `AI_AGENT_MAX_CALL_SECONDS` (default 900) caps its total length.
Both write an explanatory transcript line.
