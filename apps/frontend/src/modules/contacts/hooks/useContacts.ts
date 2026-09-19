import { type UseQueryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { contactService } from "../services/contact.service";
import type { Contact, ContactFilters, CreateContactRequest, UpdateContactRequest } from "../types";

export function useContacts(params?: ContactFilters, enabled = true) {
	return useQuery({
		queryKey: ["contacts", params],
		queryFn: () => contactService.list(params),
		enabled,
	});
}

export function useContact(id: string, options?: Partial<UseQueryOptions<Contact>>) {
	return useQuery({
		queryKey: ["contacts", id],
		queryFn: () => contactService.get(id),
		enabled: !!id,
		...options,
	});
}

export function useCreateContact() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateContactRequest) => contactService.create(data),
		onSuccess: () => {
			message.success("Kontakt yaratildi");
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Kontaktni yaratib bo'lmadi"));
		},
	});
}

export function useUpdateContact() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateContactRequest }) =>
			contactService.update(id, data),
		onSuccess: () => {
			message.success("Kontakt saqlandi");
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Kontaktni saqlab bo'lmadi"));
		},
	});
}

export function useRemoveContact() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => contactService.remove(id),
		onSuccess: () => {
			message.success("Kontakt o'chirildi");
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Kontaktni o'chirib bo'lmadi"));
		},
	});
}
