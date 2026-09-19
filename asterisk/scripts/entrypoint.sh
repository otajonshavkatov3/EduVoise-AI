#!/bin/sh
#=============================================================================
# Asterisk container entrypoint.
#
# Renders /etc/asterisk/templates/*.template into /etc/asterisk/, then execs
# Asterisk in the foreground as the unprivileged asterisk user.
#
# Why an explicit envsubst whitelist: Asterisk config files are full of
# ${DIALPLAN_VARIABLES}. A bare `envsubst` would silently blank every one of
# them. Passing an explicit variable list makes envsubst touch only these
# names and leave all other ${...} sequences alone.
#=============================================================================
set -eu

SUBST_VARS='${ASTERISK_TRANSPORT_NAT} ${ASTERISK_LEGACY_TENANT_SLUG} ${ASTERISK_SIP_PORT} ${ASTERISK_RTP_START} ${ASTERISK_RTP_END} ${SIP_EXT_101_PASSWORD} ${SIP_EXT_102_PASSWORD} ${SIP_EXT_103_PASSWORD} ${SIP_EXT_104_PASSWORD} ${SIP_WEBRTC_201_PASSWORD} ${SIP_WEBRTC_202_PASSWORD} ${SIP_WEBRTC_203_PASSWORD} ${SIP_WEBRTC_204_PASSWORD} ${ASTERISK_ARI_USERNAME} ${ASTERISK_ARI_PASSWORD} ${ASTERISK_AMI_USERNAME} ${ASTERISK_AMI_PASSWORD} ${VOICEMAIL_PIN_101} ${VOICEMAIL_PIN_102} ${VOICEMAIL_PIN_103} ${VOICEMAIL_PIN_104}'

REQUIRED_VARS="ASTERISK_SIP_PORT ASTERISK_RTP_START ASTERISK_RTP_END
SIP_EXT_101_PASSWORD SIP_EXT_102_PASSWORD SIP_EXT_103_PASSWORD SIP_EXT_104_PASSWORD
SIP_WEBRTC_201_PASSWORD SIP_WEBRTC_202_PASSWORD SIP_WEBRTC_203_PASSWORD SIP_WEBRTC_204_PASSWORD
ASTERISK_ARI_USERNAME ASTERISK_ARI_PASSWORD ASTERISK_AMI_USERNAME ASTERISK_AMI_PASSWORD
VOICEMAIL_PIN_101 VOICEMAIL_PIN_102 VOICEMAIL_PIN_103 VOICEMAIL_PIN_104"

log() { echo "[entrypoint] $*"; }

# -----------------------------------------------------------------------------
# WHICH CUSTOMER THIS CONTAINER BOOTS FOR, before the backend has said anything.
#
# The platform is multi-tenant and the tenant list is a database table, so this
# container cannot know it. What it CAN do is bootstrap the one customer this
# deployment ran as before tenancy existed - the slug below - so that a fresh
# clone, or a boot with Postgres down, still answers calls on the phones that are
# already provisioned. The backend replaces the generated files with the real
# list from the tenants table the moment it starts.
#
# It must match the same name in the backend's .env (ASTERISK_LEGACY_TENANT_SLUG),
# because the pre-tenancy context names in extensions.conf forward to it.
# -----------------------------------------------------------------------------
ASTERISK_LEGACY_TENANT_SLUG="${ASTERISK_LEGACY_TENANT_SLUG:-avilab}"
export ASTERISK_LEGACY_TENANT_SLUG
# The extensions that existed before tenancy. Each gets a tenant-named endpoint
# (avilab-101) plus a bare-digit ALIAS endpoint sharing the same aor, which is what
# keeps a softphone that was configured as "101" working untouched.
BOOTSTRAP_EXTENSIONS="${ASTERISK_BOOTSTRAP_EXTENSIONS:-101 102 103 104}"
GENERATED_DIR=/etc/asterisk/generated

