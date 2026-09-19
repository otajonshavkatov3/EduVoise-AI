export type BookingStatus = "scheduled" | "confirmed" | "cancelled" | "completed";

export type BookingCalendarView = "month" | "week";

export interface BookingAssignee {
	id: string;
	userId: string;
	extension: string;
}

export interface BookingContact {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
}

export interface Booking {
	id: string;
	contactId: string;
	callId: string | null;
	ticketId: string | null;
	/** operatorProfiles.id */
	assignedTo: string | null;
	title: string;
	notes: string | null;
	scheduledAt: string;
	/** scheduledAt + durationMinutes (backend hisoblab beradi) */
	endsAt: string;
	durationMinutes: number;
	location: string | null;
	status: BookingStatus;
	createdBySystem: boolean;
	createdAt: string;
	updatedAt: string;
	contact: BookingContact | null;
	assignee: BookingAssignee | null;
}

export interface BookingFilters {
	status?: BookingStatus;
	/** operatorProfiles.id */
	assignedTo?: string;
	contactId?: string;
	callId?: string;
	ticketId?: string;
	from?: string;
	to?: string;
	page?: number;
	limit?: number;
}

export interface BookingCalendarQuery {
	view?: BookingCalendarView;
	/** Tayanch kun, YYYY-MM-DD */
	date?: string;
	status?: BookingStatus;
	assignedTo?: string;
}

export interface BookingCalendarDay {
	/** YYYY-MM-DD (UTC bo'yicha guruhlangan) */
	date: string;
	count: number;
	items: Booking[];
}

export interface BookingCalendarResponse {
	success: boolean;
	data: {
		view: BookingCalendarView;
		range: { from: string; to: string };
		total: number;
		days: BookingCalendarDay[];
	};
}

export interface BookingsResponse {
	success: boolean;
	data: {
		items: Booking[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface BookingResponse {
	success: boolean;
	data: Booking;
}

export interface CreateBookingRequest {
	contactId: string;
	callId?: string;
	ticketId?: string;
	assignedTo?: string;
	title: string;
	notes?: string;
	scheduledAt: string;
	durationMinutes?: number;
	location?: string;
}

export interface UpdateBookingRequest {
	title?: string;
	notes?: string | null;
	scheduledAt?: string;
	durationMinutes?: number;
	location?: string | null;
	status?: BookingStatus;
	assignedTo?: string | null;
}

export interface CancelBookingResponse {
	success: boolean;
	data: { message: string };
}
