export type FollowUpStatus = "open" | "in_progress" | "done" | "cancelled";

export interface FollowUpAssignee {
	id: string;
	userId: string;
	extension: string;
}

export interface FollowUpContact {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
}

export interface FollowUpTask {
	id: string;
	callId: string | null;
	ticketId: string | null;
	contactId: string | null;
	/** operatorProfiles.id */
	assignedTo: string | null;
	title: string;
	description: string | null;
	dueAt: string | null;
	status: FollowUpStatus;
	createdBySystem: boolean;
	/** Backend hisoblab beradi: muddati o'tgan va yopilmagan */
	isOverdue: boolean;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	contact: FollowUpContact | null;
	assignee: FollowUpAssignee | null;
}

export interface FollowUpFilters {
	status?: FollowUpStatus;
	/** operatorProfiles.id */
	assignedTo?: string;
	contactId?: string;
	callId?: string;
	ticketId?: string;
	dueFrom?: string;
	dueTo?: string;
	/** Backend query paramlari string — "true" / "false" */
	overdue?: "true" | "false";
	createdBySystem?: "true" | "false";
	page?: number;
	limit?: number;
}

export interface FollowUpsResponse {
	success: boolean;
	data: {
		items: FollowUpTask[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface FollowUpResponse {
	success: boolean;
	data: FollowUpTask;
}

export interface CreateFollowUpRequest {
	title: string;
	description?: string;
	dueAt?: string;
	callId?: string;
	ticketId?: string;
	contactId?: string;
	assignedTo?: string;
}

export interface UpdateFollowUpRequest {
	title?: string;
	description?: string | null;
	dueAt?: string | null;
	status?: FollowUpStatus;
	assignedTo?: string | null;
}

export interface CancelFollowUpResponse {
	success: boolean;
	data: { message: string };
}
