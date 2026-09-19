export interface Address {
	tuman?: string;
	kocha?: string;
	uy?: string;
}

export interface Contact {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
	address: Address | null;
	notes: string | null;
	isDeleted: boolean;
	createdAt: string;
	updatedAt: string;
	callsCount?: number;
	ticketsCount?: number;
}

export interface ContactFilters {
	phoneNumber?: string;
	q?: string;
	includeDeleted?: boolean;
	page?: number;
	limit?: number;
}

export interface ContactsResponse {
	success: boolean;
	data: {
		items: Contact[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface ContactResponse {
	success: boolean;
	data: Contact;
}

export interface CreateContactRequest {
	phoneNumber: string;
	firstName?: string;
	lastName?: string;
	address?: Address;
	notes?: string;
}

export interface UpdateContactRequest {
	phoneNumber?: string;
	firstName?: string;
	lastName?: string;
	address?: Address;
	notes?: string | null;
}

export interface DeleteContactResponse {
	success: boolean;
	data: {
		message: string;
	};
}
