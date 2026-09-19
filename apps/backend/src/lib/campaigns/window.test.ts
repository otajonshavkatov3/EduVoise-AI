/**
 * The calling window.
 *
 * The rule is "nobody gets rung at 03:00", and the trap is the time zone: this
 * deployment is UTC+5, so a window evaluated in UTC would call at 04:00 local and
 * refuse at 13:00 local. Every case here pins a real instant and asserts the tenant's
 * wall clock, not the server's.
 */
import { describe, expect, test } from "bun:test";

import { describeWindow, isWithinWindow, wallClock } from "./window";

const TASHKENT = "Asia/Tashkent";
const WINDOW = { start: "09:00", end: "18:00" };

/** 2026-08-08T05:30:00Z = 10:30 in Tashkent (UTC+5). */
const INSIDE = new Date("2026-08-08T05:30:00.000Z");
/** 22:30Z the previous day = 03:30 in Tashkent. The hour this whole feature exists to prevent. */
const NIGHT = new Date("2026-08-07T22:30:00.000Z");
/** 14:00Z = 19:00 in Tashkent, just after the window closed. */
const EVENING = new Date("2026-08-08T14:00:00.000Z");

describe("wallClock", () => {
	test("reports the tenant's clock, not UTC", () => {
		expect(wallClock(TASHKENT, INSIDE)).toBe("10:30");
		expect(wallClock("UTC", INSIDE)).toBe("05:30");
	});

	test("03:30 local is 03:30 local even though UTC says the previous day", () => {
		expect(wallClock(TASHKENT, NIGHT)).toBe("03:30");
	});

	test("midnight is 00:00, never 24:00", () => {
		// 19:00Z = 00:00 next day in Tashkent, and some runtimes render that as "24:00".
		expect(wallClock(TASHKENT, new Date("2026-08-08T19:00:00.000Z"))).toBe("00:00");
	});

	test("hours are zero-padded, so string comparison is time comparison", () => {
		expect(wallClock(TASHKENT, new Date("2026-08-08T03:05:00.000Z"))).toBe("08:05");
	});
});

describe("isWithinWindow", () => {
	test("the start is inclusive and the end is exclusive", () => {
		expect(isWithinWindow(WINDOW, "09:00")).toBe(true);
		expect(isWithinWindow(WINDOW, "17:59")).toBe(true);
		expect(isWithinWindow(WINDOW, "18:00")).toBe(false);
	});

	test("outside the window in both directions", () => {
		expect(isWithinWindow(WINDOW, "08:59")).toBe(false);
		expect(isWithinWindow(WINDOW, "03:30")).toBe(false);
		expect(isWithinWindow(WINDOW, "22:00")).toBe(false);
	});
});

describe("describeWindow", () => {
	test("inside the window, in the tenant's zone", () => {
		const state = describeWindow(WINDOW, TASHKENT, INSIDE);

		expect(state.now).toBe("10:30");
		expect(state.openNow).toBe(true);
		expect(state.minutesUntilOpen).toBe(0);
		expect(state.message).toContain("ochiq");
	});

	test("03:30 local is closed - the case a UTC comparison would get wrong", () => {
		const state = describeWindow(WINDOW, TASHKENT, NIGHT);

		expect(state.now).toBe("03:30");
		expect(state.openNow).toBe(false);
		// 03:30 -> 09:00 is five and a half hours.
		expect(state.minutesUntilOpen).toBe(330);
		expect(state.message).toContain("qo'ng'iroq vaqti emas");
	});

	test("the same instant in UTC would have been inside the window", () => {
		// 22:30Z. This is the assertion that proves the zone is actually applied.
		expect(describeWindow(WINDOW, "UTC", NIGHT).now).toBe("22:30");
		expect(describeWindow(WINDOW, TASHKENT, NIGHT).now).toBe("03:30");
	});

	test("after the window, the wait runs to tomorrow morning", () => {
		const state = describeWindow(WINDOW, TASHKENT, EVENING);

		expect(state.now).toBe("19:00");
		expect(state.openNow).toBe(false);
		// 19:00 -> 09:00 next day = 14 hours.
		expect(state.minutesUntilOpen).toBe(840);
		expect(state.message).toContain("14 soat");
	});

	test("the message names the window and the zone, so a page can show it verbatim", () => {
		const state = describeWindow(WINDOW, TASHKENT, NIGHT);

		expect(state.message).toContain("09:00");
		expect(state.message).toContain("18:00");
		expect(state.timeZone).toBe(TASHKENT);
	});
});
