/**
 * The secrets a tenant row holds must never reach a response.
 *
 * Two of them: the AI key the vendor assigns the customer, and the customer's SIP
 * trunk password. Masking them per endpoint is how a secret eventually ships - so
 * the direction is inverted (a mapper that can only produce non-secret fields), and
 * this test is what keeps the inversion true as the tenant table grows.
 */
import { describe, expect, test } from "bun:test";

import type { TenantRecord } from "@/db/schema";

import { TENANT_SECRET_COLUMNS, toPublicTenant } from "./public";

const row: TenantRecord = {
	id: "00000000-0000-0000-0000-00000000000a" as TenantRecord["id"],
	name: "AviLab",
	slug: "avilab",
	status: "active",
	isVendor: false,
	contactPerson: "Owner",
	contactPhone: "+998900000000",
	contactEmail: "owner@example.com",
	timezone: "Asia/Tashkent",
	aiApiKeyProvider: "gemini",
	aiApiKey: "AIza-SUPER-SECRET-KEY",
	sipTrunkHost: "sip.carrier.uz",
	sipTrunkPort: 5060,
	sipTrunkUsername: "avilab",
	sipTrunkPassword: "trunk-SUPER-SECRET",
	sipTrunkFromDomain: null,
	sipTrunkRegister: true,
	sipOutboundCallerId: "+998711234567",
	// The third secret: it is the whole of the tenant's webhook URL, so leaking it
	// lets anybody report calls against this customer.
	webhookToken: "f".repeat(64),
	notes: null,
	createdBy: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("toPublicTenant", () => {
	test("carries no secret field, under any name", () => {
		const publicTenant = toPublicTenant(row);
		const keys = Object.keys(publicTenant);

		for (const secret of TENANT_SECRET_COLUMNS) {
			expect(keys).not.toContain(secret);
		}
	});

	test("no secret VALUE appears anywhere in the serialised payload", () => {
		// Stronger than a key check: this also fails if a secret is ever copied into a
		// differently-named field, which is how a mask gets defeated in practice.
		const serialised = JSON.stringify(toPublicTenant(row));

		expect(serialised).not.toContain("AIza-SUPER-SECRET-KEY");
		expect(serialised).not.toContain("trunk-SUPER-SECRET");
	});

	test("reports WHETHER a secret is set, because the console needs that", () => {
		expect(toPublicTenant(row).hasAiApiKey).toBe(true);
		expect(toPublicTenant(row).hasSipTrunkPassword).toBe(true);

		const blank = toPublicTenant({ ...row, aiApiKey: "   ", sipTrunkPassword: null });

		// Whitespace is not a key: "configured" has to mean usable, or the console
		// reports a customer as provisioned when their calls will fail.
		expect(blank.hasAiApiKey).toBe(false);
		expect(blank.hasSipTrunkPassword).toBe(false);
	});

	test("keeps the non-secret fields the console does need", () => {
		const publicTenant = toPublicTenant(row);

		expect(publicTenant.slug).toBe("avilab");
		expect(publicTenant.status).toBe("active");
		expect(publicTenant.timezone).toBe("Asia/Tashkent");
		expect(publicTenant.aiApiKeyProvider).toBe("gemini");
		expect(publicTenant.sipTrunkHost).toBe("sip.carrier.uz");
		expect(publicTenant.createdAt).toBe("2026-01-01T00:00:00.000Z");
	});
});
