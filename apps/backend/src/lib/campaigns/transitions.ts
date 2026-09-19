/**
 * The campaign lifecycle, as a table rather than as a pile of `if`s.
 *
 * A campaign spends money and rings strangers, so every state change is an
 * explicit, named transition and everything not in this table is refused with a
 * sentence that says why. The alternative - letting a handler decide with a few
 * inline conditions - is how "resume a cancelled campaign" quietly starts working
 * six months later and re-dials two thousand people who already said no.
 *
 *   draft     ── start ──▶ running ── pause ──▶ paused ── start ──▶ running
 *     │                      │                    │
 *     └── cancel ──▶ cancelled ◀── cancel ────────┘
 *                            │
 *                            └── finish ──▶ finished   (the dialer, when the
 *                                                       queue is empty)
 *
 * `finished` and `cancelled` are terminal. Re-running a campaign is deliberately
 * not a transition: the leads carry the outcomes of the first run, and reusing the
 * row would either lose that history or dial the people who already answered.
 * Copying the campaign is the honest way to run it again.
 */
import type { CampaignStatus } from "@/db/schema";
import { invalidOperation } from "@/lib/errors";

/** What a caller can ask for. `finish` is the dialer's, not a user's. */
export type CampaignAction = "start" | "pause" | "cancel" | "finish";

/** Status names as the UI writes them, so an error message reads like the page. */
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
	draft: "qoralama",
	running: "ishlayapti",
	paused: "pauzada",
	finished: "tugagan",
	cancelled: "bekor qilingan",
};

export const CAMPAIGN_ACTION_LABELS: Record<CampaignAction, string> = {
	start: "ishga tushirish",
	pause: "pauza qilish",
	cancel: "bekor qilish",
	finish: "tugatish",
};

/** The only legal moves. Everything else is refused. */
const ALLOWED: Record<CampaignAction, { from: CampaignStatus[]; to: CampaignStatus }> = {
	start: { from: ["draft", "paused"], to: "running" },
	pause: { from: ["running"], to: "paused" },
	cancel: { from: ["draft", "running", "paused"], to: "cancelled" },
	finish: { from: ["running", "paused"], to: "finished" },
};

/**
 * Why a specific illegal move is illegal, in Uzbek.
 *
 * Keyed by "from:action" so the common mistakes get a sentence that tells the
 * operator what to do instead, rather than a generic "not allowed".
 */
const REFUSALS: Record<string, string> = {
	"running:start": "Kampaniya allaqachon ishlayapti.",
	"finished:start":
		"Tugagan kampaniyani qayta ishga tushirib bo'lmaydi — natijalar saqlanib qolishi uchun yangi kampaniya yaratib, ro'yxatni qaytadan import qiling.",
	"cancelled:start":
		"Bekor qilingan kampaniya qayta ishga tushmaydi — yangi kampaniya yaratib, ro'yxatni qaytadan import qiling.",
	"draft:pause":
		"Kampaniya hali ishga tushmagan — pauza qilish uchun avval ishga tushirilishi kerak.",
	"paused:pause": "Kampaniya allaqachon pauzada.",
	"finished:pause": "Tugagan kampaniyani pauza qilib bo'lmaydi.",
	"cancelled:pause": "Bekor qilingan kampaniyani pauza qilib bo'lmaydi.",
	"finished:cancel": "Tugagan kampaniyani bekor qilib bo'lmaydi.",
	"cancelled:cancel": "Kampaniya allaqachon bekor qilingan.",
	"draft:finish": "Hali ishga tushmagan kampaniyani tugatib bo'lmaydi.",
	"finished:finish": "Kampaniya allaqachon tugagan.",
	"cancelled:finish": "Bekor qilingan kampaniya tugatilgan hisoblanmaydi.",
};

export function canTransition(from: CampaignStatus, action: CampaignAction): boolean {
	return ALLOWED[action].from.includes(from);
}

/** The status a legal `action` leads to. Does not check legality - use assertTransition. */
export function targetStatus(action: CampaignAction): CampaignStatus {
	return ALLOWED[action].to;
}

/** The Uzbek sentence for an illegal move. Specific where it helps, generic otherwise. */
export function describeRefusal(from: CampaignStatus, action: CampaignAction): string {
	const specific = REFUSALS[`${from}:${action}`];

	if (specific !== undefined) {
		return specific;
	}

	return `«${CAMPAIGN_STATUS_LABELS[from]}» holatidagi kampaniyani ${CAMPAIGN_ACTION_LABELS[action]} mumkin emas.`;
}

/**
 * Move, or refuse with a 422 whose message is the reason.
 *
 * invalidOperation rather than a validation error: the request was well formed,
 * the state of the world is what makes it impossible, and the frontend renders the
 * message verbatim.
 */
export function assertTransition(from: CampaignStatus, action: CampaignAction): CampaignStatus {
	if (!canTransition(from, action)) {
		throw invalidOperation(describeRefusal(from, action));
	}

	return targetStatus(action);
}

/**
 * Which actions the UI should offer for a campaign in this state.
 *
 * `finish` is excluded from the type as well as from the list: it is the dialer's
 * transition, taken when the queue empties, and offering it as a button would let
 * an operator mark a campaign "finished" with people still unrung.
 */
export function availableActions(from: CampaignStatus): Exclude<CampaignAction, "finish">[] {
	const actions: Exclude<CampaignAction, "finish">[] = ["start", "pause", "cancel"];

	return actions.filter((action) => canTransition(from, action));
}

/**
 * Is this campaign still allowed to be edited?
 *
 * A finished or cancelled campaign is history: its leads carry outcomes that were
 * produced under the purpose and the window it had at the time, so editing those
 * fields afterwards would make the record describe calls that never happened that
 * way. Everything before that is editable, including while running - "stop calling
 * at 17:00 after all" has to be possible without cancelling the campaign.
 */
export function isEditable(status: CampaignStatus): boolean {
	return status !== "finished" && status !== "cancelled";
}
