import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { campaignService } from "../services/campaign.service";
import type {
	Campaign,
	CampaignCreateBody,
	CampaignListFilters,
	CampaignProgress,
	CampaignUpdateBody,
	DncListFilters,
	LeadListFilters,
	LeadUpdateBody,
} from "../types";

/**
 * A running campaign is dialling people right now, so its numbers go stale in
 * seconds. Everything else is history and does not need polling.
 */
const LIVE_REFETCH_MS = 10_000;

const KEYS = {
	all: ["campaigns"] as const,
	list: (filters: CampaignListFilters) => ["campaigns", "list", filters] as const,
	one: (id: string) => ["campaigns", "one", id] as const,
	progress: (id: string) => ["campaigns", "progress", id] as const,
	leads: (id: string, filters: LeadListFilters) => ["campaigns", "leads", id, filters] as const,
	lead: (id: string, leadId: string) => ["campaigns", "lead", id, leadId] as const,
	dnc: (filters: DncListFilters) => ["campaigns", "dnc", filters] as const,
};

export function useCampaigns(filters: CampaignListFilters) {
	return useQuery({
		queryKey: KEYS.list(filters),
		queryFn: () => campaignService.list(filters),
		// A campaign started from another tab (or finished by the dialer) has to
		// show up here without a manual reload.
		refetchInterval: LIVE_REFETCH_MS,
		retry: false,
	});
}

export function useCampaign(id: string | undefined) {
	return useQuery({
		queryKey: KEYS.one(id ?? ""),
		queryFn: () => campaignService.get(id as string),
		enabled: id !== undefined,
		retry: false,
	});
}

export function useCampaignProgress(id: string | undefined, isLive: boolean) {
	return useQuery({
		queryKey: KEYS.progress(id ?? ""),
		queryFn: () => campaignService.progress(id as string),
		enabled: id !== undefined,
		refetchInterval: isLive ? LIVE_REFETCH_MS : false,
		retry: false,
	});
}

/**
 * Spend and the live queue for the campaigns on the visible page.
 *
 * The list endpoint deliberately does not carry spend: it is priced on read from
 * `lib/ai-cost`, the same code /ai-costs uses, so it costs a handful of queries
 * per campaign and cannot be a join. Two things follow, and both are deliberate:
 *
 *   - drafts are skipped. A draft has never dialled anybody, so its spend is
 *     zero by construction and asking the server is pure waste.
 *   - only a running campaign polls. The rest are fetched once and cached.
 *
 * It is also where the page learns whether a SIP trunk exists, which is the one
 * fact somebody about to press "Boshlash" most needs to know.
 */
export function useCampaignProgressMap(campaigns: Campaign[]): Map<string, CampaignProgress> {
	const tracked = campaigns.filter((campaign) => campaign.status !== "draft");

	const results = useQueries({
		queries: tracked.map((campaign) => ({
			queryKey: KEYS.progress(campaign.id),
			queryFn: () => campaignService.progress(campaign.id),
			refetchInterval: campaign.status === "running" ? LIVE_REFETCH_MS : (false as const),
			staleTime: 30_000,
			retry: false,
		})),
	});

	const map = new Map<string, CampaignProgress>();

	for (const result of results) {
		if (result.data !== undefined) {
			map.set(result.data.campaignId, result.data);
		}
	}

	return map;
}

export function useCampaignLeads(
	id: string | undefined,
	filters: LeadListFilters,
	isLive: boolean
) {
	return useQuery({
		queryKey: KEYS.leads(id ?? "", filters),
		queryFn: () => campaignService.listLeads(id as string, filters),
		enabled: id !== undefined,
		refetchInterval: isLive ? LIVE_REFETCH_MS : false,
		retry: false,
	});
}

export function useCampaignLead(id: string | undefined, leadId: string | undefined) {
	return useQuery({
		queryKey: KEYS.lead(id ?? "", leadId ?? ""),
		queryFn: () => campaignService.getLead(id as string, leadId as string),
		enabled: id !== undefined && leadId !== undefined,
		retry: false,
	});
}

export function useDncList(filters: DncListFilters) {
	return useQuery({
		queryKey: KEYS.dnc(filters),
		queryFn: () => campaignService.listDnc(filters),
		retry: false,
	});
}

/**
 * Every mutation invalidates the whole `campaigns` tree.
 *
 * Deliberately blunt: a start changes the campaign row, the queue, the progress
 * counts and - once a person asks not to be called - the do-not-call list too.
 * Enumerating those four keys per mutation is how a screen ends up showing a
 * paused campaign with a spinning "ishlayapti" badge.
 */
function useCampaignMutation<TArgs, TResult>(
	mutationFn: (args: TArgs) => Promise<TResult>,
	successMessage: ((result: TResult) => string) | null,
	errorFallback: string
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: (result) => {
			if (successMessage !== null) {
				message.success(successMessage(result));
			}

			queryClient.invalidateQueries({ queryKey: KEYS.all });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, errorFallback));
		},
	});
}

export function useCreateCampaign() {
	return useCampaignMutation(
		(body: CampaignCreateBody) => campaignService.create(body),
		() => "Kampaniya qoralama holatida yaratildi",
		"Kampaniyani yaratib bo'lmadi"
	);
}

export function useUpdateCampaign() {
	return useCampaignMutation(
		({ id, body }: { id: string; body: CampaignUpdateBody }) => campaignService.update(id, body),
		() => "Kampaniya saqlandi",
		"Kampaniyani saqlab bo'lmadi"
	);
}

export function useRemoveCampaign() {
	return useCampaignMutation(
		(id: string) => campaignService.remove(id),
		(text) => text,
		"Kampaniyani o'chirib bo'lmadi"
	);
}

/**
 * Start is the one mutation with no toast of its own: the response carries the
 * warnings (no trunk, window shut) and the caller shows them, which a green
 * "started" flash would sit on top of.
 */
export function useStartCampaign() {
	return useCampaignMutation(
		(id: string) => campaignService.start(id),
		null,
		"Kampaniyani ishga tushirib bo'lmadi"
	);
}

export function usePauseCampaign() {
	return useCampaignMutation(
		(id: string) => campaignService.pause(id),
		() => "Kampaniya pauzaga olindi — yangi qo'ng'iroqlar boshlanmaydi",
		"Kampaniyani pauzaga olib bo'lmadi"
	);
}

export function useCancelCampaign() {
	return useCampaignMutation(
		(id: string) => campaignService.cancel(id),
		() => "Kampaniya bekor qilindi",
		"Kampaniyani bekor qilib bo'lmadi"
	);
}

export function useImportLeads() {
	return useCampaignMutation(
		({ id, text }: { id: string; text: string }) => campaignService.importLeads(id, text),
		null,
		"Import qilib bo'lmadi"
	);
}

export function useUpdateLead() {
	return useCampaignMutation(
		({ id, leadId, body }: { id: string; leadId: string; body: LeadUpdateBody }) =>
			campaignService.updateLead(id, leadId, body),
		() => "Yozuv saqlandi",
		"Yozuvni saqlab bo'lmadi"
	);
}

export function useAddDnc() {
	return useCampaignMutation(
		({ phones, reason }: { phones: string[]; reason?: string }) =>
			campaignService.addDnc(phones, reason),
		null,
		"Raqamni ro'yxatga qo'shib bo'lmadi"
	);
}

export function useRemoveDnc() {
	return useCampaignMutation(
		(id: string) => campaignService.removeDnc(id),
		(text) => text,
		"Yozuvni o'chirib bo'lmadi"
	);
}