# -----------------------------------------------------------------------------
# NAT addressing for the plain SIP transports (udp/tcp).
#
# Two mutually exclusive situations, chosen by whether ASTERISK_EXTERNAL_ADDRESS
# is set:
#
# 1. Unset (the default, and how local development has always run): the RFC1918
#    space is declared local, so Asterisk does not rewrite SDP and a softphone on
#    the Windows host - MicroSIP at 127.0.0.1 - reaches the container's own RTP
#    address directly through Docker's routing.
#
# 2. Set: Asterisk advertises that address instead of its container IP. This is
#    what a phone somewhere ELSE needs - on the Wi-Fi, on mobile data, or a SIP
#    trunk - because such a phone has no route to 172.x and would otherwise send
#    its audio into a black hole while still hearing us (rtp_symmetric keeps the
#    return path working, which is exactly what makes the fault look one-sided).
#
#    No local_net is emitted in this mode on purpose. Docker's port proxy makes
#    every remote peer arrive from the bridge gateway, so Asterisk cannot tell a
#    LAN phone from the host anyway: any local_net entry covering that gateway
#    would suppress the external address for everyone and defeat the setting.
#    The host's own softphone keeps working - it simply sends RTP to the
#    published port on the external address rather than into the bridge.
# -----------------------------------------------------------------------------
if [ -n "${ASTERISK_EXTERNAL_ADDRESS:-}" ]; then
	ASTERISK_TRANSPORT_NAT="external_media_address = ${ASTERISK_EXTERNAL_ADDRESS}
external_signaling_address = ${ASTERISK_EXTERNAL_ADDRESS}"
	log "SIP transports will advertise ${ASTERISK_EXTERNAL_ADDRESS}"
else
	ASTERISK_TRANSPORT_NAT="local_net = 10.0.0.0/8
local_net = 172.16.0.0/12
local_net = 192.168.0.0/16
local_net = 127.0.0.0/8"
	log "SIP transports in local-only mode (set ASTERISK_EXTERNAL_ADDRESS to reach remote phones)"
fi
export ASTERISK_TRANSPORT_NAT

# -----------------------------------------------------------------------------
# Optional PSTN trunk for the BOOTSTRAP tenant, so a real phone number can reach
# the AI before the backend has generated anything.
#
# Rendered only when SIP_TRUNK_HOST is set; otherwise this expands to nothing and
# the bootstrap file has no trunk in it at all. That matters because a
# half-configured trunk is worse than none: Asterisk would keep retrying a
# registration that can never succeed and fill the log with it.
#
# Every section is named for the tenant (trunk-<slug>) and lands the call in
# from-external-<slug>, which is what makes an inbound carrier call carry a tenant
# from its very first millisecond. Each customer has their OWN trunk; .env can only
# express one, which is precisely why the real list comes from the database.
#
# Two authentication styles exist in the wild and providers pick one:
#   register - we log in to them with a username and password (SIP_TRUNK_AUTH_MODE=register)
#   ip       - they whitelist our public IP and we never authenticate (=ip)
# With "register" the registration carries line=yes, which is what lets Asterisk
# recognise THEIR inbound INVITE as belonging to this trunk while we sit behind
# NAT. With "ip" that recognition comes from the [trunk-identify] match list, so
# SIP_TRUNK_IPS is required in that mode.
# -----------------------------------------------------------------------------
TRUNK_SLUG="${ASTERISK_LEGACY_TENANT_SLUG}"
BOOTSTRAP_TRUNK_BLOCK=''
if [ -n "${SIP_TRUNK_HOST:-}" ]; then
	trunk_transport="${SIP_TRUNK_TRANSPORT:-transport-udp}"
	trunk_codecs="${SIP_TRUNK_CODECS:-ulaw,alaw}"
	trunk_mode="${SIP_TRUNK_AUTH_MODE:-register}"

	# from_user decides the caller ID the provider sees on outbound calls. Most
	# reject anything that is not the DID they issued, so it defaults to it.
	trunk_from_user="${SIP_TRUNK_FROM_USER:-${SIP_TRUNK_DID:-${SIP_TRUNK_USERNAME:-}}}"

	trunk_extra=''
	if [ -n "$trunk_from_user" ]; then
		trunk_extra="from_user = $trunk_from_user"
	fi
	if [ -n "${SIP_TRUNK_FROM_DOMAIN:-}" ]; then
		trunk_extra="$trunk_extra
