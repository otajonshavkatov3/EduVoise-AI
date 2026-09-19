#!/usr/bin/env bash
#==============================================================================
# ufw-rules.sh - host firewall for the CallCenter "Aqlli Shahar" VPS
#
# Run as root (scripts/deploy.sh calls it):
#     bash config/firewall/ufw-rules.sh
#     bash config/firewall/ufw-rules.sh --dry-run     # print, change nothing
#
# POLICY
#   default deny incoming / allow outgoing / deny routed
#
#   OPEN to the internet:
#     22/tcp            SSH (rate limited: 6 attempts / 30s per source)
#     80/tcp            HTTP - ACME challenge + redirect to HTTPS
#     443/tcp           HTTPS - dashboard and API
#     5070/udp,tcp      SIP signalling (NOT 5060: MicroSIP owns that in dev and
#                       the whole platform is configured for 5070 end to end)
#     12000-12049/udp   RTP media. Must match ASTERISK_RTP_START/END exactly -
#                       Asterisk writes these port numbers into its SDP, so a
#                       closed port here means a connected call with no audio.
#
#   NEVER open (deliberately, and asserted at the end of this script):
#     8088/tcp   Asterisk ARI  - full call control, only the backend needs it
#     5038/tcp   Asterisk AMI  - full PBX control, same reasoning
#     5434/tcp   PostgreSQL    - every citizen's data
#     6380/tcp   Redis         - sessions; also trivially abusable unauthenticated
#     9090/9100/9187/3002  Prometheus / exporters / Grafana - reach them over an
#                       SSH tunnel:  ssh -L 3002:127.0.0.1:3002 root@host
#
# THE DOCKER CAVEAT (the important part of this file)
#   `ports:` in docker-compose creates DNAT rules that are evaluated BEFORE ufw's
#   INPUT chain, so a published container port is reachable from the internet even
#   with `ufw default deny incoming`. The base docker-compose.yml publishes
#   Postgres and Redis on 0.0.0.0 (5434/6380) - which would be a full data breach
#   on a public VPS. This script therefore also installs explicit DROP rules in
#   the DOCKER-USER chain, which IS honoured for container traffic, and it
#   verifies them at the end.
#
# IDEMPOTENT: every rule is added with `ufw allow` (a no-op when the identical
# rule exists) and every iptables rule is probed with -C before insertion.
#==============================================================================
set -euo pipefail
IFS=$'\n\t'

SSH_PORT="${SSH_PORT:-22}"
SIP_PORT="${SIP_PORT:-5070}"
RTP_START="${RTP_START:-12000}"
RTP_END="${RTP_END:-12049}"

# Ports that must never be reachable from outside the host.
PRIVATE_TCP_PORTS=(8088 5038 5434 6380 9090 9100 9187 3002 9092)

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "INFO " "$*"; }
warn() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "WARN " "$*" >&2; }
err()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "ERROR" "$*" >&2; }
die()  { err "$*"; exit 1; }

