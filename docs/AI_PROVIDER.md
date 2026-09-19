# The AI voice provider

Three things are documented here: the **abstraction** that lets the platform
swap voice engines (and survive not having one), the **three providers** that
implement it today, and the **entitlement problem** that OpenAI keys hit —
including exactly how to fix it and how to verify.

**The provider running right now is `gemini-live`** (`AI_VOICE_PROVIDER=gemini`
in `.env`). Everything in sections 3 to 6 about the OpenAI wire shape still
applies to the OpenAI provider, which is one `.env` line away.

---

## 1. The `VoiceProvider` contract

Defined in `apps/backend/src/lib/telephony/contracts.ts`. It is the only thing
the orchestrator knows about a speech engine.

A provider receives a `VoiceSessionContext` (call id, contact, language, greeting
text, tool definitions, …) and a set of `VoiceProviderHandlers` that it calls
back into. It exposes:

| Member | Contract |
|--------|----------|
| `name` | Stable identifier stored in `ai_sessions.provider` (`"openai-realtime"`, `"gemini-live"`, `"fallback-ivr"`). |
| `start(context, handlers)` | Establish the session. **Must throw `VoiceProviderUnavailableError`, fast and without retrying, when this account cannot use the engine at all.** |
| `sendAudio(chunk)` | Caller audio in, as slin 8 kHz PCM16 LE. |
| `say(text)` | Speak a specific line (used for the greeting and goodbye). |
| `stop(reason)` | Tear down. Must be idempotent. |
| `model` | Optional. The model id this provider really used, persisted to `ai_sessions.model` so a Gemini call is not labelled with an OpenAI model. |
| `stats()` | `VoiceProviderStats`: interruptions, input/output audio ms, prompt/completion tokens. Persisted onto `ai_sessions`. |

Handlers the provider calls:

| Handler | Meaning |
|---------|---------|
| `onAudio(chunk)` | Agent audio out, slin 8 kHz — goes straight to AudioSocket. |
| `onTranscript(role, text, {isFinal, startMs, endMs, confidence})` | A `call_transcripts` row (`caller` \| `agent` \| `system`). |
| `onToolCall(name, args)` | One of the seven tools. Arguments are zod-validated before any DB write. |
| `onInterrupted()` | The caller talked over the agent; increments the counter and drops queued audio. |
| `onUsage(usage)` | Token counts for one turn: prompt, completion, cached, input/output audio and text. Accumulated onto the session and priced by the AI-costs page. |
| `onTranscriptionUsage(usage)` | Optional. Separately billed input transcription (OpenAI path only — Gemini transcribes inside the session). |
| `onError(error)` | Non-fatal problem. |
| `onClosed(reason)` | The session ended. |

Because the interface is this small, the orchestrator has **no branch** for which
provider is running. Adding a provider means writing one file and one line in
`provider-factory.ts`.

---

## 2. Selection and health

`lib/ai/provider-factory.ts`:

```
AI_AGENT_ENABLED is not truthy                        ->  fallback IVR
AI_VOICE_PROVIDER=gemini AND GOOGLE_AI_API_KEY is set ->  Gemini Live
AI_VOICE_PROVIDER=gemini AND no Google key            ->  fallback IVR
OPENAI_API_KEY is set                                 ->  OpenAI Realtime
anything else                                         ->  fallback IVR
```

The Gemini branch is checked **before** the OpenAI key, because a business that
switched provider has no reason to keep an OpenAI key around and the absence of
one must not push a working Gemini deployment onto the IVR.

`selectedVoiceProviderName()` answers the same question without building a
provider or touching the network. The health probe and the config endpoint both
use it, which is what stops them from describing a different provider than the
one on the phone.

Note what `resolveVoiceProvider()` deliberately does **not** do: it does not
probe OpenAI before returning the provider. A probe costs a WebSocket round trip
to `api.openai.com`, and it would run while a caller is listening to ringback.
Instead the provider itself fails fast in `start()` and the orchestrator falls
back — the caller is still on the line, so total added latency is one failed
handshake instead of two.

