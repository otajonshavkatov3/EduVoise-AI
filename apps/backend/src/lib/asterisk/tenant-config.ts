/**
 * PER-TENANT ASTERISK CONFIGURATION, generated from the tenants table.
 *
 * WHERE THE TENANT LIST COMES FROM, and why it is not the container.
 *
 * Adding a customer must not need a container rebuild, must not need a restart,
 * and must not need anybody to edit a file on the host. That rules out putting
 * tenants in the image and it rules out putting them in .env. The tenants table is
 * the only source of truth there is, so the BACKEND renders the config and asks
 * Asterisk to reload it:
 *
 *   tenants + operator_profiles  ->  asterisk/etc/generated/pjsip-tenants.conf
 *                                    asterisk/etc/generated/extensions-tenants.conf
 *                                ->  AMI Reload res_pjsip / pbx_config
 *
 * Both files are `#include`d from pjsip.conf and extensions.conf, and the
 * directory is bind-mounted into the container, so a tenant created in the vendor
 * console is answering calls a second later with no restart of anything.
 *
 * WHY NOT ARI/realtime SORCERY (res_config_pgsql). It would let Asterisk read the
 * tenants table itself, and it is the right answer at a few hundred tenants. It is
 * the wrong answer today: it puts Asterisk's ability to boot behind Postgres being
 * up, it moves the endpoint definition out of a file a human can read while
 * debugging a call, and it needs a module this image does not build. A generated
 * file keeps "what is Asterisk actually configured with" answerable with `cat`.
 *
 * WHY THE CONTAINER STILL WRITES A BOOTSTRAP COPY. asterisk/scripts/entrypoint.sh
 * writes the same two files from .env IF THEY ARE MISSING. That is what makes a
 * fresh clone work before the backend has ever run, and what keeps Asterisk
 * bootable when the database is down. It never overwrites a file the backend
 * wrote: a stale tenant list is bad, an empty one is worse.
 *
 * THE PASSWORD QUESTION. operator_profiles has no SIP password column (adding one
 * is the vendor console's phase), so a generated endpoint's password is DERIVED:
 * HMAC-SHA256(platform secret, "<slug>/<extension>"). Reproducible, so nothing has
 * to be stored and the vendor console can show the customer their credentials by
 * recomputing them; per-tenant, so knowing one customer's password tells you
 * nothing about another's. The pre-tenancy demo extensions keep their .env
 * passwords (SIP_EXT_1xx_PASSWORD), because a softphone is already registered with
 * them and rotating a working phone's password is not a tenancy change.
 */
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getServerEnv } from "@shared/env";
import { asc, eq } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";

import { db } from "@/db";
import { operatorProfiles, type TenantRecord } from "@/db/schema";
import {
	endpointAuthName,
	endpointName,
	LEGACY_CONTEXTS,
	listAllTenants,
	queueName,
	tenantContexts,
	trunkSectionNames,
	webExtensionFor,
} from "@/lib/tenancy";
import { getAmiClient } from "./ami-client";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: isProduction ? "info" : "debug", name: "asterisk:tenant-config" },
	isProduction ? undefined : pretty({ colorize: true })
);

/**
 * The monorepo root, derived from this file's own location:
 *   <root>/apps/backend/src/lib/asterisk/tenant-config.ts
 * Same reason as crm-writer.ts: the paths in .env are written relative to the repo
 * root (docker-compose needs them that way) while the process runs in apps/backend.
 */
const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

/** Host-side directory bind-mounted to /etc/asterisk/generated in the container. */
const GENERATED_DIR = resolve(REPO_ROOT, "asterisk/etc/generated");

export const PJSIP_TENANTS_FILE = "pjsip-tenants.conf";
export const EXTENSIONS_TENANTS_FILE = "extensions-tenants.conf";
export const QUEUES_TENANTS_FILE = "queues-tenants.conf";

/** Codecs, in the order the pre-tenancy endpoints offered them. */
const DESK_CODECS = "ulaw,alaw,slin,slin16";
/** Chrome speaks PCMU/PCMA and this Asterisk build has no Opus. */
const WEB_CODECS = "ulaw,alaw";

// ===========================================
// The shape a tenant's telephony has
// ===========================================

export interface TenantEndpointSpec {
	/** The digits the customer dials. Unique per tenant, deliberately not globally. */
	extension: string;
	/** Desk phone password. */
	password: string;
	/**
	 * The paired browser softphone (101 -> 201), or null when the numbering
	 * convention does not produce one.
	 */
	web: { extension: string; password: string; legacyAlias: boolean } | null;
	/**
	 * Emit a pre-tenancy alias endpoint named after the bare digits.
	 *
	 * True only for an extension that ALREADY had a provisioned phone before
	 * tenancy - i.e. one with a password in .env - and only for the legacy tenant.
	 * renderTenantPjsip() refuses two tenants asking for aliases: the bare-digit
	 * namespace is global, so a second one is exactly the collision this whole
	 * design exists to prevent.
	 */
	legacyAlias: boolean;
}

