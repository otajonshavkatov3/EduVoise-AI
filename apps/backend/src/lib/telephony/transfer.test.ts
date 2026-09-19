/**
 * Never transfer a caller to the phone they are calling from.
 *
 * The pool was chosen with no idea who was calling, so an operator ringing 900
 * from their own desk phone and asking for a colleague was transferred straight
 * back to themselves: [ai-transfer] dialled the handset already in the call, the
 * Dial found it busy or rang the caller's own hand, and the transfer failed with
 * nothing on screen to explain why.
 *
 * The desk/browser pairing is what makes this more than a string compare -
 * `_1XX` in [ai-transfer] dials `PJSIP/<ext>&PJSIP/2<ext[1:]>`, so 101 reaches
 * 201 as well and a caller on either one must exclude 101.
 */
import { describe, expect, test } from "bun:test";

import { callerExtensionOf, isSelfTransfer, ringsFor } from "./transfer";

describe("ringsFor", () => {
	test("a desk extension also rings its browser softphone", () => {
		// Mirrors `Dial(PJSIP/${EXTEN}&PJSIP/2${EXTEN:1})` in [ai-transfer].
		expect(ringsFor("101")).toEqual(["101", "201"]);
		expect(ringsFor("104")).toEqual(["104", "204"]);
	});

	test("a browser extension rings only itself", () => {
		expect(ringsFor("201")).toEqual(["201"]);
	});

	test("anything that is not a 1XX desk extension is left alone", () => {
		expect(ringsFor("900")).toEqual(["900"]);
		expect(ringsFor("+998901234567")).toEqual(["+998901234567"]);
	});
});

describe("callerExtensionOf", () => {
	test("recognises an internal three-digit caller", () => {
		expect(callerExtensionOf("101")).toBe("101");
		expect(callerExtensionOf(" 201 ")).toBe("201");
	});

	test("an outside caller has no extension to protect", () => {
		// The point of returning null: an external number matches no target, so no
		// self-transfer is possible and nothing should be excluded from the pool.
		expect(callerExtensionOf("+998901234567")).toBeNull();
		expect(callerExtensionOf("anonymous")).toBeNull();
		expect(callerExtensionOf("")).toBeNull();
		expect(callerExtensionOf(null)).toBeNull();
		expect(callerExtensionOf(undefined)).toBeNull();
	});
});

describe("isSelfTransfer", () => {
	test("the caller's own desk phone is refused", () => {
		expect(isSelfTransfer("101", "101")).toBe(true);
	});

	test("the desk target is refused for a caller on its paired softphone", () => {
		// The regression: 201 is not 101, so a string compare let this through and
		// the transfer rang the browser tab the caller was already talking on.
		expect(isSelfTransfer("101", "201")).toBe(true);
	});

	test("a colleague's phone is allowed", () => {
		expect(isSelfTransfer("102", "101")).toBe(false);
		expect(isSelfTransfer("102", "201")).toBe(false);
		expect(isSelfTransfer("101", "102")).toBe(false);
	});

	test("an outside caller excludes nobody", () => {
		expect(isSelfTransfer("101", null)).toBe(false);
	});
});
