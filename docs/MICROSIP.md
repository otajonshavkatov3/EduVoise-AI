# MicroSIP against this Asterisk

MicroSIP is the softphone used to test this platform from Windows. It is also
the reason SIP is on **5070** and RTP starts at **12000**: MicroSIP holds
5060/udp+tcp and 10010–10012/udp on this host, and it grabs them at launch.

Everything below assumes the Asterisk container is up:

```powershell
docker compose ps asterisk
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoints"
```

---

## 0. Which username: multi-tenant note

The platform is multi-tenant, and a SIP REGISTER carries no tenant field - so the
credential a phone authenticates with is the **endpoint name**, `<slug>-<ext>`, not
the bare digits. A new customer's operator therefore logs in as `beta-cc-101` with
the password the vendor console shows them, and still **dials** 101 to reach their
own colleague.

The exception is the customer this deployment ran as before tenancy
(`ASTERISK_LEGACY_TENANT_SLUG`, `avilab` here): they keep bare-digit **alias**
endpoints, so the account described below - username `101`, password
`SIP_EXT_101_PASSWORD` - still registers exactly as it always did, and the tenant's
dialplan reaches it because `avilab-101` lists both aors. Only one tenant can have
those aliases; the config generator refuses a second.

---

## 1. Account settings

MicroSIP → **Menu → Add account** (or **Edit account**):

| Field | Value | Notes |
|-------|-------|-------|
| Account name | `CallCenter 101` | Local label only. |
| SIP server | `127.0.0.1:5070` | **The port is mandatory.** Without it MicroSIP dials 5060, which is MicroSIP itself. |
| SIP proxy | *(empty)* | Asterisk is the registrar; no proxy in the path. |
| Username | `101` | Must equal the PJSIP `auth` username. On the legacy tenant that is still `101`; every other customer uses `<slug>-<ext>`, e.g. `beta-cc-101`. |
| Domain | `127.0.0.1` | |
| Login | `101` | Same as username. |
| Password | value of `SIP_EXT_101_PASSWORD` in `.env` | Not the voicemail PIN. |
| Display name | `Operator 101` | Shows as caller ID on internal calls. |
| Dialing prefix | *(empty)* | |
| Voicemail number | `700` | Enables the voicemail button. |
| Transport | `UDP` | `TCP` also works — `[transport-tcp]` binds the same 5070. TLS is not configured. |
| Public address | `Auto` / *(default)* | Do **not** set STUN: `icesupport = no` and `stunaddr =` in `rtp.conf`, and both endpoints are on the same host. |
| Media encryption | **Disabled** | No DTLS/SRTP is configured on Asterisk. |
| Allow rewrite | leave default | Asterisk already has `rewrite_contact = yes` / `force_rport = yes`. |

Save. The status line should read **Online** within a second or two.

If your `.env` password contains characters MicroSIP mangles, generate a
24-character alphanumeric one (that is what `deploy.sh` does deliberately: no
`/ + =`).

### Codecs

MicroSIP → **Settings → Codecs**. Enable **PCMU (G.711 u-law)** and optionally
**PCMA**, and move PCMU to the top. Disable everything else (`opus`, `G.722`,
`speex`, `iLBC`, `GSM`): `pjsip.conf` allows only `ulaw, alaw, slin, slin16`, so
offering others just lengthens negotiation. PCMU is also the exact format the
OpenAI Realtime session uses, so keeping it first means zero transcoding on the
AI path.

---

## 2. Confirm the registration from the Asterisk side

```powershell
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoint 101"
# and the tenant-named endpoint the dialplan actually dials:
docker exec callcenter-asterisk asterisk -rx "pjsip show endpoint avilab-101"
docker exec callcenter-asterisk asterisk -rx "pjsip show contacts"
```

Look for `Endpoint: 101 ... Not in use` (state `Unavailable` means no contact is
registered) and a `Contact: 101/sip:101@<ip>:<port>` line with status `Avail`.

Watch it live while MicroSIP registers:

```powershell
docker exec callcenter-asterisk asterisk -rx "pjsip set logger on"
docker compose logs -f asterisk
```

Registration failures land in `/var/log/asterisk/security` as
`InvalidPassword` / `InvalidAccountID` — which is also what fail2ban reads.

---

## 3. Prove RTP audio with the test extensions

Run these in order. They isolate the media path from the backend and the AI
entirely: if 600 works, SIP signalling, RTP port mapping and codec negotiation
are all correct, and any remaining problem is above the telephony layer.

### 601 — one-way audio (Asterisk → you)

Dial **601**. Expect a one-second pause, then "hello world".

- **Nothing at all** → RTP from the container is not reaching you. Check that
  the published RTP range is `12000-12049:12000-12049/udp` with **identical**
  host and container ports, and that no host firewall rule blocks it.
- **Fast busy / immediate hangup** → the endpoint's `context` is not
  `from-internal-avilab`, or the dialplan did not load
  (`dialplan show from-internal-avilab`).

