# Verification suite

Everything needed to answer two questions:

1. **Did the AI voice layer break the CRM that was already in production?**
2. **Is the AI call centre actually up, end to end?**

Run everything from the **repository root** so Bun picks up `.env` automatically.

```sh
bun test tests/                                     # all four test suites
bun --env-file=.env run tests/e2e/run-verification.ts   # the stack report
```

## Contents

| File | Proves |
| --- | --- |
| `integration/api-backward-compat.test.ts` | The pre-existing CRM surface still behaves exactly as before, including the legacy FreePBX webhooks. This is the regression gate. |
| `integration/new-endpoints.test.ts` | The six new route groups: auth is required, RBAC holds, follow-ups/bookings/transcripts CRUD works, and the status endpoints match their published shapes. |
| `integration/asterisk-ari.test.ts` | The live Asterisk container: ARI authenticates, the four PJSIP endpoints exist, the five dialplan contexts exist and do what the backend assumes, AMI logs in, the AudioSocket modules are loaded. |
| `integration/openai-provider.test.ts` | The OpenAI Realtime provider handles the current account correctly (no Realtime entitlement → fallback), sends the GA wire shape, and never sends the fatal `OpenAI-Beta` header. |
| `e2e/run-verification.ts` | One readable pass/fail table over the whole stack: Docker, Asterisk, AudioSocket listener, Postgres, Redis, the API, and the AI provider. Exits non-zero on failure. |
| `helpers/api-client.ts` | Shared HTTP client, login, and schema-validation helpers. |
| `helpers/fixtures.ts` | Test data created through the public API, plus its cleanup. |

## Prerequisites

| Needed for | Requirement |
| --- | --- |
| all suites | Postgres and Redis reachable at `DATABASE_URL` / `REDIS_URL`, migrations applied (`bun run db:migrate`), database seeded (`bun run db:seed`). |
| all suites | The seeded supervisor `+998900000000` / `admin123`. |
| `asterisk-ari` | The `callcenter-asterisk` container running, with `ASTERISK_ARI_*` and `ASTERISK_AMI_*` set. Skips with a clear message when nothing answers on the ARI port. |
| `openai-provider` | `OPENAI_API_KEY`. Without it the suite still passes: it asserts the "no key" branch instead. |
| `run-verification.ts` | Everything above plus a running backend (`bun run dev:backend`). Docker is optional - the container checks are skipped, Asterisk is still checked directly over ARI/AMI. |

Nothing needs to be installed. No suite adds a dependency.

## How the integration suites reach the API

The two API suites run the same assertions over one of two transports and print which one they used:

- **live** - `fetch()` against a running backend (`BACKEND_URL`, else `http://localhost:$PORT`, else port 4000). This is preferred, because it is the only way to test the process that is actually deployed.
- **in-process** - the same routers mounted on a Hono app inside the test process, driven with `app.request()`. Used when no backend is listening, so handlers, middleware and RBAC are still verified without a server.

`new-endpoints.test.ts` additionally falls back to in-process when the live backend is up but answers `404` for the new groups - i.e. when `apps/backend/src/routes/index.ts` has not been wired yet. It prints a warning saying so. **The live wiring itself is gated by `run-verification.ts`**, which fails on those 404s; the test suite verifies behaviour, the report verifies deployment.

## Test data

`helpers/fixtures.ts` creates everything through the public API and deletes it again in `afterAll`:

- contacts, calls, follow-ups, bookings and transcript lines are created per run with unique phone numbers, then hard-deleted directly (the API only soft-deletes, by design).
- `audit_logs` rows are **left behind** on purpose. They are append-only records of the requests the suite really made.

One fixture is long-lived and reused between runs, because deleting a user would cascade into calls and tickets:

| Fixture | Value |
| --- | --- |
| test manager user | phone `+998900000911`, password `verify-manager-123`, role `manager` |
| its operator profile | extension `991` (deliberately outside the real 101-104 / 900 range, so the dialplan can never transfer a caller to it) |

To remove it by hand:

```sql
delete from operator_status_logs where operator_id in
  (select id from operator_profiles where extension = '991');
delete from operator_profiles where extension = '991';
delete from users where phone = '+998900000911';
```

## What each suite asserts

### `api-backward-compat.test.ts` - the regression gate