export interface TenantTrunkSpec {
	host: string;
	port: number | null;
	username: string | null;
	password: string | null;
	fromDomain: string | null;
	register: boolean;
	outboundCallerId: string | null;
}

export interface TenantTelephonySpec {
	slug: string;
	name: string;
	endpoints: TenantEndpointSpec[];
	trunk: TenantTrunkSpec | null;
}

// ===========================================
// Values that end up inside a config file
// ===========================================

/**
 * Whether a value can be written into an Asterisk config file as-is.
 *
 * The trunk fields are vendor-entered free text that lands in a file Asterisk
 * PARSES, so this is an injection boundary, not a validation nicety: a newline
 * starts a new setting, `;` starts a comment and `[` starts a new section. A value
 * carrying any of them is refused rather than escaped, because there is no
 * escaping in this file format to be correct about.
 */
export function isSafeConfigValue(value: string): boolean {
	return value.length > 0 && !/[\r\n;[\]=]/.test(value);
}

function safeOrNull(field: string, value: string | null, slug: string): string | null {
	if (value === null) {
		return null;
	}

	const trimmed = value.trim();

	if (trimmed.length === 0) {
		return null;
	}

	if (!isSafeConfigValue(trimmed)) {
		logger.error(
			{ slug, field },
			"refusing a SIP trunk value that would change the meaning of pjsip.conf"
		);

		return null;
	}

	return trimmed;
}

/**
 * The SIP password for a generated endpoint.
 *
 * Derived rather than stored: see the file header. Base64url of a truncated HMAC -
 * 24 characters, no characters a SIP client or an ini file treats specially.
 */
export function derivedSipPassword(secret: string, slug: string, extension: string): string {
	return createHmac("sha256", secret)
		.update(`${slug}/${extension}`)
		.digest("base64url")
		.slice(0, 24);
}

/**
 * The key the derivation above uses.
 *
 * SIP_ENDPOINT_SECRET when set. Otherwise the ARI password, which every host that
 * has telephony at all already has: falling back keeps a working dev stack working
 * without a new mandatory secret, and an empty answer is reported by the caller
 * rather than silently producing a password of "".
 */
function endpointSecret(): string {
	const env = getServerEnv();
	const explicit = env.SIP_ENDPOINT_SECRET.trim();

	return explicit.length > 0 ? explicit : env.ASTERISK_ARI_PASSWORD;
}

/**
 * The .env password for a pre-tenancy extension, if there is one.
 *
 * Read from process.env directly and not from the env schema: the names are
 * per-extension (SIP_EXT_101_PASSWORD), so there is nothing to declare. Only the
 * legacy tenant uses these - every other tenant's password is derived.
 */
function legacyEnvPassword(extension: string): string | null {
	const desk = process.env[`SIP_EXT_${extension}_PASSWORD`]?.trim();

	if (desk !== undefined && desk.length > 0) {
		return desk;
	}

	const web = process.env[`SIP_WEBRTC_${extension}_PASSWORD`]?.trim();

	return web !== undefined && web.length > 0 ? web : null;
}

// ===========================================
// pjsip.conf rendering
// ===========================================

function header(what: string): string {
	return [
		`;=============================================================================`,
		`; ${what}`,
		`;`,
		`; GENERATED by apps/backend/src/lib/asterisk/tenant-config.ts from the tenants`,
		`; table. Do not edit by hand: the next tenant change overwrites it.`,
		`;=============================================================================`,
		"",
	].join("\n");
}

function deskEndpoint(slug: string, spec: TenantEndpointSpec, context: string): string {
	const name = endpointName(slug, spec.extension);
	const auth = endpointAuthName(slug, spec.extension);

	return `[${name}]
type = endpoint
context = ${context}
disallow = all
allow = ${DESK_CODECS}
auth = ${auth}
aors = ${aorList(name, spec.legacyAlias ? spec.extension : null)}
callerid = Operator ${spec.extension} <${spec.extension}>
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733
mailboxes = ${spec.extension}@default
device_state_busy_at = 1

[${auth}]
type = auth
auth_type = userpass
; The auth username is the ENDPOINT name, not the digits: REGISTER has no tenant
; field, so two customers' "101" would be one global credential.
username = ${name}
password = ${spec.password}

[${name}]
type = aor
max_contacts = 2
remove_existing = yes
qualify_frequency = 30
`;
}

