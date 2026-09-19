export type DashboardPeriod = "day" | "week" | "month";

export interface DashboardRange {
	from: string;
	to: string;
}

export interface DashboardScope {
	/** true — manager rejimi: faqat o'z operator raqamlari ko'rsatiladi. */
	operatorScoped: boolean;
	/** false — managerga operator profili biriktirilmagan, shuning uchun hamma son 0. */
	hasOperatorProfile: boolean;
}

export interface DashboardCallStats {
	total: number;
	inbound: number;
	outbound: number;
	answered: number;
	missed: number;
	abandoned: number;
	ringing: number;
	/** missed + abandoned. */
	unanswered: number;
	/** Foiz; yakunlangan qo'ng'iroq bo'lmasa null. */
	answerRate: number | null;
	/** Sekund; namuna bo'lmasa null. */
	avgTalkTimeSec: number | null;
	totalTalkTimeSec: number;
	talkTimeSampleSize: number;
	/** answeredAt - startedAt o'rtachasi (sekund); namuna bo'lmasa null. */
	avgWaitingTimeSec: number | null;
	waitingTimeSampleSize: number;
}

export type OperatorStatus = "online" | "offline" | "pause" | "busy";

export interface DashboardOperatorStatuses {
	total: number;
	/** online + busy. */
	active: number;
	online: number;
	busy: number;
	pause: number;
	offline: number;
}

export interface DashboardOperatorWorkload {
	operatorId: string;
	extension: string;
	name: string;
	currentStatus: OperatorStatus;
	totalCalls: number;
	answeredCalls: number;
	missedCalls: number;
	avgTalkTimeSec: number | null;
	totalTalkTimeSec: number;
}

export interface DashboardSentiment {
	positive: number;
	neutral: number;
	negative: number;
	/** Kayfiyat yozilgan tahlillar soni — foizlarning maxraji. */
	analyzed: number;
}

export interface DashboardCategoryCount {
	/** null — ticketda kategoriya ko'rsatilmagan. */
	category: string | null;
	count: number;
}

export interface DashboardOverview {
	period: DashboardPeriod;
	range: DashboardRange;
	previousRange: DashboardRange;
	scope: DashboardScope;
	current: DashboardCallStats;
	previous: DashboardCallStats;
	operators: DashboardOperatorStatuses;
	operatorWorkload: DashboardOperatorWorkload[];
	sentiment: DashboardSentiment;
	ticketCategories: DashboardCategoryCount[];
	aiCategories: DashboardCategoryCount[];
}

export interface DashboardVolumeBucket {
	bucketStart: string;
	label: string;
	total: number;
	inbound: number;
	outbound: number;
	answered: number;
	missed: number;
	abandoned: number;
	unanswered: number;
}

export interface DashboardCallVolume {
	period: DashboardPeriod;
	granularity: "hour" | "day";
	range: DashboardRange;
	scope: DashboardScope;
	buckets: DashboardVolumeBucket[];
	totalCalls: number;
}

export interface DashboardMissedCall {
	id: string;
	callerNumber: string;
	contactId: string | null;
	/** Kontakt topilmasa null — jadval raqamni ko'rsatadi. */
	contactName: string | null;
	direction: "inbound" | "outbound";
	status: "missed" | "abandoned";
	calleeExtension: string | null;
	operatorExtension: string | null;
	startedAt: string;
	endedAt: string | null;
	ringSec: number | null;
}

export interface DashboardMissedCalls {
	period: DashboardPeriod;
	range: DashboardRange;
	scope: DashboardScope;
	items: DashboardMissedCall[];
	total: number;
}
