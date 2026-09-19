#!/usr/bin/env bash
#==============================================================================
# deploy.sh - first-time provisioning + deploy of CallCenter "Aqlli Shahar"
#             on a fresh Ubuntu 24.04 LTS VPS.
#
# Run as root:
#     export DOMAIN=callcenter.example.uz
#     export REPO_URL=git@github.com:aqlli-shahar/callcenter.git
#     export LETSENCRYPT_EMAIL=admin@example.uz
#     export OPENAI_API_KEY=sk-...
#     bash deploy.sh
#
# WHAT IT DOES (every step is idempotent - re-running is safe and expected)
#   1. sanity-checks the host (Ubuntu 24.04, root, RAM, disk)
#   2. installs docker-ce + compose plugin, git, rsync, ufw, fail2ban, openssl
#   3. clones or updates the repository in /opt/callcenter
#   4. renders .env from .env.example, GENERATING every secret that is still a
#      placeholder and PRESERVING every value that already exists
#   5. renders nginx configs, the Prometheus scrape secret and a self-signed
#      bootstrap TLS certificate so nginx can start before certbot has run
#   6. installs the firewall rules and the fail2ban jails
#   7. installs the daily backup cron entry
#   8. hands the build/migrate/start/smoke-test/rollback cycle to update.sh
#
# WHAT IT DOES NOT DO
#   * request a real certificate - the DNS record must exist first; the exact
#     certbot command is printed at the end
#   * open 8088/5038/5434/6380 to the world (see config/firewall/ufw-rules.sh)
#
# EXIT CODES
#   0 success   1 failure   2 usage error   3 another run in progress
#==============================================================================
set -euo pipefail
IFS=$'\n\t'

#------------------------------------------------------------------------------
# Configuration
#------------------------------------------------------------------------------
APP_NAME="callcenter"
INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
REPO_URL="${REPO_URL:-}"
REPO_BRANCH="${REPO_BRANCH:-main}"

DOMAIN="${DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/${APP_NAME}}"
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
ASTERISK_LOG_DIR="${ASTERISK_LOG_DIR:-/var/log/asterisk}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/etc/letsencrypt}"
CERTBOT_WEBROOT="${CERTBOT_WEBROOT:-/var/www/certbot}"
NGINX_LOG_DIR="${NGINX_LOG_DIR:-/var/log/nginx}"

LOCK_FILE="/var/lock/${APP_NAME}-deploy.lock"
SKIP_APT="${SKIP_APT:-0}"
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"
SKIP_FAIL2BAN="${SKIP_FAIL2BAN:-0}"

log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "INFO " "$*"; }
warn() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "WARN " "$*" >&2; }
err()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "ERROR" "$*" >&2; }
die()  { err "$*"; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }

on_err() {
	local code=$? line=${1:-?}
	err "deploy FAILED at line ${line} (exit ${code})"
	err "nothing has been rolled back automatically at the provisioning stage -"
	err "fix the cause and re-run: every step is idempotent."
	exit "$code"
}
trap 'on_err $LINENO' ERR

usage() {
	cat <<'EOF'
Usage: DOMAIN=... REPO_URL=... deploy.sh [options]

  --domain NAME        public hostname (or DOMAIN env)
  --repo URL           git remote to clone (or REPO_URL env)
  --branch NAME        branch to deploy (default: main)
  --skip-apt           do not touch apt (host already provisioned)
  --skip-firewall      do not apply ufw rules
  --skip-fail2ban      do not install fail2ban jails
  -h, --help           this text
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--domain)        shift; DOMAIN="${1:-}" ;;
		--repo)          shift; REPO_URL="${1:-}" ;;
		--branch)        shift; REPO_BRANCH="${1:-main}" ;;
		--skip-apt)      SKIP_APT=1 ;;
		--skip-firewall) SKIP_FIREWALL=1 ;;
		--skip-fail2ban) SKIP_FAIL2BAN=1 ;;
		-h|--help)       usage; exit 0 ;;
		*)               err "unknown option: $1"; usage; exit 2 ;;
	esac
	shift
