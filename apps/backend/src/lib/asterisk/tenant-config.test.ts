/**
 * THE TEST THAT MATTERS MOST IN THIS DIRECTORY.
 *
 * The whole platform's isolation claim ends in two generated files: if the config
 * for customer A can name customer B's endpoint - or if two customers' "101" end up
 * as one PJSIP object - then a caller reaches the wrong company and no amount of
 * tenant-scoped SQL upstream matters. Both renderers are pure text functions
 * precisely so that claim can be checked here rather than by squinting at
 * `pjsip show endpoints` after a deploy.
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
	derivedSipPassword,
	isSafeConfigValue,
	renderTenantDialplan,
	renderTenantPjsip,
	setTenantConfigLive,
	type TenantTelephonySpec,
	tenantContextsFor,
	tenantEndpointFor,
} from "./tenant-config";

function operator(
	extension: string,
	options: { legacy?: boolean } = {}
): {
	extension: string;
	password: string;
	web: { extension: string; password: string; legacyAlias: boolean } | null;
	legacyAlias: boolean;
} {
	const web = extension.startsWith("1") && extension.length === 3 ? `2${extension.slice(1)}` : null;

	return {
		extension,
		password: `pw-${extension}`,
		web: web === null ? null : { extension: web, password: `pw-${web}`, legacyAlias: false },
		legacyAlias: options.legacy === true,
	};
}

const avilab: TenantTelephonySpec = {
	slug: "avilab",
	name: "AviLab",
	endpoints: [operator("101"), operator("991")],
	trunk: null,
};

/** A second customer whose operator numbers are deliberately IDENTICAL. */
const beta: TenantTelephonySpec = {
	slug: "beta-cc",
	name: "Beta Call Center",
	endpoints: [operator("101"), operator("102")],
	trunk: {
		host: "sip.beta.uz",
		port: 5060,
		username: "beta1",
		password: "trunkpw",
		fromDomain: null,
		register: true,
		outboundCallerId: "998711234567",
	},
};

/** Every `[section]` name in a rendered config, in order. */
function sections(config: string): string[] {
	return [...config.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1] ?? "");
}

/**
 * Every section as "type:name".
 *
 * An endpoint, its aor and its auth deliberately share a name - they are three
 * different sorcery types - so uniqueness only means anything per type. Within one
 * type a duplicate means Asterisk silently keeping one of two customers' objects.
 */
function typedSections(config: string): string[] {
	const found: string[] = [];
	const lines = config.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const header = /^\[([^\]]+)\]/.exec(lines[index] ?? "");

		if (header === null) {
			continue;
		}

		const typeLine = lines.slice(index + 1, index + 4).find((line) => line.startsWith("type = "));

		found.push(`${typeLine?.slice(7) ?? "unknown"}:${header[1] ?? ""}`);
	}

	return found;
}

/** The body of one tenant's block, from its own header to the next tenant's. */
function tenantBlock(config: string, slug: string): string {
	const start = config.indexOf(`(${slug})`);
	expect(start).toBeGreaterThan(-1);
	const rest = config.slice(start + 1);
	const next = rest.search(/^;--- /m);

	return next === -1 ? rest : rest.slice(0, next);
}

// The live/not-live switch is module state, and other suites in this process read it
// through tenantContextsFor(). Restored to the process default so a test that runs
// after this file sees the same answer it would see on a fresh boot.
afterAll(() => {
	setTenantConfigLive(false);
});

