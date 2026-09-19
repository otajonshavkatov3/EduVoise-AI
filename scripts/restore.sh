#!/usr/bin/env bash
#==============================================================================
# restore.sh - restore a CallCenter "Aqlli Shahar" backup produced by backup.sh
#
# TZ.md sets RTO = 4 hours; in practice a full restore of a single-node install
# is a few minutes, and most of that is pg_restore. The dangerous part is not
# speed but accidents, so this script:
#
#   * refuses to touch the live database without an explicit confirmation,
#   * takes a SAFETY DUMP of the current state first (so a wrong restore is
#     itself reversible),
#   * stops the backend while the database is being replaced, preventing a
#     half-restored schema from being written to,
#   * verifies the result (table + row counts) before declaring success,
#   * restores recordings without ever overwriting a newer live file.
#
# USAGE
#   restore.sh --list
#   restore.sh --latest --yes                       # full DR restore
#   restore.sh --file /var/backups/.../x.dump.gz --target-db callcenter_dr
#   restore.sh --latest --recordings --yes          # database + recordings
#   restore.sh --recordings-only --yes
#
# EXIT CODES
#   0 success   1 failure   2 usage error   3 another run in progress
#==============================================================================
set -euo pipefail
IFS=$'\n\t'

#------------------------------------------------------------------------------
# Configuration
#------------------------------------------------------------------------------
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"

ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/callcenter}"
DUMP_DIR="${DUMP_DIR:-$BACKUP_ROOT/postgres}"
RECORDINGS_MIRROR="${RECORDINGS_MIRROR:-$BACKUP_ROOT/recordings}"
LOG_DIR="${LOG_DIR:-$BACKUP_ROOT/logs}"
SAFETY_DIR="${SAFETY_DIR:-$BACKUP_ROOT/pre-restore}"

LOCK_FILE="${LOCK_FILE:-/var/lock/callcenter-restore.lock}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
START_EPOCH="$(date -u +%s)"

DUMP_FILE=""
USE_LATEST=0
TARGET_DB=""
DO_LIST=0
DO_DB=1
DO_RECORDINGS=0
ASSUME_YES=0
STOP_BACKEND=1
SAFETY_DUMP=1
OVERWRITE_RECORDINGS=0

log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "INFO " "$*"; }
warn() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "WARN " "$*" >&2; }
err()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "ERROR" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
	cat <<'EOF'
Usage: restore.sh [--latest | --file PATH] [options]

  --list                    show available dumps (newest first) and exit
  --latest                  use $DUMP_DIR/latest.dump.gz
  --file PATH               use a specific .dump.gz
  --target-db NAME          restore into NAME instead of the live database
                            (creates it; the live database is left untouched)
  --recordings              also restore recordings from the mirror
  --recordings-only         restore recordings only, skip the database
  --overwrite-recordings    let mirrored files replace newer live files
  --no-stop                 do not stop the backend container during the restore
  --no-safety-dump          skip the pre-restore dump of the current state
  -y, --yes                 non-interactive; required from cron
  -h, --help                this text
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--list)                 DO_LIST=1 ;;
		--latest)               USE_LATEST=1 ;;
		--file)                 shift; [[ $# -gt 0 ]] || { err "--file needs a path"; exit 2; }; DUMP_FILE="$1" ;;
		--target-db)            shift; [[ $# -gt 0 ]] || { err "--target-db needs a name"; exit 2; }; TARGET_DB="$1" ;;
		--recordings)           DO_RECORDINGS=1 ;;
		--recordings-only)      DO_RECORDINGS=1; DO_DB=0 ;;
		--overwrite-recordings) OVERWRITE_RECORDINGS=1 ;;
		--no-stop)              STOP_BACKEND=0 ;;
		--no-safety-dump)       SAFETY_DUMP=0 ;;
		-y|--yes)               ASSUME_YES=1 ;;
		-h|--help)              usage; exit 0 ;;
		*)                      err "unknown option: $1"; usage; exit 2 ;;
	esac
	shift
done

on_err() {
	local exit_code=$? line=${1:-?}
	err "FAILED at ${SCRIPT_PATH}:${line} (exit ${exit_code})"
	err "the database may be in a partially restored state - read the log above"
	exit "$exit_code"
}
trap 'on_err $LINENO' ERR

BACKEND_WAS_STOPPED=0
CLEANUP_CONTAINER_TMP=""
on_exit() {
	if [[ -n "$CLEANUP_CONTAINER_TMP" ]]; then
		pg_shell "rm -f '$CLEANUP_CONTAINER_TMP'" >/dev/null 2>&1 || true
	fi
	# Always try to bring the backend back, even after a failure: an outage that
	# outlives the incident is a second incident.
	if [[ "$BACKEND_WAS_STOPPED" -eq 1 ]]; then
		log "restarting backend"
		compose up -d backend >/dev/null 2>&1 || warn "could not restart backend - do it manually"
	fi
}
trap on_exit EXIT