- `/api/health` is public and reports uptime.
- Login with the seeded supervisor returns both tokens; a wrong password is still `401`; `/api/auth/me` matches its published schema.
- Every pre-existing group answers `200` with a token: `/api/users`, `/api/contacts`, `/api/calls`, `/api/calls/missed`, `/api/calls/me/stats`, `/api/tickets`, `/api/audit-logs`, `/api/operator-profiles`, `/api/dashboard/summary`.
- Each of those (except `/api/dashboard/summary`) is still `401` without a token, and a malformed token is `401` rather than `500`.
- List responses are validated against the **zod schemas the routes publish in their own OpenAPI definitions**, so a handler that silently drops a field fails here.
- Pagination still works, and an out-of-range `limit` is still rejected.
- The legacy FreePBX webhooks: `call-start` creates a `ringing` call, matches a known contact and joins its name; `call-end` stores duration, status and recording path; an unknown `callId` is `404`; an invalid payload is `422`; and **neither route requires a bearer token**, because FreePBX cannot send one.

One pre-existing quirk is pinned rather than "fixed": `/api/dashboard/summary` has never had `authMiddleware`. The test records that as current behaviour and flags it - changing it is a product decision, not a regression fix.

### `new-endpoints.test.ts` - the AI layer's HTTP surface

- **Auth**: twelve reads and three writes across all six groups are `401` without a token.
- **RBAC**: a manager gets `403` on `PATCH /api/ai-assistant/config`, `POST /api/asterisk/extensions/sync`, `POST /api/asterisk/originate` and `POST /api/asterisk/hangup`; a supervisor reaches the config patch (an empty patch is `400`, proving reachability without mutating the live agent); reading the config is allowed for a manager.
- **Scoping**: a follow-up assigned to nobody is invisible to a manager, and reading it by id is `404` rather than `403` (deliberate - a `403` would confirm the row exists); a manager cannot reassign a task; transcript access follows call ownership; `/api/live-calls` reports `scopedToOperator` per role.
- **Follow-ups**: create with call/contact/assignee links, get, list, filter by `assignedTo`, the `open → in_progress → done → open` status machine including `completedAt` bookkeeping, cancel-on-delete, the refused `cancelled → done` transition (`422`), and the `overdue` flag and filter.
- **Bookings**: `endsAt` computed from the duration, `409` on double-booking one operator, an adjacent slot accepted, `422` for a past time, the calendar's UTC day grouping, rescheduling and confirming, cancel-on-delete, `404` for an unknown contact.
- **Transcripts**: append caller/agent/interim lines, ordering by `startMs`, the `includeInterim` / `role` / `search` / `order` filters, the `txt` export's `[mm:ss] role: text` format, the `csv` export header, correcting a line, `400` when `endMs < startMs`, `404` for an unknown call.
- **Shapes**: `/api/asterisk/status`, `/api/asterisk/extensions`, `/api/live-calls`, `/api/ai-assistant/status`, `/api/ai-assistant/config` and `/api/ai-assistant/sessions` are validated against their declared schemas, and asserted **not to contain** the ARI password, the AMI password or the OpenAI key.

Deliberately not exercised, because a test must not disturb a running system: `originate` (would ring a real phone), `hangup` (would drop a real call), `extensions/sync` (writes reconciled state for the whole deployment) and a non-empty `config` patch (would change the live agent). Each is covered by the closest observable thing instead - the `403`, or the validation error.

### `asterisk-ari.test.ts` - the live container

Skips the whole file with an explicit message when nothing answers on the ARI port, so a developer without Docker does not see red. It does **not** skip when the container is up but a check fails.

- ARI credentials are configured; `GET /asterisk/info` returns Asterisk 18+ with a parseable `startup_time`; a wrong password is `401` (ARI is not open to the world); `/endpoints` contains PJSIP `101`-`104`; `/channels` lists.
- AMI logs in and reports the `Asterisk Call Manager` banner; `Ping` answers `Pong`; a wrong password is refused; `PJSIPShowEndpoints` sees all four endpoints.
- All five dialplan contexts exist: `from-internal`, `from-external`, `ai-bridge`, `ai-transfer`, `click-to-call`.
- Extension `900` runs `Stasis(${AI_STASIS_APP})`, and the `AI_STASIS_APP` global equals `ASTERISK_ARI_APP` - if those drift, `Stasis()` sends the call to an application the backend never subscribed to and the caller hears nothing.
- `600` / `601` / `602` diagnostics survive; `from-external` also goes to Stasis; `ai-bridge` arms `MixMonitor` **before** `AudioSocket` and guards on `AS_UUID` / `AS_HOST`; `ai-transfer` dials `PJSIP/`; `click-to-call` pattern-matches; `RECORDINGS_DIR` matches `ASTERISK_RECORDINGS_DIR`.
- `res_audiosocket.so`, `app_audiosocket.so` and `chan_audiosocket.so` are loaded - plus a negative control proving `ModuleCheck` really fails for a module that is not loaded.

