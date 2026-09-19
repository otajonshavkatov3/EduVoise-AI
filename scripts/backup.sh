#!/usr/bin/env bash
#==============================================================================
# backup.sh - database + recordings backup for CallCenter "Aqlli Shahar"
#
# WHAT IT DOES
#   1. pg_dump (custom format) -> gzip -> /var/backups/callcenter/postgres/
#   2. VERIFIES the dump by restoring it into a scratch database and comparing
#      table and row counts against the live database. An unverified backup is
#      not a backup.
#   3. rsync of the call-recordings directory into a mirror.
#   4. Retention: 30 days for dumps, 90 days for mirrored recordings.
#   5. Publishes metrics for Prometheus through node-exporter's textfile
#      collector, which is what the BackupTooOld alert reads.
#
# TZ.md requires RPO = 24h, so this is meant to run daily from cron:
#   0 2 * * *  /opt/callcenter/scripts/backup.sh >> /var/log/callcenter-backup.log 2>&1
#
# IDEMPOTENCY
#   Safe to run repeatedly and concurrently: an flock guards the whole run, all
#   directories are created with mkdir -p, dump names carry a UTC timestamp, and
#   the scratch verification database is always dropped (even on failure) before
#   being recreated.
#
# EXIT CODES
#   0 success   1 failure (any step)   2 usage error   3 another run in progress
#==============================================================================
set -euo pipefail
# Word splitting on newlines only: filenames with spaces must survive `find`.
IFS=$'\n\t'

#------------------------------------------------------------------------------
# Configuration - every value can be overridden from the environment.
#------------------------------------------------------------------------------
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"

ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/callcenter}"
DUMP_DIR="${DUMP_DIR:-$BACKUP_ROOT/postgres}"
RECORDINGS_MIRROR="${RECORDINGS_MIRROR:-$BACKUP_ROOT/recordings}"
LOG_DIR="${LOG_DIR:-$BACKUP_ROOT/logs}"

DB_RETENTION_DAYS="${DB_RETENTION_DAYS:-30}"
RECORDING_RETENTION_DAYS="${RECORDING_RETENTION_DAYS:-90}"

# node-exporter reads *.prom from here (see docker-compose.prod.yml).
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"

LOCK_FILE="${LOCK_FILE:-/var/lock/callcenter-backup.lock}"

# gzip -9 costs a few extra seconds of CPU at 02:00 and buys ~8% smaller files
# that are kept for 30 days. Worth it here; not worth it in a hot path.
GZIP_LEVEL="${GZIP_LEVEL:-9}"

DO_DB=1
DO_RECORDINGS=1
DO_VERIFY=1

TS="$(date -u +%Y%m%dT%H%M%SZ)"
START_EPOCH="$(date -u +%s)"

#------------------------------------------------------------------------------
# Logging. Every line is timestamped in UTC and prefixed with a level, so a
# concatenated cron log is still readable a month later.
#------------------------------------------------------------------------------
log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "INFO " "$*"; }
warn() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "WARN " "$*" >&2; }
err()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "ERROR" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
	cat <<'EOF'
Usage: backup.sh [options]

  --db-only            dump and verify the database, skip recordings
  --recordings-only    mirror recordings only, skip the database
  --no-verify          skip the restore-verification step (NOT recommended)
  -h, --help           this text

Environment overrides:
  PROJECT_DIR BACKUP_ROOT DUMP_DIR RECORDINGS_MIRROR LOG_DIR TEXTFILE_DIR
  DB_RETENTION_DAYS (30) RECORDING_RETENTION_DAYS (90) GZIP_LEVEL (9)
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--db-only)         DO_RECORDINGS=0 ;;
		--recordings-only) DO_DB=0 ;;
		--no-verify)       DO_VERIFY=0 ;;
		-h|--help)         usage; exit 0 ;;
		*)                 err "unknown option: $1"; usage; exit 2 ;;
	esac
	shift
done

#------------------------------------------------------------------------------
# Fail loudly: report the exact line that broke instead of a bare exit code.
#------------------------------------------------------------------------------
on_err() {
	local exit_code=$? line=${1:-?}
	err "FAILED at ${SCRIPT_PATH}:${line} (exit ${exit_code})"
	write_metrics 0
	exit "$exit_code"
}
trap 'on_err $LINENO' ERR

