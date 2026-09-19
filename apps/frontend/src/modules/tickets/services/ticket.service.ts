import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	CreateTicketRequest,
	ListTicketsResponse,
	TicketItem,
	TicketResponse,
	UpdateTicketRequest,
} from "../types";

export const ticketService = {
	async list(params?: {
		status?: string;
		priority?: string;
		/** Mavzu bo'yicha qidiruv — backend GET /tickets buni qo'llab-quvvatlaydi. */
		q?: string;
		contactId?: string;
		createdBy?: string;
		phoneNumber?: string;
		page?: number | string;
		limit?: number | string;
	}): Promise<ListTicketsResponse> {
		const response = await apiClient.get<ListTicketsResponse>(API_ENDPOINTS.TICKETS.ROOT, {
			params,
		});
		return response.data;
	},

	async get(id: string): Promise<TicketItem> {
		const response = await apiClient.get<TicketResponse>(API_ENDPOINTS.TICKETS.BY_ID(id));
		return response.data.data;
	},

	async create(data: CreateTicketRequest): Promise<TicketItem> {
		const response = await apiClient.post<TicketResponse>(API_ENDPOINTS.TICKETS.ROOT, data);
		return response.data.data;
	},

	async update(id: string, data: UpdateTicketRequest): Promise<TicketItem> {
		const response = await apiClient.patch<TicketResponse>(API_ENDPOINTS.TICKETS.BY_ID(id), data);
		return response.data.data;
	},

	async remove(id: string): Promise<void> {
		await apiClient.delete(API_ENDPOINTS.TICKETS.BY_ID(id));
	},
};