/**
 * The aors an endpoint rings, as PJSIP wants them: one name, or two.
 *
 * The second is the pre-tenancy aor - `101` - and it is what makes a phone that
 * registered under its old name reachable from the tenant's dialplan: dialling
 * `PJSIP/avilab-101` rings the contacts of EVERY aor the endpoint lists, so the old
 * registration and a new one both ring. See legacyAliasEndpoint() for the half that
 * accepts the registration.
 */
function aorList(tenantAor: string, legacyAor: string | null): string {
	return legacyAor === null ? tenantAor : `${tenantAor},${legacyAor}`;
}

function webEndpoint(
	slug: string,
	deskExtension: string,
	web: { extension: string; password: string; legacyAlias: boolean },
	context: string
): string {
	const name = endpointName(slug, web.extension);
	const auth = endpointAuthName(slug, web.extension);

	return `[${name}]
type = endpoint
context = ${context}
disallow = all
allow = ${WEB_CODECS}
auth = ${auth}
aors = ${aorList(name, web.legacyAlias ? web.extension : null)}
callerid = Operator ${deskExtension} web <${web.extension}>
webrtc = yes
dtls_cert_file = /etc/asterisk/keys/asterisk.pem
dtls_private_key = /etc/asterisk/keys/asterisk.key
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

[${auth}]
type = auth
auth_type = userpass
username = ${name}
password = ${web.password}

[${name}]
type = aor
max_contacts = 2
remove_existing = yes
`;
}

/**
 * A pre-tenancy alias: an endpoint AND an aor named after the bare digits.
 *
 * This is what keeps an already-provisioned softphone working, and it needs BOTH
 * halves. The endpoint is what a phone still calling itself "101" authenticates as.
 * The aor has to be named "101" too, because the PJSIP registrar picks the aor by
 * matching the REGISTER's URI user against the endpoint's aor names - point the
 * alias at `avilab-101` and Asterisk answers "AOR '' not found for endpoint '101'"
 * and the phone never comes back. It was measured, not assumed: that is exactly what
 * the container logged before this function grew its own aor.
 *
 * The tenant's own endpoint then lists BOTH aors (see aorList), so
 * `Dial(PJSIP/avilab-101)` rings the old registration as well as a new one. Inbound
 * from the alias enters the TENANT's context, so the call is attributed correctly
 * either way.
 *
 * `101` is a global name and only ONE tenant may have it - renderTenantPjsip()
 * refuses a second - which is the whole reason this is a migration aid and not the
 * design.
 */
function legacyAliasEndpoint(
	slug: string,
	extension: string,
	password: string,
	context: string
): string {
	const target = endpointName(slug, extension);
	const isWeb = extension.startsWith("2");
	const codecs = isWeb ? WEB_CODECS : DESK_CODECS;
	const webrtc = isWeb
		? `webrtc = yes
dtls_cert_file = /etc/asterisk/keys/asterisk.pem
dtls_private_key = /etc/asterisk/keys/asterisk.key
`
		: "";

	return `; LEGACY ALIAS for the pre-tenancy tenant. The phone registers here as
; "${extension}"; ${target} lists this aor too, so the tenant's dialplan reaches it.
[${extension}]
type = endpoint
context = ${context}
disallow = all
allow = ${codecs}
auth = ${extension}-legacy-auth
aors = ${extension}
callerid = Operator ${extension} <${extension}>
${webrtc}direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

[${extension}-legacy-auth]
type = auth
auth_type = userpass
username = ${extension}
password = ${password}

[${extension}]
type = aor
max_contacts = 2
remove_existing = yes
qualify_frequency = 30
`;
}