Pass `{ probe: true }` when the extra latency is acceptable (a warm-up on boot,
a health page) and the answer must be known before a call arrives.

`probeProviderHealth()` is the deliberate, cached probe behind
`GET /api/ai-assistant/status`. It answers the operationally useful question —
not "is a key configured" but **"can this account open a session right now"**.
Results are cached for 30 s and in-flight probes are de-duplicated, so ten
concurrent dashboard polls make one connection.

**It probes the selected provider, not always OpenAI.** That was a real bug: the
probe talked to OpenAI whatever `AI_VOICE_PROVIDER` said, so this deployment's
status card named `openai-realtime` and reported `available: true` measured
against an API that was not answering a single call, while every `ai_sessions`
row said `gemini-live`.

| Selected provider | What the probe does |
|---|---|
| `openai-realtime` | Opens a real Realtime WebSocket, then explains a failure with `GET /v1/models/<model>`. |
| `gemini-live` | `GET /v1beta/models/<model>` with the Google key. Deliberately **not** a WebSocket handshake: opening a `BidiGenerateContent` session just to close it starts a billable session and tells you little more. The detail string says plainly that no live session was opened. |
| `fallback-ivr` | Returns immediately with the reason (agent switched off, or the selected provider's key is missing). |

### Gemini Live

`lib/ai/gemini-live.ts`. Selected with `AI_VOICE_PROVIDER=gemini` and a
`GOOGLE_AI_API_KEY` (or `GEMINI_API_KEY`).

**Why it exists: Uzbek.** Measured on this account against real caller audio, the
Live model answers in fluent, idiomatic Uzbek with the spoken forms people
actually use, and its prosody comes from the model rather than from a
text-to-speech pass bolted on afterwards.

The two facts that shaped the implementation, both established against the live
API:

1. **It accepts 8 kHz input.** Asterisk's own frames go straight up with no
   resampling. 16 kHz is the documented rate; 8 kHz simply works, and avoiding a
   resampler removes latency and a class of bug.
2. **It returns 24 kHz PCM**, which `downsample24kTo8k` already handles — the
   same filter the OpenAI leg uses, so both providers sound alike on the wire.

Time to first audio, measured across eight voices: 734–879 ms.

| Setting | Default | Notes |
|---|---|---|
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | The **live** model, not the native-audio one: on the same Uzbek turn this answered in 831 ms while `gemini-2.5-flash-native-audio-latest` took 5173 ms *and* leaked its own reasoning into the spoken reply. |
| `GEMINI_LIVE_VOICE` | `Callirrhoe` | Must be one of Gemini's own voices (below). |

**The voice names are not OpenAI's.** Gemini accepts `Aoede`, `Autonoe`,
`Callirrhoe`, `Charon`, `Despina`, `Enceladus`, `Erinome`, `Fenrir`, `Kore`,
`Laomedeia`, `Leda`, `Orus`, `Puck`, `Umbriel`, `Zephyr` — all fifteen were
checked for Uzbek. Sending an OpenAI name kills the session with
`1007 No matching speaker voice found for name: cedar`, and a dead session is a
dropped call, so an unrecognised name falls back to the default and logs a
warning instead.

Because the two vendors' voice lists are disjoint, everything that touches a
voice is provider-aware:

- `GET /ai-assistant/config` returns `provider`, the active provider's `model`,
  and a `knownVoices` list for **that** provider, so the dashboard dropdown
  cannot offer a voice the running engine would reject.
- `PATCH /ai-assistant/config { voice }` stores the voice where the call actually
  reads it: the active `ai_agent_profiles` row when a business profile exists,
  and otherwise the `ai.gemini.voice` / `ai.openai.voice` setting for the
  selected provider. A name the active provider does not have is refused with a
  400. Both rules exist because of the same defect in two layers: the endpoint
  used to write the OpenAI variable whichever provider was running, and then the
  profile's own voice overrode it anyway - the dropdown saved successfully,
  reported `changed: ["voice"]`, and changed nothing about the next call.

This provider is **deliberately simpler** than the OpenAI one. That file carries
a lot of scar tissue — response serialisation, tool holding lines, session
degradation, playback-horizon tracking — and none of it was copied here on spec.
What is here is everything the `VoiceProvider` contract requires plus everything
a live call has been shown to need.

### The fallback IVR

`lib/ai/fallback-ivr.ts` exists so that a missing entitlement is a degraded
service, not dead air. Two rules define it:

1. It never calls a paid API — no key, no quota, no network at all.
2. It never leaves the caller stranded. About 1.5 s after the session opens it
   raises a `transfer_to_human` tool call. That is the *same* code path the AI
   would use, so the orchestrator needs no special case: it rings an operator,
   writes a `call_transfers` row and bridges the call.

It also writes transcript rows — one `system` row explaining why the AI is not
handling this call, and one `agent` row per `say()` — so the dashboard shows what
the caller was actually told instead of an empty conversation. The caller hears
Asterisk's own prompts (`one-moment-please`, `vm-goodbye`,
`technical-difficulties`), played by the orchestrator over ARI.