describe("renderTenantPjsip", () => {
	test("two customers' 101s are two endpoints, two auths and two aors", () => {
		const config = renderTenantPjsip([avilab, beta]);
		const names = sections(config);

		expect(names).toContain("avilab-101");
		expect(names).toContain("beta-cc-101");
		expect(names).toContain("avilab-101-auth");
		expect(names).toContain("beta-cc-101-auth");

		// The bare digits must appear as a section name NOWHERE: that is the global
		// namespace, and two tenants in it is the collision this design forbids.
		expect(names).not.toContain("101");
		expect(names).not.toContain("201");

		// No section name is repeated WITHIN A TYPE. A duplicate would mean Asterisk
		// silently keeping one of two customers' definitions.
		const typed = typedSections(config);

		expect(new Set(typed).size).toBe(typed.length);
		expect(typed).toContain("endpoint:avilab-101");
		expect(typed).toContain("aor:beta-cc-101");
		expect(typed).toContain("auth:beta-cc-101-auth");
	});

	test("the SIP auth username is the endpoint name, not the digits", () => {
		const config = renderTenantPjsip([avilab]);

		// REGISTER carries no tenant, so a credential of "101" would be one global
		// credential shared by every customer that has a 101.
		expect(config).toContain("username = avilab-101");
		expect(config).not.toMatch(/^username = 101$/m);
	});

	test("each endpoint lives in its own tenant's context and no other", () => {
		const config = renderTenantPjsip([avilab, beta]);

		expect(tenantBlock(config, "avilab")).not.toContain("beta-cc");
		expect(tenantBlock(config, "beta-cc")).not.toContain("from-internal-avilab");
		expect(tenantBlock(config, "beta-cc")).toContain("context = from-internal-beta-cc");
	});

	test("a tenant's trunk lands in that tenant's external context", () => {
		const config = renderTenantPjsip([beta]);

		expect(config).toContain("[trunk-beta-cc]");
		expect(config).toContain("context = from-external-beta-cc");
		expect(config).toContain("[trunk-beta-cc-auth]");
		expect(config).toContain("endpoint = trunk-beta-cc");
		// The port is part of WHERE the REGISTER goes; a carrier on a non-5060 port would
		// otherwise be registered to 5060 and never answer.
		expect(config).toContain("contact = sip:sip.beta.uz:5060");
		expect(config).toContain("server_uri = sip:sip.beta.uz:5060");
		// An identify match is what stops a scanner on the internet from being treated
		// as this customer's carrier and landing in their context.
		expect(config).toContain("match = sip.beta.uz");
	});

	test("legacy bare-digit aliases are rendered, but only for one tenant", () => {
		const legacy: TenantTelephonySpec = {
			slug: "avilab",
			name: "AviLab",
			endpoints: [
				{
					extension: "101",
					password: "desk",
					web: { extension: "201", password: "web", legacyAlias: true },
					legacyAlias: true,
				},
			],
			trunk: null,
		};

		const config = renderTenantPjsip([legacy]);
		const names = sections(config);
		const typed = typedSections(config);

		expect(names).toContain("101");
		expect(names).toContain("201");
		// The alias needs BOTH halves: an endpoint to authenticate as, and an aor with
		// the same name, because the registrar matches the REGISTER's URI user against
		// the endpoint's aor names. Without the aor Asterisk refuses the registration
		// with "AOR '' not found" and the phone never comes back.
		expect(typed).toContain("endpoint:101");
		expect(typed).toContain("aor:101");
		expect(typed).toContain("aor:201");
		// And the tenant's own endpoint lists both, so its dialplan rings the old
		// registration as well as a new one.
		expect(config).toContain("aors = avilab-101,101");
		expect(config).toContain("aors = avilab-201,201");

		const second: TenantTelephonySpec = { ...legacy, slug: "beta-cc", name: "Beta" };

		expect(() => renderTenantPjsip([legacy, second])).toThrow(/two tenants/);
	});

	test("a malformed slug is refused rather than rendered", () => {
		const hostile: TenantTelephonySpec = {
			slug: "avilab]\n[evil",
			name: "Injection",
			endpoints: [operator("101")],
			trunk: null,
		};

		expect(() => renderTenantPjsip([hostile])).toThrow();
	});

	test("a trunk field carrying config syntax is dropped, not escaped", () => {
		const hostile: TenantTelephonySpec = {
			slug: "gamma",
			name: "Gamma",
			endpoints: [],
			trunk: {
				host: "sip.gamma.uz",
				port: null,
				username: "gamma",
				// A newline here would start a new setting; there is no escaping in this
				// file format to be correct about, so the value must not be used.
				password: "pw\ncontext = from-internal-avilab",
				fromDomain: null,
				register: true,
				outboundCallerId: null,
			},
		};

		const config = renderTenantPjsip([hostile]);

		expect(config).not.toContain("from-internal-avilab");
		// With no usable password the trunk cannot register, and it must not pretend to.
		expect(config).not.toContain("[trunk-gamma-auth]");
		expect(config).toContain("context = from-external-gamma");
	});

	test("isSafeConfigValue rejects every character that changes a config's meaning", () => {
		expect(isSafeConfigValue("sip.provider.uz")).toBe(true);
		expect(isSafeConfigValue("")).toBe(false);
		expect(isSafeConfigValue("a\nb")).toBe(false);
		expect(isSafeConfigValue("a;b")).toBe(false);
		expect(isSafeConfigValue("a[b]")).toBe(false);
		expect(isSafeConfigValue("a=b")).toBe(false);
	});
});