function trunkSections(slug: string, trunk: TenantTrunkSpec, context: string): string {
	const names = trunkSectionNames(slug);
	const host = safeOrNull("sipTrunkHost", trunk.host, slug);

	if (host === null) {
		return `; trunk for ${slug} skipped: the host is empty or unsafe to render\n`;
	}

	const port = trunk.port !== null && trunk.port > 0 && trunk.port <= 65535 ? trunk.port : null;
	const contactUri = port === null ? `sip:${host}` : `sip:${host}:${port}`;
	const username = safeOrNull("sipTrunkUsername", trunk.username, slug);
	const password = safeOrNull("sipTrunkPassword", trunk.password, slug);
	const fromDomain = safeOrNull("sipTrunkFromDomain", trunk.fromDomain, slug);
	const callerId = safeOrNull("sipOutboundCallerId", trunk.outboundCallerId, slug);
	const registering = trunk.register && username !== null && password !== null;

	const extra: string[] = [];

	if (callerId !== null) {
		// Most carriers reject a From user that is not the DID they issued.
		extra.push(`from_user = ${callerId}`);
	}
	if (fromDomain !== null) {
		extra.push(`from_domain = ${fromDomain}`);
	}
	if (registering) {
		extra.push(`outbound_auth = ${names.auth}`);
	}

	const auth = registering
		? `
[${names.auth}]
type = auth
auth_type = userpass
username = ${username}
password = ${password}
`
		: "";

	const registration = registering
		? `
[${names.registration}]
type = registration
transport = transport-udp
outbound_auth = ${names.auth}
; server_uri carries the port (that is WHERE the REGISTER goes); client_uri does not,
; because it is the identity being registered rather than an address.
server_uri = ${contactUri}
client_uri = sip:${username}@${host}
retry_interval = 60
forbidden_retry_interval = 600
expiration = 3600
; Ties the carrier's inbound INVITE back to this endpoint while we sit behind NAT.
line = yes
endpoint = ${names.endpoint}
`
		: "";

	// Named in both modes: without it a scanner from the internet reaching this
	// port would be treated as the carrier and land in the tenant's context.
	const identify = `
[${names.identify}]
type = identify
endpoint = ${names.endpoint}
match = ${host}
`;

	return `[${names.endpoint}]
type = endpoint
transport = transport-udp
; Inbound carrier calls enter THIS TENANT's context and can reach nothing else.
context = ${context}
disallow = all
allow = ulaw,alaw
aors = ${names.endpoint}
direct_media = no
rtp_symmetric = yes
force_rport = yes
; Deliberately NOT rewrite_contact: a carrier's Contact is authoritative.
rewrite_contact = no
dtmf_mode = rfc4733
language = uz
${extra.join("\n")}${extra.length > 0 ? "\n" : ""}
[${names.endpoint}]
type = aor
contact = ${contactUri}
qualify_frequency = 60
${auth}${registration}${identify}`;
}

/**
 * Every tenant's PJSIP objects, as one file.
 *
 * Pure: it takes specs and returns text, so the two-tenants-cannot-collide claim
 * is a unit test rather than a deployment story.
 */
export function renderTenantPjsip(specs: readonly TenantTelephonySpec[]): string {
	const parts: string[] = [header("Per-tenant PJSIP endpoints, auths, aors and trunks")];
	let aliasTenant: string | null = null;

	for (const spec of specs) {
		if (aliasesOf(spec).length > 0) {
			if (aliasTenant !== null && aliasTenant !== spec.slug) {
				// Two tenants asking for globally-named aliases is the collision this design
				// forbids. Refusing to render is the only safe answer: the alternative is
				// Asterisk matching a REGISTER to whichever of them it hashed first.
				throw new Error(
					`Legacy extension aliases requested by two tenants ('${aliasTenant}' and '${spec.slug}'): the bare-digit endpoint namespace is global and cannot be shared`
				);
			}

			aliasTenant = spec.slug;
		}

		parts.push(renderOneTenantPjsip(spec));
	}

	return `${parts.join("\n")}\n`;
}

/** The bare-digit endpoints this tenant is asking for, desk and web. */
function aliasesOf(spec: TenantTelephonySpec): Array<{ extension: string; password: string }> {
	const aliases: Array<{ extension: string; password: string }> = [];

	for (const endpoint of spec.endpoints) {
		if (endpoint.legacyAlias) {
			aliases.push({ extension: endpoint.extension, password: endpoint.password });
		}

		if (endpoint.web?.legacyAlias === true) {
			aliases.push({ extension: endpoint.web.extension, password: endpoint.web.password });
		}
	}

	return aliases;
}

/** One customer's block: every endpoint in their own context, then their trunk. */
function renderOneTenantPjsip(spec: TenantTelephonySpec): string {
	const contexts = tenantContexts(spec.slug);
	const parts: string[] = [
		`;--- ${spec.name} (${spec.slug}) ${"-".repeat(Math.max(3, 60 - spec.slug.length))}\n`,
	];

	for (const endpoint of spec.endpoints) {
		parts.push(deskEndpoint(spec.slug, endpoint, contexts.internal));

		if (endpoint.web !== null) {
			parts.push(webEndpoint(spec.slug, endpoint.extension, endpoint.web, contexts.internal));
		}
	}

	for (const alias of aliasesOf(spec)) {
		parts.push(legacyAliasEndpoint(spec.slug, alias.extension, alias.password, contexts.internal));
	}

	if (spec.trunk !== null) {
		parts.push(trunkSections(spec.slug, spec.trunk, contexts.external));
	}

	return parts.join("\n");
}

// ===========================================
// extensions.conf rendering
// ===========================================

