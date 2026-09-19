import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { aiAgentService } from "../services/aiAgent.service";
import type { AgentProfilePatch, CreateAgentProfileRequest } from "../types";

const AI_AGENT_KEY = ["ai-agent"] as const;

/** Aktiv profil — bilim bazasi paneli ham shu so'rovdan foydalanadi. */
export function useActiveAgentProfile() {
	return useQuery({
		queryKey: [...AI_AGENT_KEY, "profile"],
		queryFn: () => aiAgentService.getActiveProfile(),
		staleTime: 15_000,
		retry: false,
	});
}

export function useAgentProfiles() {
	return useQuery({
		queryKey: [...AI_AGENT_KEY, "profiles"],
		queryFn: () => aiAgentService.listProfiles(),
		staleTime: 15_000,
		retry: false,
	});
}

/** Profil o'zgarsa AI holati ham o'zgaradi — ai-assistant keshi ham tozalanadi. */
function useAgentInvalidator() {
	const queryClient = useQueryClient();

	return () => {
		queryClient.invalidateQueries({ queryKey: AI_AGENT_KEY });
		queryClient.invalidateQueries({ queryKey: ["ai-assistant", "status"] });
		queryClient.invalidateQueries({ queryKey: ["knowledge-base"] });
	};
}

/**
 * Profilni saqlash.
 *
 * `id` majburiy: backendda faqat `PATCH /profiles/{id}` bor. Javob keshga darhol
 * yoziladi — shakl saqlangan holatga o'tadi va invalidatsiya so'rovi kelguncha
 * eski qiymatlar bir lahzaga qaytib chiqmaydi.
 */
export function useUpdateActiveAgentProfile() {
	const queryClient = useQueryClient();
	const invalidate = useAgentInvalidator();

	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: AgentProfilePatch }) =>
			aiAgentService.updateProfile(id, patch),
		onSuccess: (saved) => {
			// Qoralama profil tahrirlangan bo'lsa aktiv profil keshiga tegmaymiz.
			if (saved.isActive !== false) {
				queryClient.setQueryData([...AI_AGENT_KEY, "profile"], { success: true, data: saved });
			}

			invalidate();
		},
	});
}

export function useCreateAgentProfile() {
	const invalidate = useAgentInvalidator();

	return useMutation({
		mutationFn: (body: CreateAgentProfileRequest) => aiAgentService.createProfile(body),
		onSuccess: () => {
			message.success("Yangi profil yaratildi");
			invalidate();
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Profilni yaratib bo'lmadi"));
		},
	});
}

export function useActivateAgentProfile() {
	const invalidate = useAgentInvalidator();

	return useMutation({
		mutationFn: (id: string) => aiAgentService.activateProfile(id),
		onSuccess: () => {
			message.success("Profil faollashtirildi — keyingi qo'ng'iroq shu profil bilan javob beradi");
			invalidate();
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Profilni faollashtirib bo'lmadi"));
		},
	});
}

export function useDeleteAgentProfile() {
	const invalidate = useAgentInvalidator();

	return useMutation({
		mutationFn: (id: string) => aiAgentService.deleteProfile(id),
		onSuccess: () => {
			message.success("Profil o'chirildi");
			invalidate();
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Profilni o'chirib bo'lmadi"));
		},
	});
}
