/**
 * THE AUTH BOUNDARY. What a token may and may not say about a tenant.
 *
 * Everything downstream trusts one thing: that the tenant in the request context
 * came from a signed token this process minted. So the assertions here are about
 * the two ways that trust could be broken:
 *
 *   1. a token with NO tenant being accepted and then defaulted to one - which is
 *      what would happen to every access token minted before tenancy;
 *   2. an impersonation claim being misread as absent, which would turn a vendor's
 *      all-access token into an untraceable one.
 *
 * Both are tested with tokens signed by the REAL secret, because an attacker with
 * a stolen v1 token has a validly signed token: the rejection has to come from the
 * payload rules, not from the signature check.
 */

import { describe, expect, test } from "bun:test";
import { getServerEnv } from "@shared/env";
import { asTenantId } from "@shared/types";
import * as jose from "jose";

import { ACCESS_TOKEN_VERSION, generateAccessToken, verifyAccessToken } from "./jwt";

const TENANT = asTenantId("00000000-0000-0000-0000-00000000000a");
const VENDOR_TENANT = asTenantId("00000000-0000-0000-0000-000000000001");
const USER = "11111111-1111-4111-8111-111111111111";
const VENDOR_USER = "22222222-2222-4222-8222-222222222222";

const secret = new TextEncoder().encode(getServerEnv().JWT_SECRET);

/** A validly SIGNED token with an arbitrary payload - what a legacy client holds. */
async function signRaw(payload: Record<string, unknown>, subject = USER): Promise<string> {
	return await new jose.SignJWT(payload)
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(subject)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(secret);
}

describe("access tokens carry the tenant", () => {
	test("a minted token round-trips the tenant, the role and the version", async () => {
		const token = await generateAccessToken({
			userId: USER,
			role: "supervisor",
			tenantId: TENANT,
		});

		const payload = await verifyAccessToken(token);

		expect(payload.sub).toBe(USER);
		expect(payload.role).toBe("supervisor");
		expect(payload.tid).toBe(TENANT);
		expect(payload.ver).toBe(ACCESS_TOKEN_VERSION);
		// No actor claim means "this is the tenant's own user", which is what makes
		// vendor access detectable at all.
		expect(payload.act).toBeUndefined();
	});
});

describe("tokens minted before tenancy", () => {
	test("a v1 token - correctly signed, no tenant - is REFUSED", async () => {
		// This is the whole answer to "what happens to existing tokens". The
		// alternatives were to look the user up (a database read per request, to
		// resurrect a credential that predates the security model) or to default the
		// tenant, which is the cross-tenant read this phase exists to prevent.
		const legacy = await signRaw({ role: "supervisor" });

		await expect(verifyAccessToken(legacy)).rejects.toThrow();
	});

	test("a token with a tenant but no version is refused", async () => {
		const noVersion = await signRaw({ role: "supervisor", tid: TENANT });

		await expect(verifyAccessToken(noVersion)).rejects.toThrow();
	});

	test("a token with a version but no tenant is refused", async () => {
		const noTenant = await signRaw({ role: "supervisor", ver: ACCESS_TOKEN_VERSION });

		await expect(verifyAccessToken(noTenant)).rejects.toThrow();
	});

	test("a tenant claim that is not a uuid is refused", async () => {
		// Not reachable from our own minting path, so this is about a token whose
		// claims were crafted: "avilab" must not become a tenant id by being a string.
		const badTenant = await signRaw({
			role: "supervisor",
			tid: "avilab",
			ver: ACCESS_TOKEN_VERSION,
		});

		await expect(verifyAccessToken(badTenant)).rejects.toThrow();
	});
});

describe("vendor impersonation tokens", () => {
	test("the actor claim survives the round trip", async () => {
		const token = await generateAccessToken({
			userId: VENDOR_USER,
			role: "vendor",
			tenantId: TENANT,
			actor: { userId: VENDOR_USER, tenantId: VENDOR_TENANT },
			expiresIn: "30m",
		});

		const payload = await verifyAccessToken(token);

		// Acting inside the customer...
		expect(payload.tid).toBe(TENANT);
		// ...while remaining identifiable as the vendor, which is what the audit trail
		// and the middleware's isVendorAccess flag are built on.
		expect(payload.act?.sub).toBe(VENDOR_USER);
		expect(payload.act?.tid).toBe(VENDOR_TENANT);
	});

	test("a malformed actor claim is refused rather than ignored", async () => {
		// Ignoring it would be the dangerous outcome: a token scoped to a customer,
		// with vendor powers, that the audit trail would record as the customer's own
		// user. Refusing is the only safe reading.
		const malformed = await signRaw(
			{
				role: "vendor",
				tid: TENANT,
				ver: ACCESS_TOKEN_VERSION,
				act: { sub: 42 },
			},
			VENDOR_USER
		);

		await expect(verifyAccessToken(malformed)).rejects.toThrow();
	});

	test("an actor tenant that is not a uuid is refused", async () => {
		const malformed = await signRaw(
			{
				role: "vendor",
				tid: TENANT,
				ver: ACCESS_TOKEN_VERSION,
				act: { sub: VENDOR_USER, tid: "vendor" },
			},
			VENDOR_USER
		);

		await expect(verifyAccessToken(malformed)).rejects.toThrow();
	});
});

describe("signature", () => {
	test("a token signed with another secret is refused", async () => {
		const foreign = await new jose.SignJWT({
			role: "supervisor",
			tid: TENANT,
			ver: ACCESS_TOKEN_VERSION,
		})
			.setProtectedHeader({ alg: "HS256" })
			.setSubject(USER)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("not-the-real-secret-not-the-real-secret"));

		await expect(verifyAccessToken(foreign)).rejects.toThrow();
	});
});