On the fallback path the channel is deliberately **kept in Stasis**: ARI can only
play prompts, start MoH and build bridges for a channel it owns, and the fallback
needs all three. The realtime path is the opposite — it hands the channel to
`[ai-bridge]` so MixMonitor and AudioSocket can run.

---

## 3. The GA vs. beta wire-shape issue (OpenAI provider)

Everything in this section is about `lib/ai/openai-realtime.ts` only. It is the
single most important fact about that provider, and all of it was verified
against the live endpoint.

### The beta shape is dead

Sending the header `OpenAI-Beta: realtime=v1` — which every pre-GA tutorial,
blog post and older SDK does — makes the server reject the connection with error
code **`beta_api_shape_disabled`** and close it. There is no fallback, no
warning period, and the error arrives before any session event.

**Send only `Authorization: Bearer <key>` and nothing else.**

```ts
// lib/ai/openai-realtime.ts
const socket = new WebSocket(`${baseUrl}?model=${encodeURIComponent(model)}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
```

### The GA `session.update` shape

Nested under `session.audio.input` / `session.audio.output`, not flat on
`session`:

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "output_modalities": ["audio"],
    "instructions": "…system prompt…",
    "audio": {
      "input": {
        "format": { "type": "audio/pcmu" },
        "turn_detection": {
          "type": "server_vad",
          "threshold": 0.5,
          "silence_duration_ms": 500
        },
        "transcription": { "model": "whisper-1" }
      },
      "output": {
        "format": { "type": "audio/pcmu" },
        "voice": "alloy"
      }
    },
    "tools": [ … ],
    "tool_choice": "auto"
  }
}
```

Differences from the beta shape that will silently or loudly break you:

| Beta | GA |
|------|-----|
| `session.modalities: ["audio","text"]` | `session.output_modalities: ["audio"]` |
| `session.input_audio_format: "g711_ulaw"` (a string) | `session.audio.input.format: { "type": "audio/pcmu" }` (an object) |
| `session.output_audio_format: "g711_ulaw"` | `session.audio.output.format: { "type": "audio/pcmu" }` |
| `session.voice: "alloy"` | `session.audio.output.voice: "alloy"` |
| `session.turn_detection` | `session.audio.input.turn_detection` |
| `session.input_audio_transcription` | `session.audio.input.transcription` |
| `response.audio.delta` events | `response.output_audio.delta` |
| no `session.type` | `session.type: "realtime"` is required |

### Why `audio/pcmu`