/**
 * The extensions the context TEMPLATES in asterisk/etc/extensions.conf.template already
 * match, so the generator does not emit a second entry for them.
 *
 * `_1XX` and `_2XX` cover the desk/web pairs the platform has always numbered;
 * anything else - an operator on 991 - needs its own line, which is why this list
 * exists rather than an assumption.
 */
function isCoveredByTemplatePattern(extension: string): boolean {
	return extension.length === 3 && (extension.startsWith("1") || extension.startsWith("2"));
}

/** Extensions the templates already define as literals; a duplicate would clash. */
const TEMPLATE_LITERAL_EXTENSIONS = new Set(["900", "600", "601", "602", "700"]);

function extraInternalExtension(slug: string, extension: string): string {
	const target = endpointName(slug, extension);

	return `exten => ${extension},1,NoOp(Internal call \${CALLERID(num)} -> ${extension} @ ${slug})
 same => n,Set(CDR(userfield)=internal)
 same => n,Dial(PJSIP/${target},30,tT)
 same => n,Goto(dialstatus-\${DIALSTATUS},1)
`;
}

function extraTransferExtension(slug: string, extension: string): string {
	const target = endpointName(slug, extension);

	return `exten => ${extension},1,NoOp(AI transferring caller to operator ${extension} @ ${slug})
 same => n,Dial(PJSIP/${target},25,tT)
 same => n,Hangup()
`;
}

/**
 * Every tenant's five contexts, as one file.
 *
 * Each context INHERITS a `(!)` template from extensions.conf, so the dialplan
 * logic exists exactly once and a tenant's context is a one-line declaration. The
 * templates derive the slug from ${CONTEXT} at runtime, which is what lets one
 * template body dial `PJSIP/<slug>-<exten>` for every tenant.
 */
export function renderTenantDialplan(specs: readonly TenantTelephonySpec[]): string {
	const parts: string[] = [header("Per-tenant dialplan contexts")];

	for (const spec of specs) {
		const contexts = tenantContexts(spec.slug);
		const extras = spec.endpoints
			.map((endpoint) => endpoint.extension)
			.filter(
				(extension) =>
					!(isCoveredByTemplatePattern(extension) || TEMPLATE_LITERAL_EXTENSIONS.has(extension))
			);

		parts.push(`;--- ${spec.name} (${spec.slug}) ---`);
		parts.push(`[${contexts.internal}](tenant-internal)`);

		for (const extension of extras) {
			parts.push(extraInternalExtension(spec.slug, extension));
		}

		parts.push(`[${contexts.external}](tenant-external)`);
		parts.push(`[${contexts.aiBridge}](tenant-ai-bridge)`);
		parts.push(`[${contexts.aiTransfer}](tenant-ai-transfer)`);

		for (const extension of extras) {
			parts.push(extraTransferExtension(spec.slug, extension));
		}

		parts.push(`[${contexts.clickToCall}](tenant-click-to-call)`);
		// The ACD queue entry context: the AI redirects a caller here, and the
		// inherited [tenant-queue] template runs Queue(<slug>-ops). Declared only
		// when the tenant actually has operators - an empty queue would hold every
		// caller forever with nobody to answer.
		if (spec.endpoints.length > 0) {
			parts.push(`[${contexts.queue}](tenant-queue)`);
		}
		parts.push("");
	}

	return `${parts.join("\n")}\n`;
}

// ===========================================
// queues.conf rendering (ACD)
// ===========================================

/**
 * Every tenant's ACD queue, as one file #include-d from queues.conf.
 *
 * This is the "wait for a free operator" behaviour the product needs: the AI hands
 * a caller to the tenant's queue, app_queue rings a free operator (ringinuse=no
 * skips one already on a call), and when every operator is busy the caller waits on
 * hold music instead of being dropped - exactly "free operator -> connect now, all
 * busy -> wait".
 */
export function renderTenantQueues(specs: readonly TenantTelephonySpec[]): string {
	const parts: string[] = [header("Per-tenant ACD queues")];

	for (const spec of specs) {
		// A queue with no members holds callers forever; only emit one for a tenant
		// that actually has operators.
		if (spec.endpoints.length === 0) {
			continue;
		}

		parts.push(renderOneTenantQueue(spec));
	}

	return `${parts.join("\n")}\n`;
}

/**
 * One tenant's queue: the operator pool as app_queue members.
 *
 * Each operator contributes BOTH their desk phone and their paired browser
 * softphone as members, so the queue reaches them on whichever they are logged
 * into. `ringinuse = no` means a member already on a call is skipped, which is what
 * makes each operator take one call at a time; `leavewhenempty = no` + `joinempty =
 * yes` are what let a caller WAIT when every operator is busy rather than being
 * turned away.
 */