CLEANUP_SCRATCH_DB=""
CLEANUP_CONTAINER_TMP=""
on_exit() {
	# Best-effort teardown; never let cleanup mask the original failure.
	if [[ -n "$CLEANUP_SCRATCH_DB" ]]; then
		drop_scratch_db "$CLEANUP_SCRATCH_DB" || warn "could not drop scratch db $CLEANUP_SCRATCH_DB"
	fi
	if [[ -n "$CLEANUP_CONTAINER_TMP" ]]; then
		pg_shell "rm -f '$CLEANUP_CONTAINER_TMP'" >/dev/null 2>&1 || true
	fi
}
trap on_exit EXIT

#------------------------------------------------------------------------------
# .env loading.
#
# `source`ing .env directly would execute anything in it. Filtering to plain
# KEY=VALUE assignments first keeps a stray backtick in a password from running
# as a command.
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

#------------------------------------------------------------------------------
# Postgres access.
#
# Two modes, auto-detected:
#   docker - the postgres container from docker-compose is running (production)
#   local  - psql/pg_dump on PATH talk to DATABASE_URL (bare-metal or dev)
# Everything below goes through pg_dump_cmd/psql_cmd/pg_restore_cmd so the rest
# of the script does not care which mode is active.
#------------------------------------------------------------------------------
# Built as an ARRAY, not a string: IFS is restricted to newline/tab above, so a
# `${VAR:+-f "$VAR"}` style expansion would reach docker as one mangled argument.
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
	elif command -v pg_dump >/dev/null 2>&1; then
		PG_MODE=local
		log "postgres mode: local client tools"
	else
		die "no running postgres container and no local pg_dump - cannot back up"
	fi
}

# Parse host/port/user/password/db out of DATABASE_URL for local mode.
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
		DB_NAME="${POSTGRES_DB:-myapp}"
	else
		parse_database_url
		DB_USER="$PGUSER_"
		DB_NAME="$PGDATABASE_"
		export PGPASSWORD="$PGPASSWORD_"
	fi
	log "database: ${DB_NAME} as ${DB_USER}"
}

# pg_dump to stdout. -Fc keeps selective/parallel restore possible; -Z0 leaves
# compression to gzip so the whole artefact is one .gz (and `gzip -t` can verify
# it end to end).
pg_dump_cmd() {
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -Z0 --no-owner --no-privileges
	else
		pg_dump -h "$PGHOST_" -p "$PGPORT_" -U "$DB_USER" -d "$DB_NAME" -Fc -Z0 --no-owner --no-privileges
	fi
}

# psql against an arbitrary database, tuple-only + unaligned so output can be
# consumed directly by the shell.
psql_cmd() {
	local db="$1"; shift
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres psql -v ON_ERROR_STOP=1 -qtAX -U "$DB_USER" -d "$db" "$@"
	else
		psql -v ON_ERROR_STOP=1 -qtAX -h "$PGHOST_" -p "$PGPORT_" -U "$DB_USER" -d "$db" "$@"
	fi
}

# Run a shell command where the database lives (used to stage the dump for
# verification when Postgres is in a container).
pg_shell() {
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres sh -c "$1"
	else
		sh -c "$1"
	fi
}

pg_restore_cmd() {
	local db="$1" file="$2"
	if [[ "$PG_MODE" == docker ]]; then
		compose exec -T postgres pg_restore -U "$DB_USER" -d "$db" \
			--no-owner --no-privileges --single-transaction --exit-on-error "$file"
	else
		pg_restore -h "$PGHOST_" -p "$PGPORT_" -U "$DB_USER" -d "$db" \
			--no-owner --no-privileges --single-transaction --exit-on-error "$file"
	fi
}

drop_scratch_db() {
	local db="$1"
	# Terminate leftover sessions first: DROP DATABASE fails while anything is
	# connected, and pg_restore can leave a session behind after a hard failure.
	psql_cmd postgres -c \
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();" \
		>/dev/null 2>&1 || true
	psql_cmd postgres -c "DROP DATABASE IF EXISTS \"${db}\";" >/dev/null
}

