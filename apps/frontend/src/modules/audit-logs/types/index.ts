export interface AuditLog {
	id: string;
	/** Backend `null` qaytarishi mumkin (tizim tomonidan bajarilgan harakat). */
	userId: string | null;
	/** Backend `null` qaytarishi mumkin — foydalanuvchi o'chirilgan bo'lsa. */
	userName: string | null;
	action: string;
	entityType: string | null;
	entityId: string | null;
	details: Record<string, unknown> | null;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: string;
}

export interface AuditFilters {
	userId?: string;
	action?: string;
	from?: string;
	to?: string;
	page?: number;
	limit?: number;
}

export interface AuditLogsResponse {
	success: boolean;
	data: {
		items: AuditLog[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}
