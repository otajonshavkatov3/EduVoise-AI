interface StructuredAddress {
	tuman?: string;
	kocha?: string;
	uy?: string;
}

/**
 * Manzil ma'lumotlarini matn ko'rinishiga o'giradi.
 * Object yoki string bo'lishi mumkin.
 */
export function formatAddress(address: StructuredAddress | string | null | undefined): string {
	if (!address) {
		return "Manzil ko'rsatilmadi";
	}

	if (typeof address === "string") {
		return address;
	}

	const { tuman, kocha, uy } = address;
	const parts = [tuman, kocha, uy].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "Manzil ko'rsatilmadi";
}
