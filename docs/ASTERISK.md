# Asterisk

Asterisk 20.6.0 runs in the container `callcenter-asterisk`, built by
`docker/asterisk.Dockerfile` from the `ubuntu:24.04` packaged Asterisk.

**Why the distro package, not a source build:** the package already carries
`res_audiosocket` / `chan_audiosocket` / `app_audiosocket` and the full ARI
module set, and it receives security updates. Compiling would add ~15 minutes
per build for no capability used here.

**Why `ubuntu:24.04` and not Debian:** both trixie and bookworm have dropped the
`asterisk` package (`E: Package 'asterisk' has no installation candidate`),
verified against both before choosing this base.

The build **fails loudly** if any required module is missing, rather than
discovering it on the first call: `res_audiosocket.so`, `app_audiosocket.so`,
`chan_audiosocket.so`, `res_ari.so`, `res_ari_channels.so`, `res_ari_events.so`,
`res_ari_bridges.so`, `res_stasis.so`, `app_stasis.so`, `app_mixmonitor.so`,
`chan_pjsip.so`.

---

## 0. MULTI-TENANT: read this before anything below

This platform is sold to several call centres, and **each customer's telephony is
separate inside one Asterisk**. Extension numbers repeat across customers on
purpose - "101" is an operator code and every customer has one - so the isolation
lives in the **PJSIP endpoint name** and the **dialplan context**, never in the
digits a customer dials:

| Thing | Name | Note |
|-------|------|------|
| endpoint / aor / auth | `avilab-101`, `avilab-101-auth` | platform-wide unique |
| SIP auth **username** | `avilab-101` | REGISTER has no tenant field, so the credential cannot be "101" |
| contexts | `from-internal-avilab`, `from-external-avilab`, `ai-bridge-avilab`, `ai-transfer-avilab`, `click-to-call-avilab` | a call in one can reach nothing else |
| trunk | `trunk-avilab` (+ `-auth`, `-reg`, `-identify`) | every customer has their own carrier |
| recordings | `/var/spool/asterisk/recordings/avilab/<calls.id>.wav` | one directory per customer |

One naming contract produces all of them:
`apps/backend/src/lib/tenancy/asterisk-naming.ts`.

**Where the per-tenant config comes from.** Not from this repository: a tenant is
a database row, and onboarding a customer must not need a rebuild or a restart.
The backend renders two files from the `tenants` table and reloads Asterisk over
AMI (`apps/backend/src/lib/asterisk/tenant-config.ts`):

```
asterisk/etc/generated/pjsip-tenants.conf       #include-d by pjsip.conf
asterisk/etc/generated/extensions-tenants.conf  #include-d by extensions.conf
```

The directory is bind-mounted into the container. `entrypoint.sh` writes the same
two files from `.env` **only when they are missing**, so a fresh clone works and
Asterisk still boots with the database down - it never overwrites the backend's
copy, because a stale tenant list is bad and an empty one is an outage.

**Where the dialplan LOGIC lives.** `asterisk/etc/extensions.conf.template` holds
five `(!)` context templates (`tenant-internal`, `tenant-external`,
`tenant-ai-bridge`, `tenant-ai-transfer`, `tenant-click-to-call`). The generated
file contains nothing but one-line declarations that inherit them:

```
[from-internal-avilab](tenant-internal)
```

A template knows which tenant it is running for from its own context name:
`${CONTEXT}` is `from-internal-avilab` and `from-internal-` is 14 characters, so
`${CONTEXT:14}` is the slug. Every template spells out the length it strips.

**How an inbound call gets its tenant.** The dialplan states it:
`Stasis(callcenter-ai,tenant=avilab)`. That argument is the highest-authority
source in `apps/backend/src/lib/telephony/inbound-tenant.ts`, and whatever it
resolves to becomes `calls.tenant_id` and is inherited by the contact, the
transcript, the recording, the ticket and the analysis.

**The pre-tenancy names still work.** `[from-internal]`, `[from-external]`,
`[ai-bridge]`, `[ai-transfer]` and `[click-to-call]` still exist and now
**forward** to `${LEGACY_TENANT_SLUG}` (`.env`: `ASTERISK_LEGACY_TENANT_SLUG`), so
the documented smoke commands and a softphone provisioned before tenancy keep
working - and the call still arrives with a tenant attached. That tenant also
keeps **bare-digit alias endpoints** (`[101]` with its own aor `101`), and its
tenant endpoint lists both aors (`aors = avilab-101,101`) so the tenant's dialplan
rings a phone that never learned its new name. Only ONE tenant may have aliases;
the generator throws if a second asks, because that namespace is global.

