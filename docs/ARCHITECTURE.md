# Architecture

CallCenter "Aqlli Shahar" is a Bun monorepo. The pre-existing part is a CRM for
a citizens' hotline (users, contacts, calls, tickets, audit log, dashboard). The
part added by the AI voice layer replaces FreePBX with a self-hosted Asterisk 20
and answers inbound calls with a speech-to-speech AI agent that writes CRM rows
while it talks.

The legacy FreePBX webhook path (`/api/webhooks/freepbx/*`) is untouched and
still functional; nothing in the new layer writes through it.

---

## 1. Components

| Component | Where | Runtime | Notes |
|-----------|-------|---------|-------|
| Backend API | `apps/backend` | Bun + Hono + `@hono/zod-openapi` | OpenAPI at `/doc`, Scalar UI at `/reference`. |
| Frontend SPA | `apps/frontend` | React 19 + Vite + Ant Design 6 | Talks to the backend over `/api`. |
| Shared types & env | `shared` | zod v4 | `getServerEnv()` validates the backend environment once at boot. |
| PostgreSQL 17 | container `app-postgres`, or native (`.localdev`) | Drizzle ORM | Single source of truth. |
| Redis 7+ | container `app-redis`, or native | `Bun.RedisClient` | Refresh-token store. Requires RESP3 (`HELLO 3`), so Redis ≥ 6. |
| Asterisk 20.6.0 | container `callcenter-asterisk` | packaged Asterisk on `ubuntu:24.04` | SIP, RTP, dialplan, MixMonitor, ARI, AMI, AudioSocket. |
| OpenAI Realtime | external | `wss://api.openai.com/v1/realtime` | Speech-to-speech. One of two interchangeable engines. |
| Gemini Live | external | `wss://generativelanguage.googleapis.com/…BidiGenerateContent` | Speech-to-speech, **currently selected** (`AI_VOICE_PROVIDER=gemini`). Chosen for Uzbek quality. |

Both satisfy the same `VoiceProvider` contract and are optional: with neither
key, the platform degrades to a fallback IVR that transfers to a human. See
[AI_PROVIDER.md](./AI_PROVIDER.md).

### Backend internals

```
apps/backend/src/lib/
  asterisk/
    ari-client.ts    ARI REST over fetch + Basic auth. Teardown verbs treat
                     404 as success; getVariable() returns null for an unset var.
    ari-events.ts    One WebSocket to /ari/events?app=callcenter-ai. Reconnects
                     forever: 500 ms doubling to a 30 s cap, full jitter.
    ami-client.ts    AMI over node:net. Used only for PJSIP endpoint/contact
                     state and for the Redirect primitive.
  ai/
    audiosocket.ts   TCP server. 3-byte header protocol, 20 ms slin frames,
                     pacing and queue limits.
    codec.ts         G.711 u-law <-> slin16, and 8 kHz <-> 24 kHz resamplers
                     (pure functions, unit-tested).
    prompts.ts       System instructions + greeting, Uzbek-first.
    tools.ts         The seven function-calling tools in GA Realtime shape,
                     each with a zod validator for the model's arguments.
    openai-realtime.ts  The GA-shape OpenAI Realtime provider.
    gemini-live.ts   The Gemini Live provider. Takes Asterisk's 8 kHz directly
                     and returns 24 kHz, downsampled with the shared filter.
    fallback-ivr.ts  No-paid-API provider: explains itself, then asks for a human.
    provider-factory.ts  Which provider serves the next call + a health probe of
                     THAT provider (cached), shared via selectedVoiceProviderName().
  telephony/
    contracts.ts     Types and error classes only. No runtime.
    contact-matcher.ts  Phone canonicalisation and contact lookup/creation,
                     using the same rules as the legacy FreePBX webhook.
    crm-writer.ts    Every DB write an AI call can cause, idempotent where the
                     data model allows it.
    transfer.ts      AI -> human handover (two strategies, see §6).
    call-orchestrator.ts  The state machine. The only module that knows the
                     order in which Asterisk, audio, provider and Postgres
                     must be touched.
  ws/registry.ts     Socket fan-out: per user, per role, and broadcastCallEvent()
                     for the live-call board.
```

