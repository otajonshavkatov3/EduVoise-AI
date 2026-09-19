import { getServerEnv } from "@shared/env";
import type { UserRoleType } from "@shared/types";
import { and, asc, eq } from "drizzle-orm";
import type { PinoLogger } from "hono-pino";

import { db } from "@/db";
import { aiSessions, calls, operatorProfiles, sipExtensions } from "@/db/schema";
import type { AsteriskChannel, PjsipContactInfo, PjsipEndpointInfo } from "@/lib/asterisk";
import {
	AriRequestError,
	getAmiClient,
	getAriClient,
	legacyTenantSlug,
	tenantContextsFor,
	tenantEndpointFor,
} from "@/lib/asterisk";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { businessError, databaseError, invalidInput, notFound } from "@/lib/errors";
import { getAiRuntimeConfig } from "@/lib/settings";
import { getCallOrchestrator, transferToHuman } from "@/lib/telephony";
import {
	currentTenantId,
	getTenantById,
	slugFromEndpointName,
	type TenantId,
	tenantWhere,
} from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type * as r from "./asterisk.routes";

/** Only a supervisor may rewrite the extension mirror. */
const ALLOWED_SYNC_ROLES: UserRoleType[] = ["supervisor"];
/** Placing and dropping calls is a supervisor/admin action. */
const ALLOWED_CONTROL_ROLES: UserRoleType[] = ["admin", "supervisor"];

/**
 * [click-to-call-<slug>] Dials with a 45 s timeout; match it unless asked otherwise.
 *
 * There is no CONTEXT constant here any more: the context that rings the operator
 * and then dials out is that customer's own, because the extension it rings and the
 * trunk it leaves over both belong to one customer. It is resolved per request by
 * tenantContextsFor().
 */
const DEFAULT_ORIGINATE_TIMEOUT_SECONDS = 45;
/** AMI reports a registered contact as "Reachable". */
const REACHABLE_STATUS = /^reachable$/i;
/** sip_extensions.extension is varchar(10) and this deployment numbers them. */
const EXTENSION_PATTERN = /^\d{2,10}$/;

// ===========================================
// Shared helpers
// ===========================================

function errorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	// A URL with embedded credentials must never reach the client, whatever the
	// message was built from.
	return message.replace(/\/\/[^\s/@]*@/g, "//");
}

/** Strips credentials and query strings so an ARI URL can be shown in a response. */
function redactUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return raw.replace(/\/\/[^\s/@]*@/g, "//").replace(/\?.*$/, "");
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
	if (source === null) {
		return null;
	}
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Asterisk renders timestamps as "2026-08-04T09:12:33.401+0000" - a numeric
 * offset with no colon, which is not strict ISO-8601. Normalise before parsing
 * so the response can carry a real ISO string.
 */