Sections 1-9 below describe the pre-tenancy single-customer layout. Everything in
them about ports, NAT, AudioSocket, ARI and troubleshooting still holds; wherever
they say `[101]` or `[from-internal]`, read `avilab-101` and
`from-internal-avilab`.

---

## 1. Ports, and why they are unusual

| Service | Port | Published to | Reason |
|---------|------|--------------|--------|
| SIP | **5070** udp+tcp | `0.0.0.0` | **MicroSIP already owns 5060** udp+tcp on the development host. Asterisk binds 5070 *inside* the container as well (`ASTERISK_SIP_PORT` feeds `pjsip.conf`), so the port it advertises in `Via`/`Contact` matches the port callers actually reach it on. A host-only remap would produce registrations that succeed and calls that never arrive. |
| RTP | **12000–12049** udp | `0.0.0.0`, **identical** host:container mapping | Asterisk writes these exact port numbers into its SDP, so a shifted mapping would send media to a port nothing listens on. The range starts at 12000 because MicroSIP's own RTP occupies 10010–10012. It is only 50 ports (**≈ 25 concurrent calls**) because Docker Desktop creates one userland proxy process per published UDP port — a conventional 10000–20000 range makes `docker compose up` take minutes and eats RAM. Widen `ASTERISK_RTP_END` on a real Linux host, where publishing is iptables and costs nothing. |
| ARI / HTTP | 8088 tcp | `127.0.0.1` only | The backend is the only consumer. Never reachable from the LAN. |
| AMI | 5038 tcp | `127.0.0.1` only | Full PBX control. Same reasoning. |
| AudioSocket | 9092 tcp | **not** an Asterisk port | Asterisk dials **out** to the backend. Nothing is published for it. |

`extra_hosts: host.docker.internal:host-gateway` is set explicitly so the file
also works on plain Linux Docker, where that name does not exist by default.

Production firewalling (`config/firewall/ufw-rules.sh`) opens 22, 80, 443,
5070/udp+tcp and 12000–12049/udp, and installs **DOCKER-USER** DROP rules for
8088, 5038, 5434, 6380, 9090, 9100, 9187, 3002 and 9092 — because published
container ports bypass ufw's INPUT chain entirely.

---

## 2. Configuration layout

```
asterisk/etc/
  extensions.conf.template   rendered at container start (only ${ASTERISK_LEGACY_TENANT_SLUG})
  modules.conf               baked in
  logger.conf                baked in
  musiconhold.conf           baked in
  prometheus.conf            baked in
  pjsip.conf.template        rendered at container start
  ari.conf.template          rendered at container start
  http.conf.template         rendered at container start
  manager.conf.template      rendered at container start
  rtp.conf.template          rendered at container start
  voicemail.conf.template    rendered at container start
  generated/                 PER-TENANT config, bind-mounted; written by the
                             backend from the tenants table, bootstrapped from
                             .env by entrypoint.sh when missing
    pjsip-tenants.conf         endpoints, auths, aors, trunks
    extensions-tenants.conf    one line per tenant context
asterisk/scripts/entrypoint.sh
```

`entrypoint.sh`:

1. Verifies every required variable is present and **names all missing ones at
   once**, then exits 1 — better than booting with an empty SIP password and
   looking secure until someone probes the port.
2. Renders `*.template` → `/etc/asterisk/*` with `envsubst` and an **explicit
   variable whitelist**. This matters: Asterisk configs are full of
   `${DIALPLAN_VARIABLES}`, and a bare `envsubst` would silently blank every one
   of them. Only these names are substituted:
   `ASTERISK_SIP_PORT`, `ASTERISK_RTP_START`, `ASTERISK_RTP_END`,
   `SIP_EXT_101..104_PASSWORD`, `ASTERISK_ARI_USERNAME`, `ASTERISK_ARI_PASSWORD`,
   `ASTERISK_AMI_USERNAME`, `ASTERISK_AMI_PASSWORD`, `VOICEMAIL_PIN_101..104`.
3. Sets ownership/`0640` on rendered files, creates the runtime directories, and
   **checks that `asterisk` can write the recordings directory** — a host bind
   mount arrives root-owned, which would make MixMonitor fail on the first call.
   It warns rather than dying, so the PBX still serves calls.
