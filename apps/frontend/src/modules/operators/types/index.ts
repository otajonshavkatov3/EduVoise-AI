export type OperatorStatus = "online" | "offline" | "pause" | "busy";

export interface OperatorProfile {
	id: string;
	userId: string;
	extension: string;
	currentStatus: OperatorStatus;
	lastStatusChange: string | null;
	isDeleted: boolean;
	createdAt: string;
	user?: {
		id: string;
		phone: string;
		role: string;
	};
}

export interface ListOperatorsResponse {
	success: boolean;
	data: {
		items: OperatorProfile[];
		meta: {
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
	};
}

export interface OperatorResponse {
	success: boolean;
	data: OperatorProfile;
}

/**
 * Operatorning brauzer softfoni uchun SIP hisob ma'lumotlari
 * (`GET /operator-profiles/me/sip`).
 *
 * `sipUsername` ham SIP auth login, ham register URI foydalanuvchisi sifatida
 * ishlatiladi. Har bir operator o'z extension'i bilan ro'yxatdan o'tadi — avval
 * hamma bitta umumiy 201 extension bilan ro'yxatdan o'tardi va AI uzatgan
 * qo'ng'iroq faqat bitta operatorga yetib borardi.
 */
export interface OperatorSipCredentials {
	deskExtension: string;
	webExtension: string;
	sipUsername: string;
	sipPassword: string;
	wsUrl: string;
	realm: string;
}

export interface OperatorSipResponse {
	success: boolean;
	data: OperatorSipCredentials;
}

export interface CreateOperatorRequest {
	userId: string;
	extension: string;
}

export interface UpdateOperatorRequest {
	extension?: string;
	status?: OperatorStatus;
}
