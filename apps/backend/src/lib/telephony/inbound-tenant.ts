/**
 * WHOSE CALL IS THIS? The hardest question in the tenancy work, answered here.
 *
 * Every other write path has a logged-in user to take a tenant from. This one does
 * not: an inbound call arrives as an ARI StasisStart event over a WebSocket, with no
 * request, no token and no session. Whatever this module returns becomes the tenant
 * of the `calls` row, and every child row - the contact, the AI session, every
 * transcript line, the recording, the analysis, the ticket - inherits it. Get it
 * wrong and one customer's caller is recorded, transcribed and billed inside another
 * customer's account.
 *
 * WHAT THE CHANNEL ACTUALLY TELLS US, in the order this module trusts it:
 *
 *   1. A Stasis argument `tenant=<slug>`. The dialplan is the only party that knows
 *      which trunk the call came in on, and this is how it will say so:
 *      Stasis(callcenter-ai,tenant=avilab). Highest authority because it is an
 *      explicit statement rather than an inference.
 *   2. A channel variable TENANT_SLUG, for the same statement made with Set() - which
 *      is what an existing dialplan can add without changing its Stasis() line.
 *   3. The dialplan CONTEXT the channel is executing in. This is decision #1 of the
 *      three the owner made: extension numbers collide across customers, so
 *      isolation lives in the context name (from-external-avilab), and the context is
 *      therefore identity. See lib/tenancy/asterisk-naming.ts.
 *   4. The PJSIP ENDPOINT in the channel name - `PJSIP/avilab-101-0000001a`. This is
 *      how an INTERNAL call identifies itself: an operator's own endpoint is named
 *      for their tenant, so a call from a desk phone carries the tenant even when the
 *      context does not.
 *
 * WHAT ACTUALLY HAPPENS NOW, measured on the live stack: source #1 answers. The
 * dialplan says `Stasis(callcenter-ai,tenant=avilab)` from every tenant context
 * (asterisk/etc/extensions.conf.template), and the log line in the orchestrator
 * reports tenantSource "stasis-arg". Sources #2-#4 are the fallbacks for a dialplan
 * somebody edits later, in descending order of how explicit they are.
 *
 * AND WHEN IT TELLS US NOTHING. A channel can still arrive with no tenant on it: an
 * originate straight into Stasis, or a dialplan edited to drop the argument. The
 * fallback is "the only customer there is", and getSoleTenantId() THROWS the moment a
 * second customer exists rather than guessing. That throw is deliberate: a call that
 * cannot be attributed must not be attributed at random. A refused channel is a
 * caller hearing congestion; a misattributed one is a data breach nobody notices.
 * (This is not theoretical: with three customer tenants in the database, every call
 * arriving through the pre-tenancy contexts was refused until the dialplan started
 * naming the tenant. The pre-tenancy context names now FORWARD into the legacy
 * tenant's own contexts, which is what puts the tenant back on those calls.)
 *
 * A SLUG IS NOT A TENANT. Everything above produces a slug at best, and a slug from
 * Asterisk is untrusted input: it is resolved against the tenants table (cached), and
 * an unknown slug is reported as unresolved rather than quietly falling through to
 * the sole tenant - falling through would let a misconfigured context land another
 * customer's calls in this one's account.
 */
import {
	getSoleTenantId,
	getTenantBySlug,
	isTenantOperational,
	slugFromContext,
	slugFromEndpointName,
	type TenantId,
} from "@/lib/tenancy";

/** Enough of an ARI channel to name a tenant. Structural, so tests need no fixture. */
export interface TenantBearingChannel {
	name: string;
	dialplan: { context: string };
	channelvars?: Record<string, string> | undefined;
}

/** How the tenant was decided, for the log line and for the tests. */
export type InboundTenantSource =
	| "stasis-arg"
	| "channel-var"
	| "context"
	| "endpoint"
	| "sole-tenant";