function parseAsteriskTime(value: string | null): Date | null {
	if (value === null) {
		return null;
	}
	const parsed = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface AmiState {
	connected: boolean;
	banner: string | null;
	error: string | null;
	endpoints: Map<string, PjsipEndpointInfo>;
	contacts: Map<string, PjsipContactInfo[]>;
}

/**
 * PJSIP endpoint and contact state, keyed by endpoint name - which is
 * `<slug>-<extension>`, i.e. platform-wide and NOT the digits a customer dials. See
 * tenantEndpointNames() for the translation back.
 *
 * Never throws: AMI being down must not stop the extension list from rendering,
 * so the failure is reported as data instead.
 */
async function readAmiState(logger: PinoLogger): Promise<AmiState> {
	const ami = getAmiClient();

	try {
		const [endpoints, contacts] = await Promise.all([
			ami.pjsipShowEndpoints(),
			ami.pjsipShowContacts(),
		]);

		const endpointMap = new Map<string, PjsipEndpointInfo>();
		for (const endpoint of endpoints) {
			if (endpoint.endpoint.length > 0) {
				endpointMap.set(endpoint.endpoint, endpoint);
			}
		}

		const contactMap = new Map<string, PjsipContactInfo[]>();
		for (const contact of contacts) {
			// ContactList sometimes reports only "avilab-101/sip:avilab-101@host" as the
			// object name, with the endpoint in the Aor field; either way the prefix is
			// the ENDPOINT name, which is what carries the tenant.
			const key =
				contact.endpoint.length > 0 ? contact.endpoint : (contact.contact.split("/")[0] ?? "");
			if (key.length === 0) {
				continue;
			}
			const bucket = contactMap.get(key);
			if (bucket === undefined) {
				contactMap.set(key, [contact]);
			} else {
				bucket.push(contact);
			}
		}

		return {
			connected: ami.isConnected,
			banner: ami.serverBanner,
			error: null,
			endpoints: endpointMap,
			contacts: contactMap,
		};
	} catch (cause) {
		logger.warn({ err: cause }, "reading PJSIP state over AMI failed");

		return {
			connected: false,
			banner: ami.serverBanner,
			error: errorMessage(cause),
			endpoints: new Map(),
			contacts: new Map(),
		};
	}
}

interface LiveExtensionState {
	deviceState: string | null;
	isRegistered: boolean;
	contactCount: number;
	registrationStatus: string | null;
	userAgent: string | null;
	roundtripUsec: number | null;
}

/**
 * WHICH OF ASTERISK'S ENDPOINTS ARE THIS CUSTOMER'S, keyed by the digits they
 * know them as.
 *
 * AMI answers with platform-wide endpoint names (`avilab-101`) because that is
 * what PJSIP is configured with, while a customer only ever asks about "101". This
 * is the translation, and it is also the filter: without it every customer's
 * extensions page would list every other customer's endpoints, and the sync below
 * would import them as its own rows.
 *
 * A bare-digit name (`101`) is a pre-tenancy ALIAS endpoint. It belongs to the
 * legacy tenant and to nobody else - attributing it to whoever asked is exactly
 * the mistake this function exists to prevent.
 */
function tenantEndpointNames(state: AmiState, slug: string | null): Map<string, string> {
	const byExtension = new Map<string, string>();
	const ownsLegacyAliases = slug !== null && slug === legacyTenantSlug();

	for (const name of state.endpoints.keys()) {
		const owner = slugFromEndpointName(name);

		if (owner === null) {
			if (ownsLegacyAliases && EXTENSION_PATTERN.test(name) && !byExtension.has(name)) {
				byExtension.set(name, name);
			}

			continue;
		}

		if (owner !== slug) {
			continue;
		}

		// The tenant-named endpoint always wins over an alias for the same digits: it
		// is the one the dialplan dials and the one that owns the aor.
		byExtension.set(name.slice(owner.length + 1), name);
	}

	return byExtension;
}

/** Null when AMI could not be read at all, so "offline" is never invented. */
function liveStateFor(state: AmiState, endpointName: string): LiveExtensionState | null {
	if (state.error !== null) {
		return null;
	}

	const endpoint = state.endpoints.get(endpointName);
	const contacts = state.contacts.get(endpointName) ?? [];
	const best = contacts.find((contact) => REACHABLE_STATUS.test(contact.status)) ?? contacts[0];

	return {
		deviceState: endpoint?.state ?? null,
		isRegistered: contacts.some((contact) => REACHABLE_STATUS.test(contact.status)),
		contactCount: contacts.length,
		registrationStatus: best?.status ?? null,
		userAgent: best?.userAgent ?? null,
		roundtripUsec: best?.roundtripUsec ?? null,
	};
}

async function isKnownExtension(tenantId: TenantId, extension: string): Promise<boolean> {
	// "101" exists once per customer, so this question only means anything with a
	// tenant attached: unscoped, one customer could click-to-call FROM another
	// customer's desk phone, because their 101 made the check pass.
	const [sipRow] = await db
		.select({ id: sipExtensions.id })
		.from(sipExtensions)
		.where(
			tenantWhere(
				sipExtensions,
				tenantId,
				eq(sipExtensions.extension, extension),
				eq(sipExtensions.isEnabled, true)
			)
		)
		.limit(1);

	if (sipRow !== undefined) {
		return true;
	}

	const [operatorRow] = await db
		.select({ id: operatorProfiles.id })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.extension, extension),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	return operatorRow !== undefined;
}

