/**
 * WHOSE CALL IS THIS - the tests for the one question that has no request behind it.
 *
 * An inbound call is written to the database from an ARI event, so the tenant cannot
 * come from a token: it comes from the channel. Everything the call goes on to write -
 * the contact, the AI session, every transcript line, the recording, the analysis -
 * inherits whatever this module answers, which makes these the highest-consequence
 * string tests in the codebase.
 *
 * The pure half runs with no database. The resolving half uses the real tenant
 * registry, because the property being tested is precisely that a slug off the wire is
 * resolved against the tenants table rather than trusted.
 */
import { describe, expect, test } from "bun:test";

import { getTenantBySlug, LEGACY_CONTEXTS, tenantContexts } from "@/lib/tenancy";

import {
	endpointOf,
	resolveInboundTenant,
	slugFromChannel,
	type TenantBearingChannel,
} from "./inbound-tenant";

/** The demo tenant, which is the one tenant every environment has. */
const DEMO_SLUG = "avilab";

function channel(
	overrides: Partial<TenantBearingChannel> & { context?: string } = {}
): TenantBearingChannel {
	return {
		name: overrides.name ?? "PJSIP/trunk-0000001a",
		dialplan: { context: overrides.context ?? LEGACY_CONTEXTS.external },
		channelvars: overrides.channelvars,
	};
}

describe("the endpoint name inside a channel name", () => {
	test("the technology prefix and the sequence suffix are both dropped", () => {
		expect(endpointOf("PJSIP/avilab-101-0000001a")).toBe("avilab-101");
	});

	test("a name with no sequence suffix loses its last segment, and that is safe", () => {
		// endpointOf() cannot tell "avilab-101" (endpoint, no suffix) from "avilab-101-1a"
		// (endpoint plus suffix), so it strips either way. Nothing depends on it being
		// right, because slugFromEndpointName() only accepts <slug>-<digits> and rejects
		// whatever this produces from anything else - including a Local channel.
		expect(endpointOf("PJSIP/avilab-101")).toBe("avilab");
		expect(slugFromChannel(channel({ name: "Local/900@from-internal" }))).toBeNull();
	});
});

describe("the slug a channel claims", () => {
	test("a Stasis argument wins, because it is a statement rather than an inference", () => {
		const claimed = slugFromChannel(
			channel({ context: tenantContexts("beta").external, name: "PJSIP/gamma-101-0000001a" }),
			["tenant=avilab"]
		);

		expect(claimed).toBe("avilab");
	});

	test("a channel variable is the second source", () => {
		const claimed = slugFromChannel(
			channel({ channelvars: { TENANT_SLUG: "avilab" }, name: "PJSIP/gamma-101-00001" }),
			[]
		);

		expect(claimed).toBe("avilab");
	});

	test("the dialplan context identifies the tenant - decision #1, where isolation lives", () => {
		expect(slugFromChannel(channel({ context: "from-external-avilab" }))).toBe("avilab");
		expect(slugFromChannel(channel({ context: "from-internal-beta" }))).toBe("beta");
	});

	test("an internal call is identified by its own PJSIP endpoint", () => {
		const claimed = slugFromChannel(
			channel({ context: LEGACY_CONTEXTS.internal, name: "PJSIP/avilab-101-0000001a" })
		);

		expect(claimed).toBe("avilab");
	});

	test("the legacy shared contexts and bare endpoints claim nothing", () => {
		// This is what today's deployment actually looks like, and the reason the
		// sole-tenant fallback still exists. Answering a slug here would be an invention.
		expect(
			slugFromChannel(channel({ context: LEGACY_CONTEXTS.external, name: "PJSIP/101-0001" }))
		).toBeNull();
		expect(slugFromChannel(channel({ context: LEGACY_CONTEXTS.aiBridge }))).toBeNull();
	});

	test("an empty or whitespace tenant argument is not a slug", () => {
		expect(slugFromChannel(channel(), ["tenant="])).toBeNull();
		expect(slugFromChannel(channel({ channelvars: { TENANT_SLUG: "   " } }))).toBeNull();
	});
});

describe("a slug from Asterisk is resolved, never trusted", () => {
	test("the demo tenant's own context resolves to the demo tenant", async () => {
		const demo = await getTenantBySlug(DEMO_SLUG);

		if (!demo) {
			throw new Error('No "avilab" tenant. Run bun run db:seed.');
		}

		const resolved = await resolveInboundTenant(
			channel({ context: tenantContexts(DEMO_SLUG).external })
		);

		expect(resolved.tenantId).toBe(demo.id);
		expect(resolved.slug).toBe(DEMO_SLUG);
		expect(resolved.source).toBe("context");
	});

	test("an unknown slug is refused, NOT quietly served as the sole tenant", async () => {
		// The whole point. A typo in a generated context must fail loudly: falling
		// through to "the only customer there is" is how one customer's calls end up in
		// another's account after a config edit.
		await expect(
			resolveInboundTenant(channel({ context: "from-external-nosuchtenant" }))
		).rejects.toThrow(/Unknown tenant slug/);
	});

	test("the vendor's own tenant is not a call centre and is refused as well", async () => {
		const vendor = await getTenantBySlug("vendor");

		if (!vendor?.isVendor) {
			// The vendor row is seeded by the tenancy migration under this slug; if this
			// environment names it something else there is nothing to assert.
			return;
		}

		await expect(
			resolveInboundTenant(channel({ context: tenantContexts("vendor").external }))
		).rejects.toThrow(/Unknown tenant slug/);
	});

	test("a channel that claims nothing gets the sole customer, or an honest error", async () => {
		// Today's deployment: one shared [from-external] and one customer. Both outcomes
		// below are correct; what must never happen is a tenant picked out of several.
		try {
			const resolved = await resolveInboundTenant(channel());

			expect(resolved.source).toBe("sole-tenant");
			expect(resolved.slug).toBeNull();
			expect(resolved.tenantId).toBeTruthy();
		} catch (cause) {
			expect(String(cause)).toMatch(/More than one tenant|No customer tenant/);
		}
	});
});