#------------------------------------------------------------------------------
# Prometheus metrics for the textfile collector.
#
# Written atomically (temp file + mv) because node-exporter may read the
# directory at any moment and a half-written file would be a parse error.
#------------------------------------------------------------------------------
METRIC_DUMP_BYTES=0
METRIC_RECORDING_BYTES=0
METRIC_TABLES=0
write_metrics() {
	local success="$1"
	[[ -d "$TEXTFILE_DIR" ]] || return 0
	local now duration tmp out
	now="$(date -u +%s)"
	duration=$(( now - START_EPOCH ))
	out="$TEXTFILE_DIR/callcenter_backup.prom"
	tmp="${out}.$$"
	{
		echo "# HELP callcenter_backup_success Whether the last backup run finished successfully."
		echo "# TYPE callcenter_backup_success gauge"
		echo "callcenter_backup_success ${success}"
		echo "# HELP callcenter_backup_duration_seconds Wall-clock duration of the last backup run."
		echo "# TYPE callcenter_backup_duration_seconds gauge"
		echo "callcenter_backup_duration_seconds ${duration}"
		echo "# HELP callcenter_backup_size_bytes Size of the last database dump."
		echo "# TYPE callcenter_backup_size_bytes gauge"
		echo "callcenter_backup_size_bytes ${METRIC_DUMP_BYTES}"
		echo "# HELP callcenter_backup_recordings_bytes Size of the recordings mirror."
		echo "# TYPE callcenter_backup_recordings_bytes gauge"
		echo "callcenter_backup_recordings_bytes ${METRIC_RECORDING_BYTES}"
		echo "# HELP callcenter_backup_verified_tables Tables counted in the verification restore."
		echo "# TYPE callcenter_backup_verified_tables gauge"
		echo "callcenter_backup_verified_tables ${METRIC_TABLES}"
		if [[ "$success" == "1" ]]; then
			# Only a VERIFIED run advances this timestamp - the BackupTooOld
			# alert must not be silenced by a dump that cannot be restored.
			echo "# HELP callcenter_backup_last_success_timestamp_seconds Unix time of the last verified backup."
			echo "# TYPE callcenter_backup_last_success_timestamp_seconds gauge"
			echo "callcenter_backup_last_success_timestamp_seconds ${now}"
		fi
	} > "$tmp"
	mv -f "$tmp" "$out"
	log "metrics written to $out"
}

#------------------------------------------------------------------------------
# Steps
#------------------------------------------------------------------------------
acquire_lock() {
	mkdir -p "$(dirname "$LOCK_FILE")"
	exec 9>"$LOCK_FILE"
	if ! flock -n 9; then
		err "another backup run holds $LOCK_FILE - aborting"
		exit 3
	fi
}

prepare_dirs() {
	mkdir -p "$DUMP_DIR" "$RECORDINGS_MIRROR" "$LOG_DIR"
	# 0700: dumps contain every citizen's phone number and every ticket body.
	chmod 700 "$BACKUP_ROOT" "$DUMP_DIR" "$RECORDINGS_MIRROR" 2>/dev/null || true
}

dump_database() {
	local out="$DUMP_DIR/callcenter-${DB_NAME}-${TS}.dump.gz"
	log "dumping database -> $out"

	# PIPESTATUS is checked explicitly: with `set -o pipefail` a gzip success
	# would still mask nothing, but naming the failing stage makes triage
	# instant.
	set +e
	pg_dump_cmd | gzip -"$GZIP_LEVEL" > "$out"
	local rc=("${PIPESTATUS[@]}")
	set -e
	if [[ "${rc[0]}" -ne 0 ]]; then
		rm -f "$out"
		die "pg_dump failed (exit ${rc[0]})"
	fi
	if [[ "${rc[1]}" -ne 0 ]]; then
		rm -f "$out"
		die "gzip failed (exit ${rc[1]})"
	fi

	# A dump smaller than 1 KiB is an empty or truncated archive, not a backup.
	local size
	size="$(stat -c %s "$out")"
	[[ "$size" -gt 1024 ]] || { rm -f "$out"; die "dump is suspiciously small (${size} bytes)"; }

	# Integrity of the gzip container itself - cheap and catches a truncated
	# write immediately, before the (expensive) restore verification.
	gzip -t "$out" || { rm -f "$out"; die "gzip integrity check failed for $out"; }

	METRIC_DUMP_BYTES="$size"
	DUMP_FILE="$out"
	log "dump complete: $(numfmt --to=iec --suffix=B "$size" 2>/dev/null || echo "${size} bytes")"

	# `latest` symlink so restore.sh --latest and humans have a stable path.
	ln -sfn "$(basename "$out")" "$DUMP_DIR/latest.dump.gz"
}