G.711 u-law at 8 kHz is **exactly** Asterisk's telephony rate, so the whole
bridge runs without a single resampling step:

```
AudioSocket 0x10 payload (slin 8 kHz PCM16 LE)
  -> muLawEncode()  -> input_audio_buffer.append (audio/pcmu)
response.output_audio.delta (audio/pcmu)
  -> muLawDecode()  -> AudioSocket 0x10 payload (slin 8 kHz)
```

`codec.ts` also ships 8 kHz ↔ 24 kHz resamplers (a 24-tap FIR with documented
group delay) for a future provider that insists on 24 kHz PCM. They are unit
tested and currently unused on the OpenAI path — resampling would only add
latency and quantisation noise for no benefit.

### Session readiness

After `session.created` the provider sends `session.update` and waits for
`session.updated`, but only for **1.5 s** (`DEFAULT_READY_GRACE_MS`). The echo
does arrive in practice, but a caller is on the line: a missing echo must not
hold the greeting back.

### Reconnection policy

| Situation | Behaviour |
|-----------|-----------|
| `start()` fails with a terminal code | `VoiceProviderUnavailableError` immediately. **No retry.** |
| A working session drops mid-call | Up to 3 reconnects, 400 ms backoff doubling to a 4 s cap. Caller audio is buffered meanwhile, capped at 16 000 u-law bytes (2 s) so a long outage cannot grow memory. |

Terminal codes — never retried, because retrying an entitlement problem just
burns the caller's patience:

```
model_not_found   invalid_model   insufficient_quota
beta_api_shape_disabled   invalid_api_key
```

---

## 4. The current state of this project's key

Re-verified by live probe:

| Capability | Result |
|------------|--------|
| Realtime: `gpt-realtime` | **works** — `GET /v1/models/gpt-realtime` returns 200 and `probeOpenAiRealtime()` negotiates a session |
| Transcription: `gpt-4o-transcribe` | **works** (200) |
| Text chat: `gpt-4o-mini` | **works** — post-call analysis |

**The entitlement problem this document used to describe is resolved.** Earlier
every realtime model answered `model_not_found` and standalone STT/TTS returned
403; that is no longer true, and the OpenAI provider is a working option again.
Section 5 is kept as the recipe for a key that *does* still lack access, because
`model_not_found` on a model you can see in the docs is almost always a
project-level model-permission setting rather than a missing subscription.

Note that this says nothing about which provider serves calls. That is
`AI_VOICE_PROVIDER`, and it currently selects Gemini Live — for the Uzbek
quality reasons in section 2, not because OpenAI is unavailable.

---

## 5. If a key cannot use the realtime models

Realtime access is controlled per **project**, and a project-scoped API key
(`sk-proj-…`) can only use models that project allows. Do this in the OpenAI
dashboard for the project the key belongs to.

### Step 1 — identify the project the key belongs to

```bash
# The key's own project, straight from the API:
curl -s https://api.openai.com/v1/models   -H "Authorization: Bearer $OPENAI_API_KEY" | head -40
```

If this returns 401, the key is wrong or revoked. If it returns a model list that
contains no `*realtime*` entries, the project's model permissions are the
problem — continue.

In the dashboard: **Settings → API keys**, find the key, note the project shown
next to it. Then switch the project selector (top-left) to that project.

### Step 2 — enable the realtime models for that project

**Settings → Project → Limits** (in some tenants: **Project → Model
permissions**). There is a per-model allow list. Enable:

- `gpt-realtime` (the current GA realtime model — what
  `OPENAI_REALTIME_MODEL` defaults to)
- `gpt-realtime-mini` (cheaper; a useful fallback)
- `gpt-4o-mini` — keep it enabled, post-call analysis needs it **on both
  providers**: analysis is a text chat completion and runs after a Gemini call too
- `gpt-4o-transcribe` — the Realtime session's own
  `audio.input.transcription`, billed inside the session

Save. Changes apply to new connections within a minute or two; there is nothing
to redeploy.