function renderOneTenantQueue(spec: TenantTelephonySpec): string {
	const name = queueName(spec.slug);
	const members: string[] = [];

	for (const endpoint of spec.endpoints) {
		members.push(
			`member => PJSIP/${endpointName(spec.slug, endpoint.extension)},0,Operator ${endpoint.extension}`
		);

		if (endpoint.web !== null) {
			members.push(
				`member => PJSIP/${endpointName(spec.slug, endpoint.web.extension)},0,Operator ${endpoint.extension} web`
			);
		}
	}

	return `;--- ${spec.name} (${spec.slug}) ---
[${name}]
; rrmemory spreads calls round-robin and remembers where it left off, so callers
; are not all funnelled onto the first operator.
strategy = rrmemory
; How long one member's phone rings before the queue moves on to the next.
timeout = 20
; Seconds to pause before retrying members after a full pass with no answer.
retry = 2
; A short breather after a call so the queue does not instantly re-ring a member.
wrapuptime = 3
; Skip a member who is already on a call: one call per operator at a time.
ringinuse = no
autofill = yes
; Let a caller JOIN and WAIT even when every operator is momentarily busy, and do
; not eject them when the queue has no free member - this is the "wait" behaviour.
joinempty = yes
leavewhenempty = no
musicclass = default
${members.join("\n")}
`;
}

// ===========================================
// Reading the tenants out of the database
// ===========================================

/**
 * Which tenant keeps the bare-digit alias endpoints.
 *
 * The pre-tenancy deployment, i.e. the demo tenant, whose slug is in .env so the
 * container's bootstrap copy and the backend agree on it without a database read.
 */
export function legacyTenantSlug(): string {
	return getServerEnv().ASTERISK_LEGACY_TENANT_SLUG.trim() || "avilab";
}

function trunkOf(tenant: TenantRecord): TenantTrunkSpec | null {
	if (tenant.sipTrunkHost === null || tenant.sipTrunkHost.trim().length === 0) {
		return null;
	}

	return {
		host: tenant.sipTrunkHost,
		port: tenant.sipTrunkPort,
		username: tenant.sipTrunkUsername,
		password: tenant.sipTrunkPassword,
		fromDomain: tenant.sipTrunkFromDomain,
		register: tenant.sipTrunkRegister,
		outboundCallerId: tenant.sipOutboundCallerId,
	};
}

/**
 * The specs for every tenant that can have telephony.
 *
 * The vendor's own row is skipped - it is not a call centre - and so is a `closed`
 * customer: an offboarded tenant keeps its data and loses its endpoints, which is
 * the whole point of the status. A `suspended` one KEEPS them, because suspension
 * is a balance decision that phase two enforces per call, and silently deleting a
 * paying customer's phones because an invoice is late is not this module's call.
 */
export async function collectTenantTelephony(): Promise<TenantTelephonySpec[]> {
	const [tenantRows, operatorRows] = await Promise.all([
		listAllTenants(),
		db
			.select({ tenantId: operatorProfiles.tenantId, extension: operatorProfiles.extension })
			.from(operatorProfiles)
			.where(eq(operatorProfiles.isDeleted, false))
			.orderBy(asc(operatorProfiles.extension)),
	]);

	const secret = endpointSecret();
	const legacySlug = legacyTenantSlug();
	const specs: TenantTelephonySpec[] = [];

	for (const tenant of tenantRows) {
		if (tenant.isVendor || tenant.status === "closed") {
			continue;
		}

		const trunk = trunkOf(tenant);
		const endpoints = operatorRows
			.filter((row) => row.tenantId === tenant.id)
			.map((row) =>
				endpointSpecFor(tenant.slug, row.extension, secret, tenant.slug === legacySlug)
			);

		if (endpoints.length === 0 && trunk === null) {
			continue;
		}

		specs.push({ slug: tenant.slug, name: tenant.name, endpoints, trunk });
	}

	return specs;
}

/**
 * One operator's endpoints and passwords.
 *
 * The demo tenant's phones are already provisioned with the .env passwords, so those
 * are used where they exist; every other tenant's password is derived and nothing has
 * to be stored anywhere. An extension WITH a .env password is exactly a pre-tenancy
 * one, which is what earns it a bare-digit alias endpoint - so "which endpoints keep
 * their old name" is answered by the same fact rather than by a second list.
 */
