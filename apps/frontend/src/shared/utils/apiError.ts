/**
 * Backend xato javoblarini o'qish uchun yordamchi funksiyalar.
 *
 * Backend AppError quyidagi ko'rinishda qaytaradi:
 *   { success: false, error: { code, message, details } }
 * Ba'zi eski yo'llar esa oddiy { message } qaytaradi — ikkalasi ham qo'llanadi.
 */

interface ApiErrorDetail {
	field?: string;
	reason?: string;
}

/** Bitta zod tekshiruv xatosi — `issues[]` ichidagi element. */
interface ZodIssue {
	message?: string;
	path?: (string | number)[];
}

interface ApiErrorBody {
	success?: boolean;
	message?: string;
	error?: {
		code?: string;
		message?: string;
		details?: ApiErrorDetail[];
		/** Yo'l darajasidagi zod xatosi: `message` o'rniga shu keladi. */
		name?: string;
		issues?: ZodIssue[];
	};
}

/**
 * Zod xatosini o'qiladigan matnga aylantirish.
 *
 * Yo'l darajasidagi tekshiruv AppError emas, `{ error: { name: "ZodError",
 * issues: [...] } }` qaytaradi — unda `error.message` yo'q. Shu sababli har qanday
 * so'rov tekshiruvdan o'tmasa, foydalanuvchi sababini emas, umumiy zaxira matnni
 * ko'rardi. Sxemalardagi o'zbekcha xabarlar aynan shu yerda yo'qolib ketardi.
 */
function zodIssueMessage(issues: ZodIssue[] | undefined): string | null {
	if (issues === undefined || issues.length === 0) {
		return null;
	}

	const messages = issues
		.map((issue) => (issue.message ?? "").trim())
		.filter((text) => text.length > 0);

	return messages.length === 0 ? null : messages.join("; ");
}

interface ApiErrorLike {
	response?: {
		status?: number;
		data?: ApiErrorBody;
	};
	message?: string;
}

function asApiError(error: unknown): ApiErrorLike | null {
	if (typeof error === "object" && error !== null) {
		return error as ApiErrorLike;
	}
	return null;
}

/** Xato matnini olish (AppError → zod tekshiruvi → axios xabari → zaxira matn). */
export function getApiErrorMessage(error: unknown, fallback: string): string {
	const apiError = asApiError(error);
	const body = apiError?.response?.data;

	return body?.error?.message || zodIssueMessage(body?.error?.issues) || body?.message || fallback;
}

/** HTTP status kodi (mavjud bo'lsa). */
export function getApiErrorStatus(error: unknown): number | undefined {
	return asApiError(error)?.response?.status;
}

/** Backend xato kodi (mavjud bo'lsa), masalan "CONFLICT". */
export function getApiErrorCode(error: unknown): string | undefined {
	return asApiError(error)?.response?.data?.error?.code;
}

/** 409 Conflict — masalan uchrashuvlar to'qnashuvi. */
export function isConflictError(error: unknown): boolean {
	return getApiErrorStatus(error) === 409;
}
