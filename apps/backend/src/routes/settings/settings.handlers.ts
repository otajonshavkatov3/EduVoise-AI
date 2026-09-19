/**
 * HTTP layer for the runtime settings.
 *
 * This file owns exactly one thing lib/settings deliberately does not: masking.
 * A stored secret leaves the backend as "***" and never as its real value, and
 * that rule is enforced in one place - toItem() below - so no handler can forget
 * it. Backend code that needs the real token calls getSetting() directly and gets
 * it, which is the whole point of keeping masking out of the store.
 *
 * The two /test endpoints make real network calls and report exactly what came
 * back, including the HTTP status. They save nothing: a supervisor can type a
 * token, verify it works, and only then press Saqlash.
 */
import type { UserRoleType } from "@shared/types";

import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { businessError, invalidInput } from "@/lib/errors";
import {
	coerceSettingValue,
	getSettingDefinition,
	getSettings,
	getSettingsLoadWarnings,
	isSettingKey,
	listSettings,
	SETTING_CATEGORIES,
	SETTING_CATEGORY_LABELS,
	type SettingCategory,
	type SettingKey,
	type SettingSnapshotItem,
	type SettingWrite,
	setSettings,
} from "@/lib/settings";
import { currentTenantId, type TenantId } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type * as r from "./settings.routes";
import type { SettingItem, SettingsPayload } from "./settings.schemas";

/** Only a supervisor may change platform-wide configuration. */
const ALLOWED_WRITE_ROLES: UserRoleType[] = ["supervisor"];

/**
 * Categories that are not readable by every authenticated user. Anything absent
 * from this map is operational configuration everyone may look at; `canEdit`
 * still decides who may change it.
 *
 * "pricing" is here because it is the same data as /api/ai-costs, which is gated
 * to supervisor+admin on the grounds that what the business spends is finance.
 * These rows are the per-million-token rates every figure on that page is
 * multiplied by, and the cost page lists them itself in its rates card - so
 * serving them read-only here to a manager would have made that gate decorative.
 * They only look public while they are still the shipped list prices: the moment
 * an owner replaces one with their negotiated rate, this table states a
 * commercial term of their vendor contract.
 */
const CATEGORY_VIEW_ROLES: Partial<Record<SettingCategory, UserRoleType[]>> = {
	pricing: ["supervisor", "admin"],
};

/**
 * What a stored secret looks like from outside. The frontend receives this in
 * `secretMask`, so it never has to hardcode the string, and sending it back is
 * treated as "leave unchanged".
 */
const SECRET_MASK = "***";

/** Outbound test requests must not hold a request open. */
const TEST_TIMEOUT_MS = 8000;

const TELEGRAM_API_BASE = "https://api.telegram.org";

const DEFAULT_TELEGRAM_TEST_MESSAGE =
	"CallCenter В«Aqlli ShaharВ»: Telegram sozlamalari tekshirildi. Bu test xabari.";

// ===========================================
// Masking + serialisation
// ===========================================

function hasValue(value: string | number | boolean): boolean {
	if (typeof value === "string") {
		return value.trim().length > 0;
	}
	return true;
}

/** A secret leaves the backend as the mask, or as "" when nothing is stored. */
function exposedValue(
	snapshot: SettingSnapshotItem,
	isSecret: boolean,
	isSet: boolean
): string | number | boolean {
	if (!isSecret) {
		return snapshot.value;
	}

	return isSet ? SECRET_MASK : "";
}

/**
 * The only place a setting becomes JSON. A secret is replaced by the mask when
 * something is stored and by an empty string when nothing is - the caller learns
 * whether a token exists, never what it is.
 */
function toItem(snapshot: SettingSnapshotItem): SettingItem {
	const definition = snapshot.definition;
	const isSecret = definition.type === "secret";
	const isSet = hasValue(snapshot.value);

	return {
		key: snapshot.key,
		category: definition.category,
		type: definition.type,
		label: definition.label,
		description: definition.description,
		value: exposedValue(snapshot, isSecret, isSet),
		isSecret,
		isSet,
		isDefault: !snapshot.isStored,
		updatedAt: snapshot.updatedAt?.toISOString() ?? null,
	};
}

function canViewCategory(category: SettingCategory, role: UserRoleType): boolean {
	const allowed = CATEGORY_VIEW_ROLES[category];

	return allowed === undefined || allowed.includes(role);
}