run() {
	if [[ "$DRY_RUN" -eq 1 ]]; then
		printf '  [dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

[[ "$(id -u)" -eq 0 ]] || die "must run as root"
command -v ufw >/dev/null 2>&1 || die "ufw not installed (apt-get install -y ufw)"

#------------------------------------------------------------------------------
# 1. SSH FIRST.
#
# Order matters: enabling ufw with a default-deny policy before allowing SSH
# would lock us out of the box. `ufw limit` also rate limits connection attempts,
# which blunts password brute forcing before fail2ban even sees it.
#------------------------------------------------------------------------------
log "allowing SSH on ${SSH_PORT}/tcp (rate limited)"
run ufw limit "${SSH_PORT}/tcp" comment "SSH (rate limited)"

#------------------------------------------------------------------------------
# 2. Default policies.
#
# deny routed: this host is not a router. It does NOT affect Docker's own
# forwarding, which Docker manages in its own chains.
#------------------------------------------------------------------------------
log "setting default policies"
run ufw default deny incoming
run ufw default allow outgoing
run ufw default deny routed

# Log blocked packets, but at `low` - `full` fills the disk on a box that is
# being SIP-scanned continuously.
run ufw logging low

#------------------------------------------------------------------------------
# 3. Web
#------------------------------------------------------------------------------
log "allowing HTTP/HTTPS"
run ufw allow 80/tcp  comment "HTTP: ACME challenge + redirect"
run ufw allow 443/tcp comment "HTTPS: dashboard + API"

#------------------------------------------------------------------------------
# 4. Telephony
#
# SIP over both transports: the trunk provider may use either, and the WebRTC
# softphone path reaches Asterisk over TCP/WSS.
#------------------------------------------------------------------------------
log "allowing SIP on ${SIP_PORT} (udp+tcp)"
run ufw allow "${SIP_PORT}/udp" comment "SIP signalling"
run ufw allow "${SIP_PORT}/tcp" comment "SIP signalling (TCP/TLS transport)"

log "allowing RTP ${RTP_START}-${RTP_END}/udp"
run ufw allow "${RTP_START}:${RTP_END}/udp" comment "RTP media"

# If the SIP trunk provider publishes fixed source addresses, tighten the two
# SIP rules to them - it removes essentially all scanner noise:
#   ufw delete allow ${SIP_PORT}/udp
#   ufw allow from <provider-ip> to any port ${SIP_PORT} proto udp comment 'SIP trunk'

#------------------------------------------------------------------------------
# 5. Explicit denies for the private services.
#
# Redundant against `default deny incoming` for host-bound traffic, but they are
# cheap, they are self-documenting, and they show up in `ufw status` as a stated
# intention rather than an assumption.
#------------------------------------------------------------------------------
log "adding explicit denies for private services"
for port in "${PRIVATE_TCP_PORTS[@]}"; do
	run ufw deny "${port}/tcp" comment "private: never expose"
done

#------------------------------------------------------------------------------
# 6. Enable
#------------------------------------------------------------------------------
if ufw status | grep -q "^Status: active"; then
	log "ufw already active - reloading"
	run ufw reload
else
	log "enabling ufw"
	# --force skips the "this may disrupt SSH" prompt; SSH was allowed in step 1.
	run ufw --force enable
fi

#------------------------------------------------------------------------------
# 7. DOCKER-USER hardening - the rules that actually protect the container ports.
#
# Docker evaluates DOCKER-USER first in the FORWARD path and never flushes it, so
# it is the supported place for operator rules. Strategy:
#   * allow traffic from the host itself and from private ranges (the backend and
#     Prometheus reach Postgres/Redis/ARI this way),
#   * DROP everything else destined for the private ports.
# Both are inserted with -C probes so re-running changes nothing.
#------------------------------------------------------------------------------
harden_docker() {
	command -v iptables >/dev/null 2>&1 || { warn "iptables missing - skipping DOCKER-USER hardening"; return 0; }
	if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
		warn "DOCKER-USER chain absent (docker not installed yet?)"
		warn "re-run this script AFTER docker is installed, or published container"
		warn "ports will stay reachable from the internet."
		return 0
	fi

	log "hardening DOCKER-USER for private ports"

	local port
	for port in "${PRIVATE_TCP_PORTS[@]}"; do
		# Allow the RFC1918 sources first...
		local src
		for src in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
			if ! iptables -C DOCKER-USER -p tcp -s "$src" --dport "$port" -j RETURN 2>/dev/null; then
				run iptables -I DOCKER-USER 1 -p tcp -s "$src" --dport "$port" -j RETURN
			fi
		done
		# ...then drop the rest. Appended AFTER the RETURNs because iptables
		# evaluates top-down and the inserts above keep landing at position 1.
		if ! iptables -C DOCKER-USER -p tcp --dport "$port" -j DROP 2>/dev/null; then
			run iptables -A DOCKER-USER -p tcp --dport "$port" -j DROP
		fi
	done

	# AudioSocket (9092) is backend<->Asterisk only and is never published, but
	# the drop above covers it if somebody publishes it by mistake.

	# Persist across reboots. Without this, every reboot re-exposes the ports.
	if command -v netfilter-persistent >/dev/null 2>&1; then
		run netfilter-persistent save
		log "iptables rules saved via netfilter-persistent"
	elif command -v iptables-save >/dev/null 2>&1; then
		mkdir -p /etc/iptables
		if [[ "$DRY_RUN" -eq 0 ]]; then
			iptables-save > /etc/iptables/rules.v4
		fi
		log "iptables rules written to /etc/iptables/rules.v4"
		warn "install iptables-persistent so they are restored at boot:"
		warn "  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent"
	else
		warn "cannot persist iptables rules - they will be lost on reboot"
	fi
}
harden_docker

#------------------------------------------------------------------------------
# 8. Verify. A firewall script that silently did nothing is worse than none.
#------------------------------------------------------------------------------
verify() {
	[[ "$DRY_RUN" -eq 0 ]] || return 0
	log "verifying"

	local failures=0

	# The rules that MUST be present.
	local want
	for want in "80/tcp" "443/tcp" "${SIP_PORT}/udp" "${SIP_PORT}/tcp"; do
		if ufw status | grep -q "${want}"; then
			log "  ok: ${want} allowed"
		else
			err "  MISSING: ${want}"
			failures=$(( failures + 1 ))
		fi
	done
	if ufw status | grep -qE "${RTP_START}:${RTP_END}/udp"; then
		log "  ok: RTP ${RTP_START}-${RTP_END}/udp allowed"
	else
		err "  MISSING: RTP range"
		failures=$(( failures + 1 ))
	fi

	# The ports that MUST NOT be world-reachable. `ss` shows what is bound; a
	# 0.0.0.0 binding is fine as long as DOCKER-USER drops the traffic, so this
	# is reported as information, not failure - except when DOCKER-USER is absent.
	if command -v ss >/dev/null 2>&1; then
		local p
		for p in "${PRIVATE_TCP_PORTS[@]}"; do
			if ss -ltnH "sport = :${p}" 2>/dev/null | grep -qE '0\.0\.0\.0|\[::\]'; then
				if iptables -n -L DOCKER-USER 2>/dev/null | grep -qE "dpt:${p}\b.*DROP|DROP.*dpt:${p}\b"; then
					log "  ok: ${p} bound on all interfaces but DROPped in DOCKER-USER"
				else
					err "  EXPOSED: ${p} is bound on 0.0.0.0 with no DOCKER-USER drop"
					failures=$(( failures + 1 ))
				fi
			fi
		done
	fi

	echo
	ufw status verbose
	echo
	log "DOCKER-USER chain:"
	iptables -n -L DOCKER-USER --line-numbers 2>/dev/null | sed 's/^/    /' || true

	if [[ "$failures" -gt 0 ]]; then
		err "${failures} firewall problem(s) - DO NOT go live until they are fixed"
		exit 1
	fi
	log "firewall verified"
}
verify

log "done. Reach the private services through an SSH tunnel, e.g.:"
log "  ssh -L 9090:127.0.0.1:9090 -L 3002:127.0.0.1:3002 root@<host>"