The orchestrator is a process-wide singleton reached through
`getCallOrchestrator()`; `start()` binds the AudioSocket listener, subscribes to
ARI events and opens the event WebSocket, and `stop()` finalises every live call
before closing. It exposes `listActiveCalls()`, `getActiveCall(callId)` and
`hangupCall(callId, reason)` to the HTTP layer.

---

## 2. The seven AI tools

The model can only change the CRM through these, and every argument object is
validated with zod before it reaches `crm-writer`:

| Tool | Effect |
|------|--------|
| `save_contact_details` | Upsert first/last name and `address {tuman, kocha, uy}` on the contact. |
| `create_ticket` | New `tickets` row linked to the call and contact. |
| `add_note` | `call_notes` row with `authorType = ai`. |
| `create_follow_up` | `follow_up_tasks` row (`createdBySystem = true`). |
| `book_appointment` | `bookings` row (`createdBySystem = true`). |
| `transfer_to_human` | Hands the caller to an operator, writes `call_transfers`. |
| `end_call` | Says goodbye and hangs up. |

---

## 3. The exact inbound call flow

```
1. Caller -> SIP trunk -> Asterisk, context [from-external]
      (or: a softphone on 101-104 dials 900 in [from-internal])
2. Dialplan: Stasis(callcenter-ai)
3. Asterisk emits StasisStart on the ARI event WebSocket
4. Backend (CallOrchestrator.handleStasisStart):
      canonicalisePhone(callerNumber)
      findOrCreateContact()                    -> contacts row
      createInboundCall()                      -> calls row, id = UUID
      ari.answerChannel()  markCallAnswered()  -> calls.status = answered
      createAiSession()                        -> ai_sessions row
      resolveVoiceProvider()
5a. REALTIME PATH
      ari.setVariable(AS_UUID = calls.id)
      ari.setVariable(AS_HOST = AUDIOSOCKET_ADVERTISE_HOST)
      ari.continueInDialplan(context=ai-bridge, extension=s, priority=1)
6.    [ai-bridge] MixMonitor(${RECORDINGS_DIR}/${AS_UUID}.wav)
                  AudioSocket(${AS_UUID}, ${AS_HOST})
7.    Asterisk opens TCP to the backend on AUDIOSOCKET_PORT
      first packet: type 0x01, 16 raw bytes = calls.id
      -> the AudioSocket session IS the call record
8.    Provider session: wss://api.openai.com/v1/realtime?model=<model>
      caller audio: slin8k -> muLawEncode -> input_audio_buffer.append
      agent audio:  response.output_audio.delta -> muLawDecode -> slin8k
      no resampling anywhere (audio/pcmu is 8 kHz, Asterisk's own rate)
9.    While talking: call_transcripts rows, ai_sessions counters,
      tool calls -> tickets / call_notes / follow_up_tasks / bookings /
      contacts / call_transfers, and live_call_* WebSocket events.
5b. FALLBACK PATH (no realtime entitlement, AI disabled, or start() failed)
      the channel STAYS in Stasis (ARI must own it to play media)
      orchestrator plays sound:one-moment-please over ARI
      fallback provider raises transfer_to_human after ~1.5 s
      -> operator, via the ARI bridge strategy
10. Teardown (any of StasisEnd / ChannelDestroyed / AudioSocket close /
    our own hangup — all four race, all are idempotent):
      markCallEnded()        calls.endedAt, duration, status
      finishAiSession()      ai_sessions.status/endedAt/durationMs/counters
      saveRecording()        call_recordings row for <callId>.wav
      summariseCallWithOpenAi() -> writeAiAnalysis()
                             ai_analyses row + tickets.aiSummary/aiSentiment/
                             aiCategories/aiConfidence
      broadcast live_call_ended / live_call_analysis
```

