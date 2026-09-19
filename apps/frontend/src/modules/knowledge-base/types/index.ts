/**
 * Bilim bazasi — AI mijozga aytishga haqli bo'lgan yagona ma'lumot manbasi.
 *
 * Bu jadvalda bo'lmagan narsani AI aytmaydi: narx, manzil, ish vaqti va
 * kafolatlar yozib olinadigan liniyada biznes uchun javobgarlik demakdir.
 */

import type { UnknownAnswerPolicy } from "@/modules/ai-agent/types";

export interface KnowledgeBaseEntry {
	id: string;
	agentProfileId?: string;
	/** Mijoz qanday so'rashi mumkin — moslashtirish shu ustun bo'yicha ishlaydi. */
	question: string;
	/** AI aynan shuni aytadi. */
	answer: string;
	tags: string[];
	/** Bir necha yozuv mos kelsa, kattasi yutadi. */
	priority: number;
	isActive: boolean;
	useCount: number;
	lastUsedAt: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export interface KnowledgeBaseFilters {
	/** Berilmasa aktiv profil olinadi. Qoralama profilni ko'rish uchun kerak. */
	profileId?: string;
	/** Erkin matn izlash. Backend aynan shu nom bilan o'qiydi — `search` emas. */
	q?: string;
	/** Aynan shu teg bor yozuvlar (qism satr emas — to'liq moslik). */
	tag?: string;
	/** Backend query paramlari string bo'ladi. */
	isActive?: "true" | "false";
	page?: number;
	limit?: number;
}

export interface KnowledgeBaseListResult {
	items: KnowledgeBaseEntry[];
	meta: {
		total: number;
		page: number;
		limit: number;
		totalPages: number;
	} | null;
}

export interface CreateKnowledgeEntryRequest {
	/** Berilmasa aktiv profilga yoziladi. */
	profileId?: string;
	question: string;
	answer: string;
	tags?: string[];
	priority?: number;
	isActive?: boolean;
}

export interface UpdateKnowledgeEntryRequest {
	question?: string;
	answer?: string;
	tags?: string[];
	priority?: number;
	isActive?: boolean;
}

/** Qidiruv natijasi — AI ham aynan shu ro'yxatni oladi. */
export interface KnowledgeHit {
	id: string;
	question: string;
	answer: string;
	tags: string[];
	priority: number;
	score: number;
}

export interface KnowledgeSearchResult {
	query: string;
	/** Qidiruv aynan qaysi profil bo'yicha ketgani. */
	profileId: string | null;
	businessName: string;
	hitCount: number;
	/** false — AI bu savolga javob bermaydi, profildagi qoida ishlaydi. */
	wouldAnswer: boolean;
	unknownPolicy: UnknownAnswerPolicy;
	/** Javob topilmaganda AI nima qilishi — serverdan tayyor o'zbekcha jumla. */
	fallbackAction: string;
	hits: KnowledgeHit[];
}

/** Backend qaysi maydonlarni berishiga qarab UI faqat mavjudini ko'rsatadi. */
export interface KnowledgeBaseStats {
	total?: number;
	active?: number;
	inactive?: number;
	/** Barcha yozuvlar bo'yicha umumiy ishlatilish soni (backend: `totalUses`). */
	totalUses?: number;
	neverUsed?: number;
	businessName?: string;
	profileId?: string | null;
}

/** Ommaviy import uchun bir qator. */
export interface BulkEntryInput {
	question: string;
	answer: string;
	tags?: string[];
}

export type BulkRowStatus = "created" | "skipped" | "failed";

/** Import qilingan bir qatorning natijasi — sababi bilan. */
export interface BulkRowResult {
	/** Yuborilgan massivdagi o'rin — matndagi qatorga qaytarib bog'lash uchun. */
	index: number;
	status: BulkRowStatus;
	question: string;
	reason: string | null;
}

export interface BulkImportResult {
	created: number;
	skipped: number;
	failed: number;
	/** O'tkazib yuborilgan va xato qatorlar: nima uchun o'tmagani shu yerda. */
	problems: BulkRowResult[];
}