### Step 3 — check the account-level blockers

If enabling the model does not change the result, work through these in order:

1. **Organisation verification.** Some realtime and audio models require a
   verified organisation: **Settings → Organization → General**. Until
   verification completes, the models are hidden from every project.
2. **Billing.** A project with a $0 hard limit, an expired card or an unpaid
   invoice returns `insufficient_quota`, not `model_not_found` — but a brand-new
   organisation with no successful payment yet can be gated out of audio models
   entirely. **Settings → Billing** must show a positive balance or an active
   payment method.
3. **Key scope.** A **restricted** key can be limited to specific endpoints.
   Realtime needs the model/inference scope; a key restricted to, say,
   `/v1/files` will fail regardless of project permissions. Either widen the
   key's permissions or mint an unrestricted project key.
4. **Region / tier.** Realtime is not available in every region or on every
   usage tier. If the dashboard does not list realtime models **at all** for the
   organisation, no project-level toggle will produce them; that is a support
   question.

### Step 4 — put the key in `.env` and restart

```env
AI_AGENT_ENABLED=true

# Which engine answers the phone. Remove the line (or set it to anything other
# than "gemini") to use OpenAI.
AI_VOICE_PROVIDER=gemini

# OpenAI Realtime
OPENAI_API_KEY=sk-proj-...
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_VOICE=alloy

# Gemini Live
GOOGLE_AI_API_KEY=...
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_LIVE_VOICE=Callirrhoe

# Post-call analysis: OpenAI text chat, used whichever voice provider ran.
OPENAI_ANALYSIS_MODEL=gpt-4o-mini
```

Restart the backend (or wait out the 30 s health cache) so the provider factory
re-probes.

---

## 6. Verifying afterwards

Work upward: cheapest check first, real call last. 6.1 and 6.2 are OpenAI-only;
6.3 onwards apply to whichever provider is selected.

The fastest whole-stack answer is the verification runner, which now checks the
**selected** provider rather than always checking OpenAI:

```bash
bun --env-file=.env run tests/e2e/run-verification.ts
```

### 6.1 Is the model visible to the key? (OpenAI)

```bash
curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  | grep -o '"id": *"[^"]*realtime[^"]*"'
```

Expect at least `"id": "gpt-realtime"`. Nothing back ⇒ project permissions are
still not enabled; return to step 2. `403` on the whole call ⇒ the key is
restricted (step 3.3).

### 6.2 Does the Realtime handshake succeed? (OpenAI)

This is what `probeOpenAiRealtime()` does internally: open the socket with only
the `Authorization` header and wait for the first server event.

```bash
bun -e '
const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const ws = new WebSocket(
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
  { headers: { Authorization: `Bearer ${key}` } }   // NO OpenAI-Beta header
);
const t = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 8000);
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  console.log(ev.type, ev.error?.code ?? "");
  clearTimeout(t);
  ws.close();
  process.exit(ev.type === "error" ? 1 : 0);
};
ws.onerror = () => { console.log("SOCKET ERROR"); process.exit(1); };
ws.onclose = (e) => { console.log("closed", e.code, e.reason); };
'
```

| Output | Meaning |
|--------|---------|
| `session.created` | Entitlement works. Proceed. |
| `error model_not_found` | Project still cannot use this model. |
| `error invalid_api_key` | Wrong/revoked key. |
| `error insufficient_quota` | Billing. |
| `error beta_api_shape_disabled` | You added an `OpenAI-Beta` header. Remove it. |
| `SOCKET ERROR` / `closed 1006` | Network or proxy blocking `wss://api.openai.com`. Check egress from the host, and from the container in production. |

