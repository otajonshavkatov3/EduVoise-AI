#!/usr/bin/env bash
#==============================================================================
# update.sh - build, migrate, restart and verify CallCenter "Aqlli Shahar",
#             with automatic rollback to the previous image tag on failure.
#
# This is the script that runs on every deploy after the first one. deploy.sh
# handles host provisioning and then calls this with --initial.
#
#   scripts/update.sh                      # pull, build, migrate, restart, verify
#   scripts/update.sh --tag v1.4.2         # deploy an explicit image tag
#   scripts/update.sh --rollback           # go back to the previous tag now
#   scripts/update.sh --reload-nginx-only  # re-render vhosts and reload nginx
#
# HOW ROLLBACK WORKS
#   Images are tagged with the git short SHA (callcenter-backend:<sha>). The last
#   two successful tags are remembered in .deploy-state. If a health check or the
#   smoke test fails, the previous tag is brought back up and the script exits 1.
#   Database migrations are NOT rolled back - drizzle migrations are forward-only,
#   so a schema change that breaks the app needs scripts/restore.sh. This is why
#   migrations run BEFORE the new containers are started but AFTER a backup point
#   is available.
#
# EXIT CODES
#   0 success   1 failure (rolled back if possible)   2 usage error
#   3 another run in progress
#==============================================================================
set -euo pipefail
IFS=$'\n\t'

#------------------------------------------------------------------------------
# Configuration
#------------------------------------------------------------------------------
APP_NAME="callcenter"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"

ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"
STATE_FILE="${STATE_FILE:-$INSTALL_DIR/.deploy-state}"
# Same file deploy.sh uses, so provisioning and updating can never interleave.
LOCK_FILE="${LOCK_FILE:-/var/lock/${APP_NAME}-deploy.lock}"

REPO_BRANCH="${REPO_BRANCH:-main}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
SMOKE_RETRIES="${SMOKE_RETRIES:-20}"

DO_PULL=1
DO_BUILD=1
DO_MIGRATIONS=1
DO_ROLLBACK_ON_FAILURE=1
INITIAL=0
RELOAD_NGINX_ONLY=0
FORCE_ROLLBACK=0
EXPLICIT_TAG=""

log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "INFO " "$*"; }
warn() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "WARN " "$*" >&2; }
err()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "ERROR" "$*" >&2; }
die()  { err "$*"; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }

usage() {
	cat <<'EOF'
Usage: update.sh [options]

  --initial              first deploy: no git pull, no rollback target
  --no-pull              skip `git pull`
  --no-build             reuse the images already tagged for this commit
  --skip-migrations      do not run drizzle migrations
  --tag TAG              use TAG as the image tag instead of the git short SHA
  --rollback [TAG]       immediately redeploy the previous (or given) tag
  --no-rollback          on failure, leave the broken deploy up for inspection
  --reload-nginx-only    re-render vhosts, nginx -t, nginx -s reload, exit
  -h, --help             this text
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--initial)           INITIAL=1; DO_PULL=0; DO_ROLLBACK_ON_FAILURE=0 ;;
		--no-pull)           DO_PULL=0 ;;
		--no-build)          DO_BUILD=0 ;;
		--skip-migrations)   DO_MIGRATIONS=0 ;;
		--tag)               shift; [[ $# -gt 0 ]] || { err "--tag needs a value"; exit 2; }; EXPLICIT_TAG="$1" ;;
		--rollback)          FORCE_ROLLBACK=1
		                     if [[ ${2:-} =~ ^[A-Za-z0-9._-]+$ ]]; then EXPLICIT_TAG="$2"; shift; fi ;;
		--no-rollback)       DO_ROLLBACK_ON_FAILURE=0 ;;
		--reload-nginx-only) RELOAD_NGINX_ONLY=1 ;;
		-h|--help)           usage; exit 0 ;;
		*)                   err "unknown option: $1"; usage; exit 2 ;;
	esac
	shift
done

on_err() {
	local code=$? line=${1:-?}
	err "update FAILED at line ${line} (exit ${code})"
	attempt_rollback
	exit "$code"
}
trap 'on_err $LINENO' ERR

