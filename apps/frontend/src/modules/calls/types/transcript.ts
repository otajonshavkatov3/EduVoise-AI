export type TranscriptRole = "caller" | "agent" | "system";

export type TranscriptOrder = "asc" | "desc";

export type TranscriptExportFormat = "txt" | "csv";

export interface TranscriptLine {
	id: string;
	callId: string;
	aiSessionId: string | null;
	role: TranscriptRole;
	content: string;
	startMs: number | null;
	endMs: number | null;
	isFinal: boolean;
	confidence: number | null;
	createdAt: string;
}

export interface TranscriptFilters {
	role?: TranscriptRole;
	/** Backend query paramlari string — "true" / "false" */
	includeInterim?: "true" | "false";
	order?: TranscriptOrder;
	search?: string;
	page?: number;
	limit?: number;
}

export interface TranscriptsResponse {
	success: boolean;
	data: {
		items: TranscriptLine[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface TranscriptLineResponse {
	success: boolean;
	data: TranscriptLine;
}

export interface AppendTranscriptLineRequest {
	role: TranscriptRole;
	content: string;
	startMs?: number;
	endMs?: number;
	isFinal?: boolean;
	confidence?: number;
	aiSessionId?: string;
}

export interface UpdateTranscriptLineRequest {
	content?: string;
	role?: TranscriptRole;
	startMs?: number | null;
	endMs?: number | null;
	isFinal?: boolean;
	confidence?: number | null;
}

export interface TranscriptExportOptions {
	format: TranscriptExportFormat;
	role?: TranscriptRole;
	includeInterim?: "true" | "false";
}
