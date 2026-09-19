import apiClient from "@/app/api/client";
import type {
	Campaign,
	CampaignCreateBody,
	CampaignLead,
	CampaignListFilters,
	CampaignProgress,
	CampaignUpdateBody,
	DncCreateResult,
	DncEntry,
	DncListFilters,
	ImportResult,
	LeadDetail,
	LeadListFilters,
	LeadUpdateBody,
	ListEnvelope,
	OneEnvelope,
	StartResult,
} from "../types";

/**
 * `app/api/endpoint.ts` is a shared file maintained elsewhere, so the campaign
 * paths live with the module that calls them - the ai-agent and settings modules
 * do the same.
 */
const PATHS = {
	root: "/campaigns",
	byId: (id: string) => `/campaigns/${id}`,
	start: (id: string) => `/campaigns/${id}/start`,
	pause: (id: string) => `/campaigns/${id}/pause`,
	cancel: (id: string) => `/campaigns/${id}/cancel`,
	progress: (id: string) => `/campaigns/${id}/progress`,
	leads: (id: string) => `/campaigns/${id}/leads`,
	leadImport: (id: string) => `/campaigns/${id}/leads/import`,
	lead: (id: string, leadId: string) => `/campaigns/${id}/leads/${leadId}`,
	dnc: "/campaigns/dnc",
	dncById: (id: string) => `/campaigns/dnc/${id}`,
} as const;

/**
 * Empty filters are left out of the query string.
 *
 * The backend enums reject an empty string, so a cleared Select must not be sent
 * as `status=` - it has to disappear. Same helper, same reason, as /ai-costs.
 */
function cleanParams(filters: object): Record<string, unknown> {
	const params: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(filters)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}

		params[key] = value;
	}

	return params;
}

export const campaignService = {
	async list(filters: CampaignListFilters): Promise<ListEnvelope<Campaign>> {
		const response = await apiClient.get<ListEnvelope<Campaign>>(PATHS.root, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async get(id: string): Promise<Campaign> {
		const response = await apiClient.get<OneEnvelope<Campaign>>(PATHS.byId(id));

		return response.data.data;
	},

	async create(body: CampaignCreateBody): Promise<Campaign> {
		const response = await apiClient.post<OneEnvelope<Campaign>>(PATHS.root, body);

		return response.data.data;
	},

	async update(id: string, body: CampaignUpdateBody): Promise<Campaign> {
		const response = await apiClient.patch<OneEnvelope<Campaign>>(PATHS.byId(id), body);

		return response.data.data;
	},

	async remove(id: string): Promise<string> {
		const response = await apiClient.delete<OneEnvelope<{ message: string }>>(PATHS.byId(id));

		return response.data.data.message;
	},

	async start(id: string): Promise<StartResult> {
		const response = await apiClient.post<OneEnvelope<StartResult>>(PATHS.start(id), {});

		return response.data.data;
	},

	async pause(id: string): Promise<Campaign> {
		const response = await apiClient.post<OneEnvelope<Campaign>>(PATHS.pause(id), {});

		return response.data.data;
	},

	async cancel(id: string): Promise<Campaign> {
		const response = await apiClient.post<OneEnvelope<Campaign>>(PATHS.cancel(id), {});

		return response.data.data;
	},

	async progress(id: string): Promise<CampaignProgress> {
		const response = await apiClient.get<OneEnvelope<CampaignProgress>>(PATHS.progress(id));

		return response.data.data;
	},

	async listLeads(id: string, filters: LeadListFilters): Promise<ListEnvelope<CampaignLead>> {
		const response = await apiClient.get<ListEnvelope<CampaignLead>>(PATHS.leads(id), {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async getLead(id: string, leadId: string): Promise<LeadDetail> {
		const response = await apiClient.get<OneEnvelope<LeadDetail>>(PATHS.lead(id, leadId));

		return response.data.data;
	},

	async updateLead(id: string, leadId: string, body: LeadUpdateBody): Promise<CampaignLead> {
		const response = await apiClient.patch<OneEnvelope<CampaignLead>>(PATHS.lead(id, leadId), body);

		return response.data.data;
	},

	/**
	 * Import answers 201 when at least one row landed and 200 when none did, and
	 * the body is identical either way - the per-row reasons are the point. Axios
	 * treats both as success, so the caller reads `created` rather than the status.
	 */
	async importLeads(id: string, text: string): Promise<ImportResult> {
		const response = await apiClient.post<OneEnvelope<ImportResult>>(PATHS.leadImport(id), {
			text,
		});

		return response.data.data;
	},

	async listDnc(filters: DncListFilters): Promise<ListEnvelope<DncEntry>> {
		const response = await apiClient.get<ListEnvelope<DncEntry>>(PATHS.dnc, {
			params: cleanParams(filters),
		});

		return response.data;
	},

	async addDnc(phones: string[], reason: string | undefined): Promise<DncCreateResult> {
		const response = await apiClient.post<OneEnvelope<DncCreateResult>>(PATHS.dnc, {
			phones,
			reason,
			// One number typed into a box is a manual entry; a pasted list is an import.
			// The backend keeps the distinction because it decides what the list says
			// about where the number came from.
			source: phones.length > 1 ? "import" : "manual",
		});

		return response.data.data;
	},

	async removeDnc(id: string): Promise<string> {
		const response = await apiClient.delete<OneEnvelope<{ message: string }>>(PATHS.dncById(id));

		return response.data.data.message;
	},
};