done

#------------------------------------------------------------------------------
# 1. Host checks
#------------------------------------------------------------------------------
check_host() {
	step "Host checks"

	[[ "$(id -u)" -eq 0 ]] || die "must run as root (sudo bash scripts/deploy.sh)"
	[[ -n "$DOMAIN" ]] || die "DOMAIN is required (e.g. DOMAIN=callcenter.example.uz)"

	if [[ -r /etc/os-release ]]; then
		# shellcheck disable=SC1091
		. /etc/os-release
		log "OS: ${PRETTY_NAME:-unknown}"
		if [[ "${ID:-}" != "ubuntu" ]]; then
			warn "this script targets Ubuntu; ${ID:-unknown} may need adjustments"
		elif [[ "${VERSION_ID:-}" != "24.04" ]]; then
			warn "tested on Ubuntu 24.04, found ${VERSION_ID:-unknown} - continuing"
		fi
	fi

	# Asterisk + Postgres + Bun + the monitoring stack need roughly 2 GB to be
	# comfortable. Below 1.6 GB the OOM killer starts picking on Postgres, which
	# looks like random data-loss bugs later.
	local mem_mb
	mem_mb="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
	log "RAM: ${mem_mb} MB"
	[[ "$mem_mb" -ge 1600 ]] || warn "less than 1.6 GB RAM - add swap or resize the VPS"

	local disk_gb
	disk_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
	log "free disk on /: ${disk_gb} GB"
	[[ "$disk_gb" -ge 20 ]] || warn "under 20 GB free - recordings will fill this fast"

	# Recordings and RTP are timing sensitive; a wrong clock also breaks JWT
	# expiry and TLS validation.
	if command -v timedatectl >/dev/null 2>&1; then
		timedatectl set-timezone "${HOST_TIMEZONE:-Asia/Tashkent}" || warn "could not set timezone"
		log "timezone: $(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"
	fi
}

acquire_lock() {
	mkdir -p "$(dirname "$LOCK_FILE")"
	exec 9>"$LOCK_FILE"
	if ! flock -n 9; then
		err "another deploy/update run is in progress"
		exit 3
	fi
}

#------------------------------------------------------------------------------
# 2. Packages
#------------------------------------------------------------------------------
install_packages() {
	step "Base packages"
	if [[ "$SKIP_APT" -eq 1 ]]; then
		log "skipped (--skip-apt)"
		return 0
	fi

	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	# Only what the platform and these scripts actually use. No compilers: every
	# build happens inside a container.
	# postgresql-client is for ad-hoc psql on the host only. Dumps and restores
	# run the CONTAINER's binaries (see backup.sh's docker mode) because
	# Ubuntu 24.04 ships client 16 while the container is Postgres 17, and
	# pg_dump refuses to talk to a newer server.
	apt-get install -y -qq --no-install-recommends \
		ca-certificates curl gnupg git rsync openssl \
		ufw fail2ban cron jq bc \
		postgresql-client
	log "base packages present"
}

install_docker() {
	step "Docker"
	if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
		log "docker $(docker --version | awk '{print $3}' | tr -d ,) and compose plugin already installed"
		systemctl enable --now docker >/dev/null 2>&1 || true
		return 0
	fi
	if [[ "$SKIP_APT" -eq 1 ]]; then
		die "docker missing but --skip-apt was given"
	fi

	log "installing docker-ce from the official repository"
	# Ubuntu's own docker.io package lags badly and ships no compose plugin, so
	# the upstream repo is the right source here.
	install -m 0755 -d /etc/apt/keyrings
	if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
		curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
		chmod a+r /etc/apt/keyrings/docker.asc
	fi
	local codename
	codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
		> /etc/apt/sources.list.d/docker.list
	apt-get update -qq
	apt-get install -y -qq \
		docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	systemctl enable --now docker
	log "docker installed: $(docker --version)"

	# json-file logs without a cap are the classic way a VPS runs out of disk.
	# Compose services set their own limits too; this covers anything ad-hoc.
	if [[ ! -f /etc/docker/daemon.json ]]; then
		mkdir -p /etc/docker
		cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
JSON
		systemctl restart docker
		log "wrote /etc/docker/daemon.json (log rotation + live-restore)"
	fi
}

