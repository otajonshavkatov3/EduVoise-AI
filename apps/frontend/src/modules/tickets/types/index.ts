export type TicketStatus = "new" | "in_progress" | "resolved" | "closed" | "reopened";
export type TicketPriority = "low" | "medium" | "high";

export interface TicketItem {
	id: string;
	contactId: string;
	createdBy: string;
	subject: string;
	description: string;
	category: string | null;
	priority: TicketPriority;
	status: TicketStatus;
	externalRefId: string | null;
	aiSummary: string | null;
	isDeleted: boolean;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	contact?: {
		id: string;
		phoneNumber: string;
		firstName: string | null;
		lastName: string | null;
	};
	creator?: {
		id: string;
		phone: string;
		role: string;
	};
}

export interface ListTicketsResponse {
	success: boolean;
	data: {
		items: TicketItem[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface TicketResponse {
	success: boolean;
	data: TicketItem;
}

export interface CreateTicketRequest {
	contactId: string;
	subject: string;
	description: string;
	category?: string;
	priority?: TicketPriority;
}

export interface UpdateTicketRequest {
	subject?: string;
	description?: string;
	category?: string;
	priority?: TicketPriority;
	status?: TicketStatus;
}