// ===========================================
// GET /extensions
// ===========================================

export const listExtensionsHandler: AppRouteHandler<typeof r.listExtensions> = async (c) => {
	const tenantId = currentTenantId(c);

	const [rows, amiState] = await Promise.all([
		db
			.select({
				id: sipExtensions.id,
				extension: sipExtensions.extension,
				displayName: sipExtensions.displayName,
				kind: sipExtensions.kind,
				isEnabled: sipExtensions.isEnabled,
				operatorProfileId: sipExtensions.operatorProfileId,
				lastRegisteredAt: sipExtensions.lastRegisteredAt,
				lastKnownStatus: sipExtensions.lastKnownStatus,
				createdAt: sipExtensions.createdAt,
				updatedAt: sipExtensions.updatedAt,
				operatorUserId: operatorProfiles.userId,
				operatorExtension: operatorProfiles.extension,
				operatorStatus: operatorProfiles.currentStatus,
			})
			.from(sipExtensions)
			.leftJoin(
				operatorProfiles,
				and(
					eq(sipExtensions.operatorProfileId, operatorProfiles.id),
					eq(operatorProfiles.tenantId, sipExtensions.tenantId)
				)
			)
			.where(eq(sipExtensions.tenantId, tenantId))
			.orderBy(asc(sipExtensions.extension)),
		readAmiState(c.var.logger),
	]);

	const ownEndpoints = tenantEndpointNames(amiState, (await getTenantById(tenantId))?.slug ?? null);

	const items = rows.map((row) => ({
		id: row.id,
		extension: row.extension,
		displayName: row.displayName,
		kind: row.kind,
		isEnabled: row.isEnabled,
		lastRegisteredAt: row.lastRegisteredAt?.toISOString() ?? null,
		lastKnownStatus: row.lastKnownStatus,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		operator:
			row.operatorProfileId !== null &&
			row.operatorUserId !== null &&
			row.operatorExtension !== null &&
			row.operatorStatus !== null
				? {
						id: row.operatorProfileId,
						userId: row.operatorUserId,
						extension: row.operatorExtension,
						currentStatus: row.operatorStatus,
					}
				: null,
		live: liveStateFor(amiState, ownEndpoints.get(row.extension) ?? row.extension),
	}));

	// `unknownEndpoints` is what Asterisk has for THIS customer and their mirror does
	// not - which is what makes a missing sync visible. It used to be every endpoint
	// Asterisk had, i.e. another customer's registered 101 appearing in this
	// customer's list; now the endpoint names carry the tenant, so the list can be
	// filtered to the ones that are actually theirs.
	const known = new Set(rows.map((row) => row.extension));
	const unknownEndpoints = [...ownEndpoints.entries()]
		.filter(([extension]) => !known.has(extension))
		.map(([, name]) => ({
			endpoint: name,
			deviceState: amiState.endpoints.get(name)?.state ?? "Unknown",
		}))
		.sort((left, right) => left.endpoint.localeCompare(right.endpoint));

	return c.json(
		{
			success: true as const,
			data: {
				items,
				total: items.length,
				ami: {
					connected: amiState.connected,
					banner: amiState.banner,
					error: amiState.error,
				},
				unknownEndpoints,
			},
		},
		200
	);
};

// ===========================================
// POST /extensions/sync
// ===========================================

type SyncAction = "created" | "updated" | "unchanged";

interface SyncItem {
	extension: string;
	action: SyncAction;
	deviceState: string | null;
	isRegistered: boolean;
	operatorProfileId: string | null;
}

interface SipExtensionPatch {
	updatedAt: Date;
	lastKnownStatus?: string;
	lastRegisteredAt?: Date;
	operatorProfileId?: string;
}

interface ExistingSipRow {
	id: string;
	extension: string;
	operatorProfileId: string | null;
	lastKnownStatus: string | null;
}

