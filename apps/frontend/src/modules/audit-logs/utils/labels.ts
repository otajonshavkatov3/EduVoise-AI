// biome-ignore-all lint/style/useNamingConvention: every key below is an audit action or entity value exactly as the backend stores it, so the casing is not ours to change.

/**
 * Audit yozuvlarining o'zbekcha nomlari.
 *
 * Backend harakat va obyekt turlarini texnik kalit sifatida saqlaydi
 * ("tickets.create", "operator_profiles.update"). Kalitlar bazada shundayligicha
 * qoladi — bu yerda faqat ko'rsatish uchun tarjima qilinadi.
 */

/** Kalitlar `apps/backend/src/lib/audit.ts` chaqiriladigan joylardan olingan. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
	"ai-agent.profile.activate": "AI biznes profili faollashtirildi",
	"ai-agent.profile.create": "AI biznes profili yaratildi",
	"ai-agent.profile.create-default": "Standart AI biznes profili yaratildi",
	"ai-agent.profile.delete": "AI biznes profili o'chirildi",
	"ai-agent.profile.update": "AI biznes profili tahrirlandi",
	"ai-analyses.correct": "AI tahlili to'g'rilandi",
	"ai-analyses.retry": "AI tahlili qayta ishga tushirildi",
	"ai-assistant.config.update": "AI sozlamalari o'zgartirildi",
	"asterisk.extensions.sync": "Ichki raqamlar sinxronlandi",
	"asterisk.hangup": "Qo'ng'iroq majburan uzildi",
	"asterisk.originate": "Tizimdan qo'ng'iroq qilindi",
	"asterisk.transfer": "Qo'ng'iroq uzatildi",
	"auth.change_password": "Parol o'zgartirildi",
	"auth.login": "Tizimga kirdi",
	"auth.logout": "Tizimdan chiqdi",
	"auth.refresh": "Sessiya yangilandi",
	"auth.register": "Yangi hisob ochildi",
	"bookings.cancel": "Uchrashuv bekor qilindi",
	"bookings.create": "Uchrashuv yaratildi",
	"bookings.update": "Uchrashuv tahrirlandi",
	"contacts.create": "Kontakt yaratildi",
	"contacts.remove": "Kontakt o'chirildi",
	"contacts.update": "Kontakt tahrirlandi",
	"follow-ups.cancel": "Keyingi aloqa vazifasi bekor qilindi",
	"follow-ups.create": "Keyingi aloqa vazifasi yaratildi",
	"follow-ups.update": "Keyingi aloqa vazifasi tahrirlandi",
	"knowledge-base.bulk-import": "Bilim bazasiga to'plam yuklandi",
	"knowledge-base.create": "Bilim bazasiga yozuv qo'shildi",
	"knowledge-base.delete": "Bilim bazasi yozuvi o'chirildi",
	"knowledge-base.update": "Bilim bazasi yozuvi tahrirlandi",
	"operator_profiles.create": "Operator profili yaratildi",
	"operator_profiles.remove": "Operator profili o'chirildi",
	"operator_profiles.update": "Operator profili tahrirlandi",
	"reports.calls.export": "Qo'ng'iroqlar hisoboti yuklab olindi",
	"reports.operators.export": "Operatorlar hisoboti yuklab olindi",
	"reports.tickets.export": "Murojaatlar hisoboti yuklab olindi",
	"settings.test.telegram": "Telegram sinov xabari yuborildi",
	"settings.update": "Sozlama o'zgartirildi",
	"tickets.create": "Murojaat yaratildi",
	"tickets.remove": "Murojaat o'chirildi",
	"tickets.update": "Murojaat tahrirlandi",
	"transcripts.append": "Transkriptga qator qo'shildi",
	"transcripts.correct": "Transkript qatori to'g'rilandi",
	"users.remove": "Foydalanuvchi o'chirildi",
	"users.update": "Foydalanuvchi tahrirlandi",
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
	ai_agent_profile: "AI biznes profili",
	ai_analysis: "AI tahlili",
	ai_config: "AI sozlamasi",
	asterisk: "Telefoniya",
	booking: "Uchrashuv",
	call: "Qo'ng'iroq",
	call_transcript: "Transkript",
	contact: "Kontakt",
	follow_up_task: "Keyingi aloqa vazifasi",
	knowledge_base_entry: "Bilim bazasi yozuvi",
	operator_profile: "Operator profili",
	report: "Hisobot",
	sip_extension: "SIP ichki raqami",
	system_setting: "Tizim sozlamasi",
	ticket: "Murojaat",
	user: "Foydalanuvchi",
};

/** Ro'yxatda yo'q kalit xom holda ko'rsatiladi — yangi harakat qo'shilsa ham sahifa ishlaydi. */
export function auditActionLabel(action: string): string {
	return AUDIT_ACTION_LABELS[action] ?? action;
}

export function auditEntityLabel(entityType: string): string {
	return AUDIT_ENTITY_LABELS[entityType] ?? entityType;
}

/** Filtr ro'yxati uchun — alifbo tartibida, qiymat sifatida xom kalit yuboriladi. */
export const AUDIT_ACTION_OPTIONS = Object.entries(AUDIT_ACTION_LABELS)
	.map(([value, label]) => ({ value, label }))
	.sort((a, b) => a.label.localeCompare(b.label, "uz"));