### 6.3 Does the platform agree?

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  http://localhost:4000/api/ai-assistant/status
```

`provider` must name the engine `AI_VOICE_PROVIDER` selected. On this
deployment:

```json
{ "success": true, "data": {
  "provider": "gemini-live",
  "available": true,
  "detail": "model gemini-3.1-flash-live-preview is visible to this Google AI key (no live session was opened - the handshake happens on the first call)",
  "enabled": true,
  "model": "gemini-3.1-flash-live-preview",
  "orchestrator": { "running": true, "activeCalls": 0 }
} }
```

On the OpenAI path the same call reports `"provider": "openai-realtime"`,
`"model": "gpt-realtime"` and a detail naming the negotiated session.

If `provider` here disagrees with `ai_sessions.provider` on recent calls, the
status endpoint is describing an engine that is not answering the phone — that
was a real bug and it is what the shared `selectedVoiceProviderName()` prevents.

`available: false` with a `model_not_found` detail while 6.2 succeeded means the
cached health result is stale — wait 30 s or restart the backend.
`orchestrator.running: false` is a *different* problem: the ARI event stream is
not up, so no inbound call would be noticed at all. See
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### 6.4 A real call

1. Dial **900** from MicroSIP.
2. You should hear the agent's greeting (not "one moment please") within roughly
   `AI_AGENT_GREETING_DELAY_MS` of the answer.
3. Say something and confirm the agent responds and that interrupting it stops
   its speech.
4. Then check the CRM:

   ```sql
   SELECT provider, status, model, voice, interruptions,
          input_audio_ms, output_audio_ms, prompt_tokens, completion_tokens,
          error_message
   FROM ai_sessions ORDER BY created_at DESC LIMIT 1;

   SELECT role, is_final, left(content, 80)
   FROM call_transcripts
   WHERE call_id = (SELECT id FROM calls ORDER BY created_at DESC LIMIT 1)
   ORDER BY created_at;
   ```

   Expect `status = "completed"`, `error_message IS NULL`, non-zero audio
   counters, and alternating `caller`/`agent` transcript rows. `provider` and
   `model` must both name the engine that actually ran — `gemini-live` /
   `gemini-3.1-flash-live-preview` on this deployment. A row saying
   `gemini-live` with model `gpt-realtime` is the bug the `VoiceProvider.model`
   member exists to prevent, and it would price the call at the wrong vendor's
   rates on the AI-costs page.

5. Confirm the recording exists as `<callId>.wav` in
   `apps/backend/uploads/call-recordings/` and that a `call_recordings` row
   points at it.
6. Exercise a tool: ask the agent to create a ticket, then check `tickets` and
   `call_notes`.

### 6.5 Confirm the fallback still works

Regression-test the degraded path deliberately — it is what protects the
service:

```
PATCH /api/ai-assistant/config   { "enabled": false }     # supervisor
```

Dial 900. You should get "one moment please" and a transfer. Then set it back to
`true`.

---

## 7. Adding a different provider

1. Create `apps/backend/src/lib/ai/<provider>.ts` implementing `VoiceProvider`.
   Convert audio to and from slin 8 kHz PCM16 LE at the boundary — everything
   above the provider assumes that format.
2. Export a `create<Provider>Provider()` factory and a
   `<PROVIDER>_PROVIDER_NAME` constant, and re-export both from
   `lib/ai/index.ts`.
3. Add the selection branch to `provider-factory.ts`, teach
   `selectedVoiceProviderName()` about it, and add a probe branch in
   `runProbe()` if it can be entitlement-gated. Both must agree: a health page
   that describes a different provider than the one on the phone is worse than
   no health page.
4. Expose `model`, and if the provider has its own voice names, make
   `knownVoices` and the `PATCH /ai-assistant/config` voice write provider-aware
   in `ai-assistant.runtime.ts` — otherwise the dashboard will offer voices the
   engine rejects.
5. Throw `VoiceProviderUnavailableError` from `start()` for anything terminal —
   that single behaviour is what keeps the fallback chain working.
6. `ai_sessions.provider` is a `varchar(50)`, so no migration is needed for a
   new name.
