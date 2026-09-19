# HTTP API

Base path: **`/api`**. Everything is mounted by
`apps/backend/src/routes/index.ts`.

| Surface | URL |
|---------|-----|
| OpenAPI JSON | `GET /doc` |
| Scalar UI | `GET /reference` |
| Health | `GET /api/health` |

Backend framework: Hono + `@hono/zod-openapi`. Every route is declared with
`createRoute({...})`, so the OpenAPI document is generated from the same schemas
that validate requests — the document cannot drift from the implementation.

> **Legacy FreePBX endpoints are retained.** `POST /api/webhooks/freepbx/call-start`
> and `POST /api/webhooks/freepbx/call-end` are kept **for backward
> compatibility** and are fully functional. The AI voice layer writes its
> `calls` rows through a completely separate path (ARI → orchestrator →
> `crm-writer`) and never calls these endpoints. Nothing that currently posts to
> them needs to change.

---

## 1. Authentication

JWT bearer tokens. `POST /api/auth/login` returns an access token (`15m` by
default) and a refresh token (`7d`), the latter stored in Redis.

```
Authorization: Bearer <accessToken>
```

Protected groups apply `authMiddleware` with `router.use("/*", authMiddleware)`;
the authenticated principal is `c.get("user")` → `{ id, role }` where role is
`supervisor | admin | manager`.

### Roles

| Role | Intent |
|------|--------|
| `supervisor` | Full control, including user management and AI configuration. |
| `admin` | Everything operational: sees all calls/tickets/sessions, can originate and hang up calls. Cannot manage users or change AI config. |
| `manager` | Operator. Sees their own calls, sessions, bookings and tasks. |

`requireRoles(c, [...])` throws `403 FORBIDDEN` when the role does not match.
Where a role is not *blocked* but *scoped*, the table below says "own only".

### Unauthenticated endpoints

These have **no** `authMiddleware`, deliberately:

| Endpoint | Why |
|----------|-----|
| `GET /api/health` | Liveness probe used by Docker, compose and `update.sh`. |
| `POST /api/auth/login`, `POST /api/auth/refresh` | Bootstrapping the session. |
| `GET /api/uploads/call-recordings/{fileName}` | Recordings are played by `<audio src>` and downloaded by `<a download>`, and neither element can send an `Authorization` header. The file name is passed through `basename()`, so no path escapes the directory. In production nginx keeps `/api/uploads` behind its own rate limit and serves recordings from an `internal` location. |
| `POST /api/webhooks/freepbx/*` | Legacy PBX callbacks. Restrict at the network layer (nginx / firewall). |

---

## 2. Response envelope

Success:

```json
{ "success": true, "data": { ... } }
```

Paginated (helpers `paginated()` / `PaginationQuerySchema`, query `page`, `limit`):

```json
{ "success": true, "data": { "items": [ ... ], "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 } } }
```

Error (`lib/errors.ts` + `error-handler.ts`):

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…", "details": [ … ] } }
```

Common statuses: `400` invalid input, `401` unauthorized, `403` forbidden,
`404` not found, `409` conflict, `422` business rule, `500` internal /
database error.

---

## 3. Existing endpoints (pre-AI CRM)

### `/api/health`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/health` | none | — | `{ status, timestamp, uptime }`. |

### `/api/auth`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| POST | `/api/auth/login` | none | — | Phone + password → access + refresh token. |
| POST | `/api/auth/refresh` | none | — | Refresh token → new token pair (validated against Redis). |
| POST | `/api/auth/register` | **yes** | any authenticated | Creates a user; the role is **forced to `manager`** regardless of input. |
| POST | `/api/auth/logout` | yes | any | Deletes the refresh token from Redis. |
| GET | `/api/auth/me` | yes | any | The current user. |

### `/api/users`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/users` | yes | supervisor, admin | Paginated list. |
| GET | `/api/users/{id}` | yes | supervisor, admin | One user. |
| PATCH | `/api/users/{id}` | yes | supervisor, admin | Update. |
| DELETE | `/api/users/{id}` | yes | supervisor, admin | Soft delete (`isDeleted`). |

### `/api/operator-profiles`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/operator-profiles` | yes | any | List profiles. |
| GET | `/api/operator-profiles/me/profile` | yes | any | The caller's own profile. |
| GET | `/api/operator-profiles/{id}` | yes | any | One profile. |
| POST | `/api/operator-profiles` | yes | **supervisor** | Create a profile (extension ↔ user). |
| PATCH | `/api/operator-profiles/me/status` | yes | any | Change own status (`online\|offline\|pause\|busy`); writes `operator_status_logs`. |
| PATCH | `/api/operator-profiles/{id}` | yes | **supervisor** | Update any profile. |
| DELETE | `/api/operator-profiles/{id}` | yes | **supervisor** | Soft delete. |

