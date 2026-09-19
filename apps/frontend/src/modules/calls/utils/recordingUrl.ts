import { getClientEnv } from "@shared/env";
import { API_ENDPOINTS } from "@/app/api/endpoint";

/** Yo'ldan fayl nomini ajratib olish (Windows/POSIX ajratkichlari). */
export function recordingFileName(recordingPath: string): string {
	const parts = recordingPath.split(/[\\/]/);
	return parts[parts.length - 1] || recordingPath;
}

/** tenants.slug bilan bir xil shakl — biz yaratadigan yagona katalog nomi. */
const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Yozuv qaysi mijoz katalogida turgani (bo'lsa).
 *
 * Yozuvlar endi har bir mijozning o'z katalogida: `.../recordings/<slug>/<fayl>`.
 * Katalog nomi manzilda saqlanadi — aks holda server faylni faqat nom bo'yicha
 * qidirishi kerak bo'ladi, ya'ni ichida hech qanday mijoz belgisi yo'q qidiruv.
 */
function recordingTenantDirectory(recordingPath: string): string | null {
	const parts = recordingPath.split(/[\\/]/).filter((part) => part.length > 0);
	const directory = parts[parts.length - 2];
	const parent = parts[parts.length - 3];

	// Mijoz katalogi — yozuvlar ildizi ICHIDAGI katalog. Ildiz nomi tekshirilmasa,
	// tenancy'dan oldingi "/var/spool/asterisk/recordings/abc.wav" yo'lida
	// "recordings" mijoz slug'i deb o'qiladi va eski yozuvlar ochilmay qoladi.
	if (parent === undefined || !RECORDINGS_ROOT_NAMES.has(parent)) {
		return null;
	}

	return directory !== undefined && TENANT_SLUG_PATTERN.test(directory) ? directory : null;
}

/** Yozuvlar ildizining oxirgi bo'lagi: konteyner tomoni, keyin host tomoni. */
const RECORDINGS_ROOT_NAMES = new Set(["recordings", "call-recordings"]);

/**
 * Yozuvni o'ynatish/yuklab olish manzili.
 *
 * `calls.recordingPath` uch xil bo'lishi mumkin:
 *  - brauzerdan yuklangan yozuv: "/uploads/call-recordings/<fayl>"
 *  - Asterisk MixMonitor (tenancy'dan keyin):
 *    "/var/spool/asterisk/recordings/<slug>/<fayl>"
 *  - o'sha yo'lning tenancy'dan oldingi, kataloqsiz shakli
 * Hammasi mavjud `uploads` route orqali beriladi (yangi route yaratilmaydi).
 */
export function resolveRecordingUrl(recordingPath: string): string {
	if (recordingPath.startsWith("http://") || recordingPath.startsWith("https://")) {
		return recordingPath;
	}
	const env = getClientEnv();
	const base = `${env.VITE_API_URL}/api`;
	if (recordingPath.startsWith("/uploads/")) {
		return `${base}${recordingPath}`;
	}
	const directory = recordingTenantDirectory(recordingPath);
	const fileName = recordingFileName(recordingPath);
	const suffix = directory === null ? fileName : `${directory}/${fileName}`;

	return `${base}${API_ENDPOINTS.UPLOADS.CALL_RECORDING(suffix)}`;
}