#------------------------------------------------------------------------------
# 3. Source code
#------------------------------------------------------------------------------
fetch_source() {
	step "Source code"
	if [[ -d "$INSTALL_DIR/.git" ]]; then
		log "repository already present at $INSTALL_DIR - update.sh will pull"
		return 0
	fi
	if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
		# Someone rsync'ed the tree by hand. Accept it, but say so - update.sh
		# will not be able to pull or to tag images by commit.
		warn "$INSTALL_DIR exists and is not a git checkout; continuing without git"
		return 0
	fi
	[[ -n "$REPO_URL" ]] || die "REPO_URL is required for the first deploy"
	log "cloning ${REPO_URL} (${REPO_BRANCH}) into ${INSTALL_DIR}"
	mkdir -p "$(dirname "$INSTALL_DIR")"
	git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
}

#------------------------------------------------------------------------------
# 4. .env rendering
#
# Rules:
#   * an existing value is NEVER overwritten (rotating a Postgres password by
#     accident on the second deploy would orphan the data volume),
#   * a placeholder value from .env.example IS replaced with a real secret,
#   * secrets are generated with openssl and kept free of characters that would
#     need escaping inside a URL.
#------------------------------------------------------------------------------
ENV_FILE=""

rand_hex()  { openssl rand -hex "${1:-32}"; }
# URL-safe: no / + = so it can be embedded in postgres:// and redis:// URLs.
rand_pass() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
rand_pin()  { tr -dc '0-9' < /dev/urandom | head -c "${1:-6}"; }

env_get() {
	local key="$1"
	sed -nE "s/^${key}=(.*)$/\1/p" "$ENV_FILE" | tail -1
}

env_set() {
	local key="$1" value="$2"
	if grep -qE "^${key}=" "$ENV_FILE"; then
		# The value can contain / and & so use a delimiter that cannot appear in
		# it and escape the replacement for sed.
		local escaped
		escaped="$(printf '%s' "$value" | sed -e 's/[|\\&]/\\&/g')"
		sed -i -E "s|^${key}=.*$|${key}=${escaped}|" "$ENV_FILE"
	else
		printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
	fi
}

# Set only if currently empty or still a placeholder from .env.example.
env_default() {
	local key="$1" value="$2" current
	current="$(env_get "$key")"
	case "$current" in
		""|your_*|change_me*|dev_local_*|*_change_me*|sk-proj-REPLACE*)
			env_set "$key" "$value"
			log "  ${key}: generated"
			;;
		*)
			log "  ${key}: kept existing value"
			;;
	esac
}