### ASCII sequence diagram

```
Caller     Asterisk            Backend                     OpenAI        Postgres
  |           |                   |                          |              |
  |--INVITE-->|                   |                          |              |
  |           |--StasisStart(ws)->|                          |              |
  |           |                   |--findOrCreateContact---------------->   |
  |           |                   |<-------------------------------contact  |
  |           |                   |--createInboundCall------------------>   |
  |           |                   |<---------------------------calls.id(U)  |
  |           |<--answer (REST)---|                          |              |
  |<--200 OK--|                   |--markCallAnswered------------------->   |
  |           |                   |--createAiSession-------------------->   |
  |           |<--setVar AS_UUID=U|                          |              |
  |           |<--setVar AS_HOST--|                          |              |
  |           |<--continueInDialplan(ai-bridge,s,1)          |              |
  |           |                   |                          |              |
  |           |--MixMonitor U.wav |                          |              |
  |           |==TCP connect=====>| (AudioSocket :9092)      |              |
  |           |--0x01 UUID=U----->|                          |              |
  |           |                   |====WS connect (Bearer)==>|              |
  |           |                   |<===session.created=======|              |
  |           |                   |----session.update(GA)===>|              |
  |           |                   |<===session.updated=======|              |
  |           |                   |----response.create (greeting)========>  |
  |           |<--0x10 audio------|<==output_audio.delta=====|              |
  |<==RTP=====|                   |                          |              |
  |==RTP=====>|--0x10 audio------>|==input_audio_buffer.append==>           |
  |           |                   |<==input_audio_transcription.completed== |
  |           |                   |--appendTranscript------------------->   |
  |           |                   |<==response.function_call_arguments.done=|
  |           |                   |--createTicket / addNote / booking-->    |
  |           |                   |--ws: live_call_transcript (supervisors)  |
  |           |                   |                          |              |
  |--BYE----->|--StasisEnd------->|                          |              |
  |           |==TCP close=======>|                          |              |
  |           |                   |--markCallEnded--------------------->    |
  |           |                   |--finishAiSession------------------->    |
  |           |                   |--saveRecording--------------------->    |
  |           |                   |----chat.completions (summary)=====>     |
  |           |                   |--writeAiAnalysis------------------->    |
```

---

## 4. Why AudioSocket and not ARI `externalMedia`

Both can move a channel's audio to an external process. They differ in who
dials whom and over which transport, and that difference decides the matter
here.

**`externalMedia` is UDP and inbound-to-the-host.** You give ARI an address and
Asterisk starts sending RTP to it, expecting RTP back on a port it chose. Inside
Docker that means:

- The container must reach a **UDP** listener on the host. On Docker Desktop
  (Windows/WSL2) the container-to-host path goes through a NAT layer plus the
  WSL2 virtual switch; `host.docker.internal` resolves, but UDP has no
  connection state for that NAT to key a return path on.
- The return stream has to arrive at the port Asterisk picked from its RTP
  range, so every concurrent media stream needs its own published UDP port.
  Docker Desktop spawns one userland proxy process per published UDP port,
  which is exactly why `ASTERISK_RTP_END` is only 12049 in this project.
- Symmetric-NAT rewriting (`rtp_symmetric`) helps real SIP endpoints, but the
  external-media socket is not a SIP endpoint, so it does not apply.

**AudioSocket inverts the direction and uses TCP.** The dialplan runs
`AudioSocket(${AS_UUID},${AS_HOST})` and Asterisk **dials out** to the backend:

- Outbound TCP from a container always works — no published port, no NAT
  return-path problem, nothing to configure on Docker Desktop beyond
  `extra_hosts: host.docker.internal:host-gateway`.
