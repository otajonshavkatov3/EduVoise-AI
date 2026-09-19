import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { settingsService } from "../services/settings.service";
import type { SettingsUpdateRequest, TelegramTestRequest } from "../types";

const SETTINGS_QUERY_KEY = ["settings"] as const;

export function useSettings() {
	return useQuery({
		queryKey: SETTINGS_QUERY_KEY,
		queryFn: () => settingsService.list(),
		// Settings change rarely; a stale window avoids refetching on every tab switch.
		staleTime: 60_000,
		retry: false,
	});
}

export function useUpdateSettings() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (body: SettingsUpdateRequest) => settingsService.update(body),
		onSuccess: (response) => {
			// PATCH returns the full payload, so the cache can be replaced without a
			// second round trip - and the forms re-seed from the saved values.
			queryClient.setQueryData(SETTINGS_QUERY_KEY, {
				success: true as const,
				data: response.data.settings,
			});
		},
	});
}

export function useTestTelegram() {
	return useMutation({
		mutationFn: (body: TelegramTestRequest) => settingsService.testTelegram(body),
	});
}