function endpointSpecFor(
	slug: string,
	extension: string,
	secret: string,
	isLegacyTenant: boolean
): TenantEndpointSpec {
	const web = webExtensionFor(extension);
	const envPassword = isLegacyTenant ? legacyEnvPassword(extension) : null;
	const envWebPassword = isLegacyTenant && web !== null ? legacyEnvPassword(web) : null;

	return {
		extension,
		password: envPassword ?? derivedSipPassword(secret, slug, extension),
		web:
			web === null
				? null
				: {
						extension: web,
						password: envWebPassword ?? derivedSipPassword(secret, slug, web),
						legacyAlias: envWebPassword !== null,
					},
		legacyAlias: envPassword !== null,
	};
}

/**
 * The browser-softphone SIP identity for one operator, computed the SAME way the
 * generated pjsip config is, so the credentials always match what Asterisk has.
 *
 * Each operator registers the dashboard softphone as their OWN web endpoint
 * (`avilab-202`, not a shared `201`), so an AI transfer that rings their desk pair
 * (102 -> 202) reaches THEIR browser and nobody else's. The password is the
 * pre-tenancy .env one for the legacy tenant's endpoints and the derived HMAC for
 * every other tenant - identical to endpointSpecFor() - and is handed out only over
 * the authenticated API to the operator it belongs to, never baked into the bundle.
 *
 * Returns null for an extension with no browser pair (only 1XX desk extensions have
 * one), which is the caller's signal that this operator has no web softphone.
 */
export function operatorWebSipIdentity(
	slug: string,
	deskExtension: string
): { sipUsername: string; sipPassword: string; webExtension: string } | null {
	const webExtension = webExtensionFor(deskExtension);

	if (webExtension === null) {
		return null;
	}

	const isLegacyTenant = slug === legacyTenantSlug();
	const envPassword = isLegacyTenant ? legacyEnvPassword(webExtension) : null;

	return {
		sipUsername: endpointName(slug, webExtension),
		sipPassword: envPassword ?? derivedSipPassword(endpointSecret(), slug, webExtension),
		webExtension,
	};
}

// ===========================================
// Writing it out and reloading Asterisk
// ===========================================

/**
 * Where MixMonitor writes this tenant's recordings, host side.
 *
 * Created ahead of the call rather than relied on: the dialplan hands MixMonitor a
 * path with a tenant directory in it, and a missing directory is a call with no
 * recording. Cheap and idempotent, and remembered so it is one syscall per tenant
 * per process rather than one per call.
 */
const ensuredRecordingDirs = new Set<string>();

export function tenantRecordingDir(slug: string): string {
	const configured = getServerEnv().RECORDINGS_DIR.replace(/\/+$/, "");
	const base = isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);

	return join(base, slug);
}

/**
 * DEPLOYMENT NOTE for a Linux host: MixMonitor runs as the container's `asterisk`
 * user and this runs as whoever the backend runs as, so a directory created here
 * must be writable by that user. entrypoint.sh chowns the recordings ROOT at boot;
 * a tenant directory created later inherits its permissions, which is fine when the
 * bind mount is group-writable and is worth checking when it is not. On Docker
 * Desktop the mount ignores ownership entirely, which is why this is a note rather
 * than a chmod: a 0777 that only matters on one platform hides the real question.
 */
export async function ensureTenantRecordingDir(slug: string): Promise<void> {
	if (ensuredRecordingDirs.has(slug)) {
		return;
	}

	const dir = tenantRecordingDir(slug);

	try {
		await mkdir(dir, { recursive: true });
		ensuredRecordingDirs.add(slug);
	} catch (cause) {
		logger.warn({ err: cause, slug, dir }, "could not create the tenant recording directory");
	}
}

/**
 * True once the generated per-tenant config is known to be live in Asterisk.
 *
 * Read by tenantContextsFor(): naming a context Asterisk does not have would drop
 * every call, so until the write and the reload have both succeeded the backend
 * keeps using the pre-tenancy context names, which are static and always present.
 */
let generatedConfigLive = false;

export function isTenantConfigLive(): boolean {
	return generatedConfigLive;
}

/** Test seam: lets a test assert both sides of the fallback without a container. */
export function setTenantConfigLive(live: boolean): void {
	generatedConfigLive = live;
}

/**
 * The five context names to use for a tenant, or the pre-tenancy ones.
 *
 * ONE place decides, so a half-migrated deployment cannot have the orchestrator
 * handing channels to `ai-bridge-avilab` while the transfer path redirects them to
 * `ai-transfer`. `slug === null` means the call's tenant could not be named (the
 * sole-tenant fallback), and a nameless tenant has no context of its own.
 */