### `/api/contacts`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/contacts` | yes | any | Paginated list. |
| GET | `/api/contacts/lookup` | yes | any | Caller-ID lookup by `?phoneNumber=`. Same normalisation the AI layer uses. Registered **before** `/{id}`, or the literal `lookup` is parsed as an id and the request 422s on uuid validation. |
| GET | `/api/contacts/{id}` | yes | any | One contact. |
| POST | `/api/contacts` | yes | any | Create. |
| PATCH | `/api/contacts/{id}` | yes | any | Update (incl. `address {tuman, kocha, uy}`). |
| DELETE | `/api/contacts/{id}` | yes | **admin, supervisor** | Soft delete. |

### `/api/calls`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/calls` | yes | any | Paginated list. Filters: `direction`, `status`, `operatorId`, `phoneNumber`, `from`, `to`. |
| GET | `/api/calls/missed` | yes | any | Missed calls. |
| GET | `/api/calls/export` | yes | any | Export (`?format=`), via exceljs. |
| GET | `/api/calls/me/stats` | yes | any | The caller's own statistics. |
| GET | `/api/calls/{id}` | yes | any | One call with its relations. `operator` carries `{ id, phone, username, extension }` — `phone` is the operator's real phone, not their user id. |

Route order matters and is respected in `index.ts`: `/export`, `/missed` and
`/me/stats` are registered **before** `/{id}`.

### `/api/tickets`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/tickets` | yes | any | Paginated list. Filters: `q` (subject, case-insensitive substring), `status`, `priority`, `phoneNumber`, `contactId`, `createdBy`. |
| GET | `/api/tickets/{id}` | yes | any | One ticket. |
| POST | `/api/tickets` | yes | any | Create. |
| PATCH | `/api/tickets/{id}` | yes | any | Update (status, priority, assignment). |
| DELETE | `/api/tickets/{id}` | yes | any | Soft delete. |

### `/api/audit-logs`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/audit-logs` | yes | **supervisor, admin** | Paginated list. Filters: `userId`, `action`, `from`, `to`. `action` is a case-insensitive substring match, so `login` finds `auth.login`. |

### `/api/dashboard`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/dashboard/summary` | yes | any | Aggregate counters. Was unauthenticated until the audit; no frontend code called it, so closing it broke nothing. |

### `/api/uploads`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| POST | `/api/uploads/recording` | yes | any | `multipart/form-data`, one audio file; returns a path. Was unauthenticated, which let anyone write files into the recordings directory. |
| GET | `/api/uploads/call-recordings/{fileName}` | **none** | — | Streams a recording for playback. Deliberately open — see the table above. Serves the same bind-mounted directory MixMonitor writes to, so AI-call recordings (`<callId>.wav`) need no copy step. |

### `/api/webhooks/freepbx` — legacy, retained

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| POST | `/api/webhooks/freepbx/call-start` | **none** | — | Writes a `calls` row (`inbound`/`outbound`), matching or creating the contact. Returns `{ id, createdAt, startedAt, contact }` — the `id` is what `call-end` needs. |
| POST | `/api/webhooks/freepbx/call-end` | **none** | — | Sets `duration`, `recordingPath` and `status` on the row identified by that `id`. |

### `/api/ws`

| Method | Path | Auth | Roles | Purpose |
|--------|------|------|-------|---------|
| GET | `/api/ws` | via handshake | any | WebSocket upgrade (Hono Bun adapter). Registers the socket in `lib/ws/registry.ts`. |

`POST /api/ws/test/broadcast` was removed: no code called it, and the
`test_broadcast` frame it pushed had no client handler, so it could not even
demonstrate that the socket worked.

The socket is **server-to-client only**. The server replies `pong` to a `ping`,
but no client sends one.

Server-pushed message types: `live_call_started`, `live_call_updated`,
`live_call_transcript`, `live_call_transfer`, `live_call_ended`,
`live_call_analysis`, plus `incoming_call` / `call_ended` from the FreePBX
webhooks. This list is exhaustive — the frontend used to dispatch on
`transcript_delta`, `transfer_status`, `ai_session_status` and `outgoing_call`,
none of which any broadcaster sends. Live-call events reach every supervisor/admin and the
operator who owns the call.

