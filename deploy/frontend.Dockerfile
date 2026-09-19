# syntax=docker/dockerfile:1
#=============================================================================
# Frontend image - Vite/React dashboard, built once and then served as static
# files by a minimal nginx on port 3001.
#
# Build from the PROJECT ROOT:
#   docker build -f deploy/frontend.Dockerfile \
#     --build-arg VITE_API_URL=https://callcenter.example.uz \
#     -t callcenter-frontend:dev .
#
# Port 3001 (not 80) because the edge nginx in docker-compose.prod.yml proxies
# to frontend:3001, and 3000 is left free for a developer running `bun dev`.
#=============================================================================

#-----------------------------------------------------------------------------
# Stage 1: build the bundle
#-----------------------------------------------------------------------------
FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY shared ./shared
COPY apps/frontend ./apps/frontend

# Vite inlines VITE_* variables at BUILD time, so the API base URL is baked into
# the bundle and cannot be changed by an environment variable at runtime. That is
# why scripts/update.sh passes it as a build argument on every deploy.
ARG VITE_API_URL=/
ENV VITE_API_URL=${VITE_API_URL}

# `bunx vite build` rather than the package's "tsc -b && vite build": a type
# error must fail CI, not a production deploy at 02:00. The emitted bundle is
# identical - esbuild strips types either way.
RUN cd apps/frontend && bunx vite build

#-----------------------------------------------------------------------------
# Stage 2: serve
#-----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# The edge proxy owns compression, security headers and TLS. This inner server
# only has to resolve SPA routes and set cache headers, so its config is written
# here instead of carried as another file.
RUN set -eux; \
	rm -f /etc/nginx/conf.d/default.conf; \
	printf '%s\n' \
		'server {' \
		'    listen 3001;' \
		'    listen [::]:3001;' \
		'    server_name _;' \
		'    root /usr/share/nginx/html;' \
		'    index index.html;' \
		'' \
		'    # Container healthcheck target: answers without touching the filesystem.' \
		'    location = /healthz { access_log off; add_header Content-Type text/plain; return 200 "ok"; }' \
		'' \
		'    # Vite emits content-hashed filenames, so assets can be cached forever.' \
		'    location /assets/ {' \
		'        expires 1y;' \
		'        add_header Cache-Control "public, immutable";' \
		'        access_log off;' \
		'        try_files $uri =404;' \
		'    }' \
		'' \
		'    # index.html must never be cached, or operators keep running the' \
		'    # previous bundle after a deploy.' \
		'    location = /index.html {' \
		'        add_header Cache-Control "no-store, must-revalidate";' \
		'        expires -1;' \
		'    }' \
		'' \
		'    # SPA fallback: /calls/42 is a client-side route, not a file.' \
		'    location / {' \
		'        try_files $uri $uri/ /index.html;' \
		'    }' \
		'}' \
		> /etc/nginx/conf.d/frontend.conf; \
	nginx -t

COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
	CMD wget -q -O /dev/null http://127.0.0.1:3001/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