#------------------------------------------------------------------------------
# Shared helpers (same contract as backup.sh)
#------------------------------------------------------------------------------
load_env() {
	[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
	local tmp
	tmp="$(mktemp)"
	grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
		| sed -E 's/^[[:space:]]*//' > "$tmp"
	set -a
	# shellcheck disable=SC1090
	. "$tmp"
	set +a
	rm -f "$tmp"
}

COMPOSE_ARGS=()
compose() {
	docker compose --project-directory "$PROJECT_DIR" "${COMPOSE_ARGS[@]}" "$@"
}

detect_pg_mode() {
	COMPOSE_ARGS=(-f "$PROJECT_DIR/docker-compose.yml")
	if [[ -f "$PROJECT_DIR/docker-compose.prod.yml" ]]; then
		COMPOSE_ARGS+=(-f "$PROJECT_DIR/docker-compose.prod.yml")
	fi

	if command -v docker >/dev/null 2>&1 \
		&& compose ps --services --status running 2>/dev/null | grep -qx postgres; then
		PG_MODE=docker
		log "postgres mode: docker (compose service 'postgres')"
	elif command -v pg_restore >/dev/null 2>&1; then
		PG_MODE=local
		log "postgres mode: local client tools"
	else
		die "no running postgres container and no local pg_restore available"
	fi
}

parse_database_url() {
	local url="${DATABASE_URL:-}"
	[[ -n "$url" ]] || die "DATABASE_URL is not set"
	local re='^postgres(ql)?://([^:]+):([^@]*)@([^:/]+):([0-9]+)/([^?]+)'
	[[ "$url" =~ $re ]] || die "cannot parse DATABASE_URL"
	PGUSER_="${BASH_REMATCH[2]}"
	PGPASSWORD_="${BASH_REMATCH[3]}"
	PGHOST_="${BASH_REMATCH[4]}"
	PGPORT_="${BASH_REMATCH[5]}"
	PGDATABASE_="${BASH_REMATCH[6]}"
}

pg_env() {
	if [[ "$PG_MODE" == docker ]]; then
		DB_USER="${POSTGRES_USER:-myapp}"
		LIVE_DB="${POSTGRES_DB:-myapp}"
	else
		parse_database_url
		DB_USER="$PGUSER_"
		LIVE_DB="$PGDATABASE_"
		export PGPASSWORD="$PGPASSWORD_"
	fi
	RESTORE_DB="${TARGET_DB:-$LIVE_DB}"
	log "live database: ${LIVE_DB}; restore target: ${RESTORE_DB}"
}

psql_cmd() {
	local db="$1"; shift
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres psql -v ON_ERROR_STOP=1 -qtAX -U "$DB_USER" -d "$db" "$@"
	else
		psql -v ON_ERROR_STOP=1 -qtAX -h "$PGHOST_" -p "$PGPORT_" -U "$DB_USER" -d "$db" "$@"
	fi
}

pg_shell() {
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres sh -c "$1"
	else
		sh -c "$1"
	fi
}

pg_dump_to() {
	local db="$1" out="$2"
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres pg_dump -U "$DB_USER" -d "$db" -Fc -Z0 --no-owner --no-privileges | gzip -6 > "$out"
	else
		pg_dump -h "$PGHOST_" -p "$PGPORT_" -U "$DB_USER" -d "$db" -Fc -Z0 --no-owner --no-privileges | gzip -6 > "$out"
	fi
}

pg_restore_cmd() {
	local db="$1" file="$2"
	# --single-transaction + --exit-on-error: either the whole schema and data
	# land, or nothing does. A half-restored database is the worst outcome
	# because the app will happily start on it.
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres pg_restore -U "$DB_USER" -d "$db" \
			--no-owner --no-privileges --single-transaction --exit-on-error "$file"
	else
		pg_restore -h "$PGHOST_" -p "$PGPORT_" -U "$DB_USER" -d "$db" \
			--no-owner --no-privileges --single-transaction --exit-on-error "$file"
	fi
}

acquire_lock() {
	mkdir -p "$(dirname "$LOCK_FILE")"
	exec 9>"$LOCK_FILE"
	if ! flock -n 9; then
		err "another restore run holds $LOCK_FILE - aborting"
		exit 3
	fi
}

#------------------------------------------------------------------------------
# Dump selection
#------------------------------------------------------------------------------
list_dumps() {
	log "dumps in $DUMP_DIR (newest first):"
	if ! find "$DUMP_DIR" -maxdepth 1 -type f -name '*.dump.gz' | grep -q .; then
		warn "  (none)"
		return 0
	fi
	local f
	while IFS= read -r f; do
		printf '    %s  %8s  %s\n' \
			"$(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)" \
			"$(du -h "$f" | cut -f1)" \
			"$(basename "$f")"
	done < <(find "$DUMP_DIR" -maxdepth 1 -type f -name '*.dump.gz' -printf '%T@ %p\n' \
		| sort -rn | cut -d' ' -f2-)
}

resolve_dump() {
	if [[ "$USE_LATEST" -eq 1 ]]; then
		DUMP_FILE="$DUMP_DIR/latest.dump.gz"
		# latest.dump.gz is a symlink written by backup.sh; resolve it so the log
		# names the real archive.
		[[ -e "$DUMP_FILE" ]] || die "no latest.dump.gz in $DUMP_DIR - run backup.sh first"
		DUMP_FILE="$(readlink -f "$DUMP_FILE")"
	fi
	[[ -n "$DUMP_FILE" ]] || { err "specify --latest or --file PATH"; usage; exit 2; }
	[[ -f "$DUMP_FILE" ]] || die "dump not found: $DUMP_FILE"

	log "selected dump: $DUMP_FILE"
	log "  size    : $(du -h "$DUMP_FILE" | cut -f1)"
	log "  modified: $(date -u -r "$DUMP_FILE" +%Y-%m-%dT%H:%M:%SZ)"

	# Cheap integrity gate before anything destructive happens.
	gzip -t "$DUMP_FILE" || die "gzip integrity check FAILED - this archive is corrupt"
	log "  gzip integrity: OK"
}

confirm() {
	if [[ "$ASSUME_YES" -eq 1 ]]; then
		return 0
	fi
	if [[ ! -t 0 ]]; then
		die "not a terminal and --yes was not given - refusing to continue"
	fi
	local answer
	echo
	echo "  About to REPLACE database '${RESTORE_DB}' with:"
	echo "    ${DUMP_FILE}"
	if [[ "$RESTORE_DB" == "$LIVE_DB" ]]; then
		echo "  This is the LIVE database. All data written since the dump will be LOST."
	fi
	echo
	printf "  Type the database name to continue: "
	read -r answer
	[[ "$answer" == "$RESTORE_DB" ]] || die "confirmation did not match - nothing was changed"
}

#------------------------------------------------------------------------------
# Database restore
#------------------------------------------------------------------------------
safety_dump() {
	[[ "$SAFETY_DUMP" -eq 1 ]] || { warn "safety dump skipped (--no-safety-dump)"; return 0; }

	# Only meaningful if the target already exists.
	if [[ "$(psql_cmd postgres -c "SELECT 1 FROM pg_database WHERE datname='${RESTORE_DB}';")" != "1" ]]; then
		log "target database does not exist yet - no safety dump needed"
		return 0
	fi

	mkdir -p "$SAFETY_DIR"
	chmod 700 "$SAFETY_DIR" 2>/dev/null || true
	local out="$SAFETY_DIR/pre-restore-${RESTORE_DB}-${TS}.dump.gz"
	log "taking safety dump of current '${RESTORE_DB}' -> $out"
	pg_dump_to "$RESTORE_DB" "$out"
	gzip -t "$out" || die "safety dump failed its integrity check - aborting before restore"
	log "safety dump OK ($(du -h "$out" | cut -f1)). To undo this restore:"
	log "  $SCRIPT_PATH --file $out --yes"
}

stop_backend() {
	[[ "$STOP_BACKEND" -eq 1 ]] || { warn "backend left running (--no-stop)"; return 0; }
	[[ "$PG_MODE" == docker ]] || return 0
	# Only stop it if it is actually up, so a DR restore on a fresh host does not
	# fail here.
	if compose ps --services --status running 2>/dev/null | grep -qx backend; then
		log "stopping backend so nothing writes during the restore"
		compose stop backend >/dev/null
		BACKEND_WAS_STOPPED=1
	else
		log "backend is not running - nothing to stop"
	fi
}

recreate_database() {
	log "recreating database '${RESTORE_DB}'"
	# Kill every session first: DROP DATABASE fails with "is being accessed by
	# other users" otherwise, and after stopping the backend the leftovers are
	# usually psql shells and the metrics exporter.
	psql_cmd postgres -c \
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${RESTORE_DB}' AND pid <> pg_backend_pid();" \
		>/dev/null || true
	psql_cmd postgres -c "DROP DATABASE IF EXISTS \"${RESTORE_DB}\";" >/dev/null
	psql_cmd postgres -c "CREATE DATABASE \"${RESTORE_DB}\" OWNER \"${DB_USER}\";" >/dev/null
	log "empty database created"
}

restore_database() {
	local container_tmp="/tmp/callcenter-restore-${TS}.dump"
	CLEANUP_CONTAINER_TMP="$container_tmp"

	log "staging archive for pg_restore"
	gunzip -c "$DUMP_FILE" | pg_shell "cat > '$container_tmp'"

	log "restoring (single transaction, exit on first error)"
	pg_restore_cmd "$RESTORE_DB" "$container_tmp" \
		|| die "pg_restore FAILED - '${RESTORE_DB}' is empty, nothing was half-written"

	pg_shell "rm -f '$container_tmp'" >/dev/null 2>&1 || true
	CLEANUP_CONTAINER_TMP=""
	log "pg_restore completed"
}

verify_restore() {
	log "verifying restored database"
	local tables
	tables="$(psql_cmd "$RESTORE_DB" -c \
		"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")"
	log "  tables: ${tables}"
	[[ "$tables" -gt 0 ]] || die "restored database has no tables"

	# The platform is unusable without at least one active user, so this doubles
	# as a smoke test of the restore.
	local t n
	for t in users operator_profiles contacts calls tickets ai_sessions call_transcripts; do
		if [[ "$(psql_cmd "$RESTORE_DB" -c "SELECT to_regclass('public.${t}') IS NOT NULL;")" != "t" ]]; then
			warn "  ${t}: table absent from this dump"
			continue
		fi
		n="$(psql_cmd "$RESTORE_DB" -c "SELECT count(*) FROM public.${t};")"
		log "  ${t}: ${n} rows"
		if [[ "$t" == "users" && "$n" -eq 0 ]]; then
			die "no users restored - nobody could log in; treat this dump as broken"
		fi
	done

	# Migrations table sanity: drizzle records applied migrations here, and a
	# mismatch with the code is the usual cause of a "restored but broken" app.
	if [[ "$(psql_cmd "$RESTORE_DB" -c "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL;")" == "t" ]]; then
		local mig
		mig="$(psql_cmd "$RESTORE_DB" -c "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
		log "  applied migrations in dump: ${mig}"
		log "  run 'bun run db:migrate' after starting the backend if the code is newer"
	fi
	log "verification PASSED"
}

#------------------------------------------------------------------------------
# Recordings restore
#------------------------------------------------------------------------------
restore_recordings() {
	local dest="${RECORDINGS_DIR:-./apps/backend/uploads/call-recordings}"
	case "$dest" in
		/*) ;;
		*) dest="$PROJECT_DIR/${dest#./}" ;;
	esac

	[[ -d "$RECORDINGS_MIRROR" ]] || { warn "no recordings mirror at $RECORDINGS_MIRROR - skipping"; return 0; }
	command -v rsync >/dev/null 2>&1 || die "rsync is required (apt-get install -y rsync)"

	mkdir -p "$dest"
	log "restoring recordings: $RECORDINGS_MIRROR -> $dest"

	local -a flags=(-a --human-readable --stats)
	if [[ "$OVERWRITE_RECORDINGS" -eq 1 ]]; then
		warn "  --overwrite-recordings: live files WILL be replaced by mirrored copies"
	else
		# Default: only fill gaps. A recording produced after the backup must
		# never be clobbered by an older mirrored copy.
		flags+=(--ignore-existing)
		log "  mode: fill gaps only (existing live files are kept)"
	fi

	rsync "${flags[@]}" "$RECORDINGS_MIRROR"/ "$dest"/ | sed 's/^/    /'

	# The backend serves these; ownership must match the container user or the
	# uploads route returns 403. 1000:1000 is the oven/bun image's `bun` user.
	if [[ -n "${RECORDINGS_OWNER:-}" ]]; then
		log "  chown -R ${RECORDINGS_OWNER} $dest"
		chown -R "$RECORDINGS_OWNER" "$dest"
	fi
	log "recordings restored"
}

#------------------------------------------------------------------------------
# main
#------------------------------------------------------------------------------
main() {
	load_env
	detect_pg_mode
	pg_env

	if [[ "$DO_LIST" -eq 1 ]]; then
		list_dumps
		exit 0
	fi

	acquire_lock
	mkdir -p "$LOG_DIR"
	local run_log="$LOG_DIR/restore-${TS}.log"
	exec > >(tee -a "$run_log") 2>&1

	log "===== CallCenter restore started (${TS}) ====="

	if [[ "$DO_DB" -eq 1 ]]; then
		resolve_dump
		confirm
		safety_dump
		stop_backend
		recreate_database
		restore_database
		verify_restore
	else
		log "database step skipped (--recordings-only)"
	fi

	if [[ "$DO_RECORDINGS" -eq 1 ]]; then
		restore_recordings
	fi

	log "===== restore finished OK in $(( $(date -u +%s) - START_EPOCH ))s ====="
	log "next steps:"
	log "  1. docker compose ... up -d          (backend restarts automatically)"
	log "  2. curl -fsS http://127.0.0.1:4000/api/health"
	log "  3. spot-check a recent call and its recording in the dashboard"
}

main "$@"