- **One** listening port (`AUDIOSOCKET_PORT=9092`) serves every concurrent call.
  Sessions are separated by the UUID in the first packet, not by port number.
- TCP gives framing for free. The protocol is a 3-byte header
  (`type` 1 byte, big-endian `length` 2 bytes) then the payload, so the backend
  never deals with reordering, duplication or loss:

  ```
  0x00 terminate   0x01 UUID (16 raw bytes)   0x02 DTMF (1 ASCII digit)
  0x10 audio (slin: PCM16 LE, 8 kHz, mono, 320 bytes = 20 ms)   0xff error
  ```

- Cost: a few milliseconds of buffering and head-of-line blocking risk. At
  8 kHz mono that is 128 kbit/s over loopback — irrelevant — and the server
  caps its queue at 150 frames (3 s) and paces drains so a stalled peer cannot
  make it burst.

In production, where Asterisk and the backend share a compose network,
`externalMedia` would also work. AudioSocket is kept there too so development
and production run the identical code path; only `AUDIOSOCKET_ADVERTISE_HOST`
changes (`host.docker.internal:9092` -> `backend:9092`).

---

## 5. Why `calls.id` doubles as the AudioSocket UUID

AudioSocket's only correlation handle is the 16-byte UUID the dialplan passes in
`AS_UUID`, sent as the connection's first packet. The orchestrator sets that
variable to the freshly-inserted `calls.id`, which makes the incoming TCP
connection **self-identifying**:

1. **No side table.** `session.uuid` *is* the primary key of the call row, so
   the AudioSocket session resolves to the CRM record with zero lookups.
2. **No race.** If the mapping lived in a `Map<channelId, callId>`, the TCP
   connection could arrive before the entry was written (Asterisk is fast and
   the two events travel different paths — REST reply vs. TCP connect). With the
   id inside the protocol, ordering is impossible to get wrong.
3. **Recordings name themselves.** `[ai-bridge]` sets
   `MIXMON_FILE=${RECORDINGS_DIR}/${AS_UUID}.wav`, so the recording on disk is
   `<callId>.wav`. `saveRecording()` derives the path from the call id alone
   (`recordingPathFor()`), and the uploads route can serve it without a
   database round trip.
4. **Debuggable.** One UUID appears in the Asterisk log, the recording
   filename, the `calls`/`ai_sessions`/`call_transcripts` rows and every
   log line the orchestrator writes.

The cost is that the UUID is a real database identifier travelling through the
dialplan. `[ai-bridge]` guards against an unset or empty `AS_UUID`/`AS_HOST` by
jumping to `missing,1`, playing `technical-difficulties` and hanging up, rather
than opening a session that can never be correlated.

---

## 6. Transfer to a human: two strategies

`transfer.ts` picks the strategy from where the caller's channel actually is.

| Strategy | When | How |
|----------|------|-----|
| `ari-bridge` | The caller is still inside Stasis (AI never started, or fallback IVR). ARI owns the channel. | Hold the caller, create a mixing bridge, originate `Local/<ext>@ai-transfer` with our Stasis app as the destination — the `;2` half runs the dialplan `Dial` (25 s, `tT`) and the `;1` half lands in Stasis where it can be bridged. If nobody answers, the caller is kept. |
| `ami-redirect` | The caller was already handed to `[ai-bridge]` and is executing `AudioSocket()`. A channel inside a dialplan application is not under Stasis control — ARI answers **409** for `moh`, `bridge` and `addChannel` on it. | AMI `Redirect` pulls the channel out of `AudioSocket` and drops it at `ai-transfer,<ext>,1`. The existing dialplan `Dial`s the operator and bridges natively on answer. The AudioSocket connection ends, which is the orchestrator's "the AI is done" signal. |

Neither path needs a dialplan change: both use the existing `[ai-transfer]`
context. Originating `PJSIP/<ext>` straight into that context would double-dial
(Asterisk rings the endpoint, then the dialplan `Dial`s it again), so it is only
used as a last resort when the `Local` channel cannot be created.