4. `exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv` under `tini`
   (foreground, dropped privileges, correct signal/zombie handling).

Health check: `asterisk -rx "core show version"` — it only succeeds once the
control socket accepts commands, which is exactly the readiness signal the
backend needs.

---

## 3. Dialplan contexts

`asterisk/etc/extensions.conf`. Globals: `AI_STASIS_APP = callcenter-ai`,
`RECORDINGS_DIR = /var/spool/asterisk/recordings`.

### `[from-internal]` — registered softphones (101–104)

| Extension | What it does |
|-----------|--------------|
| `_1XX` | Operator-to-operator. `Dial(PJSIP/${EXTEN},30,tT)` then branches on `DIALSTATUS`: **BUSY** → `Voicemail(${EXTEN}@default,bu)`; **NOANSWER** → `Voicemail(...,u)`; **CHANUNAVAIL** → `Playback(ss-noservice)`; **CONGESTION** → `Congestion(5)`; **ANSWER** → hang up (normal clearing). `CDR(userfield)=internal`. |
| **900** | **The AI agent.** `Stasis(callcenter-ai)` — hands the channel to the backend. Dial it from any softphone to talk to the agent. |
| **600** | **Echo test.** `Answer()` → `Playback(demo-echotest)` → `Echo()` → `Playback(demo-echodone)`. Proves **two-way** RTP without involving the backend or the AI at all. |
| **601** | **Playback test.** `Answer()` → `Wait(1)` → `Playback(hello-world)`. Proves **one-way** RTP (Asterisk → you) and codec negotiation. |
| **602** | **Music on hold.** `Answer()` → `MusicOnHold(default,30)`. Proves sustained one-way media; also verifies the `asterisk-moh-opsound-wav` package. |
| **700** | **Voicemail retrieval.** `VoiceMailMain(${CALLERID(num)}@default)` — asks for the PIN from `VOICEMAIL_PIN_1xx`. |

### `[from-external]` — inbound from a SIP trunk

```
exten => _.,1,NoOp(External inbound from ${CALLERID(num)} to ${EXTEN})
 same => n,Set(CDR(userfield)=inbound-ai)
 same => n,Stasis(${AI_STASIS_APP})
 same => n,Hangup()
exten => i,1,Hangup()
```

Every external caller goes straight to the AI agent; the backend then decides
whether to keep talking or transfer to a human. Point the trunk's endpoint
`context` at this.

### `[ai-bridge]` — the audio path

Entered **only** via ARI `continueInDialplan`, after the backend has set
`AS_UUID` and `AS_HOST` on the channel.

```
exten => s,1,NoOp(AudioSocket bridge uuid=${AS_UUID} host=${AS_HOST})
 same => n,GotoIf($["${AS_UUID}" = ""]?missing,1)
 same => n,GotoIf($["${AS_HOST}" = ""]?missing,1)
 same => n,Set(MIXMON_FILE=${RECORDINGS_DIR}/${AS_UUID}.wav)
 same => n,MixMonitor(${MIXMON_FILE},)
 same => n,AudioSocket(${AS_UUID},${AS_HOST})
 same => n,NoOp(AudioSocket ended status=${AUDIOSOCKETSTATUS})
 same => n,Hangup()

exten => missing,1,Playback(technical-difficulties) ; then Hangup
```