describe("renderTenantDialplan", () => {
	test("each tenant gets five contexts, all by inheritance", () => {
		const config = renderTenantDialplan([avilab, beta]);

		for (const slug of ["avilab", "beta-cc"]) {
			expect(config).toContain(`[from-internal-${slug}](tenant-internal)`);
			expect(config).toContain(`[from-external-${slug}](tenant-external)`);
			expect(config).toContain(`[ai-bridge-${slug}](tenant-ai-bridge)`);
			expect(config).toContain(`[ai-transfer-${slug}](tenant-ai-transfer)`);
			expect(config).toContain(`[click-to-call-${slug}](tenant-click-to-call)`);
		}
	});

	test("an extension no template pattern covers gets its own tenant-scoped Dial", () => {
		const config = renderTenantDialplan([avilab]);

		// 991 matches neither _1XX nor _2XX, so without this line the operator would be
		// unreachable - and the Dial names the tenant's endpoint, never bare digits.
		expect(config).toContain("exten => 991,1,");
		expect(config).toContain("Dial(PJSIP/avilab-991,30,tT)");
		expect(config).not.toContain("Dial(PJSIP/991");
	});

	test("extensions the templates already define are not emitted twice", () => {
		const clashing: TenantTelephonySpec = {
			slug: "delta",
			name: "Delta",
			// 700 is the voicemail extension in the template and 101 matches _1XX; a
			// duplicate entry would make Asterisk keep one of two definitions.
			endpoints: [operator("700"), operator("101")],
			trunk: null,
		};

		const config = renderTenantDialplan([clashing]);

		expect(config).not.toContain("exten => 700,1,");
		expect(config).not.toContain("exten => 101,1,");
	});
});

describe("tenantContextsFor / tenantEndpointFor", () => {
	test("the pre-tenancy names are used until the generated config is live", () => {
		setTenantConfigLive(false);

		expect(tenantContextsFor("avilab").aiBridge).toBe("ai-bridge");
		expect(tenantEndpointFor("avilab", "101")).toBe("101");

		setTenantConfigLive(true);

		expect(tenantContextsFor("avilab").aiBridge).toBe("ai-bridge-avilab");
		expect(tenantEndpointFor("avilab", "101")).toBe("avilab-101");
	});

	test("a call whose tenant has no name keeps the pre-tenancy names", () => {
		setTenantConfigLive(true);

		// Naming a context after a tenant we cannot name would be a guess, and a guess
		// here is one customer's caller executing another customer's dialplan.
		expect(tenantContextsFor(null).aiTransfer).toBe("ai-transfer");
		expect(tenantEndpointFor(null, "101")).toBe("101");
	});

	test("a slug Asterisk could not parse falls back instead of building a name", () => {
		setTenantConfigLive(true);

		expect(tenantContextsFor("Not A Slug").internal).toBe("from-internal");
		expect(tenantEndpointFor("Not A Slug", "101")).toBe("101");
	});
});

describe("derivedSipPassword", () => {
	test("is stable, per tenant and per extension", () => {
		expect(derivedSipPassword("secret", "avilab", "101")).toBe(
			derivedSipPassword("secret", "avilab", "101")
		);
		// Knowing one customer's password must say nothing about another's, even for the
		// same digits.
		expect(derivedSipPassword("secret", "avilab", "101")).not.toBe(
			derivedSipPassword("secret", "beta-cc", "101")
		);
		expect(derivedSipPassword("secret", "avilab", "101")).not.toBe(
			derivedSipPassword("secret", "avilab", "102")
		);
		expect(derivedSipPassword("secret", "avilab", "101")).toMatch(/^[A-Za-z0-9_-]{24}$/);
	});
});