---

## 7. Real-time updates to the dashboard

`lib/ws/registry.ts` was extended additively — every previously existing export
kept its signature. New: per-socket role metadata and role-scoped fan-out.

| Function | Audience |
|----------|----------|
| `broadcastToUser(userId, data)` | One user's sockets (pre-existing). |
| `broadcastToAll(data)` | Everyone. |
| `broadcastToRoles(roles, data)` | Sockets whose authenticated role matches. Sockets registered without a role are skipped, so a role-restricted event cannot leak. |
| `broadcastCallEvent(data, ownerUserId)` | Every supervisor/admin, plus the operator who owns the call (never twice). |

Live-call event types (`LIVE_CALL_EVENTS`): `live_call_started`,
`live_call_updated`, `live_call_transcript`, `live_call_transfer`,
`live_call_ended`, `live_call_analysis`.

Interim transcript deltas are throttled: broadcast at most every 250 ms,
persisted at most every 2 s, and an interim buffer never exceeds 4000
characters — the final row carries the real text.

---

## 8. Data model

### Pre-existing tables (unchanged)

```
users(id, phone, username, email, passwordHash, role, isActive, isDeleted, ...)
operatorProfiles(id, userId -> users.id, extension, currentStatus, isDeleted, ...)
operatorStatusLogs, userSessions, refreshTokens, auditLogs
contacts(id, phoneNumber, firstName, lastName, address jsonb{tuman,kocha,uy},
         notes, isDeleted, ...)
calls(id, direction, callerNumber, calleeExtension, contactId,
      operatorId -> operatorProfiles.id, ticketId, status, duration,
      recordingPath, aiStatus, startedAt, endedAt, createdAt)
tickets(id, contactId, createdBy -> users.id, subject, description, category,
        priority, status, mnazoratRefId, aiSummary, aiSentiment,
        aiCategories jsonb, aiConfidence, aiAnalysisId, isDeleted, ...)
aiAnalyses(id, callId UNIQUE, status, transcript, summary, sentiment,
           categories, confidence, errorMessage, retryCount, processedAt, ...)
```

Enums: `call_direction(inbound|outbound)`,
`call_status(ringing|answered|missed|abandoned|completed)`,
`ticket_status(new|in_progress|resolved|closed|reopened)`,
`ticket_priority(low|medium|high)`,
`ai_status(pending|processing|completed|failed)`,
`sentiment(positive|neutral|negative)`,
`operator_status(online|offline|pause|busy)`.

### New tables (migration `0003`, `db/schema/aiVoice.ts`)

Strictly additive: no existing table or column was altered, so the migration
cannot break the routes already in production. New enums live in `aiVoice.ts`
rather than `enums.ts` because that file is referenced by earlier migrations.

