import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	Contact,
	ContactFilters,
	ContactResponse,
	ContactsResponse,
	CreateContactRequest,
	DeleteContactResponse,
	UpdateContactRequest,
} from "../types";

export const contactService = {
	async list(params?: ContactFilters): Promise<ContactsResponse> {
		const response = await apiClient.get<ContactsResponse>(API_ENDPOINTS.CONTACTS.ROOT, {
			params,
		});
		return response.data;
	},

	async get(id: string): Promise<Contact> {
		const response = await apiClient.get<ContactResponse>(API_ENDPOINTS.CONTACTS.BY_ID(id));
		return response.data.data;
	},

	async create(data: CreateContactRequest): Promise<Contact> {
		const response = await apiClient.post<ContactResponse>(API_ENDPOINTS.CONTACTS.ROOT, data);
		return response.data.data;
	},

	async update(id: string, data: UpdateContactRequest): Promise<Contact> {
		const response = await apiClient.patch<ContactResponse>(API_ENDPOINTS.CONTACTS.BY_ID(id), data);
		return response.data.data;
	},

	async remove(id: string): Promise<void> {
		await apiClient.delete<DeleteContactResponse>(API_ENDPOINTS.CONTACTS.BY_ID(id));
	},
};