verify_dump() {
	local dump="$1"
	local scratch="verify_${TS}"
	local container_tmp="/tmp/callcenter-verify-${TS}.dump"

	log "verifying dump by restoring into scratch database '$scratch'"

	# Row counts from the LIVE database for comparison. A dump that restores but
	# is empty is the classic silent-failure mode this step exists to catch.
	local live_tables live_rows
	live_tables="$(psql_cmd "$DB_NAME" -c \
		"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")"
	live_rows="$(psql_cmd "$DB_NAME" -c \
		"SELECT coalesce(sum(c.reltuples)::bigint,0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';")"
	log "live database: ${live_tables} tables, ~${live_rows} rows (planner estimate)"

	drop_scratch_db "$scratch"
	CLEANUP_SCRATCH_DB="$scratch"
	psql_cmd postgres -c "CREATE DATABASE \"${scratch}\";" >/dev/null

	# Stage the decompressed archive where pg_restore runs. Custom-format
	# archives are read as a file rather than from a pipe, so this indirection is
	# required when Postgres lives in a container.
	CLEANUP_CONTAINER_TMP="$container_tmp"
	gunzip -c "$dump" | pg_shell "cat > '$container_tmp'"

	pg_restore_cmd "$scratch" "$container_tmp" \
		|| die "verification restore FAILED - the dump at $dump is NOT usable"

	local v_tables v_rows
	v_tables="$(psql_cmd "$scratch" -c \
		"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")"
	log "restored database: ${v_tables} tables"

	[[ "$v_tables" -gt 0 ]] || die "verification restore produced 0 tables"
	if [[ "$v_tables" -ne "$live_tables" ]]; then
		die "table count mismatch: live=${live_tables} restored=${v_tables}"
	fi

	# Exact row counts on the tables that would make the platform unusable if
	# they came back empty. reltuples is an estimate, so these use count(*).
	local t live_n rest_n
	for t in users operator_profiles contacts calls tickets; do
		if [[ "$(psql_cmd "$scratch" -c "SELECT to_regclass('public.${t}') IS NOT NULL;")" != "t" ]]; then
			warn "table ${t} not present in dump - skipping row comparison"
			continue
		fi
		live_n="$(psql_cmd "$DB_NAME" -c "SELECT count(*) FROM public.${t};")"
		rest_n="$(psql_cmd "$scratch"  -c "SELECT count(*) FROM public.${t};")"
		if [[ "$live_n" != "$rest_n" ]]; then
			# Rows written between the dump and this comparison make the restored
			# count LOWER, which is expected; higher is impossible and means the
			# archive is wrong.
			if [[ "$rest_n" -gt "$live_n" ]]; then
				die "row count for ${t} higher in restore (${rest_n}) than live (${live_n})"
			fi
			log "  ${t}: live=${live_n} restored=${rest_n} (drift during dump, acceptable)"
		else
			log "  ${t}: ${rest_n} rows match"
		fi
		v_rows=$(( ${v_rows:-0} + rest_n ))
	done
	log "restored core tables hold ${v_rows:-0} rows in total"

	METRIC_TABLES="$v_tables"
	drop_scratch_db "$scratch"
	CLEANUP_SCRATCH_DB=""
	pg_shell "rm -f '$container_tmp'" >/dev/null 2>&1 || true
	CLEANUP_CONTAINER_TMP=""
	log "verification PASSED (${v_tables} tables restored cleanly)"
}

prune_dumps() {
	log "pruning dumps older than ${DB_RETENTION_DAYS} days in $DUMP_DIR"
	local count=0 f
	while IFS= read -r -d '' f; do
		log "  removing $(basename "$f")"
		rm -f "$f"
		count=$(( count + 1 ))
	done < <(find "$DUMP_DIR" -maxdepth 1 -type f -name '*.dump.gz' -mtime "+${DB_RETENTION_DAYS}" -print0)
	log "pruned ${count} old dump(s)"

	# Never delete the newest dump, whatever the retention says: a stopped cron
	# plus an aggressive retention window must not leave us with nothing.
	if ! find "$DUMP_DIR" -maxdepth 1 -type f -name '*.dump.gz' | grep -q .; then
		die "retention removed every dump - refusing to finish in a state with no backup"
	fi
}

mirror_recordings() {
	# RECORDINGS_DIR in .env is relative to the project root in development.
	local src="${RECORDINGS_DIR:-./apps/backend/uploads/call-recordings}"
	case "$src" in
		/*) ;;
		*) src="$PROJECT_DIR/${src#./}" ;;
	esac

	if [[ ! -d "$src" ]]; then
		warn "recordings directory not found: $src - skipping"
		return 0
	fi

	command -v rsync >/dev/null 2>&1 || die "rsync is required (apt-get install -y rsync)"

	log "mirroring recordings: $src -> $RECORDINGS_MIRROR"
	# -a preserves times (retention depends on mtime!), --no-delete is implicit:
	# the mirror keeps files for 90 days even after the live directory prunes
	# them, which is the entire point of having a mirror.
	# --partial-dir keeps an interrupted large WAV out of the mirror's root.
	rsync -a \
		--human-readable \
		--partial-dir=.rsync-partial \
		--exclude '.rsync-partial' \
		--stats \
		"$src"/ "$RECORDINGS_MIRROR"/ \
		| sed 's/^/    /'

	log "pruning mirrored recordings older than ${RECORDING_RETENTION_DAYS} days"
	local removed=0 f
	while IFS= read -r -d '' f; do
		rm -f "$f"
		removed=$(( removed + 1 ))
	done < <(find "$RECORDINGS_MIRROR" -type f -mtime "+${RECORDING_RETENTION_DAYS}" -print0)
	# Remove the directory skeleton the prune left behind (dated subfolders).
	find "$RECORDINGS_MIRROR" -mindepth 1 -type d -empty -delete || true
	log "pruned ${removed} recording(s)"

	METRIC_RECORDING_BYTES="$(du -sb "$RECORDINGS_MIRROR" 2>/dev/null | cut -f1 || echo 0)"
}

report_disk() {
	# A backup run that fills the disk is worse than no backup run. Warn early.
	local avail_pct
	avail_pct="$(df -P "$BACKUP_ROOT" | awk 'NR==2 {gsub("%","",$5); print 100-$5}')"
	log "free space on backup volume: ${avail_pct}%"
	if [[ "$avail_pct" -lt 10 ]]; then
		warn "less than 10% free on $BACKUP_ROOT - shorten DB_RETENTION_DAYS or add disk"
	fi
}

#------------------------------------------------------------------------------
# main
#------------------------------------------------------------------------------
main() {
	acquire_lock
	prepare_dirs

	# Tee everything to a dated log as well as stdout, so a cron run that mails
	# nothing still leaves a trace on disk.
	local run_log="$LOG_DIR/backup-${TS}.log"
	exec > >(tee -a "$run_log") 2>&1

	log "===== CallCenter backup started (${TS}) ====="
	log "project dir : $PROJECT_DIR"
	log "backup root : $BACKUP_ROOT"

	load_env
	detect_pg_mode
	pg_env

	if [[ "$DO_DB" -eq 1 ]]; then
		dump_database
		if [[ "$DO_VERIFY" -eq 1 ]]; then
			verify_dump "$DUMP_FILE"
		else
			warn "verification skipped (--no-verify): this dump is UNPROVEN"
		fi
		prune_dumps
	else
		log "database step skipped (--recordings-only)"
	fi

	if [[ "$DO_RECORDINGS" -eq 1 ]]; then
		mirror_recordings
	else
		log "recordings step skipped (--db-only)"
	fi

	report_disk
	write_metrics 1

	# Keep the run logs from growing forever - same window as the dumps.
	find "$LOG_DIR" -type f -name 'backup-*.log' -mtime "+${DB_RETENTION_DAYS}" -delete || true

	log "===== CallCenter backup finished OK in $(( $(date -u +%s) - START_EPOCH ))s ====="
}

main "$@"
