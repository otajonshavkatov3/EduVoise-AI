# syntax=docker/dockerfile:1
#=============================================================================
# Backend image - Bun + Hono API, ARI controller and AudioSocket bridge.
#
# Build from the PROJECT ROOT (the build context must include shared/ and the
# workspace lockfile):
#   docker build -f deploy/backend.Dockerfile -t callcenter-backend:dev .
#
# Lives in deploy/ rather than docker/ so the Asterisk image build in docker/
# stays a self-contained unit.
#
# Two stages: the first one compiles native modules (bcrypt) and is thrown away,
# so build-essential never ships to production.
#=============================================================================

#-----------------------------------------------------------------------------
# Stage 1: dependencies
#-----------------------------------------------------------------------------
FROM oven/bun:1 AS deps

WORKDIR /app

# bcrypt is a native addon. Its prebuilt binaries do not cover every
# platform/runtime combination, so the toolchain has to be available here or the
# install fails with a node-gyp error that is very hard to read.
RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends python3 make g++ ca-certificates; \
	rm -rf /var/lib/apt/lists/*

# Copy ONLY the manifests first so this layer (the slow one) is cached until a
# dependency actually changes.
#
# Every workspace manifest is required, including the frontend's: `bun install`
# resolves the whole workspace graph and --frozen-lockfile refuses to continue if
# a workspace referenced by bun.lock is missing. The cost is that the frontend's
# dev dependencies land in the shared node_modules; the alternative (a second
# lockfile) is worse to maintain.
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/

# --frozen-lockfile: a deploy must never silently resolve a different version
# than the one that was tested.
# devDependencies are KEPT on purpose: drizzle-kit runs the migrations
# (scripts/update.sh -> bunx drizzle-kit migrate) inside this image.
RUN bun install --frozen-lockfile

#-----------------------------------------------------------------------------
# Stage 2: runtime
#-----------------------------------------------------------------------------
FROM oven/bun:1 AS runtime

ENV NODE_ENV=production \
	PORT=4000 \
	HOST=0.0.0.0

WORKDIR /app

# Dependencies from the previous stage; no compiler in this layer.
COPY --from=deps /app/node_modules ./node_modules

# Source. .dockerignore keeps node_modules, uploads, .env and .git out of the
# context, so these COPYs are small and cannot leak secrets into the image.
COPY package.json bun.lock tsconfig.json ./
COPY shared ./shared
COPY apps/backend ./apps/backend

# Recordings are a bind mount in production (shared with Asterisk and nginx).
# Creating it here means the container also works without the mount, e.g. in CI.
RUN set -eux; \
	mkdir -p /app/apps/backend/uploads/call-recordings; \
	chown -R bun:bun /app

# Never run the API as root: a template-injection bug in a report handler should
# not be able to read /etc/shadow. `bun` is uid/gid 1000 in this image, which is
# also what the host recordings directory is chowned to by scripts/deploy.sh.
USER bun

# 4000 = HTTP + dashboard WebSocket. 9092 = AudioSocket listener that Asterisk
# dials back into (AUDIOSOCKET_ADVERTISE_HOST=backend:9092). Neither is published
# to the host; nginx and the compose network are the only paths in.
EXPOSE 4000 9092

# The health endpoint exercises the router and the dependency probes, which is a
# far better readiness signal than a TCP connect. Implemented with bun itself
# because this image has no curl and adding one would only grow the attack
# surface.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=4 \
	CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 4000) + '/api/health'); process.exit(r.ok ? 0 : 1)"

# src/index.ts exports { fetch, websocket }, which Bun serves directly - no
# separate server bootstrap, and PORT/HOST are read from the environment.
CMD ["bun", "run", "apps/backend/src/index.ts"]