interface ReconcileContext {
	/** Whose extensions are being reconciled. Endpoint 101 exists once per customer. */
	tenantId: TenantId;
	amiState: AmiState;
	existingByExtension: Map<string, ExistingSipRow>;
	operatorByExtension: Map<string, string>;
	aiExtension: string;
	now: Date;
}

/**
 * What actually changed for an extension we already know about.
 *
 * Deliberately additive: a device state is overwritten, but a registration time
 * and an operator link are only ever filled in, never cleared. Asterisk is the
 * authority on registration, and a momentarily unreachable phone must not erase
 * the fact that it was registered at 09:00.
 */
function buildExtensionPatch(
	existing: ExistingSipRow,
	deviceState: string,
	isRegistered: boolean,
	operatorProfileId: string | null,
	now: Date
): SipExtensionPatch {
	const patch: SipExtensionPatch = { updatedAt: now };

	if (existing.lastKnownStatus !== deviceState) {
		patch.lastKnownStatus = deviceState;
	}
	if (isRegistered) {
		patch.lastRegisteredAt = now;
	}
	if (existing.operatorProfileId === null && operatorProfileId !== null) {
		patch.operatorProfileId = operatorProfileId;
	}

	return patch;
}

async function insertSipExtension(
	context: ReconcileContext,
	extension: string,
	deviceState: string,
	isRegistered: boolean,
	operatorProfileId: string | null
): Promise<void> {
	const isAiAgent = extension === context.aiExtension;

	const [inserted] = await db
		.insert(sipExtensions)
		.values({
			tenantId: context.tenantId,
			extension,
			displayName: isAiAgent ? "AI Agent" : `Operator ${extension}`,
			// Asterisk owns the real configuration; kind is only guessed on insert
			// and never overwritten afterwards.
			kind: isAiAgent ? "ai" : "sip",
			operatorProfileId,
			isEnabled: true,
			lastKnownStatus: deviceState,
			lastRegisteredAt: isRegistered ? context.now : null,
		})
		.returning({ id: sipExtensions.id });

	if (inserted === undefined) {
		throw databaseError(`sip_extensions qatorini yaratish bajarilmadi: ${extension}`);
	}
}

async function reconcileEndpoint(
	context: ReconcileContext,
	extension: string,
	endpointName: string,
	deviceState: string
): Promise<SyncItem> {
	// Contacts are keyed by the PLATFORM-WIDE endpoint name, not by the digits: two
	// customers' 101s are two endpoints with two registrations.
	const contacts = context.amiState.contacts.get(endpointName) ?? [];
	const isRegistered = contacts.some((contact) => REACHABLE_STATUS.test(contact.status));
	const existing = context.existingByExtension.get(extension);
	const operatorProfileId =
		existing?.operatorProfileId ?? context.operatorByExtension.get(extension) ?? null;
	const base = { extension, deviceState, isRegistered, operatorProfileId };

	if (existing === undefined) {
		await insertSipExtension(context, extension, deviceState, isRegistered, operatorProfileId);
		return { ...base, action: "created" };
	}

	const patch = buildExtensionPatch(
		existing,
		deviceState,
		isRegistered,
		operatorProfileId,
		context.now
	);

	// Only updatedAt is set: nothing actually moved, so leave the row alone.
	if (Object.keys(patch).length === 1) {
		return { ...base, action: "unchanged" };
	}

	await db
		.update(sipExtensions)
		.set(patch)
		.where(tenantWhere(sipExtensions, context.tenantId, eq(sipExtensions.id, existing.id)));
	return { ...base, action: "updated" };
}

