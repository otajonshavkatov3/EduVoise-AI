import type { Sentiment } from "./analysis";

export type CallStatus = "ringing" | "answered" | "missed" | "abandoned" | "completed";
export type CallDirection = "inbound" | "outbound";
export type AIStatus = "pending" | "processing" | "completed" | "failed";

export interface Call {
	id: string;
	direction: CallDirection;
	callerNumber: string;
	calleeExtension: string | null;
	contactId: string | null;
	contactName: string | null;
	operatorId: string | null;
	ticketId: string | null;
	status: CallStatus;
	duration: number | null;
	recordingPath: string | null;
	/** Backend bu maydonni null qaytarishi mumkin (tahlil boshlanmagan). */
	aiStatus: AIStatus | null;
	startedAt: string;
	endedAt: string | null;
	createdAt: string;
	contact?: {
		id: string;
		phoneNumber: string;
		firstName: string | null;
		lastName: string | null;
	};
	/**
	 * GET /calls/{id} qaytaradigan shakl. Avval bu yerda ichma-ich `user.username`
	 * e'lon qilingan edi, backend esa uni hech qachon qaytarmagan — natijada
	 * sahifada har doim "Operator biriktirilmagan" chiqardi. Endi maydonlar
	 * javobning o'ziga mos.
	 */
	operator?: {
		id: string;
		phone: string;
		username: string | null;
		extension: string | null;
	};
}

/**
 * `GET /calls` qatori — `GET /calls/{id}` javobining ustiga ro'yxat uchun
 * qo'shilgan maydonlar. Bular avval alohida sahifalarda yashardi: yozuv bor-yo'qi
 * "Qo'ng'iroq yozuvlari" da, kayfiyat "Sun'iy intellekt tahlili" da, narx esa
 * "AI xarajatlari" da. Endi qatorning o'zida.
 */
export interface CallListItem extends Call {
	operatorName: string | null;
	operatorExtension: string | null;
	hasRecording: boolean;
	hasTranscript: boolean;
	sentiment: Sentiment | null;
	/** null — ko'rish huquqi yo'q yoki narxlanadigan narsa bo'lmagan. */
	costUsd: number | null;
}

export interface CallFilters {
	status?: CallStatus;
	direction?: CallDirection;
	operatorId?: string;
	from?: string;
	to?: string;
	page?: number;
	limit?: number;
	/**
	 * Server `phoneNumber` ni ANIQ moslik bilan qo'llaydi. Erkin matnli qidiruv
	 * `GET /calls` da yo'q — shu sababli avvalgi `q` maydoni olib tashlandi
	 * (u so'rovga qo'shilar, lekin server uni e'tiborsiz qoldirardi).
	 */
	phoneNumber?: string;
	aiStatus?: AIStatus;
	sentiment?: Sentiment;
	/** Backend query paramlari string — "true" / "false" */
	hasRecording?: "true" | "false";
}

export interface CallsResponse {
	success: boolean;
	data: {
		items: CallListItem[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
		/** false bo'lsa `costUsd` yashirilgan, nol emas. */
		costVisible: boolean;
	};
}

export interface SingleCallResponse {
	success: boolean;
	data: Call;
}

/** `GET /calls/me/stats` javobi (backend `MeStatsOutSchema` bilan bir xil). */
export interface MeCallStats {
	totalCalls: number;
	answeredCalls: number;
	missedCalls: number;
	avgTalkTime: number;
	totalTalkTime: number;
}

export interface MeCallStatsResponse {
	success: boolean;
	data: MeCallStats;
}
