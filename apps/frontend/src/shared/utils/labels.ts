import type { UserRoleType } from "@shared/types";
import type { WsStatus } from "@/shared/store/ws.store";

/**
 * Bir nechta modul o'qiydigan yorliqlar. Har bir modulda alohida ro'yxat
 * bo'lganda ular bir-biridan uzoqlashib ketardi (masalan bir sahifa "Online",
 * boshqasi "Onlayn" deb yozardi).
 */

/** Backenddagi `user_role` enum qiymatlari uchun. */
export const ROLE_LABELS: Record<UserRoleType, string> = {
	supervisor: "Nazoratchi",
	admin: "Administrator",
	manager: "Menejer",
	vendor: "Vendor",
};

/** Noma'lum rol kelsa xom qiymat qaytadi — yangi rol qo'shilsa sahifa buzilmaydi. */
export function roleLabel(role: string): string {
	return ROLE_LABELS[role as UserRoleType] ?? role;
}

/** Rol tanlash ro'yxatlari uchun tayyor variantlar. */
export const ROLE_OPTIONS: { value: UserRoleType; label: string }[] = (
	Object.keys(ROLE_LABELS) as UserRoleType[]
).map((role) => ({ value: role, label: ROLE_LABELS[role] }));

/** Operator holatlari — operatorlar sahifasi, sarlavha va hisobotlar uchun bir xil. */
export type OperatorStatus = "online" | "offline" | "pause" | "busy";

export const OPERATOR_STATUS_LABELS: Record<OperatorStatus, string> = {
	online: "Onlayn",
	offline: "Oflayn",
	pause: "Tanaffus",
	busy: "Band",
};

export const WS_STATUS_LABELS: Record<WsStatus, string> = {
	connected: "Ulangan",
	connecting: "Ulanmoqda",
	disconnected: "Uzilgan",
};

/**
 * Murojaat turkumlari. Qiymatlar ingliz tilida saqlanadi — bazadagi eski
 * yozuvlar shu qiymatlarga ega, shuning uchun ular o'zgartirilmaydi va faqat
 * ko'rsatishda tarjima qilinadi.
 */
export const TICKET_CATEGORY_LABELS: Record<string, string> = {
	Technical: "Texnik yordam",
	Billing: "Moliyaviy / To'lov",
	Complaint: "Shikoyat",
	Feedback: "Taklif / Fikr",
	Other: "Boshqa",
};

/**
 * Tanish bo'lmagan turkum xom holda qaytadi: AI o'zi tanlaydigan turkumlar
 * biznes profilida o'zbekcha yoziladi va ularni tarjima qilish kerak emas.
 */
export function ticketCategoryLabel(category: string): string {
	return TICKET_CATEGORY_LABELS[category] ?? category;
}