render_env() {
	step ".env"
	ENV_FILE="$INSTALL_DIR/.env"

	if [[ ! -f "$ENV_FILE" ]]; then
		[[ -f "$INSTALL_DIR/.env.example" ]] || die ".env.example missing - cannot render .env"
		cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
		log "created .env from .env.example"
	else
		log ".env exists - only filling in what is missing"
	fi
	chmod 600 "$ENV_FILE"

	# --- runtime ---
	env_set NODE_ENV production
	env_set PORT 4000
	env_set HOST 0.0.0.0
	env_set DOMAIN "$DOMAIN"
	[[ -n "$LETSENCRYPT_EMAIL" ]] && env_set LETSENCRYPT_EMAIL "$LETSENCRYPT_EMAIL"

	# --- app secrets ---
	env_default JWT_SECRET "$(rand_hex 32)"
	env_default JWT_REFRESH_SECRET "$(rand_hex 32)"
	env_set JWT_EXPIRES_IN 15m
	env_set REFRESH_TOKEN_EXPIRES_IN 7d

	# --- datastores ---
	env_default POSTGRES_USER "callcenter"
	env_default POSTGRES_DB "callcenter"
	env_default POSTGRES_PASSWORD "$(rand_pass 32)"
	env_default REDIS_PASSWORD "$(rand_pass 32)"
	# Host-side ports stay on the project's unusual numbers so a local psql/
	# redis-cli works the same way it does in development. They are bound by the
	# base compose file and blocked from the internet by ufw + DOCKER-USER.
	env_set POSTGRES_PORT 5434
	env_set REDIS_PORT 6380
	# These URLs are for tooling that runs ON THE HOST (backup.sh in local mode,
	# drizzle-kit studio). The CONTAINERS get in-network URLs from
	# docker-compose.prod.yml, which always win over env_file.
	env_set DATABASE_URL "postgresql://$(env_get POSTGRES_USER):$(env_get POSTGRES_PASSWORD)@localhost:$(env_get POSTGRES_PORT)/$(env_get POSTGRES_DB)"
	env_set REDIS_URL "redis://:$(env_get REDIS_PASSWORD)@localhost:$(env_get REDIS_PORT)"

	# --- frontend build-time API base ---
	env_set VITE_API_URL "https://${DOMAIN}"

	# --- Asterisk: ARI / AMI ---
	env_default ASTERISK_ARI_USERNAME "callcenter-ari"
	env_default ASTERISK_ARI_PASSWORD "$(rand_pass 32)"
	env_default ASTERISK_AMI_USERNAME "callcenter-ami"
	env_default ASTERISK_AMI_PASSWORD "$(rand_pass 32)"
	env_set ASTERISK_ARI_APP callcenter-ai
	# Host-side values; containers are pointed at the `asterisk` service name by
	# docker-compose.prod.yml.
	env_set ASTERISK_ARI_URL "http://localhost:8088/ari"
	env_set ASTERISK_ARI_WS_URL "ws://localhost:8088/ari/events"
	env_set ASTERISK_AMI_HOST localhost
	env_set ASTERISK_AMI_PORT 5038

	# --- SIP / RTP: the live topology, do not "normalise" these ---
	env_set ASTERISK_SIP_PORT 5070
	env_set ASTERISK_RTP_START 12000
	env_set ASTERISK_RTP_END 12049

	# --- AudioSocket ---
	env_set AUDIOSOCKET_HOST 0.0.0.0
	env_set AUDIOSOCKET_PORT 9092
	# In production Asterisk and the backend share a compose network, so the
	# advertised host is the service name - host.docker.internal is a Docker
	# Desktop development crutch.
	env_set AUDIOSOCKET_ADVERTISE_HOST "backend:9092"

	# --- extension + voicemail secrets ---
	local ext
	for ext in 101 102 103 104; do
		env_default "SIP_EXT_${ext}_PASSWORD" "$(rand_pass 24)"
		env_default "VOICEMAIL_PIN_${ext}" "$(rand_pin 6)"
	done
	env_set AI_TRANSFER_EXTENSIONS "101,102,103,104"

	# --- OpenAI / AI agent ---
	if [[ -n "${OPENAI_API_KEY:-}" ]]; then
		env_set OPENAI_API_KEY "$OPENAI_API_KEY"
	fi
	if [[ -z "$(env_get OPENAI_API_KEY)" ]]; then
		warn "OPENAI_API_KEY is empty - the AI agent will fail closed and every"
		warn "call will be routed to a human operator (which is a safe default)."
	fi
	env_default OPENAI_REALTIME_MODEL "gpt-realtime"
	env_default OPENAI_REALTIME_VOICE "alloy"
	env_default AI_AGENT_ENABLED "true"
	env_default AI_AGENT_EXTENSION "900"
	env_default AI_AGENT_LANGUAGE "uz"
	env_default AI_AGENT_MAX_CALL_SECONDS "900"
	env_default AI_AGENT_SILENCE_HANGUP_MS "20000"

	# --- recordings ---
	env_set RECORDINGS_DIR "./apps/backend/uploads/call-recordings"
	env_set ASTERISK_RECORDINGS_DIR "/var/spool/asterisk/recordings"

	# --- monitoring ---
	env_default GRAFANA_ADMIN_USER "admin"
	env_default GRAFANA_ADMIN_PASSWORD "$(rand_pass 24)"
	# Grafana is reachable on the host's loopback only (SSH tunnel). Exposing it
	# under https://DOMAIN/grafana/ would need an nginx location plus
	# GF_SERVER_SERVE_FROM_SUB_PATH=true; it is intentionally not published.
	env_set GRAFANA_ROOT_URL "http://127.0.0.1:3002/"
	env_set ASTERISK_LOG_DIR "$ASTERISK_LOG_DIR"
	env_set TEXTFILE_DIR "$TEXTFILE_DIR"

	log ".env rendered (mode 600, secrets preserved across runs)"
}