Recording starts **before** AudioSocket so the greeting is captured too.
`AS_UUID` is the CRM `calls.id`, so the recording is `<callId>.wav` and the
inbound TCP connection identifies its own call row — see
[ARCHITECTURE.md § 5](./ARCHITECTURE.md#5-why-callsid-doubles-as-the-audiosocket-uuid).

### `[ai-transfer]` — human handover

```
exten => _1XX,1,Dial(PJSIP/${EXTEN},25,tT)
 same => n,Hangup()
```

Used by both transfer strategies. The `ari-bridge` strategy originates
`Local/<ext>@ai-transfer` (so the 25 s timeout and `tT` flags still apply); the
`ami-redirect` strategy drops the caller's channel here directly. No dialplan
change is needed for either.

### `[click-to-call]` — outbound

```
exten => _X.,1,Set(CDR(userfield)=outbound-c2c)
 same => n,Dial(PJSIP/${EXTEN},45,tT)
 same => n,Hangup()
```

`POST /api/asterisk/originate` rings the operator's extension here first, then
bridges the answered channel to the outbound leg. The destination number is
stripped of a leading `+` because `_X.` matches digits only.

---

## 4. PJSIP endpoints

`asterisk/etc/pjsip.conf.template`. Two transports:

```ini
[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:${ASTERISK_SIP_PORT}
local_net = 10.0.0.0/8
local_net = 172.16.0.0/12
local_net = 192.168.0.0/16
local_net = 127.0.0.0/8

[transport-tcp]
type = transport
protocol = tcp
bind = 0.0.0.0:${ASTERISK_SIP_PORT}
```

`local_net` covers the RFC1918 space because the container sits behind Docker's
NAT; treating those ranges as local stops Asterisk rewriting SDP for LAN
softphones such as MicroSIP.

Extensions **101, 102, 103, 104** are the human operators. Each is three
sections — endpoint, auth, AOR:

```ini
[101]
type = endpoint
context = from-internal
disallow = all
allow = ulaw,alaw,slin,slin16
auth = auth101
aors = 101
callerid = Operator 101 <101>
direct_media = no          ; media must flow through Asterisk for
                           ; MixMonitor AND AudioSocket to work
rtp_symmetric = yes        ; send RTP back where it actually came from,
                           ; not to the address in the SDP - essential
                           ; behind Docker NAT
force_rport = yes          ; same idea for signalling
rewrite_contact = yes      ; trust the source address over the Contact
                           ; header, so a phone reporting a private
                           ; address still gets calls
dtmf_mode = rfc4733
mailboxes = 101@default
device_state_busy_at = 1

[auth101]
type = auth
auth_type = userpass
username = 101
password = ${SIP_EXT_101_PASSWORD}

[101]
type = aor
max_contacts = 2
remove_existing = yes
qualify_frequency = 30
```

PJSIP has no template inheritance across sections, so these options are
**repeated per endpoint** — keep them in sync when editing.

**The AI agent has no PJSIP endpoint.** It is reached through the dialplan
(`Stasis`) and speaks over AudioSocket, not SIP. It appears in the
`sip_extensions` mirror table as `900` / `kind = ai` purely so the dashboard can
show it as a callable destination.

Codecs: `ulaw, alaw, slin, slin16`. G.711 u-law at 8 kHz is exactly what the
OpenAI Realtime session uses (`audio/pcmu`), so the whole bridge runs **without a
single resampling step**.

---

## 5. Adding a SIP trunk

Add to `pjsip.conf.template` (and the entrypoint whitelist if it needs a secret):

```ini
[trunk-provider]
type = registration
transport = transport-udp
outbound_auth = trunk-auth
server_uri = sip:sip.provider.uz
client_uri = sip:<account>@sip.provider.uz
retry_interval = 60

[trunk-auth]
type = auth
auth_type = userpass
username = <account>
password = ${SIP_TRUNK_PASSWORD}

[trunk-provider]
type = aor
contact = sip:sip.provider.uz

[trunk-provider]
type = endpoint
transport = transport-udp
context = from-external          ; <- inbound calls land on the AI agent
disallow = all
allow = ulaw,alaw
outbound_auth = trunk-auth
aors = trunk-provider
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes

[trunk-provider]
type = identify
endpoint = trunk-provider
match = sip.provider.uz          ; so inbound INVITEs are recognised
```

Then `docker compose up -d --force-recreate asterisk` and check
`pjsip show registrations`.

---

## 6. Adding an extension

Adding **105** touches five places. Miss one and the container refuses to boot
(which is the intended failure mode).

1. **`.env`**

   ```env
   SIP_EXT_105_PASSWORD=<24 chars>
   VOICEMAIL_PIN_105=<6 digits>
   ```

2. **`asterisk/scripts/entrypoint.sh`** — add `${SIP_EXT_105_PASSWORD}` and
   `${VOICEMAIL_PIN_105}` to `SUBST_VARS`, and `SIP_EXT_105_PASSWORD`
   `VOICEMAIL_PIN_105` to `REQUIRED_VARS`. Without this, `envsubst` leaves the
   literal `${SIP_EXT_105_PASSWORD}` in `pjsip.conf`.

3. **`asterisk/etc/pjsip.conf.template`** — copy the three `[104]` sections and
   renumber.

4. **`asterisk/etc/voicemail.conf.template`** — add to `[default]`:

   ```ini
   105 => ${VOICEMAIL_PIN_105},Operator 105,,,tz=tashkent|attach=no
   ```

5. **The CRM side**
   - `apps/backend/src/db/seedSipExtensions.ts` — add `105` to `EXTENSIONS`
     (the seed upserts on the unique `extension`, so it is re-runnable), then
     `bun run db:seed:sip`. Or just call
     `POST /api/asterisk/extensions/sync`, which reconciles the mirror from AMI.
   - `.env` → `AI_TRANSFER_EXTENSIONS=101,102,103,104,105` if the AI should be
     able to transfer there.
   - Link it to an operator: `operatorProfiles.extension` and/or
     `sip_extensions.operatorProfileId`.

`_1XX` in `[from-internal]` and `[ai-transfer]` already matches any 1xx, so the
dialplan needs no change for 105–199.

Apply:

```bash
docker compose build asterisk        # extensions.conf/voicemail template are baked/copied
docker compose up -d --force-recreate asterisk
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoints"
```

---

## 7. ARI usage

`ari.conf`:

```ini
[general]
enabled = yes
pretty = yes                 ; costs a little bandwidth, makes curl/tcpdump
                             ; debugging of a live call far easier
allowed_origins =            ; the dashboard never talks to ARI from the
                             ; browser, only through the backend
[${ASTERISK_ARI_USERNAME}]
type = user
read_only = no
password = ${ASTERISK_ARI_PASSWORD}
password_format = plain
```

ARI rides on the embedded HTTP server (`http.conf`, `bindaddr 0.0.0.0:8088`,
`enablestatic = no`, `server_name = callcenter-pbx` — the default leaks the
Asterisk version).

The backend uses two channels:

- **REST** `http://<host>:8088/ari/...` with HTTP Basic auth, via
  `lib/asterisk/ari-client.ts` (plain `fetch`, no client library).
  Verbs used: `answer`, `setChannelVar`, `continueInDialplan`, `play`,
  `startMoh`/`stopMoh`, `originate`, `createBridge`, `addChannelToBridge`,
  `removeChannelFromBridge`, `destroyBridge`, `hangup`, `getChannel`,
  `listChannels`, `asterisk/info`.
  Two deliberate behaviours: `getVariable` returns `null` for an unset variable
  (Asterisk answers 404 for both "no such channel" and "no such variable", told
  apart by the message), and every teardown verb treats **404 as success**
  because a call that has already gone is the normal outcome of a race.

- **Events** `ws://<host>:8088/ari/events?app=callcenter-ai&api_key=user:pass`,
  via `lib/asterisk/ari-events.ts` using Bun's global `WebSocket` (no `ws`
  package). This socket is the heartbeat of the voice layer — if it is down, no
  inbound call is ever noticed — so it reconnects **forever** with exponential
  backoff plus full jitter (500 ms doubling to a 30 s cap, floored at 100 ms so a
  refused port cannot become a hot loop). Subscribed events: `StasisStart`,
  `StasisEnd`, `ChannelDestroyed`, `PlaybackFinished`, `ChannelLeftBridge`.