---

## 4. New endpoints (AI voice layer)

Six new route groups, all with `router.use("/*", authMiddleware)`.

### `/api/asterisk` — PBX control (tag `Asterisk`)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/asterisk/extensions` | any authenticated | The `sip_extensions` mirror joined with **live AMI state** (registration, contact, device state) and the linked operator. |
| POST | `/api/asterisk/extensions/sync` | **supervisor** | Reconciles `sip_extensions` from AMI. `503` when AMI is unreachable — there is nothing to reconcile against. |
| GET | `/api/asterisk/status` | any authenticated | One-shot health: `reachable`, `ari{ok, baseUrl (credentials stripped), app, version, systemName, startupTime, uptimeSeconds, error}`, `ami{ok, host, port, banner, error}`, `eventStream{running, app, url}`, `channels{active, byState[], error}`, `aiCalls{active, orchestratorRunning}`, `backend{uptimeSeconds}`. |
| POST | `/api/asterisk/originate` | **admin, supervisor** | Click-to-call. Body: `toNumber` (`^\+?\d{2,20}$`, leading `+` stripped because `[click-to-call]` matches `_X.`), `fromExtension`, optional `callerId`, optional `timeoutSeconds` (5–120). Returns the channel it created. `422` if Asterisk refuses or the extension is unknown. |
| POST | `/api/asterisk/transfer` | **admin, supervisor** | Transfer a live call to a human. Body: `callId`, optional `extension` (omit to let the router choose), optional `reason`. Returns `connected`, `extension`, `transferId`, `source` (`orchestrator` \| `direct`), `strategy` (`ari-bridge` \| `ami-redirect` \| `none`), `callerRetained`, `alreadyInProgress`, `failureReason`. `422` when the call has no live channel. |
| POST | `/api/asterisk/hangup` | **admin, supervisor** | Body: `callId`, optional `reason`. `source: "orchestrator"` also tears the AI session down; `"ari"` is the raw fallback. |

### `/api/live-calls` — the live board (tag `Live calls`)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/live-calls` | admin/supervisor see all; **manager sees own only** | Snapshot of currently active calls straight from the orchestrator's in-memory state (no DB scan). |
| GET | `/api/live-calls/{id}` | same scoping | One live call plus its latest transcript lines. `?transcriptLimit=` (1–200, default 50). |

Use the WebSocket for updates; poll these only to (re)build initial state.

### `/api/transcripts` (tag `Transcripts`)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/transcripts/call/{callId}` | admin/supervisor all; **manager own calls only** | Paginated transcript lines. Query: `role` (`caller\|agent\|system`), `includeInterim` (default `false`), `order` (`asc`\|`desc`, default `asc`), `search`, plus `page`/`limit`. |
| GET | `/api/transcripts/call/{callId}/export` | same | Download as `txt` (default) or `csv`. Query: `format`, `role`, `includeInterim`. Returns a file, not JSON. |
| POST | `/api/transcripts/call/{callId}` | same | Append a **manual** line. Body: `role`, `content` (1–10 000), optional `startMs`, `endMs`, `isFinal` (default true), `confidence` (0–100), `aiSessionId`. |
| PATCH | `/api/transcripts/{id}` | same | Correct a line: `content`, `role`, `startMs`, `endMs`, `isFinal`, `confidence`. |

Interim (`isFinal = false`) rows are excluded by default because a live call
writes them at most every 2 s and the final row carries the real text.

### `/api/bookings` (tag `Bookings`)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/bookings/calendar` | admin/supervisor all; manager own | Calendar view. Query: `view` (`month` default \| `week`), `date` (`YYYY-MM-DD`, default today, UTC), `status`, `assignedTo`. Registered **before** `/{id}` so it is not swallowed by the id route. |
| GET | `/api/bookings` | admin/supervisor all; manager own | Paginated list. Query: `status`, `assignedTo`, `contactId`, `callId`, `ticketId`, `from`/`to` (ISO, on `scheduledAt`), `page`, `limit`. |
| POST | `/api/bookings` | any authenticated | Create. A manager may only assign to themselves; admin/supervisor may assign to any operator. |
| GET | `/api/bookings/{id}` | own or all per role | One booking. |
| PATCH | `/api/bookings/{id}` | own or all per role | Update. |
| DELETE | `/api/bookings/{id}` | own or all per role | **Cancel** — the row is not deleted, `status` becomes `cancelled`. |