export function tenantContextsFor(slug: string | null): {
	internal: string;
	external: string;
	aiBridge: string;
	aiTransfer: string;
	clickToCall: string;
	queue: string;
} {
	if (slug === null || !generatedConfigLive) {
		return { ...LEGACY_CONTEXTS };
	}

	try {
		return tenantContexts(slug);
	} catch {
		// An unparseable slug cannot name a context. The legacy names are wrong but
		// present, which loses isolation on this one call instead of dropping it -
		// and resolveInboundTenant() already refused any slug the tenants table does
		// not know, so getting here means a tenant row itself is malformed.
		logger.error({ slug }, "tenant slug cannot be used in a context name");

		return { ...LEGACY_CONTEXTS };
	}
}

/**
 * The PJSIP endpoint to dial for an extension: `avilab-101`, or `101` before the
 * generated config is live.
 */
export function tenantEndpointFor(slug: string | null, extension: string): string {
	if (slug === null || !generatedConfigLive) {
		return extension;
	}

	try {
		return endpointName(slug, extension);
	} catch {
		return extension;
	}
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
	try {
		const existing = await readFile(path, "utf8");

		if (existing === content) {
			return false;
		}
	} catch {
		// Missing file: fall through and write it.
	}

	await writeFile(path, content, "utf8");

	return true;
}

export interface SyncResult {
	tenants: number;
	endpoints: number;
	changed: boolean;
	reloaded: boolean;
}

/**
 * Regenerate the two include files and, if anything changed, ask Asterisk to
 * reload.
 *
 * Called at startup and by whatever changes a tenant or an operator. Never throws:
 * a failure here must leave the platform on the pre-tenancy contexts (which still
 * work for the demo tenant) rather than take the API down - so the return value
 * says what happened and the log says why.
 */
export async function syncAsteriskTenantConfig(): Promise<SyncResult> {
	const result: SyncResult = { tenants: 0, endpoints: 0, changed: false, reloaded: false };

	let specs: TenantTelephonySpec[];

	try {
		specs = await collectTenantTelephony();
	} catch (cause) {
		logger.error({ err: cause }, "could not read the tenants for the Asterisk config");

		return result;
	}

	result.tenants = specs.length;
	result.endpoints = specs.reduce(
		(total, spec) => total + spec.endpoints.length + spec.endpoints.filter((e) => e.web).length,
		0
	);

	let pjsip: string;
	let dialplan: string;
	let queues: string;

	try {
		pjsip = renderTenantPjsip(specs);
		dialplan = renderTenantDialplan(specs);
		queues = renderTenantQueues(specs);
	} catch (cause) {
		// A refused render is a configuration the platform must not deploy - two
		// tenants claiming the alias namespace, or a malformed slug.
		logger.error({ err: cause }, "refusing to generate the per-tenant Asterisk config");

		return result;
	}

	try {
		await mkdir(GENERATED_DIR, { recursive: true });

		const pjsipChanged = await writeIfChanged(join(GENERATED_DIR, PJSIP_TENANTS_FILE), pjsip);
		const dialplanChanged = await writeIfChanged(
			join(GENERATED_DIR, EXTENSIONS_TENANTS_FILE),
			dialplan
		);
		const queuesChanged = await writeIfChanged(join(GENERATED_DIR, QUEUES_TENANTS_FILE), queues);

		result.changed = pjsipChanged || dialplanChanged || queuesChanged;
	} catch (cause) {
		logger.error({ err: cause, dir: GENERATED_DIR }, "could not write the per-tenant config");

		return result;
	}

	await Promise.all(specs.map((spec) => ensureTenantRecordingDir(spec.slug)));

	// Reload even when nothing changed on OUR side: the container may have restarted
	// since, and the cost is two AMI actions at boot.
	result.reloaded = await reloadAsterisk();

	if (result.reloaded) {
		generatedConfigLive = true;
	}

	logger.info(
		{ ...result, dir: GENERATED_DIR },
		result.reloaded
			? "per-tenant Asterisk config is live"
			: "per-tenant Asterisk config written but NOT reloaded - staying on the pre-tenancy contexts"
	);

	return result;
}

/**
 * Reload the modules that read the generated files.
 *
 * `Reload` with an explicit module rather than a full `core reload`: reloading
 * everything drops the ARI HTTP server and the AMI connection this very call is
 * travelling on. res_pjsip reads pjsip-tenants.conf, pbx_config reads
 * extensions-tenants.conf, and app_queue reads queues-tenants.conf (the ACD pool).
 */
async function reloadAsterisk(): Promise<boolean> {
	const ami = getAmiClient();
	let ok = true;

	for (const module of ["res_pjsip.so", "pbx_config.so", "app_queue.so"]) {
		try {
			await ami.action("Reload", { Module: module });
		} catch (cause) {
			logger.error({ err: cause, module }, "Asterisk module reload failed");
			ok = false;
		}
	}

	return ok;
}