Manual probing:

```bash
# from the host (8088 is loopback-published)
curl -u "$ASTERISK_ARI_USERNAME:$ASTERISK_ARI_PASSWORD" \
  http://localhost:8088/ari/asterisk/info | head -30
curl -u "$ASTERISK_ARI_USERNAME:$ASTERISK_ARI_PASSWORD" \
  http://localhost:8088/ari/channels
```

Or through the backend: `GET /api/asterisk/status` reports ARI reachability,
version, uptime, AMI banner, event-stream state, channel counts and active AI
calls in one response.

---

## 8. AMI usage

`manager.conf`:

```ini
[general]
enabled = yes
webenabled = yes
bindaddr = 0.0.0.0
port = 5038
displayconnects = no
timestampevents = yes
channelvars =                ; drop the noisiest event classes
[${ASTERISK_AMI_USERNAME}]
secret = ${ASTERISK_AMI_PASSWORD}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.0.0.0
permit = 10.0.0.0/255.0.0.0
permit = 172.16.0.0/255.240.0.0
permit = 192.168.0.0/255.255.0.0
read  = system,call,agent,user,dtmf,reporting,cdr,dialplan
write = system,call,agent,user,command,originate,reporting
```

ARI covers call control, so AMI is used only for what ARI does not expose
cleanly:

- **PJSIP endpoint / contact state** (`PJSIPShowEndpoints`,
  `PJSIPShowEndpoint`) behind `GET /api/asterisk/extensions` and
  `POST /api/asterisk/extensions/sync`.