#------------------------------------------------------------------------------
# 5. Host directories, nginx rendering, bootstrap certificate
#------------------------------------------------------------------------------
prepare_dirs() {
	step "Host directories"
	mkdir -p \
		"$BACKUP_ROOT/postgres" "$BACKUP_ROOT/recordings" "$BACKUP_ROOT/logs" "$BACKUP_ROOT/pre-restore" \
		"$TEXTFILE_DIR" \
		"$ASTERISK_LOG_DIR" \
		"$CERTBOT_WEBROOT" \
		"$NGINX_LOG_DIR" \
		"$INSTALL_DIR/apps/backend/uploads/call-recordings" \
		"$INSTALL_DIR/nginx/conf.d.rendered"
	chmod 700 "$BACKUP_ROOT"
	# node-exporter runs unprivileged and only reads here; backup.sh (root)
	# writes. 0755 is enough and avoids a root-only directory the exporter
	# cannot list.
	chmod 755 "$TEXTFILE_DIR"

	# Recordings: THREE writers/readers share this one directory - Asterisk
	# (MixMonitor, as the container's asterisk user), the backend (uid 1000 =
	# `bun` in the oven/bun image) and nginx (read-only). Without a shared group
	# and the setgid bit, files created by one are unreadable by the other and
	# the uploads route starts returning 403 for exactly the newest calls.
	local rec="$INSTALL_DIR/apps/backend/uploads/call-recordings"
	chown -R 1000:1000 "$rec" 2>/dev/null || warn "could not chown $rec"
	# 2775: group-writable + setgid so new files inherit the group.
	chmod 2775 "$rec" 2>/dev/null || true
	log "directories ready"
}