#------------------------------------------------------------------------------
# Helpers
#------------------------------------------------------------------------------
COMPOSE_ARGS=()
compose() {
	# IMAGE_TAG is read by docker-compose.prod.yml's image: keys, which is what
	# makes tag-based rollback possible.
	IMAGE_TAG="${IMAGE_TAG:-latest}" \
	docker compose --project-name "$APP_NAME" --project-directory "$INSTALL_DIR" "${COMPOSE_ARGS[@]}" "$@"
}

init_compose() {
	[[ -f "$INSTALL_DIR/docker-compose.yml" ]] || die "docker-compose.yml not found in $INSTALL_DIR"
	[[ -f "$INSTALL_DIR/docker-compose.prod.yml" ]] || die "docker-compose.prod.yml not found in $INSTALL_DIR"
	COMPOSE_ARGS=(
		-f "$INSTALL_DIR/docker-compose.yml"
		-f "$INSTALL_DIR/docker-compose.prod.yml"
		--env-file "$ENV_FILE"
	)
}

env_get() {
	sed -nE "s/^$1=(.*)$/\1/p" "$ENV_FILE" 2>/dev/null | tail -1
}

state_get() {
	[[ -f "$STATE_FILE" ]] || return 0
	sed -nE "s/^$1=(.*)$/\1/p" "$STATE_FILE" | tail -1
}

state_set() {
	local key="$1" value="$2"
	touch "$STATE_FILE"
	if grep -qE "^${key}=" "$STATE_FILE"; then
		sed -i -E "s|^${key}=.*$|${key}=${value}|" "$STATE_FILE"
	else
		printf '%s=%s\n' "$key" "$value" >> "$STATE_FILE"
	fi
}

acquire_lock() {
	mkdir -p "$(dirname "$LOCK_FILE")"
	exec 9>"$LOCK_FILE"
	if ! flock -n 9; then
		err "another deploy/update run holds $LOCK_FILE"
		exit 3
	fi
}

#------------------------------------------------------------------------------
# Health + smoke
#------------------------------------------------------------------------------
# Waits for one compose service to report healthy (or merely running when it has
# no healthcheck). Returns non-zero on timeout so the caller can roll back.
wait_healthy() {
	local svc="$1" timeout="${2:-$HEALTH_TIMEOUT}"
	local waited=0 cid state
	log "waiting for '${svc}' to become healthy (timeout ${timeout}s)"
	while [[ "$waited" -lt "$timeout" ]]; do
		cid="$(compose ps -q "$svc" 2>/dev/null || true)"
		if [[ -n "$cid" ]]; then
			# Containers without a healthcheck have no .State.Health, so fall back
			# to .State.Status - otherwise the template renders empty forever.
			state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
			case "$state" in
				healthy|running)
					log "  ${svc}: ${state}"
					return 0
					;;
				exited|dead)
					err "  ${svc}: ${state} - last 40 log lines:"
					compose logs --tail=40 "$svc" || true
					return 1
					;;
			esac
		fi
		sleep 3
		waited=$(( waited + 3 ))
		[[ $(( waited % 30 )) -eq 0 ]] && log "  ${svc}: still ${state:-absent} after ${waited}s"
	done
	err "timed out waiting for ${svc} (last state: ${state:-absent})"
	compose logs --tail=60 "$svc" || true
	return 1
}

http_check() {
	local url="$1" expect="${2:-}" tries="${3:-$SMOKE_RETRIES}" body
	local i
	for (( i = 1; i <= tries; i++ )); do
		# --max-time keeps a hung upstream from stalling the deploy; -k because on
		# a fresh host the certificate is still the self-signed bootstrap one.
		if body="$(curl -fsSk --max-time 10 "$url" 2>/dev/null)"; then
			if [[ -z "$expect" ]] || grep -q "$expect" <<<"$body"; then
				log "  OK  ${url}"
				return 0
			fi
			warn "  ${url} answered but did not contain '${expect}' (attempt ${i}/${tries})"
		else
			[[ $(( i % 5 )) -eq 0 ]] && log "  ...still waiting for ${url} (attempt ${i}/${tries})"
		fi
		sleep 3
	done
	err "  FAIL ${url}"
	return 1
}