function groupByCategory(
	snapshots: SettingSnapshotItem[],
	role: UserRoleType
): SettingsPayload["categories"] {
	return SETTING_CATEGORIES.filter((category: SettingCategory) => canViewCategory(category, role))
		.map((category: SettingCategory) => ({
			category,
			label: SETTING_CATEGORY_LABELS[category],
			items: snapshots
				.filter((snapshot) => snapshot.definition.category === category)
				.map((snapshot) => toItem(snapshot)),
		}))
		.filter((group) => group.items.length > 0);
}

async function buildPayload(tenantId: TenantId, role: UserRoleType): Promise<SettingsPayload> {
	const snapshots = await listSettings(tenantId);

	return {
		canEdit: isSupervisor(role),
		secretMask: SECRET_MASK,
		categories: groupByCategory(snapshots, role),
	};
}

function isSupervisor(role: UserRoleType): boolean {
	return ALLOWED_WRITE_ROLES.includes(role);
}

// ===========================================
// GET /
// ===========================================

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const user = c.get("user");
	const payload = await buildPayload(user.tenantId, user.role);

	// A stored row that no longer matches its schema is served as the default.
	// Silence would hide that, so it is logged once per cache load.
	const warnings = getSettingsLoadWarnings(user.tenantId);

	if (warnings.length > 0) {
		c.var.logger.warn({ warnings }, "system_settings rows were skipped while loading");
	}

	return c.json({ success: true as const, data: payload }, 200);
};

// ===========================================
// PATCH /
// ===========================================

interface PreparedWrites {
	writes: SettingWrite[];
	/** Secret keys whose incoming value was the mask, i.e. deliberately untouched. */
	ignoredMasked: string[];
}

function prepareWrites(values: Record<string, string | number | boolean>): PreparedWrites {
	const writes: SettingWrite[] = [];
	const ignoredMasked: string[] = [];

	for (const [key, raw] of Object.entries(values)) {
		if (!isSettingKey(key)) {
			throw invalidInput(key, "Noma'lum sozlama kaliti");
		}

		const definition = getSettingDefinition(key);

		if (definition.type === "secret" && raw === SECRET_MASK) {
			// The UI round-tripped the mask it was given. Overwriting the real token
			// with "***" would be a silent, unrecoverable data loss.
			ignoredMasked.push(key);
			continue;
		}

		writes.push({ key, value: coerceSettingValue(definition, raw) });
	}

	return { writes, ignoredMasked };
}

/** Audit detail that records what changed without ever recording a secret. */
function describeChange(change: {
	key: SettingKey;
	before: string | number | boolean;
	after: string | number | boolean;
	isSecret: boolean;
}) {
	if (change.isSecret) {
		return {
			key: change.key,
			secret: true,
			change: hasValue(change.after) ? "replaced" : "cleared",
		};
	}

	return { key: change.key, secret: false, before: change.before, after: change.after };
}

export const updateHandler: AppRouteHandler<typeof r.update> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const user = c.get("user");
	const body = c.req.valid("json");
	const prepared = prepareWrites(body.values);

	// setSettings validates every value against its registry schema and throws a
	// 400 naming the offending key, so no extra validation pass is needed here.
	const changes = await setSettings(user.tenantId, prepared.writes, user.id);

	if (changes.length > 0) {
		await audit(c, {
			action: "settings.update",
			entityType: "system_setting",
			details: {
				keys: changes.map((change) => change.key),
				changes: changes.map((change) => describeChange(change)),
				ignoredMaskedKeys: prepared.ignoredMasked,
			},
		});

		c.var.logger.info(
			{ keys: changes.map((change) => change.key) },
			"system settings were updated"
		);
	}

	const payload = await buildPayload(user.tenantId, user.role);

	return c.json(
		{
			success: true as const,
			data: { changed: changes.map((change) => change.key), settings: payload },
		},
		200
	);
};

// ===========================================
// Shared test helpers
// ===========================================

/**
 * Remove secrets from any text that is about to leave the backend. Error messages
 * from fetch can contain the request URL, and a Telegram token lives in that URL.
 */
function redact(text: string, secrets: string[]): string {
	let output = text;

	for (const secret of secrets) {
		if (secret.length >= 8) {
			output = output.split(secret).join(SECRET_MASK);
		}
	}

	return output;
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "TimeoutError" || error.name === "AbortError"
			? `so'rov ${TEST_TIMEOUT_MS} ms ichida javob bermadi`
			: error.message;
	}
	return "noma'lum xato";
}

/**
 * A value typed into the test form wins over the stored one, so credentials can
 * be verified before they are saved. The mask means "use what is stored".
 */