export const syncExtensionsHandler: AppRouteHandler<typeof r.syncExtensions> = async (c) => {
	requireRoles(c, ALLOWED_SYNC_ROLES);

	const amiState = await readAmiState(c.var.logger);

	if (amiState.error !== null) {
		throw businessError(`AMI bilan aloqa yo'q, sinxronlash bajarilmadi: ${amiState.error}`, [
			{ field: "ami", reason: amiState.error },
		]);
	}

	// Read live: the AI's own extension is configurable from the AI settings page,
	// and this sync must exclude whatever it is now rather than what it was at boot.
	const tenantId = currentTenantId(c);
	const aiExtension = getAiRuntimeConfig(tenantId).agentExtension.trim();
	const now = new Date();

	// Both reads are scoped, and this is the one place in this file where an unscoped
	// read would have caused a cross-tenant WRITE: reconcileEndpoint() updates the row
	// it finds by extension, so another customer's "101" row would have been rewritten
	// with our device state and linked to our operator.
	const [existingRows, operatorRows] = await Promise.all([
		db
			.select({
				id: sipExtensions.id,
				extension: sipExtensions.extension,
				operatorProfileId: sipExtensions.operatorProfileId,
				lastKnownStatus: sipExtensions.lastKnownStatus,
			})
			.from(sipExtensions)
			.where(eq(sipExtensions.tenantId, tenantId)),
		db
			.select({ id: operatorProfiles.id, extension: operatorProfiles.extension })
			.from(operatorProfiles)
			.where(tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.isDeleted, false))),
	]);

	const existingByExtension = new Map(existingRows.map((row) => [row.extension, row]));
	const operatorByExtension = new Map(operatorRows.map((row) => [row.extension, row.id]));

	// ONLY this customer's endpoints. Unfiltered, this loop created a sip_extensions
	// row in the CALLING tenant for every numeric endpoint Asterisk had - i.e. it
	// imported other customers' extensions, then wrote their device state and linked
	// their registrations to this customer's operators.
	const ownEndpoints = [
		...tenantEndpointNames(amiState, (await getTenantById(tenantId))?.slug ?? null),
	]
		.map(([extension, endpointName]) => ({ extension, endpointName }))
		.sort((left, right) => left.extension.localeCompare(right.extension));

	const context: ReconcileContext = {
		tenantId,
		amiState,
		existingByExtension,
		operatorByExtension,
		aiExtension,
		now,
	};

	const items: SyncItem[] = [];
	const skipped: string[] = [];

	for (const own of ownEndpoints) {
		// varchar(10) and numeric in this deployment; anything else is not an
		// extension we can mirror, and truncating it would be worse than skipping.
		if (!EXTENSION_PATTERN.test(own.extension)) {
			skipped.push(own.endpointName);
			continue;
		}

		const deviceState = amiState.endpoints.get(own.endpointName)?.state ?? "Unknown";

		items.push(await reconcileEndpoint(context, own.extension, own.endpointName, deviceState));
	}

	const created = items.filter((item) => item.action === "created").length;
	const updated = items.filter((item) => item.action === "updated").length;
	const unchanged = items.filter((item) => item.action === "unchanged").length;

	const seen = new Set(items.map((item) => item.extension));
	const notInAsterisk = existingRows
		.map((row) => row.extension)
		.filter((extension) => !seen.has(extension))
		.sort((left, right) => left.localeCompare(right));

	await audit(c, {
		action: "asterisk.extensions.sync",
		entityType: "sip_extension",
		details: {
			endpointsFromAmi: ownEndpoints.length,
			created,
			updated,
			unchanged,
			skipped,
			notInAsterisk,
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				endpointsFromAmi: ownEndpoints.length,
				created,
				updated,
				unchanged,
				skipped,
				notInAsterisk,
				items,
			},
		},
		200
	);
};

// ===========================================
// GET /status
// ===========================================

