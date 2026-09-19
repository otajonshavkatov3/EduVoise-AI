export const API_ENDPOINTS = {
	AUTH: {
		LOGIN: "/auth/login",
		LOGOUT: "/auth/logout",
		REFRESH: "/auth/refresh",
		REGISTER: "/auth/register",
		ME: "/auth/me",
	},
	OPERATOR_PROFILES: {
		ROOT: "/operator-profiles",
		ME: "/operator-profiles/me/profile",
		ME_STATUS: "/operator-profiles/me/status",
		/** Shu operatorning brauzer softfoni uchun SIP hisob ma'lumotlari. */
		ME_SIP: "/operator-profiles/me/sip",
		BY_ID: (id: string) => `/operator-profiles/${id}`,
	},
	TICKETS: {
		ROOT: "/tickets",
		BY_ID: (id: string) => `/tickets/${id}`,
	},
	USERS: {
		ROOT: "/users",
		ME_PROFILE: "/users/me/profile",
		BY_ID: (id: string) => `/users/${id}`,
	},
	CONTACTS: {
		ROOT: "/contacts",
		BY_ID: (id: string) => `/contacts/${id}`,
	},
	CALLS: {
		ROOT: "/calls",
		MISSED: "/calls/missed",
		ME_STATS: "/calls/me/stats",
		EXPORT: "/calls/export",
		BY_ID: (id: string) => `/calls/${id}`,
		/** Qo'ng'iroq kartasi: yozuv, transkript, tahlil, sessiya, narx va amallar. */
		FULL: (id: string) => `/calls/${id}/full`,
	},
	AI_ANALYSES: {
		BY_ID: (id: string) => `/ai-analyses/${id}`,
		RETRY: (id: string) => `/ai-analyses/${id}/retry`,
	},
	AUDIT_LOGS: {
		ROOT: "/audit-logs",
	},
	TRANSCRIPTS: {
		BY_CALL: (callId: string) => `/transcripts/call/${callId}`,
		EXPORT_BY_CALL: (callId: string) => `/transcripts/call/${callId}/export`,
		BY_ID: (id: string) => `/transcripts/${id}`,
	},
	FOLLOW_UPS: {
		ROOT: "/follow-ups",
		BY_ID: (id: string) => `/follow-ups/${id}`,
	},
	BOOKINGS: {
		ROOT: "/bookings",
		CALENDAR: "/bookings/calendar",
		BY_ID: (id: string) => `/bookings/${id}`,
	},
	UPLOADS: {
		RECORDING: "/uploads/recording",
		CALL_RECORDING: (fileName: string) => `/uploads/call-recordings/${fileName}`,
	},
	LIVE_CALLS: {
		ROOT: "/live-calls",
		BY_ID: (id: string) => `/live-calls/${id}`,
	},
	AI_ASSISTANT: {
		STATUS: "/ai-assistant/status",
		CONFIG: "/ai-assistant/config",
		VOICE_PREVIEW: "/ai-assistant/voice-preview",
		SESSIONS: "/ai-assistant/sessions",
		SESSION_BY_ID: (id: string) => `/ai-assistant/sessions/${id}`,
	},
	// Faqat UI chaqiradigan uchta amal. GET /asterisk/status, POST
	// /asterisk/extensions/sync va POST /asterisk/originate backendda ishlaydi,
	// lekin frontendda ularga murojaat yo'q — ishlatilmaydigan konstanta
	// "bu allaqachon ulangan" degan taassurot beradi, shuning uchun olib
	// tashlandi (backend route'lari joyida qoldi).
	ASTERISK: {
		EXTENSIONS: "/asterisk/extensions",
		TRANSFER: "/asterisk/transfer",
		HANGUP: "/asterisk/hangup",
	},
	WS: "/ws",
} as const;