function pickOverride(provided: string | undefined, stored: string): string {
	const trimmed = (provided ?? "").trim();

	if (trimmed.length === 0 || trimmed === SECRET_MASK) {
		return stored.trim();
	}

	return trimmed;
}

function jsonHeaders(): Headers {
	const headers = new Headers({ Accept: "application/json" });
	headers.set("Content-Type", "application/json");
	return headers;
}

// ===========================================
// POST /test/telegram
// ===========================================

interface TelegramEnvelope {
	ok?: boolean;
	description?: string;
	result?: unknown;
}

interface TelegramCall {
	ok: boolean;
	description: string | null;
	username: string | null;
}

function readTelegramEnvelope(payload: unknown): TelegramEnvelope | null {
	if (typeof payload === "object" && payload !== null) {
		return payload as TelegramEnvelope;
	}
	return null;
}

function readUsername(envelope: TelegramEnvelope | null): string | null {
	const result = envelope?.result;

	if (typeof result === "object" && result !== null && "username" in result) {
		const username = (result as { username?: unknown }).username;
		return typeof username === "string" ? username : null;
	}

	return null;
}

async function callTelegram(
	token: string,
	method: string,
	body?: Record<string, unknown>
): Promise<TelegramCall> {
	const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
		method: body === undefined ? "GET" : "POST",
		headers: jsonHeaders(),
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
	});

	const envelope = readTelegramEnvelope(await response.json().catch(() => null));
	const description = typeof envelope?.description === "string" ? envelope.description : null;

	return {
		ok: response.ok && envelope?.ok === true,
		description: description ?? (response.ok ? null : `HTTP ${response.status}`),
		username: readUsername(envelope),
	};
}

interface TelegramTestResult {
	ok: boolean;
	botUsername: string | null;
	messageSent: boolean;
	detail: string;
}

async function runTelegramTest(
	token: string,
	chatId: string,
	message: string
): Promise<TelegramTestResult> {
	const identity = await callTelegram(token, "getMe");

	if (!identity.ok) {
		return {
			ok: false,
			botUsername: null,
			messageSent: false,
			detail: `Token qabul qilinmadi: ${redact(identity.description ?? "javob bo'sh", [token])}`,
		};
	}

	if (chatId.length === 0) {
		return {
			ok: true,
			botUsername: identity.username,
			messageSent: false,
			detail: "Token to'g'ri. Chat ID kiritilmagani uchun test xabari yuborilmadi.",
		};
	}

	const sent = await callTelegram(token, "sendMessage", {
		// biome-ignore lint/style/useNamingConvention: chat_id is the Telegram Bot API field name and must be spelled exactly as the API spells it.
		chat_id: chatId,
		text: message,
	});

	if (!sent.ok) {
		return {
			ok: false,
			botUsername: identity.username,
			messageSent: false,
			detail: `Token to'g'ri, lekin xabar yuborilmadi: ${redact(sent.description ?? "javob bo'sh", [
				token,
			])}`,
		};
	}

	return {
		ok: true,
		botUsername: identity.username,
		messageSent: true,
		detail: "Test xabari yuborildi — Telegramdagi chatni tekshiring.",
	};
}

export const testTelegramHandler: AppRouteHandler<typeof r.testTelegram> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const body = c.req.valid("json");
	const stored = await getSettings(currentTenantId(c), [
		"notifications.telegram.botToken",
		"notifications.telegram.chatId",
	]);

	const token = pickOverride(body.botToken, stored["notifications.telegram.botToken"]);
	const chatId = pickOverride(body.chatId, stored["notifications.telegram.chatId"]);

	if (token.length === 0) {
		throw businessError("Telegram bot tokeni kiritilmagan");
	}

	const message = (body.message ?? "").trim() || DEFAULT_TELEGRAM_TEST_MESSAGE;

	let result: TelegramTestResult;

	try {
		result = await runTelegramTest(token, chatId, message);
	} catch (error) {
		result = {
			ok: false,
			botUsername: null,
			messageSent: false,
			detail: `Telegram API ga ulanib bo'lmadi: ${redact(errorText(error), [token])}`,
		};
	}

	await audit(c, {
		action: "settings.test.telegram",
		entityType: "system_setting",
		details: {
			ok: result.ok,
			messageSent: result.messageSent,
			botUsername: result.botUsername,
			usedStoredToken: (body.botToken ?? "").trim().length === 0,
			chatIdProvided: chatId.length > 0,
		},
	});

	return c.json(
		{
			success: true as const,
			data: { ...result, checkedAt: new Date().toISOString() },
		},
		200
	);
};
