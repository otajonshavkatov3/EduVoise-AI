// biome-ignore-all lint/style/useNamingConvention: the keys below are wire values - `campaign_outcome`, `campaign_lead_status` and the import skip-reason codes are snake_case in Postgres and in the API response, so a label map keyed by them has to spell them the way they arrive.

/**
 * Every enum the campaign screens render, in Uzbek.
 *
 * One file, because the same outcome appears on the list page, the detail page,
 * the lead drawer and the filters - and an outcome that reads "Rozi bo'ldi" in
 * one place and "Roziligini bildirdi" in another looks like two different
 * things to the person reading the report.
 */
import type {
	CampaignKind,
	CampaignLeadStatus,
	CampaignOutcome,
	CampaignStatus,
	DncSource,
	ImportSkipReason,
} from "../types";

/** Antd `Tag` colour names, so a status looks the same everywhere it appears. */
type TagColor = string;

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
	draft: "Qoralama",
	running: "Ishlayapti",
	paused: "Pauza",
	finished: "Tugadi",
	cancelled: "Bekor qilingan",
};

export const CAMPAIGN_STATUS_COLORS: Record<CampaignStatus, TagColor> = {
	draft: "default",
	running: "green",
	paused: "gold",
	finished: "blue",
	cancelled: "red",
};

export const CAMPAIGN_KIND_LABELS: Record<CampaignKind, string> = {
	reminder: "Eslatma",
	sales: "Sotuv",
	promo: "Reklama",
	survey: "So'rovnoma",
	other: "Boshqa",
};

/**
 * What each kind is for, shown under the picker in the form.
 *
 * The kind is coarse on purpose - it steers the opening sentence and groups the
 * list - so the field needs to say what it actually changes, otherwise it reads
 * as a required label with no consequence.
 */
export const CAMPAIGN_KIND_HINTS: Record<CampaignKind, string> = {
	reminder: "«Shunday narsa qilgan ekansiz» — eslatma yoki keyingi aloqa",
	sales: "Mahsulot yoki xizmat taklif qilish",
	promo: "Aksiya, yangilik — reklama qo'ng'irog'i",
	survey: "Fikr so'rash, bitta aniq savol berish",
	other: "Yuqoridagilarga to'g'ri kelmasa",
};

export const LEAD_STATUS_LABELS: Record<CampaignLeadStatus, string> = {
	pending: "Navbatda",
	calling: "Qo'ng'iroq ketmoqda",
	done: "Tugallandi",
	failed: "Xatolik",
	skipped: "O'tkazib yuborilgan",
};

export const LEAD_STATUS_COLORS: Record<CampaignLeadStatus, TagColor> = {
	pending: "default",
	calling: "processing",
	done: "green",
	failed: "red",
	skipped: "default",
};

export const OUTCOME_LABELS: Record<CampaignOutcome, string> = {
	answered: "Javob berdi",
	no_answer: "Javob bermadi",
	busy: "Band",
	invalid_number: "Raqam noto'g'ri",
	refused: "Rad etdi",
	agreed: "Rozi bo'ldi",
	callback_requested: "Keyin qo'ng'iroq qilishni so'radi",
	wrong_person: "Boshqa odam",
	do_not_call: "Qo'ng'iroq qilinmasin",
	failed: "Qo'ng'iroq ketmadi",
};

export const OUTCOME_COLORS: Record<CampaignOutcome, TagColor> = {
	answered: "blue",
	no_answer: "default",
	busy: "gold",
	invalid_number: "volcano",
	refused: "orange",
	agreed: "green",
	callback_requested: "cyan",
	wrong_person: "purple",
	do_not_call: "red",
	failed: "red",
};

/**
 * The outcomes a person actually produced, in the order a business reads them.
 *
 * `answered` first because it is the "we spoke to them" bucket, then the three
 * decisions, then the machine facts. The progress card renders this order
 * rather than `Object.keys`, so the same ten rows never reshuffle themselves
 * between two refreshes.
 */
export const OUTCOME_ORDER: CampaignOutcome[] = [
	"agreed",
	"answered",
	"callback_requested",
	"refused",
	"wrong_person",
	"do_not_call",
	"no_answer",
	"busy",
	"invalid_number",
	"failed",
];

export const DNC_SOURCE_LABELS: Record<DncSource, string> = {
	asked_on_call: "Qo'ng'iroqda so'radi",
	manual: "Qo'lda kiritilgan",
	import: "Import",
};

export const DNC_SOURCE_COLORS: Record<DncSource, TagColor> = {
	asked_on_call: "red",
	manual: "default",
	import: "default",
};

/**
 * Import skip reasons, grouped into one sentence above the per-row table.
 *
 * The per-row message comes from the server; this is the summary line, which is
 * the difference between "986 ta qator o'tkazib yuborildi" and knowing that 14
 * of them are duplicates and 2 asked not to be called.
 */
export const IMPORT_REASON_LABELS: Record<ImportSkipReason, string> = {
	invalid_number: "raqam formati noto'g'ri",
	duplicate_in_file: "faylning o'zida takrorlangan",
	already_in_campaign: "shu kampaniyada allaqachon bor",
	do_not_call: "«qo'ng'iroq qilinmasin» ro'yxatida",
	insert_failed: "saqlashda xatolik",
};

export const IMPORT_REASON_ORDER: ImportSkipReason[] = [
	"invalid_number",
	"duplicate_in_file",
	"already_in_campaign",
	"do_not_call",
	"insert_failed",
];

export function campaignStatusLabel(status: CampaignStatus): string {
	return CAMPAIGN_STATUS_LABELS[status] ?? status;
}

export function outcomeLabel(outcome: CampaignOutcome | null): string {
	return outcome === null ? "—" : (OUTCOME_LABELS[outcome] ?? outcome);
}

/** Select/filter options built from the maps, so a new enum member cannot be forgotten. */
export function optionsFrom<T extends string>(
	labels: Record<T, string>
): {
	value: T;
	label: string;
}[] {
	return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}