export interface InboundTenantResolution {
	tenantId: TenantId;
	slug: string | null;
	source: InboundTenantSource;
	/**
	 * False for a suspended or closed customer. Nothing here acts on it - refusing a
	 * call is the balance phase's decision, not this module's - but the fact is
	 * carried out so that phase has one place to put the rule.
	 */
	operational: boolean;
}

/** The Stasis argument spelling the dialplan will use: `tenant=avilab`. */
const TENANT_ARG_PREFIX = "tenant=";
/** The channel-variable spelling, for a dialplan that prefers Set(). */
const TENANT_CHANNEL_VAR = "TENANT_SLUG";

/**
 * The slug the channel claims, or null.
 *
 * Pure and exported: this is the part with all the string handling in it, and it is
 * worth testing without a database.
 */
export function slugFromChannel(channel: TenantBearingChannel, args: string[] = []): string | null {
	for (const arg of args) {
		if (arg.startsWith(TENANT_ARG_PREFIX)) {
			const slug = arg.slice(TENANT_ARG_PREFIX.length).trim();

			if (slug.length > 0) {
				return slug;
			}
		}
	}

	const fromVar = channel.channelvars?.[TENANT_CHANNEL_VAR]?.trim();

	if (fromVar) {
		return fromVar;
	}

	const fromContext = slugFromContext(channel.dialplan.context);

	if (fromContext !== null) {
		return fromContext;
	}

	return slugFromEndpointName(endpointOf(channel.name));
}

/**
 * The endpoint part of a channel name.
 *
 * `PJSIP/avilab-101-0000001a` -> `avilab-101`: the technology prefix and the
 * per-channel sequence suffix Asterisk appends are both dropped. A name with no
 * sequence suffix is returned as-is, since slugFromEndpointName() rejects what it
 * cannot parse anyway.
 */
export function endpointOf(channelName: string): string {
	const withoutTech = channelName.includes("/")
		? (channelName.split("/").at(-1) ?? channelName)
		: channelName;
	const separator = withoutTech.lastIndexOf("-");

	return separator > 0 ? withoutTech.slice(0, separator) : withoutTech;
}

/**
 * Which customer this inbound channel belongs to.
 *
 * Throws only when there is no honest answer at all: no slug on the channel and no
 * single customer to fall back to. The orchestrator turns that into a released
 * channel, which is the correct outcome - a call we cannot attribute is a call we
 * cannot record.
 */
export async function resolveInboundTenant(
	channel: TenantBearingChannel,
	args: string[] = []
): Promise<InboundTenantResolution> {
	const claimed = slugFromChannel(channel, args);

	if (claimed !== null) {
		const tenant = await getTenantBySlug(claimed);

		if (tenant === null || tenant.isVendor) {
			// An unknown slug is a misconfigured dialplan, and the vendor's own row is not
			// a call centre. Neither may fall through to the sole tenant: that is how one
			// customer's calls end up in another's account after a config edit.
			throw new Error(`Unknown tenant slug on the channel: '${claimed}'`);
		}

		return {
			tenantId: tenant.id,
			slug: tenant.slug,
			source: sourceOf(channel, args),
			operational: isTenantOperational(tenant.status),
		};
	}

	// TODO(tenancy): remove with the per-tenant dialplan. Until asterisk/etc/
	// extensions.conf and entrypoint.sh generate per-tenant contexts and endpoints
	// (asterisk-naming.ts is the contract), a channel carries no slug and this is the
	// only answer that is not a guess. It throws on customer number two.
	return {
		tenantId: await getSoleTenantId(),
		slug: null,
		source: "sole-tenant",
		operational: true,
	};
}

/** Which of the four sources produced the slug. Recomputed, so it cannot disagree. */
function sourceOf(channel: TenantBearingChannel, args: string[]): InboundTenantSource {
	if (args.some((arg) => arg.startsWith(TENANT_ARG_PREFIX))) {
		return "stasis-arg";
	}

	if (channel.channelvars?.[TENANT_CHANNEL_VAR]?.trim()) {
		return "channel-var";
	}

	if (slugFromContext(channel.dialplan.context) !== null) {
		return "context";
	}

	return "endpoint";
}