export const statusHandler: AppRouteHandler<typeof r.status> = async (c) => {
	const env = getServerEnv();
	const ari = getAriClient();
	const ami = getAmiClient();
	const orchestrator = getCallOrchestrator();

	const [info, channels, ping] = await Promise.allSettled([
		ari.info(),
		ari.listChannels(),
		ami.action("Ping"),
	]);

	const infoRecord = info.status === "fulfilled" ? asRecord(info.value) : null;
	const system = asRecord(infoRecord?.system ?? null);
	const config = asRecord(infoRecord?.config ?? null);
	const statusSection = asRecord(infoRecord?.status ?? null);
	const startedAt = parseAsteriskTime(readString(statusSection, "startup_time"));
	const uptimeSeconds =
		startedAt === null ? null : Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));

	const channelList = channels.status === "fulfilled" ? channels.value : [];
	const byStateCounts = new Map<string, number>();
	for (const channel of channelList) {
		byStateCounts.set(channel.state, (byStateCounts.get(channel.state) ?? 0) + 1);
	}
	const byState = [...byStateCounts.entries()]
		.map(([state, count]) => ({ state, count }))
		.sort((left, right) => left.state.localeCompare(right.state));

	return c.json(
		{
			success: true as const,
			data: {
				reachable: info.status === "fulfilled",
				checkedAt: new Date().toISOString(),
				ari: {
					ok: info.status === "fulfilled",
					baseUrl: redactUrl(env.ASTERISK_ARI_URL),
					app: env.ASTERISK_ARI_APP,
					version: readString(system, "version"),
					systemName: readString(config, "name") ?? readString(system, "entity_id"),
					startupTime: startedAt?.toISOString() ?? null,
					uptimeSeconds,
					error: info.status === "rejected" ? errorMessage(info.reason) : null,
				},
				ami: {
					ok: ping.status === "fulfilled",
					host: env.ASTERISK_AMI_HOST,
					port: env.ASTERISK_AMI_PORT,
					banner: ami.serverBanner,
					error: ping.status === "rejected" ? errorMessage(ping.reason) : null,
				},
				eventStream: {
					running: orchestrator.isRunning,
					app: env.ASTERISK_ARI_APP,
					url: redactUrl(env.ASTERISK_ARI_WS_URL),
				},
				channels: {
					active: channelList.length,
					byState,
					error: channels.status === "rejected" ? errorMessage(channels.reason) : null,
				},
				aiCalls: {
					// This customer's live AI calls, not the platform's. `channels.active` above
					// is Asterisk's own number and stays platform-wide: it comes from ARI, which
					// knows nothing about tenants until the dialplan is split per tenant.
					active: orchestrator.activeCallCountFor(currentTenantId(c)),
					orchestratorRunning: orchestrator.isRunning,
				},
				backend: {
					uptimeSeconds: Math.floor(process.uptime()),
				},
			},
		},
		200
	);
};

// ===========================================
// POST /originate
// ===========================================

