/**
 * The naming contract the per-tenant dialplan will be generated against.
 *
 * This is where "extension numbers may collide across customers" is either true or
 * a lie. The digits are shared on purpose; what must never collide is the endpoint
 * name and the context name, and that is exactly what these assertions check.
 */
import { describe, expect, test } from "bun:test";

import {
	endpointName,
	LEGACY_CONTEXTS,
	slugFromContext,
	slugFromEndpointName,
	tenantContexts,
	trunkEndpointName,
} from "./asterisk-naming";

describe("endpointName", () => {
	test("two customers' 101s are two different endpoints", () => {
		expect(endpointName("avilab", "101")).toBe("avilab-101");
		expect(endpointName("clinic", "101")).toBe("clinic-101");
		expect(endpointName("avilab", "101")).not.toBe(endpointName("clinic", "101"));
	});

	test("rejects a slug that would change how Asterisk parses the name", () => {
		// A dot, a space or a slash in a slug would either break the generated config
		// or, worse, merge two tenants into one context.
		expect(() => endpointName("avi lab", "101")).toThrow();
		expect(() => endpointName("avi.lab", "101")).toThrow();
		expect(() => endpointName("avi/lab", "101")).toThrow();
		expect(() => endpointName("AviLab", "101")).toThrow();
		expect(() => endpointName("", "101")).toThrow();
	});

	test("rejects an extension that is not digits", () => {
		expect(() => endpointName("avilab", "10a")).toThrow();
		expect(() => endpointName("avilab", "")).toThrow();
	});
});

describe("tenantContexts", () => {
	test("every context is the tenant's own", () => {
		const contexts = tenantContexts("avilab");

		expect(contexts).toEqual({
			internal: "from-internal-avilab",
			external: "from-external-avilab",
			aiBridge: "ai-bridge-avilab",
			aiTransfer: "ai-transfer-avilab",
			clickToCall: "click-to-call-avilab",
			queue: "queue-avilab",
		});
	});

	test("no tenant's context is another tenant's context", () => {
		const a = Object.values(tenantContexts("avilab"));
		const b = Object.values(tenantContexts("clinic"));

		expect(a.filter((context) => b.includes(context))).toEqual([]);
	});
});

describe("trunkEndpointName", () => {
	test("each customer's carrier is a separate endpoint", () => {
		expect(trunkEndpointName("avilab")).toBe("trunk-avilab");
		expect(trunkEndpointName("clinic")).toBe("trunk-clinic");
	});
});

describe("reading a name back", () => {
	test("the slug comes back out of an endpoint name", () => {
		expect(slugFromEndpointName("avilab-101")).toBe("avilab");
		expect(slugFromEndpointName("some-long-slug-204")).toBe("some-long-slug");
	});

	test("a pre-tenancy endpoint name yields null, not a guess", () => {
		// Every endpoint that exists today is called "101", "201", "900". Returning a
		// slug for one of those would be inventing a tenant.
		expect(slugFromEndpointName("101")).toBeNull();
		expect(slugFromEndpointName("900")).toBeNull();
		expect(slugFromEndpointName("")).toBeNull();
	});

	test("the slug comes back out of a context name", () => {
		expect(slugFromContext("from-internal-avilab")).toBe("avilab");
		expect(slugFromContext("ai-bridge-clinic")).toBe("clinic");
	});

	test("the legacy shared contexts yield null", () => {
		// They are the contexts the single demo tenant still answers on, and they
		// belong to no tenant by name - which is precisely why they are being replaced.
		for (const context of Object.values(LEGACY_CONTEXTS)) {
			expect(slugFromContext(context)).toBeNull();
		}
	});

	test("an unrelated context yields null", () => {
		expect(slugFromContext("default")).toBeNull();
		expect(slugFromContext("macro-something")).toBeNull();
	});
});
