import apiClient from "@/app/api/client";
import type { UnknownAnswerPolicy } from "@/modules/ai-agent/types";
import type {
	BulkEntryInput,
	BulkImportResult,
	BulkRowResult,
	CreateKnowledgeEntryRequest,
	KnowledgeBaseEntry,
	KnowledgeBaseFilters,
	KnowledgeBaseListResult,
	KnowledgeBaseStats,
	KnowledgeHit,
	KnowledgeSearchResult,
	UpdateKnowledgeEntryRequest,
} from "../types";

/**
 * `app/api/endpoint.ts` umumiy fayl va boshqa joyda yuritiladi, shuning uchun
 * yo'llar shu modulda e'lon qilinadi (settings moduli ham shunday qiladi).
 */
const KB_ENDPOINTS = {
	ROOT: "/knowledge-base",
	BY_ID: (id: string) => `/knowledge-base/${id}`,
	BULK: "/knowledge-base/bulk",
	SEARCH: "/knowledge-base/search",
	STATS: "/knowledge-base/stats",
} as const;

interface Envelope<T> {
	success?: boolean;
	data?: T;
}

type ListPayload =
	| KnowledgeBaseEntry[]
	| {
			items?: KnowledgeBaseEntry[];
			meta?: { total: number; page: number; limit: number; totalPages: number };
	  };

interface SearchPayload {
	query?: string;
	profileId?: string | null;
	businessName?: string;
	hitCount?: number;
	wouldAnswer?: boolean;
	unknownPolicy?: UnknownAnswerPolicy;
	fallbackAction?: string;
	hits?: KnowledgeHit[];
}

interface BulkPayload {
	created?: number;
	skipped?: number;
	failed?: number;
	results?: BulkRowResult[];
}

function normalizeEntry(entry: KnowledgeBaseEntry): KnowledgeBaseEntry {
	return {
		...entry,
		tags: entry.tags ?? [],
		priority: entry.priority ?? 0,
		useCount: entry.useCount ?? 0,
		lastUsedAt: entry.lastUsedAt ?? null,
	};
}

/** `paginated()` (items + meta) ham, oddiy massiv ham qabul qilinadi. */
function unwrapList(payload: Envelope<ListPayload>): KnowledgeBaseListResult {
	const data = payload?.data;

	if (Array.isArray(data)) {
		return { items: data.map(normalizeEntry), meta: null };
	}

	return {
		items: (data?.items ?? []).map(normalizeEntry),
		meta: data?.meta ?? null,
	};
}

/**
 * Import natijasi.
 *
 * Backend har bir qator uchun `results[]` qaytaradi (`created | skipped |
 * failed` va sababi). Ilgari bu ro'yxat tashlab yuborilar, UI esa mavjud
 * bo'lmagan `errors` maydonini o'qigani uchun «12 ta o'tkazib yuborildi» deb
 * yozib, nima uchunligini hech qachon ko'rsatmasdi.
 */
function unwrapBulk(payload: Envelope<BulkPayload>): BulkImportResult {
	const data = payload?.data ?? {};
	const results = data.results ?? [];

	return {
		created: data.created ?? 0,
		skipped: data.skipped ?? 0,
		failed: data.failed ?? 0,
		problems: results.filter((row) => row.status !== "created"),
	};
}

export const knowledgeBaseService = {
	async list(filters: KnowledgeBaseFilters): Promise<KnowledgeBaseListResult> {
		const response = await apiClient.get<Envelope<ListPayload>>(KB_ENDPOINTS.ROOT, {
			params: filters,
		});
		return unwrapList(response.data);
	},

	async create(body: CreateKnowledgeEntryRequest): Promise<KnowledgeBaseEntry | null> {
		const response = await apiClient.post<Envelope<KnowledgeBaseEntry>>(KB_ENDPOINTS.ROOT, body);
		return response.data?.data ?? null;
	},

	async update(id: string, body: UpdateKnowledgeEntryRequest): Promise<KnowledgeBaseEntry | null> {
		const response = await apiClient.patch<Envelope<KnowledgeBaseEntry>>(
			KB_ENDPOINTS.BY_ID(id),
			body
		);
		return response.data?.data ?? null;
	},

	async remove(id: string): Promise<void> {
		await apiClient.delete(KB_ENDPOINTS.BY_ID(id));
	},

	/** Ommaviy import — "savol | javob" qatorlaridan yig'ilgan ro'yxat. */
	async bulkImport(entries: BulkEntryInput[], profileId?: string): Promise<BulkImportResult> {
		const response = await apiClient.post<Envelope<BulkPayload>>(KB_ENDPOINTS.BULK, {
			entries,
			profileId,
		});
		return unwrapBulk(response.data);
	},

	/**
	 * AI qanday natija olishini aynan ko'rsatadi.
	 *
	 * Javob topilmagandagi xulosa ham serverdan olinadi (`fallbackAction`): qoidani
	 * UI da qaytadan yozish ikki nusxa demak va ular vaqt o'tib bir-biridan uzoqlashadi.
	 */
	async search(query: string, limit: number, profileId?: string): Promise<KnowledgeSearchResult> {
		const response = await apiClient.post<Envelope<SearchPayload>>(KB_ENDPOINTS.SEARCH, {
			query,
			limit,
			profileId,
		});

		const data = response.data?.data ?? {};
		const hits = data.hits ?? [];

		return {
			query: data.query ?? query,
			profileId: data.profileId ?? null,
			businessName: data.businessName ?? "",
			hitCount: data.hitCount ?? hits.length,
			wouldAnswer: data.wouldAnswer ?? hits.length > 0,
			unknownPolicy: data.unknownPolicy ?? "transfer",
			fallbackAction: data.fallbackAction ?? "",
			hits,
		};
	},

	async stats(profileId?: string): Promise<KnowledgeBaseStats> {
		const response = await apiClient.get<Envelope<KnowledgeBaseStats>>(KB_ENDPOINTS.STATS, {
			params: { profileId },
		});
		return response.data?.data ?? {};
	},
};