export const originateHandler: AppRouteHandler<typeof r.originate> = async (c) => {
	requireRoles(c, ALLOWED_CONTROL_ROLES);

	const body = c.req.valid("json");
	const tenantId = currentTenantId(c);
	const aiExtension = getAiRuntimeConfig(tenantId).agentExtension.trim();

	if (body.fromExtension === aiExtension) {
		throw invalidInput(
			"fromExtension",
			`${aiExtension} — AI agent extensioni, undan click-to-call qilinmaydi`
		);
	}

	if (!(await isKnownExtension(tenantId, body.fromExtension))) {
		throw businessError(
			`Extension ${body.fromExtension} ma'lum emas. POST /asterisk/extensions/sync ni ishga tushiring yoki operator profilini tekshiring.`,
			[{ field: "fromExtension", reason: "unknown extension" }]
		);
	}

	// [click-to-call-<slug>] matches _X. so the destination has to be bare digits.
	const dialledNumber = body.toNumber.replace(/^\+/, "");
	// This customer's own endpoint and this customer's own context. `PJSIP/101` would
	// ring whichever customer's 101 Asterisk resolved first - i.e. it would place a
	// call from a phone on somebody else's desk.
	const tenantSlug = (await getTenantById(tenantId))?.slug ?? null;
	const clickToCallContext = tenantContextsFor(tenantSlug).clickToCall;
	const endpoint = `PJSIP/${tenantEndpointFor(tenantSlug, body.fromExtension)}`;
	const startedAt = new Date();

	let channel: AsteriskChannel;

	try {
		channel = await getAriClient().originate({
			endpoint,
			context: clickToCallContext,
			extension: dialledNumber,
			priority: 1,
			callerId: body.callerId ?? dialledNumber,
			timeout: body.timeoutSeconds ?? DEFAULT_ORIGINATE_TIMEOUT_SECONDS,
		});
	} catch (cause) {
		// status 0 is the ARI client's "could not reach Asterisk at all" signal,
		// which is a different problem from "Asterisk refused the originate".
		const reason =
			cause instanceof AriRequestError && cause.status === 0
				? `Asterisk ARI bilan aloqa yo'q: ${errorMessage(cause)}`
				: errorMessage(cause);

		c.var.logger.error(
			{ err: cause, fromExtension: body.fromExtension, endpoint },
			"click-to-call originate failed"
		);

		// A refused click-to-call is worth recording, but the audit row must not
		// replace the real failure if the insert itself goes wrong.
		try {
			await audit(c, {
				action: "asterisk.originate",
				entityType: "asterisk",
				details: {
					ok: false,
					fromExtension: body.fromExtension,
					toNumber: body.toNumber,
					dialledNumber,
					endpoint,
					context: clickToCallContext,
					error: reason,
				},
			});
		} catch (auditCause) {
			c.var.logger.error({ err: auditCause }, "writing the click-to-call audit row failed");
		}

		throw businessError(`Click-to-call bajarilmadi: ${reason}`);
	}

	await audit(c, {
		action: "asterisk.originate",
		entityType: "asterisk",
		// audit_logs.entity_id is a uuid column and an Asterisk channel id is not
		// one ("1754282616.12"), so the channel goes in details instead.
		details: {
			ok: true,
			channelId: channel.id,
			fromExtension: body.fromExtension,
			toNumber: body.toNumber,
			dialledNumber,
			endpoint,
			context: clickToCallContext,
			channelName: channel.name,
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				channelId: channel.id,
				channelName: channel.name,
				state: channel.state,
				endpoint,
				context: clickToCallContext,
				fromExtension: body.fromExtension,
				toNumber: body.toNumber,
				dialledNumber,
				startedAt: startedAt.toISOString(),
			},
		},
		200
	);
};

// ===========================================
// POST /transfer
// ===========================================

export const transferHandler: AppRouteHandler<typeof r.transfer> = async (c) => {
	const body = c.req.valid("json");
	const tenantId = currentTenantId(c);

	// The call id arrives in the REQUEST BODY, which is the shape of cross-tenant write
	// the type system cannot catch. Checked first, before anything is asked of Asterisk:
	// another customer's call is a 404 here, so this endpoint can neither transfer it
	// nor confirm that it exists.
	const call = await db.query.calls.findFirst({
		where: tenantWhere(calls, tenantId, eq(calls.id, body.callId)),
		columns: { id: true, callerNumber: true, endedAt: true },
	});

	if (!call) {
		throw notFound("Qo'ng'iroq", body.callId);
	}

	const reason = body.reason ?? "dashboard-transfer";
	const preferredExtension = body.extension ?? null;

	// The orchestrator path is preferred: it knows the channel, keeps the AI
	// session consistent and refuses a second concurrent transfer.
	const outcome = await getCallOrchestrator().transferCall(tenantId, body.callId, {
		reason,
		preferredExtension,
	});

	if (outcome !== null) {
		await audit(c, {
			action: "asterisk.transfer",
			entityType: "call",
			entityId: body.callId,
			details: {
				source: "orchestrator",
				reason,
				preferredExtension,
				connected: outcome.connected,
				extension: outcome.extension,
				transferId: outcome.transferId,
				alreadyInProgress: outcome.alreadyInProgress,
				failureReason: outcome.failureReason,
			},
		});

		return c.json(
			{
				success: true as const,
				data: {
					callId: body.callId,
					connected: outcome.connected,
					extension: outcome.extension,
					transferId: outcome.transferId,
					source: "orchestrator" as const,
					strategy: null,
					callerRetained: outcome.callerRetained,
					alreadyInProgress: outcome.alreadyInProgress,
					failureReason: outcome.failureReason,
				},
			},
			200
		);
	}

	if (call.endedAt !== null) {
		throw businessError("Qo'ng'iroq allaqachon tugagan, uzatish mumkin emas");
	}

	// Not tracked in memory (a restart, or the call was handed to the dialplan
	// before this process started): fall back to the recorded channel.
	const session = await db.query.aiSessions.findFirst({
		where: tenantWhere(aiSessions, tenantId, eq(aiSessions.callId, body.callId)),
		columns: { id: true, channelId: true },
	});

	if (!session?.channelId) {
		throw businessError("Bu qo'ng'iroqda jonli kanal yo'q, uzatish mumkin emas");
	}

	const result = await transferToHuman({
		tenantId,
		callId: body.callId,
		channelId: session.channelId,
		aiSessionId: session.id,
		reason,
		preferredExtension,
		callerNumber: call.callerNumber,
	});

	await audit(c, {
		action: "asterisk.transfer",
		entityType: "call",
		entityId: body.callId,
		details: {
			source: "direct",
			reason,
			preferredExtension,
			connected: result.connected,
			extension: result.extension,
			transferId: result.transferId,
			strategy: result.strategy,
			failureReason: result.failureReason,
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				callId: body.callId,
				connected: result.connected,
				extension: result.extension.length > 0 ? result.extension : null,
				transferId: result.transferId,
				source: "direct" as const,
				strategy: result.strategy,
				callerRetained: result.callerRetained,
				alreadyInProgress: false,
				failureReason: result.failureReason,
			},
		},
		200
	);
};

