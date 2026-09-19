import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiAssistantService } from "../services/ai-assistant.service";
import type { AiConfigPatch, AiSessionFilters, AiVoicePreviewRequest } from "../types";

/** Provayder salomatligi. Backend natijani 30 sekund keshlaydi. */
export function useAiStatus() {
	return useQuery({
		queryKey: ["ai-assistant", "status"],
		queryFn: () => aiAssistantService.getStatus(),
		refetchInterval: 30_000,
		staleTime: 15_000,
		retry: false,
	});
}

export function useAiConfig() {
	return useQuery({
		queryKey: ["ai-assistant", "config"],
		queryFn: () => aiAssistantService.getConfig(),
		staleTime: 30_000,
		retry: false,
	});
}

export function useUpdateAiConfig() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (body: AiConfigPatch) => aiAssistantService.updateConfig(body),
		onSuccess: (response) => {
			// PATCH to'liq konfiguratsiyani qaytaradi — keshni darhol o'shanga
			// almashtiramiz, shunda shakl fon so'rovini kutib turmaydi.
			queryClient.setQueryData(["ai-assistant", "config"], {
				success: true as const,
				data: response.data.config,
			});
			queryClient.invalidateQueries({ queryKey: ["ai-assistant", "config"] });
			queryClient.invalidateQueries({ queryKey: ["ai-assistant", "status"] });
		},
	});
}

/**
 * Ovoz namunasi.
 *
 * Kesh yo'q: natija ~380 KB audio va uni React Query keshida saqlab qo'yish
 * xotirani o'ttiz ovozga ko'paytirardi. Takroriy so'rov backend keshidan
 * millisekundlarda qaytadi, ya'ni Google kvotasi sarflanmaydi.
 */
export function usePreviewVoice() {
	return useMutation({
		mutationFn: (body: AiVoicePreviewRequest) => aiAssistantService.previewVoice(body),
	});
}

export function useAiSessions(filters: AiSessionFilters) {
	return useQuery({
		queryKey: ["ai-assistant", "sessions", filters],
		queryFn: () => aiAssistantService.listSessions(filters),
		retry: false,
	});
}

export function useAiSession(id: string | undefined) {
	return useQuery({
		queryKey: ["ai-assistant", "session", id],
		queryFn: () => aiAssistantService.getSession(id as string),
		enabled: !!id,
		retry: false,
	});
}