Audio actually flowing over AudioSocket cannot be tested without a real channel; it needs a softphone dialling `900`.

### `openai-provider.test.ts` - the provider and the fallback decision

Written as invariants, so it keeps passing when the account is upgraded and starts proving the opposite branch:

- `probeProviderHealth()` returns a coherent verdict. If `available` is `false` the provider must be `fallback-ivr` and the detail must name the configured model, say something actionable about access, and tell the operator what happens to callers meanwhile. If `available` is `true` the provider must be `openai-realtime`. The detail never contains the API key.
- `resolveVoiceProvider({ probe: true })` returns exactly the provider the verdict implies, and the verdict is cached so a polling dashboard cannot hammer OpenAI.
- Configuration alone decides the rest: `AI_AGENT_ENABLED=false` and a missing `OPENAI_API_KEY` both short-circuit without a network call; with both set and no probe, the hot path returns the OpenAI provider immediately (probing while a caller listens to ringback is not acceptable).
- Against a **local** WebSocket server standing in for `wss://api.openai.com/v1/realtime`: the upgrade request carries `Authorization: Bearer …` and **no** `openai-*` header at all, the model is in the query string, and `session.update` is the GA shape (`session.type: "realtime"`, `output_modalities`, nested `audio.input` / `audio.output`, `audio/pcmu` both ways, `server_vad`) with none of the dead beta fields.
- Failure handling: `model_not_found` and a dropped upgrade both make `start()` throw `VoiceProviderUnavailableError` - the typed signal the orchestrator falls back on - and the probe reports the error code rather than a bare failure.
- A source-level guard asserts no code path outside comments can send `OpenAI-Beta`.

**Current reality this suite is built around:** this project's key has no Realtime entitlement (`model_not_found` on every realtime model) and no standalone STT/TTS. Calls therefore run on the IVR fallback and are transferred to an operator. The tests assert that this is detected and reported, not that it is hidden.

### `e2e/run-verification.ts` - the stack report

```sh
bun --env-file=.env run tests/e2e/run-verification.ts
```

29 read-only checks, in dependency order, printed as one table:

| Group | Checks |
| --- | --- |
| `docker` | daemon reachable; `callcenter-asterisk` running and healthy |
| `asterisk` | SIP tcp/5070; SIP udp/5070 answers a real `OPTIONS`; ARI `/asterisk/info`; ARI rejects a bad password; PJSIP 101-104; AMI login; AMI `Ping`; the five dialplan contexts; `AI_STASIS_APP` matches the ARI app; the three AudioSocket modules |
| `backend` | the AudioSocket TCP listener on `AUDIOSOCKET_PORT` |
| `database` | Postgres connectivity; all 18 expected tables; Redis `PING` |
| `api` | `/api/health`; supervisor login; all nine new read endpoints; the new groups reject an anonymous request |
| `ai` | the voice provider verdict |

Statuses: `PASS` (verified, with evidence), `WARN` (working but deliberately degraded - the OpenAI fallback), `SKIP` (a prerequisite is absent, e.g. no Docker CLI - never used to hide a failure of the thing being checked), `FAIL` (not ready). **Exit code is non-zero if anything failed.**

Every check is a read, a TCP connect, or a request Asterisk answers without side effects. No call is placed, no configuration is reconciled, no row is written.

Note: the libraries being verified log through pino as the script runs, so their output appears above the table. The report is the block starting at `AI CALL CENTRE - STACK VERIFICATION`.

## Known state at the time of writing

`run-verification.ts` currently reports two groups of `FAIL`s, both outside this suite's ownership:

1. `GET /api/{follow-ups,bookings,live-calls,asterisk/*,ai-assistant/*}` → `404`. The routers exist and are fully tested; they are not yet mounted in `apps/backend/src/routes/index.ts`.
2. No AudioSocket listener on `:9092`. The orchestrator binds it in `start()`, which is not called at boot yet.

Both disappear once the wiring lands. Nothing in this suite was weakened to make them look green.

## Not covered by automation

These need a real call and a human:

- Audio actually flowing over AudioSocket (Asterisk dials **in** to the backend; only a live channel creates that connection).
- A transfer actually connecting the caller to a ringing softphone.
- Speech quality, barge-in behaviour and the greeting's timing.
- The post-call summary, which needs a completed AI-handled call.

The manual check, once the wiring is in place: register a softphone on `101`, dial `600` to prove audio both ways, then dial `900` and watch `/api/live-calls` and `/api/ai-assistant/sessions`.