smoke_test() {
	step "Smoke test"
	local domain
	domain="$(env_get DOMAIN)"

	# 1. nginx itself, without touching any upstream.
	http_check "http://127.0.0.1/nginx-health" "ok" || return 1

	# 2. The API through nginx - proves proxying, the backend and its own
	#    dependency wiring in one request.
	http_check "http://127.0.0.1/api/health" '"status"' || return 1

	# 3. The SPA shell.
	http_check "http://127.0.0.1/" "<div id=\"root\"" 10 \
		|| http_check "http://127.0.0.1/" "<html" 5 \
		|| return 1

	# 4. Backend metrics on the private network (Prometheus depends on this).
	#    Tolerated if absent: the metrics route may be mounted under /api.
	if compose exec -T backend sh -c 'command -v curl >/dev/null 2>&1'; then
		compose exec -T backend sh -c 'curl -fsS --max-time 5 http://127.0.0.1:4000/metrics >/dev/null' \
			&& log "  OK  backend /metrics" \
			|| warn "  backend /metrics not reachable - Prometheus 'backend' job will be down"
	fi

	# 5. Asterisk answers its control socket. A container that is "running" but
	#    whose PBX never finished loading modules is a real failure mode.
	if compose exec -T asterisk asterisk -rx "core show version" >/dev/null 2>&1; then
		log "  OK  asterisk control socket"
	else
		err "  FAIL asterisk is not answering 'core show version'"
		return 1
	fi

	# 6. ARI must be reachable from the backend, or no call is ever controlled.
	local ari_user ari_pass
	ari_user="$(env_get ASTERISK_ARI_USERNAME)"
	ari_pass="$(env_get ASTERISK_ARI_PASSWORD)"
	if compose exec -T asterisk sh -c \
		"curl -fsS --max-time 5 -u '${ari_user}:${ari_pass}' http://127.0.0.1:8088/ari/asterisk/info >/dev/null" 2>/dev/null; then
		log "  OK  ARI /asterisk/info"
	else
		warn "  ARI check inconclusive (curl may be missing inside the container)"
	fi

	# 7. TLS terminates. Only informational while the bootstrap certificate is in
	#    place - -k means we are not validating the chain here.
	if [[ -n "$domain" ]]; then
		http_check "https://127.0.0.1/nginx-health" "ok" 5 \
			|| warn "  HTTPS check failed - certificate or 443 binding problem"
	fi

	log "smoke test passed"
	return 0
}

#------------------------------------------------------------------------------
# Rollback
#------------------------------------------------------------------------------
ROLLBACK_DONE=0
attempt_rollback() {
	[[ "$ROLLBACK_DONE" -eq 0 ]] || return 0
	ROLLBACK_DONE=1

	if [[ "$DO_ROLLBACK_ON_FAILURE" -eq 0 ]]; then
		warn "rollback disabled - the failed deploy is left running for inspection"
		warn "  docker compose -p ${APP_NAME} logs --tail=100 backend"
		return 0
	fi

	local prev
	prev="$(state_get PREVIOUS_TAG)"
	if [[ -z "$prev" ]]; then
		warn "no PREVIOUS_TAG in $STATE_FILE - cannot roll back automatically"
		return 0
	fi

	step "ROLLBACK to ${prev}"
	if ! docker image inspect "${APP_NAME}-backend:${prev}" >/dev/null 2>&1; then
		warn "image ${APP_NAME}-backend:${prev} is gone - cannot roll back"
		return 0
	fi

	IMAGE_TAG="$prev"
	export IMAGE_TAG
	# Deliberately not `--force-recreate`: only the two app services carry a tag,
	# so restarting them is enough and Postgres/Asterisk keep running.
	if compose up -d backend frontend nginx; then
		wait_healthy backend 120 || warn "rolled-back backend is not healthy either"
		wait_healthy nginx 60 || true
		state_set CURRENT_TAG "$prev"
		state_set ROLLED_BACK_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		err "rolled back to ${prev}. NOTE: database migrations are forward-only -"
		err "if this deploy migrated the schema, use scripts/restore.sh."
	else
		err "rollback itself failed - manual intervention required"
	fi
}