- **`Redirect`** — the one primitive that can pull a channel out of
  `AudioSocket()` and drop it at `ai-transfer,<ext>,1`. ARI answers **409** for
  a channel executing a dialplan application.

Banner check:

```bash
docker exec callcenter-asterisk sh -c 'echo | nc 127.0.0.1 5038' | head -1
# Asterisk Call Manager/9.0.0
```

---

## 9. Modules

`modules.conf` uses `autoload = yes` plus explicit `load =>` lines for the
modules the platform cannot function without, so a missing module produces a
loud startup error instead of a mysterious first-call failure.

Deliberately **not** loaded:

| `noload` | Why |
|----------|-----|
| `chan_sip.so` | The deprecated SIP stack. Autoload pulls it in, where it binds its own SIP port and logs a deprecation banner every start. This platform is `chan_pjsip` only — and it is one less listener to attack. |
| `chan_dahdi.so`, `codec_dahdi.so` | No telephony hardware; only produces errors. |
| `res_hep*.so` | No HEP/Homer capture deployed. |
| `chan_mgcp.so`, `chan_skinny.so` | Unused legacy channel drivers. |
| `app_macro.so`, `app_getcpeid.so` | The dialplan uses `GoSub`, never `Macro()`. Removing the last deprecation warning means a genuine warning stands out. |

`res_adsi` is **deliberately not** noloaded: `app_voicemail` links against it and
declines to load without it.

---

## 10. Logging

`logger.conf` sends everything of interest to stdout so `docker logs` and the
json-file driver own rotation, while still writing files because
`asterisk -rx` debugging and fail2ban need them.

| Target | Levels | Use |
|--------|--------|-----|
| `console` | notice, warning, error, verbose | `docker compose logs -f asterisk` |
| `messages` | notice, warning, error | operational log without per-frame noise |
| `full` | + verbose, dtmf | the file to read when a call behaved strangely — the only place DTMF and verbose land together |
| `security` | security | failed registrations and auth attempts; **fail2ban tails this** |

Buffering is kept low (`logger_queue_limit = 1000`) because the last few lines
before a container is killed matter more than the syscall overhead.

In production the log directory is a **bind mount**
(`${ASTERISK_LOG_DIR}:/var/log/asterisk`) replacing the base file's named
volume — fail2ban runs on the host and cannot tail a named volume.

---

## 11. Music on hold and sounds

```ini
[default]
mode = files
directory = /usr/share/asterisk/moh
sort = random
```

Files mode, so no extra binary is needed in the image. Sounds come from
`asterisk-core-sounds-en-wav` and `asterisk-moh-opsound-wav`, installed in their
own Dockerfile layer so a package rename fails visibly there rather than taking
down the whole install.

Prompts the platform depends on: `demo-echotest`, `demo-echodone`,
`hello-world`, `ss-noservice`, `one-moment-please`, `vm-goodbye`,
`technical-difficulties`, and the `vm-*` voicemail set. `asterisk/sounds/` exists
for custom Uzbek prompts and is currently empty.

---

## 12. Metrics

`prometheus.conf` enables `res_prometheus` at `http://<host>:8088/metrics`
(without the file the module registers the route but answers 503). No
`auth_username`/`auth_password` is set: 8088 is loopback-only in development and
container-network-only in production. The Prometheus scrape job nonetheless
sends basic auth from `ASTERISK_ARI_*`, so if you ever publish 8088, set both
fields here to match.

If `res_prometheus.so` is absent from the distro package, the endpoint 404s and
the `asterisk` scrape target shows as down. That is why `monitoring/alerts.yml`
raises only a **warning** off `up{job="asterisk"}` and keys the page-worthy
`AsteriskDown` alert off the backend's own ARI/AMI connectivity gauges instead.

---

## 13. Useful CLI

```bash
docker exec -it callcenter-asterisk asterisk -rvvv       # interactive console

# SIP
pjsip show endpoints
pjsip show endpoint 101
pjsip show aors
pjsip show contacts
pjsip show registrations
pjsip set logger on            # full SIP trace to the console

# Dialplan
dialplan show from-internal
dialplan show ai-bridge
dialplan reload

# Channels and media
core show channels verbose
core show channel <channel>
rtp set debug on
mixmonitor list

# ARI / Stasis
ari show apps
ari show app callcenter-ai
stasis show apps

# Modules
module show like audiosocket
module show like ari

core reload                    # re-read config without dropping calls
```
