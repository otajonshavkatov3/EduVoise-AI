/**
 * Telefon raqamlarini standartlashtirish (Normalize)
 * 998886003230 -> 886003230
 */
export function normalizePhone(phone: string): string {
	const clean = phone.replace(/\D/g, "");
	if (clean.length === 12 && clean.startsWith("998")) {
		return clean.slice(3);
	}
	return clean;
}

/**
 * Asterisk raqam ko'rsatilmagan qo'ng'iroqqa shu qiymatni yozadi.
 *
 * Bazadagi qo'ng'iroqlarning yarmidan ko'pi shunday. Formatlagich uni tanimasa,
 * xom "anonymous" so'zi ro'yxatda ham, qo'ng'iroq kartasida ham chiqib turadi —
 * o'zbekcha sahifada yolg'iz inglizcha so'z bo'lib.
 */
const WITHHELD_CALLER_ID = "anonymous";

/**
 * Telefon raqamlarini chiroyli formatda ko'rsatish
 * 886003230 -> +998 (88) 600-32-30
 */
export function formatPhone(phone: string): string {
	if (phone.trim().toLowerCase() === WITHHELD_CALLER_ID) {
		return "Raqam yashirilgan";
	}

	const clean = normalizePhone(phone);

	if (clean.length === 9) {
		const part1 = clean.slice(0, 2);
		const part2 = clean.slice(2, 5);
		const part3 = clean.slice(5, 7);
		const part4 = clean.slice(7, 9);
		return `+998 (${part1}) ${part2}-${part3}-${part4}`;
	}

	return phone;
}