from_domain = ${SIP_TRUNK_FROM_DOMAIN}"
	fi
	if [ "${SIP_TRUNK_SRTP:-no}" = "yes" ]; then
		trunk_extra="$trunk_extra
media_encryption = sdes"
	fi

	trunk_auth=''
	trunk_registration=''
	trunk_identify=''

	if [ "$trunk_mode" = "register" ]; then
		if [ -z "${SIP_TRUNK_USERNAME:-}" ] || [ -z "${SIP_TRUNK_PASSWORD:-}" ]; then
			log "FATAL: SIP_TRUNK_AUTH_MODE=register needs SIP_TRUNK_USERNAME and SIP_TRUNK_PASSWORD"
			exit 1
		fi
		trunk_extra="$trunk_extra
outbound_auth = trunk-${TRUNK_SLUG}-auth"
		trunk_auth="
[trunk-${TRUNK_SLUG}-auth]
type = auth
auth_type = userpass
username = ${SIP_TRUNK_USERNAME}
password = ${SIP_TRUNK_PASSWORD}"
		trunk_registration="
[trunk-${TRUNK_SLUG}-reg]
type = registration
transport = ${trunk_transport}
outbound_auth = trunk-${TRUNK_SLUG}-auth
server_uri = sip:${SIP_TRUNK_HOST}
client_uri = sip:${SIP_TRUNK_USERNAME}@${SIP_TRUNK_HOST}
contact_user = ${trunk_from_user}
retry_interval = 60
forbidden_retry_interval = 600
expiration = ${SIP_TRUNK_REGISTER_EXPIRY:-3600}
; Ties inbound calls on this registration back to the trunk endpoint, which is
; how a NATed PBX is recognised without an IP whitelist.
line = yes
endpoint = trunk-${TRUNK_SLUG}"
		log "PSTN trunk for ${TRUNK_SLUG}: registering to ${SIP_TRUNK_HOST} as ${SIP_TRUNK_USERNAME}"
	else
		if [ -z "${SIP_TRUNK_IPS:-}" ]; then
			log "FATAL: SIP_TRUNK_AUTH_MODE=ip needs SIP_TRUNK_IPS (the provider's signalling addresses)"
			exit 1
		fi
		log "PSTN trunk for ${TRUNK_SLUG}: IP authentication against ${SIP_TRUNK_IPS}"
	fi

	# Present in both modes: naming the provider's addresses is what stops a
	# random scanner on the internet from being treated as the carrier - which on a
	# multi-tenant platform would mean its call entering a real customer's context.
	if [ -n "${SIP_TRUNK_IPS:-}" ]; then
		trunk_matches=$(printf '%s' "${SIP_TRUNK_IPS}" | tr ',' '
' |
			sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d; s/^/match = /')
		trunk_identify="
[trunk-${TRUNK_SLUG}-identify]
type = identify
endpoint = trunk-${TRUNK_SLUG}
${trunk_matches}"
	fi

	BOOTSTRAP_TRUNK_BLOCK="
;--- PSTN trunk for ${TRUNK_SLUG} (from SIP_TRUNK_* in .env) -------------------

[trunk-${TRUNK_SLUG}]
type = endpoint
transport = ${trunk_transport}
; Inbound carrier calls enter THIS TENANT's context, which hands any called
; number to the AI with the tenant already attached.
context = from-external-${TRUNK_SLUG}
disallow = all
allow = ${trunk_codecs}
aors = trunk-${TRUNK_SLUG}
direct_media = no
; The carrier is not behind NAT but we are: answer RTP to where it actually came
; from, and keep media through Asterisk so MixMonitor and AudioSocket both work.
rtp_symmetric = yes
force_rport = yes
; Deliberately NOT rewrite_contact: a carrier's Contact is authoritative, and
; overwriting it breaks in-dialog requests such as re-INVITE and BYE.
rewrite_contact = no
dtmf_mode = ${SIP_TRUNK_DTMF_MODE:-rfc4733}
language = uz
${trunk_extra}

[trunk-${TRUNK_SLUG}]
type = aor
contact = sip:${SIP_TRUNK_HOST}
qualify_frequency = 60
${trunk_auth}
${trunk_registration}
${trunk_identify}"
else
	log "PSTN trunk not configured (set SIP_TRUNK_HOST to connect a real phone number)"
fi

# Fail fast and name every missing variable at once, rather than booting with
# an empty SIP password and looking secure until someone probes port 5060.
missing=''
for v in $REQUIRED_VARS; do
	eval "val=\${$v:-}"
	if [ -z "$val" ]; then
		missing="$missing $v"
	fi
done
if [ -n "$missing" ]; then
	log "FATAL: missing required environment variables:$missing"
	log "These come from the project .env via docker-compose env_file."
	exit 1
fi

log "rendering config templates"
for tpl in /etc/asterisk/templates/*.template; do
	[ -e "$tpl" ] || continue
	base=$(basename "$tpl" .template)
	out="/etc/asterisk/$base"
	envsubst "$SUBST_VARS" <"$tpl" >"$out"
	chown asterisk:asterisk "$out"
	chmod 640 "$out"
	log "  rendered $base"
done

# Static (secret-free) configs are baked in at build time by the Dockerfile;
# re-assert ownership in case a bind mount replaced them during development.
for f in modules.conf logger.conf musiconhold.conf; do
	if [ -f "/etc/asterisk/$f" ]; then
		chown asterisk:asterisk "/etc/asterisk/$f"
		chmod 640 "/etc/asterisk/$f"
	fi
done

# -----------------------------------------------------------------------------
# THE PER-TENANT CONFIG, and why this container only bootstraps it.
#
# pjsip.conf and extensions.conf both #include a file from this directory, and
# every endpoint, aor, auth, trunk and dialplan context that belongs to a CUSTOMER
# lives in there. The authority on that list is the tenants table, so the BACKEND
# writes these files (apps/backend/src/lib/asterisk/tenant-config.ts) and reloads
# res_pjsip/pbx_config over AMI - which is what lets the vendor onboard a customer
# with no rebuild, no restart and nobody editing a file on the host.
#
# WRITE-IF-MISSING, never overwrite. Asterisk must be able to boot when Postgres
# is down and a fresh clone must answer calls before the backend has ever run, so
# the pre-tenancy tenant is rendered here from .env. But if a file is already
# there it was written by the backend from the real tenant list, and clobbering it
# on a container restart would silently un-provision every customer created since:
# a stale tenant list is bad, an empty one is a platform-wide outage.
#
# The directory is bind-mounted, so these files survive the container.
# -----------------------------------------------------------------------------
mkdir -p "$GENERATED_DIR"

bootstrap_pjsip() {
	echo ";============================================================================="
	echo "; BOOTSTRAP per-tenant PJSIP for '${ASTERISK_LEGACY_TENANT_SLUG}', written by"
	echo "; entrypoint.sh from .env because this file did not exist yet."
	echo ";"
	echo "; The backend overwrites it with the real list from the tenants table. Endpoint"
	echo "; names carry the tenant; the bare-digit ALIAS endpoints share the tenant's aor"
	echo "; so a softphone provisioned before tenancy keeps registering unchanged."
	echo ";============================================================================="
	echo ""

	for ext in $BOOTSTRAP_EXTENSIONS; do
		eval "deskpw=\${SIP_EXT_${ext}_PASSWORD:-}"
		webext="2${ext#?}"
		eval "webpw=\${SIP_WEBRTC_${webext}_PASSWORD:-}"
		slug="$ASTERISK_LEGACY_TENANT_SLUG"

		[ -n "$deskpw" ] || continue

		cat <<EOF
[${slug}-${ext}]
type = endpoint
context = from-internal-${slug}
disallow = all
allow = ulaw,alaw,slin,slin16
auth = ${slug}-${ext}-auth
; BOTH aors: the tenant's own, and the pre-tenancy one the alias endpoint below
; registers into. Dial(PJSIP/${slug}-${ext}) rings the contacts of both, so a phone
; that still calls itself "${ext}" is reachable from the tenant's dialplan.
aors = ${slug}-${ext},${ext}
callerid = Operator ${ext} <${ext}>
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733
mailboxes = ${ext}@default
device_state_busy_at = 1

[${slug}-${ext}-auth]
type = auth
auth_type = userpass
; The auth username is the ENDPOINT name, not the digits: REGISTER carries no
; tenant, so two customers' "101" would be one global credential.
username = ${slug}-${ext}
password = ${deskpw}

[${slug}-${ext}]
type = aor
max_contacts = 2
remove_existing = yes
qualify_frequency = 30

; LEGACY ALIAS - the endpoint AND the aor are named after the bare digits, because
; the PJSIP registrar picks the aor by matching the REGISTER's URI user against the
; endpoint's aor names: point it at ${slug}-${ext} and Asterisk answers
; "AOR '' not found for endpoint '${ext}'" and the phone never comes back.
[${ext}]
type = endpoint
context = from-internal-${slug}
disallow = all
allow = ulaw,alaw,slin,slin16
auth = ${ext}-legacy-auth
aors = ${ext}
callerid = Operator ${ext} <${ext}>
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

[${ext}-legacy-auth]
type = auth
auth_type = userpass
username = ${ext}
password = ${deskpw}

[${ext}]
type = aor
max_contacts = 2
remove_existing = yes
qualify_frequency = 30

EOF

		[ -n "$webpw" ] || continue

		cat <<EOF
[${slug}-${webext}]
type = endpoint
context = from-internal-${slug}
disallow = all
allow = ulaw,alaw
auth = ${slug}-${webext}-auth
aors = ${slug}-${webext},${webext}
callerid = Operator ${ext} web <${webext}>
webrtc = yes
dtls_cert_file = /etc/asterisk/keys/asterisk.pem
dtls_private_key = /etc/asterisk/keys/asterisk.key
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

[${slug}-${webext}-auth]
type = auth
auth_type = userpass
username = ${slug}-${webext}
password = ${webpw}

[${slug}-${webext}]
type = aor
max_contacts = 2
remove_existing = yes

; LEGACY ALIAS for the browser softphone - own aor, same reason as above.
[${webext}]
type = endpoint
context = from-internal-${slug}
disallow = all
allow = ulaw,alaw
auth = ${webext}-legacy-auth
aors = ${webext}
callerid = Operator ${ext} web <${webext}>
webrtc = yes
dtls_cert_file = /etc/asterisk/keys/asterisk.pem
dtls_private_key = /etc/asterisk/keys/asterisk.key
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

[${webext}-legacy-auth]
type = auth
auth_type = userpass
username = ${webext}
password = ${webpw}

[${webext}]
type = aor
max_contacts = 2
remove_existing = yes

EOF
	done

	if [ -n "$BOOTSTRAP_TRUNK_BLOCK" ]; then
		echo "$BOOTSTRAP_TRUNK_BLOCK"
	fi
}

bootstrap_dialplan() {
	slug="$ASTERISK_LEGACY_TENANT_SLUG"
	cat <<EOF
;=============================================================================
; BOOTSTRAP per-tenant contexts for '${slug}', written by entrypoint.sh because
; this file did not exist yet. The backend overwrites it from the tenants table.
;
; Nothing but inheritance: every line of dialplan logic is a (!) template in
; extensions.conf, so a tenant costs five declarations and cannot drift from
; another tenant's behaviour.
;=============================================================================

[from-internal-${slug}](tenant-internal)
[from-external-${slug}](tenant-external)
[ai-bridge-${slug}](tenant-ai-bridge)
[ai-transfer-${slug}](tenant-ai-transfer)
[queue-${slug}](tenant-queue)
[click-to-call-${slug}](tenant-click-to-call)
EOF
}

# The ACD queue for the bootstrap tenant: the operator pool the AI hands callers
# to. Members are each bootstrap extension's desk phone AND its paired browser
# softphone, so the queue reaches an operator on whichever they are logged into.
# The backend overwrites this from operator_profiles the moment it starts.
bootstrap_queues() {
	slug="$ASTERISK_LEGACY_TENANT_SLUG"
	cat <<EOF
;=============================================================================
; BOOTSTRAP ACD queue for '${slug}', written by entrypoint.sh because this file
; did not exist yet. The backend overwrites it from the operator_profiles table.
;=============================================================================

[${slug}-ops]
strategy = rrmemory
timeout = 20
retry = 2
wrapuptime = 3
; One call per operator at a time: skip a member already on a call.
ringinuse = no
autofill = yes
; Let callers WAIT on hold music when every operator is busy.
joinempty = yes
leavewhenempty = no
musicclass = default
EOF

	for ext in $BOOTSTRAP_EXTENSIONS; do
		eval "deskpw=\${SIP_EXT_${ext}_PASSWORD:-}"
		[ -n "$deskpw" ] || continue
		webext="2${ext#?}"
		echo "member => PJSIP/${slug}-${ext},0,Operator ${ext}"
		eval "webpw=\${SIP_WEBRTC_${webext}_PASSWORD:-}"
		[ -n "$webpw" ] && echo "member => PJSIP/${slug}-${webext},0,Operator ${ext} web"
	done
}

if [ -f "$GENERATED_DIR/pjsip-tenants.conf" ]; then
	log "per-tenant pjsip config already present - leaving the backend's copy alone"
else
	bootstrap_pjsip >"$GENERATED_DIR/pjsip-tenants.conf"
	log "bootstrapped pjsip endpoints for tenant '${ASTERISK_LEGACY_TENANT_SLUG}'"
fi

if [ -f "$GENERATED_DIR/extensions-tenants.conf" ]; then
	log "per-tenant dialplan already present - leaving the backend's copy alone"
else
	bootstrap_dialplan >"$GENERATED_DIR/extensions-tenants.conf"
	log "bootstrapped dialplan contexts for tenant '${ASTERISK_LEGACY_TENANT_SLUG}'"
fi

if [ -f "$GENERATED_DIR/queues-tenants.conf" ]; then
	log "per-tenant queues already present - leaving the backend's copy alone"
else
	bootstrap_queues >"$GENERATED_DIR/queues-tenants.conf"
	log "bootstrapped ACD queue for tenant '${ASTERISK_LEGACY_TENANT_SLUG}'"
fi

# Readable by Asterisk. Deliberately tolerant: on a Windows bind mount chown is a
# no-op and failing here would stop a container that is otherwise fine.
chown asterisk:asterisk "$GENERATED_DIR"/*.conf 2>/dev/null || true
chmod 640 "$GENERATED_DIR"/*.conf 2>/dev/null || true

# -----------------------------------------------------------------------------
# DTLS certificate for WebRTC (the dashboard's browser softphone).
#
# Self-signed on purpose: WebRTC authenticates media by comparing the DTLS
# fingerprint carried in the SDP, not by validating a CA chain, so a public
# certificate buys nothing here. Regenerated whenever the container is recreated,
# which is harmless for the same reason.
# -----------------------------------------------------------------------------
KEYS_DIR=/etc/asterisk/keys
if [ ! -f "$KEYS_DIR/asterisk.pem" ]; then
	mkdir -p "$KEYS_DIR"
	log "generating self-signed DTLS certificate for WebRTC"
	openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
		-keyout "$KEYS_DIR/asterisk.key" \
		-out "$KEYS_DIR/asterisk.pem" \
		-subj "/CN=callcenter-pbx" >/dev/null 2>&1
	chown asterisk:asterisk "$KEYS_DIR/asterisk.key" "$KEYS_DIR/asterisk.pem"
	chmod 600 "$KEYS_DIR/asterisk.key"
	chmod 640 "$KEYS_DIR/asterisk.pem"
else
	log "DTLS certificate already present"
fi

# -----------------------------------------------------------------------------
# ICE host-candidate rewriting, without which browser calls have no audio.
#
# Asterisk gathers ICE candidates from the container's own interface (172.x),
# which a browser on the Windows host cannot route to. The RTP range is published
# on the host, so rewriting the advertised candidate to 127.0.0.1 makes the
# browser send media to a port that Docker forwards straight into the container.
#
# This only affects endpoints that use ICE - i.e. the WebRTC ones. MicroSIP and
# any other plain SIP endpoint are untouched, so the verified desk-phone path
# cannot regress.
# -----------------------------------------------------------------------------
CONTAINER_IP="$(hostname -I 2>/dev/null | cut -d' ' -f1)"
if [ -n "$CONTAINER_IP" ]; then
	{
		echo ""
		echo "; --- appended at container start by entrypoint.sh ---"
		echo "[ice_host_candidates]"
		echo "${CONTAINER_IP} => 127.0.0.1"
	} >>/etc/asterisk/rtp.conf
	log "ICE host candidate ${CONTAINER_IP} -> 127.0.0.1"
else
	log "WARNING: could not determine the container IP; browser calls may have no audio"
fi

log "preparing runtime directories"
for d in /var/run/asterisk /var/log/asterisk /var/spool/asterisk \
	/var/spool/asterisk/recordings /var/spool/asterisk/voicemail \
	/var/spool/asterisk/monitor /var/lib/asterisk; do
	mkdir -p "$d"
	chown -R asterisk:asterisk "$d" 2>/dev/null || true
done

# ARI live recordings are written to Asterisk's own $astspooldir/recording
# (singular), which is NOT the bind-mounted directory the backend reads. The
# fallback call path records through ARI rather than MixMonitor, so without this
# link those recordings would exist inside the container and be invisible to the
# dashboard. A relative symlink keeps both producers writing to one directory.
if [ -L /var/spool/asterisk/recording ]; then
	log "ARI recording dir already linked"
elif [ -d /var/spool/asterisk/recording ] && [ -z "$(ls -A /var/spool/asterisk/recording 2>/dev/null)" ]; then
	rmdir /var/spool/asterisk/recording
	ln -s recordings /var/spool/asterisk/recording
	log "linked ARI recording dir -> recordings"
elif [ -e /var/spool/asterisk/recording ]; then
	# Deliberately non-destructive: never delete files that might be recordings.
	log "WARNING: /var/spool/asterisk/recording exists and is not empty - leaving it"
	log "         ARI-recorded fallback calls will not be readable by the backend."
else
	ln -s recordings /var/spool/asterisk/recording
	log "linked ARI recording dir -> recordings"
fi
chown -h asterisk:asterisk /var/spool/asterisk/recording 2>/dev/null || true

# The recordings directory is bind-mounted from the Windows host so the
# backend can serve the files. A host bind mount arrives root-owned, which
# would make MixMonitor fail with a permission error on the first call.
if ! su -s /bin/sh asterisk -c 'test -w /var/spool/asterisk/recordings'; then
	log "WARNING: /var/spool/asterisk/recordings is not writable by asterisk"
	log "         MixMonitor recording will fail; check the bind mount owner."
fi

log "starting asterisk (foreground)"
# -f foreground, -U/-G drop privileges, -p raise RTP thread priority.
exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv
