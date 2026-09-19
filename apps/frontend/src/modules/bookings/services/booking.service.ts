import apiClient from "@/app/api/client";
import { API_ENDPOINTS } from "@/app/api/endpoint";
import type {
	Booking,
	BookingCalendarQuery,
	BookingCalendarResponse,
	BookingFilters,
	BookingResponse,
	BookingsResponse,
	CancelBookingResponse,
	CreateBookingRequest,
	UpdateBookingRequest,
} from "../types";

export const bookingService = {
	async list(filters: BookingFilters): Promise<BookingsResponse> {
		const response = await apiClient.get<BookingsResponse>(API_ENDPOINTS.BOOKINGS.ROOT, {
			params: filters,
		});
		return response.data;
	},

	async calendar(query: BookingCalendarQuery): Promise<BookingCalendarResponse> {
		const response = await apiClient.get<BookingCalendarResponse>(API_ENDPOINTS.BOOKINGS.CALENDAR, {
			params: query,
		});
		return response.data;
	},

	async create(data: CreateBookingRequest): Promise<Booking> {
		const response = await apiClient.post<BookingResponse>(API_ENDPOINTS.BOOKINGS.ROOT, data);
		return response.data.data;
	},

	async update(id: string, data: UpdateBookingRequest): Promise<Booking> {
		const response = await apiClient.patch<BookingResponse>(API_ENDPOINTS.BOOKINGS.BY_ID(id), data);
		return response.data.data;
	},

	/** Uchrashuv o'chirilmaydi — status = cancelled qilinadi. */
	async cancel(id: string): Promise<string> {
		const response = await apiClient.delete<CancelBookingResponse>(
			API_ENDPOINTS.BOOKINGS.BY_ID(id)
		);
		return response.data.data.message;
	},
};
