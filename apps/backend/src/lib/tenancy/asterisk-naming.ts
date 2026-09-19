/**
 * How a tenant's telephony is named. ONE source of truth, used by the config
 * generator, the dialplan and anything that has to read a channel name back.
 *
 * THE DECISION THIS ENCODES. Each customer has their own SIP trunk and their own
 * numbers, and their extension numbers WILL collide - "101" is an operator code
 * and every customer has one. Renaming a customer's extensions to make them
 * globally unique would break the only thing the customer cares about: that they
 * dial 101 and reach their own operator. So the digits stay, and isolation lives
 * one level up, in the PJSIP endpoint name and the dialplan context:
 *
 *   endpoint   avilab-101                 (unique platform-wide)
 *   context    from-internal-avilab       (a caller in it can reach nothing else)
 *   trunk      trunk-avilab
 *
 * A customer dials 101 inside their own context and reaches their own 101. Two
 * customers' 101s are two endpoints in two contexts that cannot see each other.
 *
 * WHAT GENERATES AGAINST IT. lib/asterisk/tenant-config.ts renders
 * asterisk/etc/generated/pjsip-tenants.conf and extensions-tenants.conf from the
 * tenants table using only the functions below, and asterisk/etc/extensions.conf.template
 * holds the per-tenant contexts as `(!)` templates that the generated file
 * inherits. The LEGACY_* names still exist: they are the pre-tenancy contexts the
 * demo tenant answered on before this, kept as the fallback for a deployment whose
 * generated config has not been written yet.
 *
 * ONE THING SIP DOES NOT LET US TENANT: the REGISTER namespace. A phone
 * authenticates with a username and a password and there is no tenant field in
 * the request, so two customers' "101" auth users would be one global name and
 * Asterisk would match a REGISTER to whichever endpoint it hashed first. So the
 * SIP AUTH USERNAME is the endpoint name (`avilab-101`) - globally unique - while
 * the DIGITS the customer dials stay 101. Provisioning a softphone with a unique
 * username is what every hosted PBX does; dialling is what the customer sees, and
 * that is untouched.
 */

/**
 * The pre-tenancy context names, still live. Kept as constants rather than string
 * literals scattered around so the migration to per-tenant contexts is a search
 * for one identifier each.
 */
export const LEGACY_CONTEXTS = {
	internal: "from-internal",
	external: "from-external",
	aiBridge: "ai-bridge",
	aiTransfer: "ai-transfer",
	clickToCall: "click-to-call",
	queue: "queue",
} as const;

/** Matches tenants_slug_format_chk in the tenants table. */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** Digits only, at most 10, matching operator_profiles.extension. */
const EXTENSION_PATTERN = /^[0-9]{1,10}$/;

function assertSlug(slug: string): void {
	if (!SLUG_PATTERN.test(slug)) {
		// A malformed slug would produce a context name Asterisk parses differently
		// than intended - which is how two tenants end up sharing one context.
		throw new Error("Invalid tenant slug for Asterisk naming");
	}
}

function assertExtension(extension: string): void {
	if (!EXTENSION_PATTERN.test(extension)) {
		throw new Error("Invalid extension for Asterisk naming");
	}
}

/** `avilab-101` - the PJSIP endpoint, aor and auth name for one operator. */
export function endpointName(slug: string, extension: string): string {
	assertSlug(slug);
	assertExtension(extension);

	return `${slug}-${extension}`;
}

/** The tenant's own dialplan contexts. */
export function tenantContexts(slug: string): {
	internal: string;
	external: string;
	aiBridge: string;
	aiTransfer: string;
	clickToCall: string;
	queue: string;
} {
	assertSlug(slug);

	return {
		internal: `from-internal-${slug}`,
		external: `from-external-${slug}`,
		aiBridge: `ai-bridge-${slug}`,
		aiTransfer: `ai-transfer-${slug}`,
		clickToCall: `click-to-call-${slug}`,
		queue: `queue-${slug}`,
	};
}

/**
 * The app_queue name for a tenant's operator pool: `avilab-ops`.
 *
 * This is the Asterisk queue (queues.conf) that the AI hands a caller to. Like
 * every other name here it carries the slug, because a queue is a global object in
 * Asterisk and two customers' "ops" queues must not be one shared queue that mixes
 * their callers and operators.
 */
export function queueName(slug: string): string {
	assertSlug(slug);

	return `${slug}-ops`;
}

/** `trunk-avilab` - the endpoint for this tenant's own carrier. */
export function trunkEndpointName(slug: string): string {
	assertSlug(slug);

	return `trunk-${slug}`;
}

/**
 * `avilab-101-auth` - the PJSIP auth section for one operator endpoint.
 *
 * A separate suffix rather than reusing the endpoint name because auth, aor and
 * endpoint are three sorcery types and reading a config where all three sections
 * are spelled identically is how a mis-edit goes unnoticed. The suffix is not
 * digits, so slugFromEndpointName() cannot mistake an auth name for an endpoint.
 */
export function endpointAuthName(slug: string, extension: string): string {
	return `${endpointName(slug, extension)}-auth`;
}

/**
 * The browser softphone that pairs with a desk extension: 101 -> 201.
 *
 * The pairing predates tenancy - dialling 101 rings the desk phone AND the
 * dashboard's phone - and it only ever applied to three-digit 1XX extensions,
 * which is why anything else returns null instead of inventing a second endpoint.
 */
export function webExtensionFor(extension: string): string | null {
	assertExtension(extension);

	if (extension.length !== 3 || !extension.startsWith("1")) {
		return null;
	}

	return `2${extension.slice(1)}`;
}

/** The auth, aor, registration and identify names for a tenant's own carrier. */
export function trunkSectionNames(slug: string): {
	endpoint: string;
	auth: string;
	registration: string;
	identify: string;
} {
	const endpoint = trunkEndpointName(slug);

	return {
		endpoint,
		auth: `${endpoint}-auth`,
		registration: `${endpoint}-reg`,
		identify: `${endpoint}-identify`,
	};
}

/**
 * The slug back out of an endpoint name, or null.
 *
 * Needed because Asterisk hands back channel names, not tenant ids: a channel
 * `PJSIP/avilab-101-0000001a` has to resolve to a tenant before anything is
 * written to the database. Returns null for a name that does not carry a slug -
 * every pre-tenancy endpoint, which is why the caller must have a fallback for as
 * long as the legacy contexts exist.
 */
export function slugFromEndpointName(endpoint: string): string | null {
	const separator = endpoint.lastIndexOf("-");

	if (separator <= 0) {
		return null;
	}

	const slug = endpoint.slice(0, separator);
	const extension = endpoint.slice(separator + 1);

	if (!(SLUG_PATTERN.test(slug) && EXTENSION_PATTERN.test(extension))) {
		return null;
	}

	return slug;
}

/** The slug out of a context name, or null when it is one of the legacy contexts. */
export function slugFromContext(context: string): string | null {
	for (const prefix of Object.values(LEGACY_CONTEXTS)) {
		if (context === prefix) {
			return null;
		}

		if (context.startsWith(`${prefix}-`)) {
			const slug = context.slice(prefix.length + 1);

			return SLUG_PATTERN.test(slug) ? slug : null;
		}
	}

	return null;
}
