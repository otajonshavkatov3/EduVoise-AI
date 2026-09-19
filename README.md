# CallCenter "Aqlli Shahar" — AI Voice Platform

A call centre CRM (**Bun**, **Hono**, **React** + **Vite**, **PostgreSQL**, **Redis**, JWT)
with an **AI phone agent** layer on top: **Asterisk 20** answers SIP calls, bridges audio to the
**OpenAI Realtime API** over AudioSocket, and writes every call into the CRM.

## AI Voice Platform

Telephony is **Asterisk**, not FreePBX. The legacy `/api/webhooks/freepbx` endpoints are
retained for backward compatibility.

| Piece | Where |
|---|---|
| Asterisk container + dialplan | `asterisk/`, `docker/asterisk.Dockerfile` |
| ARI / AMI adapter | `apps/backend/src/lib/asterisk/` |
| Voice providers + audio codec | `apps/backend/src/lib/ai/` |
| Call orchestrator + CRM writes | `apps/backend/src/lib/telephony/` |
| New API groups | `routes/{asterisk,live-calls,ai-assistant,transcripts,follow-ups,bookings}` |
| Dashboard modules | `apps/frontend/src/modules/{live-calls,ai-assistant,transcripts,recordings,follow-ups,bookings}` |
| Full docs | [`docs/`](docs/) |

### Quick start (telephony)

```bash
docker compose up -d asterisk      # Postgres/Redis run natively here - see LOCAL_DEV.md
cd apps/backend && bun run db:migrate && bun run db:seed && bun run db:seed:sip
bun run dev
bun --env-file=.env run tests/e2e/run-verification.ts   # 29-check stack report
```

Then point a softphone at `127.0.0.1:5070` (credentials in `.env`) and dial:

| Ext | Does |
|---|---|
| **900** | AI agent |
| 600 / 601 / 602 | echo test / playback / music-on-hold |
| 700 | voicemail |
| 101–104 | human operators |

### Call flow

```
caller → Stasis(callcenter-ai) → orchestrator: create call + match/create contact
       → ARI answer → set AS_UUID=calls.id → [ai-bridge]
       → MixMonitor (recording) + AudioSocket → OpenAI Realtime
       → tools write contacts/tickets/notes/follow-ups/bookings, or transfer to a human
```

`calls.id` doubles as the AudioSocket UUID, so inbound audio resolves to a CRM row with no
extra lookup. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> **Requires an OpenAI key with realtime model access.** Without it the platform still
> answers, records, creates CRM records and transfers to a human — it just cannot talk.
> See [`docs/AI_PROVIDER.md`](docs/AI_PROVIDER.md).

## Features

- **Monorepo** with Bun workspaces
- **Backend**: Hono + OpenAPI + Drizzle ORM
- **Frontend**: React 19 + Vite + Ant Design + Tailwind CSS
- **Authentication**: JWT access/refresh tokens with Redis storage
- **Type Safety**: Shared types between frontend and backend
- **Code Quality**: Biome (lint + format), Husky, Commitlint

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Backend | Hono, Zod OpenAPI, Drizzle ORM |
| Frontend | React 19, Vite, Ant Design 6, Tailwind CSS 4 |
| Database | PostgreSQL 17 |
| Cache | Redis 7 |
| Auth | JWT (jose), bcrypt |
| State | Zustand, TanStack Query |

## Quick Start

### 1. Clone and Setup

```bash
git clone <repo-url> my-project
cd my-project

# Run setup script (renames project, installs deps)
./scripts/setup.sh
```

### 2. Configure Environment

Edit `.env` with your actual values:

```env
# Generate secure secrets
JWT_SECRET=your_32_char_secret_here
JWT_REFRESH_SECRET=your_32_char_refresh_secret
POSTGRES_PASSWORD=your_secure_password
REDIS_PASSWORD=your_redis_password
```

### 3. Start Services

```bash
# Start PostgreSQL and Redis
docker compose up -d

# Run database migrations
cd apps/backend
bun run db:migrate

# Seed admin user
bun run db:seed
```

### 4. Run Development

```bash
# From root - starts both backend and frontend
bun run dev

# Or separately
bun run dev:backend  # http://localhost:4000
bun run dev:frontend # http://localhost:3000
```

## Project Structure

```
├── apps/
│   ├── backend/          # Hono API server
│   │   ├── src/
│   │   │   ├── db/       # Drizzle schema, migrations
│   │   │   ├── lib/      # Utils, auth, errors
│   │   │   └── routes/   # API endpoints
│   │   └── drizzle.config.ts
│   │
│   └── frontend/         # React SPA
│       └── src/
│           ├── app/      # Providers, router, API client
│           ├── modules/  # Feature modules (auth, dashboard)
│           ├── shared/   # Layouts, hooks, utils
│           └── types/
│
├── shared/               # Shared code
│   └── src/
│       ├── types/        # API types, error codes
│       └── env.ts        # Environment validation
│
├── scripts/
│   └── setup.sh          # Project setup script
│
├── docker-compose.yml
├── biome.json
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start all apps in dev mode |
| `bun run dev:backend` | Start backend only |
| `bun run dev:frontend` | Start frontend only |
| `bun run check` | Run Biome linter |
| `bun run check:fix` | Fix lint issues |

### Backend Scripts (in `apps/backend/`)

| Command | Description |
|---------|-------------|
| `bun run db:generate` | Generate migrations |
| `bun run db:migrate` | Run migrations |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run db:seed` | Seed admin user |

## API Documentation

After starting the backend, visit:
- **OpenAPI JSON**: http://localhost:4000/doc
- **Scalar UI**: http://localhost:4000/reference

## Default Credentials

After running `db:seed`:
- **Phone**: +998900000000
- **Password**: admin123

> Change these immediately in production!

## Authentication Flow

1. **Login** → Returns `accessToken` (15min) + `refreshToken` (7d)
2. **API Calls** → Include `Authorization: Bearer <accessToken>`
3. **Token Refresh** → Use `refreshToken` to get new tokens
4. **Logout** → Invalidates refresh token in Redis

## Adding New Features

### Backend Route

```typescript
// apps/backend/src/routes/example/example.routes.ts
import { createRoute } from "@/lib";

export const exampleRoute = createRoute({
  method: "get",
  path: "/example",
  responses: { 200: { description: "Success" } },
});
```

### Frontend Module

```
apps/frontend/src/modules/example/
├── components/
├── hooks/
├── pages/
├── services/
├── store/
└── types/
```

## License

MIT
