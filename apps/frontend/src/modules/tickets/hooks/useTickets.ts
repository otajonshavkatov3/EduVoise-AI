import { type UseQueryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { ticketService } from "../services/ticket.service";
import type {
	CreateTicketRequest,
	ListTicketsResponse,
	TicketItem,
	UpdateTicketRequest,
} from "../types";

export function useTickets(
	params?: {
		status?: string;
		priority?: string;
		/** Mavzu bo'yicha qidiruv — backend GET /tickets buni qo'llab-quvvatlaydi. */
		q?: string;
		contactId?: string;
		createdBy?: string;
		phoneNumber?: string;
		includeDeleted?: boolean;
		page?: number | string;
		limit?: number | string;
	},
	enabled = true,
	options?: Partial<UseQueryOptions<ListTicketsResponse>>
) {
	return useQuery({
		queryKey: ["tickets", params],
		queryFn: () => ticketService.list(params),
		enabled,
		...options,
	});
}

export function useTicket(id: string) {
	return useQuery({
		queryKey: ["tickets", id],
		queryFn: () => ticketService.get(id),
		enabled: !!id,
	});
}

export function useCreateTicket() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateTicketRequest) => ticketService.create(data),
		onSuccess: () => {
			message.success("Murojaat yaratildi");
			queryClient.invalidateQueries({ queryKey: ["tickets"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Murojaatni yaratib bo'lmadi"));
		},
	});
}

export function useUpdateTicket() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateTicketRequest }) =>
			ticketService.update(id, data),
		onSuccess: (data: TicketItem) => {
			message.success("Murojaat yangilandi");
			queryClient.invalidateQueries({ queryKey: ["tickets"] });
			queryClient.invalidateQueries({ queryKey: ["tickets", data.id] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Murojaatni yangilab bo'lmadi"));
		},
	});
}

export function useRemoveTicket() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => ticketService.remove(id),
		onSuccess: () => {
			message.success("Murojaat o'chirildi");
			queryClient.invalidateQueries({ queryKey: ["tickets"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Murojaatni o'chirib bo'lmadi"));
		},
	});
}
