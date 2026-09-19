import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { getApiErrorMessage, isConflictError } from "@/shared/utils/apiError";
import { bookingService } from "../services/booking.service";
import type {
	BookingCalendarQuery,
	BookingFilters,
	CreateBookingRequest,
	UpdateBookingRequest,
} from "../types";

export function useBookings(filters: BookingFilters, enabled = true) {
	return useQuery({
		queryKey: ["bookings", "list", filters],
		queryFn: () => bookingService.list(filters),
		enabled,
	});
}

export function useBookingCalendar(query: BookingCalendarQuery) {
	return useQuery({
		queryKey: ["bookings", "calendar", query],
		queryFn: () => bookingService.calendar(query),
	});
}

/**
 * Yaratish. 409 (double-booking) xatosi modal ichida Alert sifatida
 * ko'rsatiladi, shuning uchun bu yerda toast chiqarilmaydi.
 */
export function useCreateBooking() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateBookingRequest) => bookingService.create(data),
		onSuccess: () => {
			message.success("Uchrashuv yaratildi");
			queryClient.invalidateQueries({ queryKey: ["bookings"] });
		},
		onError: (error: unknown) => {
			if (!isConflictError(error)) {
				message.error(getApiErrorMessage(error, "Uchrashuvni yaratib bo'lmadi"));
			}
		},
	});
}

export function useUpdateBooking() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateBookingRequest }) =>
			bookingService.update(id, data),
		onSuccess: () => {
			message.success("Uchrashuv yangilandi");
			queryClient.invalidateQueries({ queryKey: ["bookings"] });
		},
		onError: (error: unknown) => {
			if (!isConflictError(error)) {
				message.error(getApiErrorMessage(error, "Uchrashuvni yangilab bo'lmadi"));
			}
		},
	});
}

export function useCancelBooking() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => bookingService.cancel(id),
		onSuccess: (text) => {
			message.success(text || "Uchrashuv bekor qilindi");
			queryClient.invalidateQueries({ queryKey: ["bookings"] });
		},
		onError: (error: unknown) => {
			message.error(getApiErrorMessage(error, "Uchrashuvni bekor qilib bo'lmadi"));
		},
	});
}
