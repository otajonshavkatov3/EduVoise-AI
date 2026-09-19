import apiClient from "@/app/api/client";
import type {
	ActiveAgentProfile,
	ActiveAgentProfileResponse,
	AgentProfileMutationResponse,
	AgentProfilePatch,
	AgentProfileSummary,
	AgentProfilesResponse,
	CreateAgentProfileRequest,
	RawActiveAgentProfile,
	RawActiveAgentProfileResponse,
} from "../types";

/**
 * `app/api/endpoint.ts` umumiy fayl va boshqa joyda yuritiladi, shuning uchun
 * yo'llar shu modulda e'lon qilinadi (settings moduli ham shunday qiladi).
 */
const AI_AGENT_ENDPOINTS = {
	PROFILE: "/ai-agent/profile",
	PROFILES: "/ai-agent/profiles",
	PROFILE_BY_ID: (id: string) => `/ai-agent/profiles/${id}`,
	ACTIVATE: (id: string) => `/ai-agent/profiles/${id}/activate`,
} as const;

/**
 * Backend `isConfigured` ni qaytarmaydi, panel esa unga qarab «profil
 * to'ldirilmagan» ogohlantirishini ko'rsatadi. Qator bor bo'lsa profil ham bor:
 * aktiv profil topilmasa backend uni GET paytida o'zi yaratadi.
 */
function normalizeProfile(raw: RawActiveAgentProfile): ActiveAgentProfile {
	return { ...raw, isConfigured: raw.isConfigured ?? typeof raw.id === "string" };
}

interface ListEnvelope<T> {
	success?: boolean;
	data?:
		| T[]
		| {
				items?: T[];
				meta?: { total: number; page: number; limit: number; totalPages: number };
		  };
}

/**
 * Ro'yxat javobini bir shaklga keltiradi.
 *
 * Backend `paginated()` (items + meta) yoki oddiy `success(c, rows)` (massiv)
 * qaytarishi mumkin — profillar soni kam, shuning uchun ikkalasi ham qabul
 * qilinadi va UI hech qanday holatda bo'sh ekran ko'rsatib qolmaydi.
 */
function unwrapList<T>(payload: ListEnvelope<T>): {
	items: T[];
	meta: AgentProfilesResponse["meta"];
} {
	const data = payload?.data;

	if (Array.isArray(data)) {
		return { items: data, meta: null };
	}

	return {
		items: data?.items ?? [],
		meta: data?.meta ?? null,
	};
}

export const aiAgentService = {
	/** Hozir qo'ng'iroqlarga javob berayotgan profil. */
	async getActiveProfile(): Promise<ActiveAgentProfileResponse> {
		const response = await apiClient.get<RawActiveAgentProfileResponse>(AI_AGENT_ENDPOINTS.PROFILE);
		return { success: response.data.success, data: normalizeProfile(response.data.data) };
	},

	async listProfiles(): Promise<AgentProfilesResponse> {
		const response = await apiClient.get<ListEnvelope<AgentProfileSummary>>(
			AI_AGENT_ENDPOINTS.PROFILES,
			{ params: { limit: 50 } }
		);
		return unwrapList(response.data);
	},

	async createProfile(body: CreateAgentProfileRequest): Promise<AgentProfileMutationResponse> {
		const response = await apiClient.post<AgentProfileMutationResponse>(
			AI_AGENT_ENDPOINTS.PROFILES,
			body
		);
		return response.data;
	},

	/**
	 * Profilni saqlash. Yozish yagona yo'l orqali ketadi: `PATCH /profiles/{id}`.
	 *
	 * Backendda `PATCH /profile` (aktiv profil uchun qisqa yo'l) yo'q — ilgari
	 * shunga so'rov yuborilar va har bir «Saqlash» 404 bilan qaytar edi, keyingi
	 * fon so'rovi esa shaklni eski holatiga tiklardi.
	 */
	async updateProfile(id: string, body: AgentProfilePatch): Promise<ActiveAgentProfile> {
		const response = await apiClient.patch<RawActiveAgentProfileResponse>(
			AI_AGENT_ENDPOINTS.PROFILE_BY_ID(id),
			body
		);
		return normalizeProfile(response.data.data);
	},

	async deleteProfile(id: string): Promise<AgentProfileMutationResponse> {
		const response = await apiClient.delete<AgentProfileMutationResponse>(
			AI_AGENT_ENDPOINTS.PROFILE_BY_ID(id)
		);
		return response.data;
	},

	async activateProfile(id: string): Promise<AgentProfileMutationResponse> {
		const response = await apiClient.post<AgentProfileMutationResponse>(
			AI_AGENT_ENDPOINTS.ACTIVATE(id),
			{}
		);
		return response.data;
	},
};