render_nginx() {
	step "nginx configuration"
	local src="$INSTALL_DIR/nginx/conf.d" dst="$INSTALL_DIR/nginx/conf.d.rendered"
	mkdir -p "$dst"
	# Rendered copies are regenerated from scratch every run: a stale vhost for
	# an old domain would otherwise keep answering.
	rm -f "$dst"/*.conf
	local f
	for f in "$src"/*.conf; do
		[[ -e "$f" ]] || continue
		sed "s/__DOMAIN__/${DOMAIN}/g" "$f" > "$dst/$(basename "$f")"
		log "  rendered $(basename "$f") for ${DOMAIN}"
	done
}

bootstrap_certificate() {
	step "TLS bootstrap"
	local live="$LETSENCRYPT_DIR/live/$DOMAIN"
	if [[ -f "$live/fullchain.pem" && -f "$live/privkey.pem" ]]; then
		log "certificate already present at $live - leaving it alone"
		return 0
	fi
	# nginx refuses to start when ssl_certificate points at a missing file, and
	# certbot's HTTP-01 challenge needs a running nginx. A throwaway self-signed
	# pair breaks that cycle; certbot replaces it on first issuance.
	log "generating a self-signed bootstrap certificate for ${DOMAIN}"
	mkdir -p "$live"
	openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
		-keyout "$live/privkey.pem" \
		-out "$live/fullchain.pem" \
		-subj "/CN=${DOMAIN}/O=CallCenter bootstrap" \
		2>/dev/null
	chmod 600 "$live/privkey.pem"
	warn "TLS is self-signed for now - browsers will warn until certbot runs"
}

render_monitoring_secrets() {
	step "Monitoring secrets"
	local dir="$INSTALL_DIR/monitoring/prometheus/secrets"
	mkdir -p "$dir"
	# Prometheus cannot expand env vars in prometheus.yml, so the Asterisk
	# scrape password has to exist as a file.
	printf '%s' "$(env_get ASTERISK_ARI_PASSWORD)" > "$dir/asterisk_password"
	# Prometheus runs as nobody(65534) in its image and must be able to read it.
	chmod 644 "$dir/asterisk_password"
	log "wrote monitoring/prometheus/secrets/asterisk_password"
}

#------------------------------------------------------------------------------
# 6. Firewall + fail2ban
#------------------------------------------------------------------------------
apply_firewall() {
	step "Firewall"
	if [[ "$SKIP_FIREWALL" -eq 1 ]]; then
		log "skipped (--skip-firewall)"
		return 0
	fi
	local rules="$INSTALL_DIR/config/firewall/ufw-rules.sh"
	[[ -x "$rules" ]] || chmod +x "$rules" 2>/dev/null || true
	[[ -f "$rules" ]] || { warn "ufw-rules.sh not found - firewall NOT configured"; return 0; }
	bash "$rules"
}

install_fail2ban() {
	step "fail2ban"
	if [[ "$SKIP_FAIL2BAN" -eq 1 ]]; then
		log "skipped (--skip-fail2ban)"
		return 0
	fi
	local jail="$INSTALL_DIR/config/fail2ban/jail.local"
	local filter="$INSTALL_DIR/config/fail2ban/filter.d/asterisk-security.conf"
	local action="$INSTALL_DIR/config/fail2ban/action.d/docker-user.conf"
	[[ -f "$jail" && -f "$filter" ]] || { warn "fail2ban config missing - skipping"; return 0; }

	install -m 0644 "$filter" /etc/fail2ban/filter.d/asterisk-security.conf
	# Without this action every container-port ban would be a no-op: ufw rules
	# live in INPUT, Docker's published ports are filtered in DOCKER-USER.
	if [[ -f "$action" ]]; then
		install -m 0644 "$action" /etc/fail2ban/action.d/docker-user.conf
	else
		warn "docker-user action missing - SIP bans would NOT block container traffic"
	fi
	install -m 0644 "$jail" /etc/fail2ban/jail.local

	# The jail tails a file Asterisk writes from inside its container; the prod
	# compose override bind-mounts $ASTERISK_LOG_DIR for exactly this. Create the
	# file so fail2ban does not refuse to start on a missing logpath.
	mkdir -p "$ASTERISK_LOG_DIR"
	touch "$ASTERISK_LOG_DIR/security" "$ASTERISK_LOG_DIR/messages"
	mkdir -p "$NGINX_LOG_DIR"
	touch "$NGINX_LOG_DIR/error.log" "$NGINX_LOG_DIR/access.log"

	systemctl enable fail2ban >/dev/null 2>&1 || true
	systemctl restart fail2ban
	sleep 2
	fail2ban-client status || warn "fail2ban started but status could not be read"
	log "fail2ban jails installed"
}

#------------------------------------------------------------------------------
# 7. Scheduled backups
#------------------------------------------------------------------------------
install_cron() {
	step "Backup schedule"
	# /etc/cron.d entry rather than a user crontab: it is declarative, survives
	# user changes, and re-running deploy.sh simply rewrites it.
	cat > "/etc/cron.d/${APP_NAME}-backup" <<EOF
# CallCenter "Aqlli Shahar" - daily verified backup (RPO 24h per TZ.md).
# Managed by scripts/deploy.sh - edits will be overwritten on the next deploy.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=${LETSENCRYPT_EMAIL:-root}

# 02:15 local time: after midnight traffic has stopped, before the morning shift.
15 2 * * * root ${INSTALL_DIR}/scripts/backup.sh >> /var/log/${APP_NAME}-backup.log 2>&1

# Certificate renewal at a random-ish minute twice a day, as Let's Encrypt asks.
# --deploy-hook reloads nginx inside the container after a successful renewal.
27 3,15 * * * root certbot renew --quiet --webroot -w ${CERTBOT_WEBROOT} --deploy-hook '${INSTALL_DIR}/scripts/update.sh --reload-nginx-only' >> /var/log/${APP_NAME}-certbot.log 2>&1
EOF
	chmod 0644 "/etc/cron.d/${APP_NAME}-backup"
	systemctl enable --now cron >/dev/null 2>&1 || true
	log "installed /etc/cron.d/${APP_NAME}-backup"

	# logrotate for the two log files the cron jobs append to.
	cat > "/etc/logrotate.d/${APP_NAME}" <<EOF
/var/log/${APP_NAME}-backup.log /var/log/${APP_NAME}-certbot.log /var/log/${APP_NAME}-deploy.log {
	weekly
	rotate 8
	compress
	delaycompress
	missingok
	notifempty
	create 0640 root adm
}
EOF
	log "installed /etc/logrotate.d/${APP_NAME}"
}

#------------------------------------------------------------------------------
# 8. Build / migrate / start / smoke test - delegated to update.sh
#------------------------------------------------------------------------------
run_first_deploy() {
	step "Application deploy"
	local updater="$INSTALL_DIR/scripts/update.sh"
	[[ -f "$updater" ]] || die "scripts/update.sh missing"
	chmod +x "$updater" "$INSTALL_DIR/scripts/backup.sh" "$INSTALL_DIR/scripts/restore.sh" 2>/dev/null || true

	# --initial: skip `git pull` (we just cloned) and skip rollback (there is no
	# previous image to roll back to). Closing fd 9 releases the deploy lock,
	# which update.sh acquires on the same file.
	exec 9>&-

	if bash "$updater" --initial --no-pull; then
		print_summary
	else
		err "application deploy failed."
		err "Host provisioning IS complete, so fix the cause and re-run only:"
		err "  ${updater}"
		exit 1
	fi
}

print_summary() {
	step "Done"
	cat <<EOF

CallCenter "Aqlli Shahar" is deployed.

  URL              https://${DOMAIN}          (self-signed until certbot runs)
  API health       https://${DOMAIN}/api/health
  Grafana          http://127.0.0.1:3002      (ssh -L 3002:127.0.0.1:3002)
  Prometheus       http://127.0.0.1:9090      (ssh -L 9090:127.0.0.1:9090)
  Grafana login    $(env_get GRAFANA_ADMIN_USER) / see GRAFANA_ADMIN_PASSWORD in ${ENV_FILE}

NEXT STEPS

  1. Point DNS: ${DOMAIN} -> $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "<this host's public IP>")

  2. Get a real certificate (nginx is already serving the ACME webroot):
       certbot certonly --webroot -w ${CERTBOT_WEBROOT} \\
         -d ${DOMAIN} -d www.${DOMAIN} \\
         --email ${LETSENCRYPT_EMAIL:-you@example.com} --agree-tos --no-eff-email
       ${INSTALL_DIR}/scripts/update.sh --reload-nginx-only

  3. Enable the HTTP->HTTPS redirect: in nginx/conf.d/callcenter.conf uncomment
     the ENABLE-AFTER-CERTS block, then re-run update.sh --reload-nginx-only.

  4. Point the SIP trunk at ${DOMAIN}:5070 (udp+tcp). RTP 12000-12049/udp is
     already open; 8088 (ARI), 5038 (AMI), 5434 (Postgres) and 6380 (Redis) are
     deliberately NOT reachable from outside.

  5. Verify a backup end to end before go-live:
       ${INSTALL_DIR}/scripts/backup.sh
       ${INSTALL_DIR}/scripts/restore.sh --list

EOF
}

main() {
	mkdir -p /var/log
	exec > >(tee -a "/var/log/${APP_NAME}-deploy.log") 2>&1
	log "===== CallCenter deploy started ====="

	check_host
	acquire_lock
	install_packages
	install_docker
	fetch_source
	render_env
	prepare_dirs
	render_nginx
	bootstrap_certificate
	render_monitoring_secrets
	apply_firewall
	install_fail2ban
	install_cron
	# Prints the summary itself, but only if the deploy actually succeeded.
	run_first_deploy
}

main "$@"
