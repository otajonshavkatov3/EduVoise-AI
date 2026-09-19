# syntax=docker/dockerfile:1
#=============================================================================
# Asterisk PBX for CallCenter "Aqlli Shahar"
#
# Built from the distro's packaged Asterisk rather than from source: it already
# carries res_audiosocket / chan_audiosocket / app_audiosocket and the full ARI
# module set, and it gets security updates. Compiling from source would add
# ~15 minutes per build for no capability we use.
#
# Base is ubuntu:24.04 (Asterisk 20.6.0) and NOT Debian: both trixie and
# bookworm have dropped the asterisk package entirely
# ("E: Package 'asterisk' has no installation candidate"), verified against
# both bases before choosing this one.
#
# Build from the PROJECT ROOT so the COPY paths resolve:
#   docker build -f docker/asterisk.Dockerfile -t callcenter-asterisk:latest .
#=============================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Debian's asterisk postinst tries to start the service via invoke-rc.d.
# There is no init system in a container, so tell policy-rc.d to refuse all
# service actions - otherwise the postinst exits non-zero and the build dies.
RUN set -eux; \
	printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; \
	chmod +x /usr/sbin/policy-rc.d

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		asterisk \
		gettext-base \
		ca-certificates \
		procps \
		iproute2 \
		tini; \
	rm -rf /var/lib/apt/lists/*

# Sounds and music-on-hold in their own layer: if a package name shifts
# between Debian releases the failure is isolated and obvious here rather
# than taking down the whole install above.
RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		asterisk-core-sounds-en-wav \
		asterisk-moh-opsound-wav; \
	rm -rf /var/lib/apt/lists/*

# Fail the build loudly if the modules this platform depends on are absent,
# instead of discovering it on the first call.
RUN set -eux; \
	moddir="$(find /usr/lib -maxdepth 3 -type d -name modules -path '*asterisk*' | head -n 1)"; \
	echo "asterisk module dir: $moddir"; \
	for m in res_audiosocket.so app_audiosocket.so chan_audiosocket.so \
		res_ari.so res_ari_channels.so res_ari_events.so res_ari_bridges.so \
		res_stasis.so app_stasis.so app_mixmonitor.so chan_pjsip.so; do \
		if [ ! -f "$moddir/$m" ]; then echo "MISSING MODULE: $m"; exit 1; fi; \
		echo "  ok $m"; \
	done; \
	/usr/sbin/asterisk -V

# Secret-free configs are baked into the image.
COPY asterisk/etc/modules.conf \
	asterisk/etc/logger.conf \
	asterisk/etc/musiconhold.conf \
	asterisk/etc/prometheus.conf \
	/etc/asterisk/

# Rendered at container start: the ones carrying credentials, plus the dialplan -
# extensions.conf is a template now because it has to name the pre-tenancy tenant
# (ASTERISK_LEGACY_TENANT_SLUG), which is a deployment fact and not a constant.
COPY asterisk/etc/extensions.conf.template \
	asterisk/etc/pjsip.conf.template \
	asterisk/etc/ari.conf.template \
	asterisk/etc/http.conf.template \
	asterisk/etc/manager.conf.template \
	asterisk/etc/rtp.conf.template \
	asterisk/etc/voicemail.conf.template \
	asterisk/etc/queues.conf.template \
	/etc/asterisk/templates/

COPY asterisk/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN set -eux; \
	chmod +x /usr/local/bin/entrypoint.sh; \
	mkdir -p /var/spool/asterisk/recordings /etc/asterisk/generated; \
	chown -R asterisk:asterisk /etc/asterisk /var/spool/asterisk

# SIP signalling, ARI/HTTP, AMI. The RTP range is published by compose, not
# here: EXPOSE cannot take a variable range and it is documentation only.
EXPOSE 5060/udp 5060/tcp 8088/tcp 5038/tcp

# "core show version" only succeeds once the control socket is accepting
# commands, which is exactly the readiness signal the backend needs.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=4 \
	CMD /usr/sbin/asterisk -rx "core show version" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