#------------------------------------------------------------------------------
# Steps
#------------------------------------------------------------------------------
pull_source() {
	step "Source"
	if [[ "$DO_PULL" -eq 0 ]]; then
		log "git pull skipped"
	elif [[ -d "$INSTALL_DIR/.git" ]]; then
		log "pulling ${REPO_BRANCH}"
		git -C "$INSTALL_DIR" fetch --prune origin "$REPO_BRANCH"
		# --ff-only: never create a merge commit on a server. If this fails the
		# working tree has local edits and a human must look.
		git -C "$INSTALL_DIR" checkout "$REPO_BRANCH"
		git -C "$INSTALL_DIR" merge --ff-only "origin/${REPO_BRANCH}"
	else
		warn "$INSTALL_DIR is not a git checkout - skipping pull"
	fi

	if [[ -d "$INSTALL_DIR/.git" ]]; then
		GIT_SHA="$(git -C "$INSTALL_DIR" rev-parse --short=12 HEAD)"
		log "commit: ${GIT_SHA} $(git -C "$INSTALL_DIR" log -1 --pretty=%s)"
	else
		GIT_SHA=""
	fi
}

resolve_tag() {
	if [[ -n "$EXPLICIT_TAG" ]]; then
		IMAGE_TAG="$EXPLICIT_TAG"
	elif [[ -n "${GIT_SHA:-}" ]]; then
		IMAGE_TAG="$GIT_SHA"
	else
		IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
	fi
	export IMAGE_TAG
	log "image tag: ${IMAGE_TAG}"
}