| Table | Key columns | Lifecycle |
|-------|-------------|-----------|
| `ai_sessions` | `callId` **UNIQUE** -> `calls.id` (cascade), `channelId`, `provider`, `model`, `voice`, `language`, `status`, `interruptions`, `inputAudioMs`, `outputAudioMs`, `promptTokens`, `completionTokens`, `errorMessage`, `metadata jsonb`, `startedAt`, `endedAt`, `durationMs` | One row per AI-handled call. `UNIQUE(callId)` makes creation idempotent. |
| `call_transcripts` | `callId` -> `calls.id` (cascade), `aiSessionId` -> `ai_sessions.id` (set null), `role`, `content`, `startMs`, `endMs`, `isFinal`, `confidence` | Append-only during the call; correctable afterwards via the transcripts API. |
| `call_recordings` | `callId` -> `calls.id` (cascade), `filePath`, `fileName`, `format`, `sizeBytes`, `durationSeconds`, `isAvailable` | Written at teardown from the MixMonitor file `<callId>.wav`. |
| `call_transfers` | `callId` (cascade), `aiSessionId` (set null), `fromChannelId`, `toChannelId`, `toExtension`, `toOperatorId` -> `operatorProfiles.id`, `reason`, `status`, `requestedAt`, `connectedAt`, `endedAt` | One row per handover attempt, including failures and abandons. |
| `call_notes` | `callId` (cascade), `ticketId` (cascade), `authorType(ai\|operator\|system)`, `authorUserId` -> `users.id` (set null), `content` | Written by the `add_note` tool and by operators. |
| `follow_up_tasks` | `callId`/`ticketId`/`contactId` (set null), `assignedTo` -> `operatorProfiles.id`, `title`, `description`, `dueAt`, `status`, `createdBySystem`, `completedAt` | `createdBySystem = true` marks AI-created tasks. |
| `bookings` | `contactId` **NOT NULL** (cascade), `callId`/`ticketId` (set null), `assignedTo`, `title`, `notes`, `scheduledAt`, `durationMinutes` (default 30), `location`, `status`, `createdBySystem` | Home visits and appointments. |
| `sip_extensions` | `extension` **UNIQUE**, `displayName`, `operatorProfileId` (set null), `kind(sip\|webrtc\|ai)`, `isEnabled`, `lastRegisteredAt`, `lastKnownStatus` | A mirror, not the authority. Asterisk's `pjsip.conf` remains the source of truth; this table exists so the dashboard can list extensions without hitting AMI on every page load. `POST /api/asterisk/extensions/sync` reconciles it. |

New enums: `ai_session_status(initializing|active|transferring|completed|failed)`,
`transcript_role(caller|agent|system)`,
`follow_up_status(open|in_progress|done|cancelled)`,
`booking_status(scheduled|confirmed|cancelled|completed)`,
`transfer_status(requested|ringing|connected|failed|abandoned)`,
`note_author_type(ai|operator|system)`,
`sip_extension_kind(sip|webrtc|ai)`.

### Relationship sketch

```
users ──1:1── operatorProfiles ──┬── calls.operatorId
                                 ├── call_transfers.toOperatorId
                                 ├── follow_up_tasks.assignedTo
                                 ├── bookings.assignedTo
                                 └── sip_extensions.operatorProfileId

contacts ──1:N── calls ──1:1── ai_sessions ──1:N── call_transcripts
              │        ├──1:N── call_recordings
              │        ├──1:N── call_transfers
              │        ├──1:N── call_notes
              │        ├──1:1── ai_analyses          (callId UNIQUE)
              │        └──1:N── follow_up_tasks / bookings
              └──1:N── tickets ──1:N── call_notes / follow_up_tasks / bookings
```

---

## 9. Idempotency and failure rules

Three rules shape the orchestrator, and changing code in `lib/telephony` means
keeping them:

1. **The caller never gets dead air.** A provider that cannot start, a tool that
   throws, an operator who does not answer — each has a path that still ends
   with the caller hearing something or reaching a human.
2. **Every teardown path is idempotent.** `StasisEnd`, `ChannelDestroyed`, the
   AudioSocket closing and a hangup we requested ourselves all race, and all
   four can arrive for the same call. Guards live both on the in-memory call
   record and in SQL (`ended_at IS NULL`), so running teardown twice changes
   nothing.
3. **Nothing here touches the legacy FreePBX path.** `routes/webhooks` keeps
   writing its own `calls` rows through its own handlers.

Availability of the AI is a first-class outcome, not an exception. Terminal
OpenAI error codes (`model_not_found`, `invalid_model`, `insufficient_quota`,
`beta_api_shape_disabled`, `invalid_api_key`) are never retried — retrying an
entitlement problem only burns the caller's patience. They surface as
`VoiceProviderUnavailableError` from `start()`, and the orchestrator falls back
to the IVR provider while the caller is still on the line.