// ===========================================
// POST /hangup
// ===========================================

export const hangupHandler: AppRouteHandler<typeof r.hangup> = async (c) => {
	requireRoles(c, ALLOWED_CONTROL_ROLES);

	const body = c.req.valid("json");
	const reason = body.reason ?? "manual-hangup";
	const tenantId = currentTenantId(c);
	const orchestrator = getCallOrchestrator();
	// Read the channel before the hangup: the snapshot is gone afterwards. Both calls
	// are tenant-scoped, so a callId from another customer neither hangs their caller up
	// nor reveals that the call is live - it falls through to the 404 below.
	const snapshot = orchestrator.getActiveCall(tenantId, body.callId);
	const stopped = await orchestrator.hangupCall(tenantId, body.callId, reason);

	if (stopped) {
		await audit(c, {
			action: "asterisk.hangup",
			entityType: "call",
			entityId: body.callId,
			details: { source: "orchestrator", reason, channelId: snapshot?.channelId ?? null },
		});

		return c.json(
			{
				success: true as const,
				data: {
					callId: body.callId,
					hungUp: true,
					source: "orchestrator" as const,
					channelId: snapshot?.channelId ?? null,
					message: "Qo'ng'iroq tugatildi",
				},
			},
			200
		);
	}

	const session = await db.query.aiSessions.findFirst({
		where: tenantWhere(aiSessions, tenantId, eq(aiSessions.callId, body.callId)),
		columns: { id: true, channelId: true },
	});

	if (!session?.channelId) {
		throw notFound("Jonli qo'ng'iroq", body.callId);
	}

	try {
		// ARI hangup tolerates a channel that has already gone.
		await getAriClient().hangup(session.channelId, "normal");
	} catch (cause) {
		c.var.logger.error(
			{ err: cause, callId: body.callId, channelId: session.channelId },
			"ARI hangup failed"
		);
		throw businessError(`Qo'ng'iroqni tugatish bajarilmadi: ${errorMessage(cause)}`);
	}

	await audit(c, {
		action: "asterisk.hangup",
		entityType: "call",
		entityId: body.callId,
		details: { source: "ari", reason, channelId: session.channelId },
	});

	return c.json(
		{
			success: true as const,
			data: {
				callId: body.callId,
				hungUp: true,
				source: "ari" as const,
				channelId: session.channelId,
				message: "Kanal ARI orqali tugatildi",
			},
		},
		200
	);
};