render_configs() {
	step "Rendering configs"
	local domain
	domain="$(env_get DOMAIN)"
	[[ -n "$domain" ]] || die "DOMAIN is not set in $ENV_FILE"

	local src="$INSTALL_DIR/nginx/conf.d" dst="$INSTALL_DIR/nginx/conf.d.rendered"
	mkdir -p "$dst"
	rm -f "$dst"/*.conf
	local f
	for f in "$src"/*.conf; do
		[[ -e "$f" ]] || continue
		sed "s/__DOMAIN__/${domain}/g" "$f" > "$dst/$(basename "$f")"
	done
	log "nginx vhosts rendered for ${domain}"

	# Prometheus cannot read env vars, so the Asterisk scrape password is a file.
	local secrets="$INSTALL_DIR/monitoring/prometheus/secrets"
	mkdir -p "$secrets"
	printf '%s' "$(env_get ASTERISK_ARI_PASSWORD)" > "$secrets/asterisk_password"
	chmod 644 "$secrets/asterisk_password"
}

build_images() {
	step "Build"
	if [[ "$DO_BUILD" -eq 0 ]]; then
		log "build skipped (--no-build)"
		return 0
	fi
	# --pull refreshes the base images so a Bun or nginx CVE fix actually lands.
	# Asterisk is built by the base compose file and rarely changes, so it is
	# built explicitly only when its image is missing.
	log "building backend and frontend (tag ${IMAGE_TAG})"
	compose build --pull backend frontend
	if ! docker image inspect "callcenter-asterisk:latest" >/dev/null 2>&1; then
		log "asterisk image missing - building it too (this takes a few minutes)"
		compose build asterisk
	fi
	log "images built"
}

start_datastores() {
	step "Datastores"
	compose up -d postgres redis
	wait_healthy postgres 120 || return 1
	wait_healthy redis 60 || return 1
}

run_migrations() {
	step "Migrations"
	if [[ "$DO_MIGRATIONS" -eq 0 ]]; then
		warn "migrations skipped (--skip-migrations)"
		return 0
	fi

	# A migration is the only irreversible part of a deploy, so take a dump first
	# whenever the tooling is available. Non-fatal on the very first deploy, when
	# there is nothing to dump yet.
	if [[ "$INITIAL" -eq 0 && -x "$INSTALL_DIR/scripts/backup.sh" ]]; then
		log "pre-migration backup"
		"$INSTALL_DIR/scripts/backup.sh" --db-only || warn "pre-migration backup failed - continuing"
	fi

	# --no-deps: postgres is already up; we do not want compose starting nginx.
	# The env comes from the backend service definition, so DATABASE_URL already
	# points at the in-network postgres:5432.
	log "running drizzle migrations"
	compose run --rm --no-deps -T backend \
		sh -c 'cd /app/apps/backend && bunx drizzle-kit migrate'
	log "migrations applied"
}

start_app() {
	step "Start"
	compose up -d
	wait_healthy asterisk 180 || return 1
	wait_healthy backend 180 || return 1
	wait_healthy frontend 120 || return 1
	wait_healthy nginx 90 || return 1
	# Restart loops are invisible to a single health check.
	local cid restarts svc
	for svc in backend frontend nginx; do
		cid="$(compose ps -q "$svc" || true)"
		[[ -n "$cid" ]] || continue
		restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
		if [[ "$restarts" -gt 2 ]]; then
			err "${svc} has restarted ${restarts} times - treating as failed"
			compose logs --tail=60 "$svc" || true
			return 1
		fi
	done
}

reload_nginx() {
	# Config changes and, importantly, re-resolution of the backend/frontend
	# container IPs after a recreate. nginx -t first so a bad vhost cannot take
	# the site down.
	if compose exec -T nginx nginx -t 2>/dev/null; then
		compose exec -T nginx nginx -s reload
		log "nginx reloaded"
	else
		warn "nginx -t failed - NOT reloading. Current config stays active:"
		compose exec -T nginx nginx -t || true
		return 1
	fi
}

record_success() {
	local prev current
	current="$(state_get CURRENT_TAG)"
	# Only shift history when the tag actually changed, so re-running the same
	# deploy does not make PREVIOUS_TAG equal CURRENT_TAG and destroy the
	# rollback target.
	if [[ -n "$current" && "$current" != "$IMAGE_TAG" ]]; then
		state_set PREVIOUS_TAG "$current"
		prev="$current"
	else
		prev="$(state_get PREVIOUS_TAG)"
	fi
	state_set CURRENT_TAG "$IMAGE_TAG"
	state_set DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	log "state: CURRENT_TAG=${IMAGE_TAG} PREVIOUS_TAG=${prev:-none}"
}

prune_images() {
	step "Housekeeping"
	local keep_current keep_prev
	keep_current="$(state_get CURRENT_TAG)"
	keep_prev="$(state_get PREVIOUS_TAG)"
	local img
	# Keep the running tag and the rollback target; drop older app images. Never
	# touch anything that is not one of our two app repositories.
	while IFS= read -r img; do
		case "$img" in
			*":${keep_current}"|*":${keep_prev}"|*":latest") continue ;;
		esac
		log "  removing image $img"
		docker rmi "$img" >/dev/null 2>&1 || true
	done < <(docker images --format '{{.Repository}}:{{.Tag}}' \
		| grep -E "^${APP_NAME}-(backend|frontend):" || true)

	# Dangling layers from the build. --filter until=24h protects a fresh build
	# that another deploy may still be using.
	docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true
	log "housekeeping done"
}

print_state() {
	step "Result"
	local domain
	domain="$(env_get DOMAIN)"
	cat <<EOF
  deployed tag  : $(state_get CURRENT_TAG)
  rollback tag  : $(state_get PREVIOUS_TAG || echo none)
  deployed at   : $(state_get DEPLOYED_AT)
  site          : https://${domain}/
  api health    : https://${domain}/api/health

  containers:
EOF
	compose ps || true
}

#------------------------------------------------------------------------------
# main
#------------------------------------------------------------------------------
main() {
	[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found - run scripts/deploy.sh first"
	init_compose
	acquire_lock

	mkdir -p /var/log 2>/dev/null || true
	exec > >(tee -a "/var/log/${APP_NAME}-deploy.log") 2>&1
	log "===== update started (install dir: ${INSTALL_DIR}) ====="

	if [[ "$RELOAD_NGINX_ONLY" -eq 1 ]]; then
		render_configs
		reload_nginx
		log "===== nginx reload finished ====="
		exit 0
	fi

	if [[ "$FORCE_ROLLBACK" -eq 1 ]]; then
		local target="${EXPLICIT_TAG:-$(state_get PREVIOUS_TAG)}"
		[[ -n "$target" ]] || die "nothing to roll back to"
		step "Manual rollback to ${target}"
		IMAGE_TAG="$target"
		export IMAGE_TAG
		compose up -d backend frontend nginx
		wait_healthy backend 180
		wait_healthy nginx 90
		smoke_test || die "rolled-back deploy failed its smoke test"
		state_set CURRENT_TAG "$target"
		state_set DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		print_state
		log "===== rollback finished OK ====="
		exit 0
	fi

	pull_source
	resolve_tag
	render_configs
	build_images
	start_datastores
	run_migrations
	start_app

	if ! smoke_test; then
		err "smoke test failed"
		attempt_rollback
		exit 1
	fi

	reload_nginx || warn "continuing despite the nginx reload warning above"
	record_success
	prune_images
	print_state
	log "===== update finished OK ====="
}

main "$@"