### `/api/follow-ups` (tag `Follow-ups`)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/follow-ups` | admin/supervisor all; manager own | Paginated list. Query: `status`, `assignedTo`, `contactId`, `callId`, `ticketId`, `dueFrom`, `dueTo`, `overdue` (default `false`), `createdBySystem` (`true` = AI-created), `page`, `limit`. |
| POST | `/api/follow-ups` | any authenticated | Create. Manager may only assign to themselves. |
| GET | `/api/follow-ups/{id}` | own or all per role | One task. |
| PATCH | `/api/follow-ups/{id}` | own or all per role | Update (status, due date, assignment). |
| DELETE | `/api/follow-ups/{id}` | own or all per role | **Cancel** (soft): `status = cancelled`. |

### `/api/ai-assistant` (tag `AI assistant`)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/ai-assistant/status` | any authenticated | Voice-provider health. Returns `provider` (`openai-realtime` \| `fallback-ivr`), `available` (can a Realtime session **actually** be opened by this account), `detail` (safe to display), `enabled`, `model`, `voice`, `language`, `apiKeyConfigured`, `agentExtension`, `orchestrator{running, activeCalls}`, `checkedAt`. Probe results are cached ~30 s and de-duplicated, so a dashboard poll cannot hammer OpenAI. |
| GET | `/api/ai-assistant/config` | any authenticated | Effective configuration with **no secrets** — `apiKeyConfigured` / `googleApiKeyConfigured` are booleans, neither key is ever returned. `sources` says where each field comes from (`profile` \| `override` \| `env`), `overrides` gives the value when it is not the `.env` baseline, `options` carries the closed lists the selects are built from, and `notes` carries the Uzbek caveats a field needs (dialplan, provider, missing key). `restartRequiredFor` is normally empty — every field this endpoint writes is re-read on the next call. |
| PATCH | `/api/ai-assistant/config` | **supervisor** | Persisted change of `enabled`, `provider`, `language`, `dialect`, `voice`, `model`, `analysisModel`, `transcribeModel`, `maxCallSeconds`, `silenceHangupMs`, `greetingDelayMs`, `agentExtension`, `transferExtensions` and the `gemini` speech block (`temperature`, `topP`, `maxOutputTokens`, `languageCode`, the four VAD values). Every field takes effect on the **next call** and survives a restart. Storage: `voice`, `language` and the two call limits go to the active `ai_agent_profiles` row (that is what the orchestrator reads); everything else to `system_settings` under the `ai` category, whose defaults are the `.env` values — so the precedence is stored row > `.env` > built-in. `.env` itself is never rewritten. A value that could not work (a Gemini model with no `live` in its name, another vendor's voice, a non-numeric extension) is refused with a 400 and an Uzbek reason. |
| GET | `/api/ai-assistant/sessions` | admin/supervisor all; **manager own calls only** | Paginated `ai_sessions`. Query: `status`, `provider`, `callId`, `from`, `to`, `page`, `limit`. |
| GET | `/api/ai-assistant/sessions/{id}` | same scoping | One session with its full transcript, the call and the contact. |

---

## 5. Tag → group map (for the OpenAPI document)

| Tag | Group |
|-----|-------|
| Auth, Users, Operator Profiles, Contacts, Calls, Tickets, Audit Logs, Dashboard, Uploads, Webhooks | existing CRM |
| Asterisk | `/api/asterisk` |
| Live calls | `/api/live-calls` |
| Transcripts | `/api/transcripts` |
| Bookings | `/api/bookings` |
| Follow-ups | `/api/follow-ups` |
| AI assistant | `/api/ai-assistant` |

---

## 6. Not implemented

- **`GET /metrics` on the backend.** `monitoring/prometheus/prometheus.yml`
  documents a metric contract (`callcenter_calls_total`,
  `callcenter_ai_sessions_active`, `callcenter_ari_connected`, …) and scrapes
  `backend:4000/metrics`, but the backend does not currently expose that route,
  so the `backend` scrape target reports as down. The contract in that file is
  the specification to implement against; nothing else in the stack depends on
  it being live.
- **Browser softphone endpoints.** SIP over WebSocket would terminate on
  Asterisk (`/ws` on 8088), not on this API. It needs a `wss` transport and DTLS
  certificates on Asterisk, which are not configured — see
  [CONFIGURATION.md § 12](./CONFIGURATION.md#12-frontend) on the unused
  `VITE_SIP_*` variables.