### 600 — two-way audio (echo)

Dial **600**. Expect "echo test", then everything you say back in your ear, then
"echo done" when you hang up.

- **You hear the prompts but no echo** → classic **one-way audio**: your audio
  is not reaching Asterisk. Check the microphone in MicroSIP →
  **Settings → Audio**, then see
  [TROUBLESHOOTING.md § one-way audio](./TROUBLESHOOTING.md#1-one-way-audio).
- **Choppy or robotic echo** → packet loss or a codec mismatch. Force PCMU only
  and retry.

### 602 — sustained media (music on hold)

Dial **602**. Expect up to 30 seconds of hold music.

- **Silence** → the MoH files are missing. Verify:

  ```powershell
  docker exec callcenter-asterisk ls /usr/share/asterisk/moh | head
  docker exec callcenter-asterisk asterisk -rx "moh show classes"
  ```

602 is the best test for *sustained* streaming — a jitter or RTP-timeout problem
that a two-second prompt hides shows up here (`rtptimeout = 60` tears down a
call whose media dies).

### 700 — voicemail

Dial **700**, enter the `VOICEMAIL_PIN_1xx` for your extension. Proves
`app_voicemail` loaded (it needs `res_adsi`, which is deliberately not
noloaded) and that DTMF works — MicroSIP sends RFC 4733 and `pjsip.conf` sets
`dtmf_mode = rfc4733`.

### 101 ↔ 102 — a real call between two endpoints

Register a second MicroSIP instance (or a second device on the LAN, pointing at
this host's LAN IP instead of `127.0.0.1`) as **102**, then dial `102` from
`101`. Do not answer: after 30 seconds you should be sent to voicemail
(`dialstatus-NOANSWER`). Answering proves bridged two-way media between two
endpoints, which is what a transferred AI call ends up as.

---

## 4. 900 — the AI agent

Dial **900**.

**With no OpenAI Realtime entitlement on the key** (the current state of this
project) the expected sequence is:

1. The channel enters Stasis; the backend answers it.
2. You hear **"one moment please"**.
3. The fallback IVR raises `transfer_to_human` after ~1.5 s.
4. An operator extension rings; when it answers you are bridged.

That is the fallback working correctly, not a failure. The CRM still gets a
`calls` row, an `ai_sessions` row with `status = failed` and an error message, a
`call_transcripts` system line explaining why the AI is not handling the call,
and a `call_transfers` row.

**With a working Realtime entitlement** you instead hear the agent's greeting and
can talk to it. Check which path you are on before debugging:

```
GET /api/ai-assistant/status
  -> { provider: "openai-realtime" | "fallback-ivr", available, detail, ... }
```

See [AI_PROVIDER.md](./AI_PROVIDER.md).

**Nothing happens at all when you dial 900** — the channel is in Stasis but no
backend is listening. The call orchestrator has to be running:

```
GET /api/asterisk/status   -> eventStream.running, aiCalls.orchestratorRunning
```

If `running` is false, the backend is not subscribed to ARI. Check the backend
log for `call orchestrator started` and for ARI 401s.

---

## 5. Recording a test call

Only calls that reach `[ai-bridge]` are recorded — that is where MixMonitor
runs. 600/601/602 are **not** recorded by design.

After a 900 call:

```powershell
docker exec callcenter-asterisk ls -la /var/spool/asterisk/recordings
Get-ChildItem .\apps\backend\uploads\call-recordings
```

Both should show `<callId>.wav`, the same file through the bind mount. The
`callId` is the `calls.id` of that call, and also the `call_recordings.fileName`.
Play it back through the API:

```
GET /api/uploads/call-recordings/<callId>.wav
```

If the directory is empty, the bind mount is not writable by the container's
`asterisk` user — the entrypoint logs a warning about exactly this at startup.

---

## 6. Multiple softphones on one Windows host

MicroSIP binds a fixed local SIP port and its own RTP range, so a second copy on
the same machine conflicts. Options:

- Run the second endpoint on a **phone or another PC** on the LAN, pointing at
  this host's LAN address (e.g. `192.168.1.50:5070`) instead of `127.0.0.1`. The
  `local_net` entries in `pjsip.conf` already cover 192.168/16, and Windows
  Firewall must allow inbound 5070 and 12000–12049.
- Use a portable MicroSIP copy configured with a different local SIP port
  (**Settings → Network → SIP port**) and a non-overlapping RTP range.
- Use a different softphone (Zoiper, Linphone) for the second leg.

---

## 7. Quick reference

| Dial | Purpose | Proves |
|------|---------|--------|
| `601` | Playback | One-way RTP + codec negotiation |
| `600` | Echo | **Two-way** RTP |
| `602` | Music on hold | Sustained media, MoH files |
| `700` | Voicemail main | DTMF, `app_voicemail`, PINs |
| `1XX` | Another operator | Endpoint-to-endpoint bridging, `DIALSTATUS` branches |
| `900` | AI agent | Stasis → ARI → backend → AudioSocket → provider |
