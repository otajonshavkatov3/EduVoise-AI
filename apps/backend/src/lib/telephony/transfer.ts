/**
 * AI -> human handover.
 *
 * Two strategies, chosen from where the caller's channel actually is:
 *
 *   ari-bridge   The caller is still inside our Stasis application (the AI never
 *                started, or the provider was unavailable and we are running the
 *                fallback). ARI owns the channel, so we can put it on hold,
 *                build a mixing bridge, ring the operator into that bridge and
 *                keep the caller if nobody answers.
 *
 *   ami-redirect The caller has already been handed to [ai-bridge] and is
 *                executing AudioSocket(). A channel inside a dialplan
 *                application is NOT under Stasis control, and ARI answers 409
 *                for moh / bridge / addChannel on it. AMI Redirect is the one
 *                primitive that still works: it pulls the channel out of
 *                AudioSocket and drops it at ai-transfer,<ext>,1, where the
 *                existing dialplan Dials the operator (25 s, tT) and bridges
 *                them natively on answer. The caller hears ringback rather than
 *                MoH, and the AudioSocket connection ends - which is what the
 *                orchestrator uses as its "the AI is done" signal.
 *
 * Both paths use the existing [ai-transfer] context and neither needs a dialplan
 * change. On the ari-bridge path the operator leg is originated as
 * Local/<ext>@ai-transfer with our Stasis app as its destination: the ;2 half
 * runs the dialplan Dial (so the 25 s timeout and tT flags still apply) while
 * the ;1 half lands in Stasis where it can be bridged. Originating
 * PJSIP/<ext> straight INTO the context would double-dial - Asterisk rings the
 * endpoint and then the dialplan Dials it again - so it is deliberately only the
 * fallback, in Stasis mode, if the Local channel cannot be created.
 */
import { asc, eq, inArray, isNull, ne } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";
import { db } from "@/db";
import { calls, callTransfers, operatorProfiles, sipExtensions } from "@/db/schema";
import {
	type AmiClient,
	getAmiClient,
	getAriClient,
	isTenantConfigLive,
	tenantContextsFor,
	tenantEndpointFor,
} from "@/lib/asterisk";
import { databaseError } from "@/lib/errors";
import { getAiRuntimeConfig } from "@/lib/settings";
import { getTenantById, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AriClient, AsteriskBridge, AsteriskChannel } from "./contracts";
import { resolveOperatorByExtension, setCallOperator } from "./crm-writer";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "telephony:transfer",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

/**
 * The handover context is PER TENANT (`ai-transfer-avilab`), resolved per transfer.
 *
 * This is the single most dangerous name in the module. "101" is an operator code
 * every customer has, so a redirect into a SHARED transfer context would ring
 * whichever customer's 101 Asterisk found first and hand them a stranger's caller.
 * The context is therefore derived from the call's tenant, and the endpoint dialled
 * is that tenant's own (`PJSIP/avilab-101`).
 */
/** [ai-transfer] Dials with a 25 s timeout; wait a little longer than that. */
const DEFAULT_ANSWER_TIMEOUT_MS = 30_000;
const ANSWER_POLL_INTERVAL_MS = 400;

/**
 * How long the queue path waits for an operator to answer, and how often it looks.
 *
 * The [tenant-queue] dialplan holds a caller for 120 s (Queue(...,120)) before it
 * gives up, so the backend watches a little longer than that to see the outcome
 * whichever way it lands - a busy pool that frees up at 90 s still connects, and the
 * call is attributed correctly. Polled once a second rather than the tighter
 * single-operator cadence, because a caller on hold music does not need 400 ms
 * precision and the pool can hold for two minutes.
 */
const QUEUE_WAIT_TIMEOUT_MS = 125_000;
const QUEUE_POLL_INTERVAL_MS = 1_000;

export type TransferStatus = "requested" | "ringing" | "connected" | "failed" | "abandoned";
export type TransferStrategy = "ari-bridge" | "ami-redirect" | "queue" | "none";

export interface TransferTarget {
	extension: string;
	/** operator_profiles.id, or null for an extension with no operator attached. */
	operatorProfileId: string | null;
	/** operator_profiles.current_status, else the sip_extensions mirror, else "unknown". */
	status: string;
	/** False when this operator already has a live call. */
	isFree: boolean;
	source: "configured" | "sip-extension";
}

export interface TransferToHumanInput {
	callId: string;
	/**
	 * The tenant whose call this is.
	 *
	 * The single most dangerous unscoped query in the whole platform would have been
	 * here: the transfer pool is a list of extensions, extension numbers repeat
	 * across customers, and an unscoped lookup on "101" would ring a DIFFERENT
	 * CUSTOMER's operator and hand them the caller. So every query in this module is
	 * scoped, and the tenant is required rather than optional.
	 */
	tenantId: TenantId;
	channelId: string;
	aiSessionId?: string | null;
	reason?: string | null;
	preferredExtension?: string | null;
	/** Shown to the operator as the calling number. */
	callerNumber?: string | null;
	answerTimeoutMs?: number;
	/**
	 * The same tenant, spelled the way Asterisk knows it - which decides the context
	 * this transfer executes in and the endpoint it dials.
	 *
	 * Optional because callers outside the voice layer (the transfers endpoint) have
	 * only a tenant id; it is then read from the tenant row. Passing it is cheaper and
	 * is what the orchestrator does, since the call already carries it.
	 */
	tenantSlug?: string | null;
	/** Injected for tests; defaults to the process-wide clients. */
	ari?: AriClient;
	ami?: AmiClient;
}

export interface TransferResult {
	/** Null only when no target could be chosen at all, so no row was written. */
	transferId: string | null;
	extension: string;
	connected: boolean;
	toChannelId: string | null;
	strategy: TransferStrategy;
	/**
	 * True when the caller is still ours to talk to after a failed attempt. False
	 * on the ami-redirect path, where the dialplan hangs the caller up itself
	 * after a no-answer - the orchestrator must not try to speak to them then.
	 */
	callerRetained: boolean;
	failureReason: string | null;
}

// ===========================================
// Target selection
// ===========================================

/**
 * The transfer pool as configured right now.
 *
 * Read from the settings rather than from the boot-time environment so a pool
 * edited on the AI settings page applies to the next transfer instead of the next
 * restart. The registry's default is AI_TRANSFER_EXTENSIONS, so a deployment that
 * has never touched the page behaves exactly as before.
 */
function configuredExtensions(tenantId: TenantId): string[] {
	const config = getAiRuntimeConfig(tenantId);
	const aiExtension = config.agentExtension.trim();

	return config.transferExtensions.filter((item) => item !== aiExtension);
}

/**
 * Every extension that would ring if we transferred to `target`.
 *
 * [ai-transfer] pairs a desk phone with its browser softphone - `_1XX` dials
 * `PJSIP/<ext>&PJSIP/2<ext[1:]>` so an operator is reached on whichever they are
 * logged into - and that pairing is exactly why "do not transfer a caller to
 * their own phone" cannot be a simple string compare: a caller on 201 must not be
 * transferred to 101 either, because 101 rings 201.
 */
export function ringsFor(target: string): string[] {
	const extension = target.trim();

	if (/^1\d\d$/.test(extension)) {
		return [extension, `2${extension.slice(1)}`];
	}

	return [extension];
}

/**
 * The extension a caller is on, when they are internal.
 *
 * An outside caller's number matches nothing here, which is the right answer -
 * there is no self-transfer to avoid.
 */
export function callerExtensionOf(callerNumber: string | null | undefined): string | null {
	const value = (callerNumber ?? "").trim();

	return /^\d{3}$/.test(value) ? value : null;
}

/** Would transferring to `target` ring the phone the caller is speaking from? */
export function isSelfTransfer(target: string, callerExtension: string | null): boolean {
	return callerExtension !== null && ringsFor(target).includes(callerExtension);
}

/** operator_profiles.id values with a call that has not ended yet. */
async function busyOperatorIds(tenantId: TenantId): Promise<Set<string>> {
	const rows = await db
		.selectDistinct({ operatorId: calls.operatorId })
		.from(calls)
		.where(
			tenantWhere(
				calls,
				tenantId,
				isNull(calls.endedAt),
				inArray(calls.status, ["ringing", "answered"])
			)
		);

	const busy = new Set<string>();

	for (const row of rows) {
		if (row.operatorId) {
			busy.add(row.operatorId);
		}
	}

	return busy;
}

/**
 * The configured transfer pool with live state attached, in the order
 * ai.transferExtensions lists them.
 */
export async function listTransferTargets(tenantId: TenantId): Promise<TransferTarget[]> {
	const extensions = configuredExtensions(tenantId);

	if (extensions.length === 0) {
		logger.warn("the transfer pool is empty; transfers will fall back to sip_extensions");
		return [];
	}

	const [operatorRows, sipRows, busy] = await Promise.all([
		db
			.select({
				id: operatorProfiles.id,
				extension: operatorProfiles.extension,
				currentStatus: operatorProfiles.currentStatus,
			})
			.from(operatorProfiles)
			.where(
				tenantWhere(
					operatorProfiles,
					tenantId,
					inArray(operatorProfiles.extension, extensions),
					eq(operatorProfiles.isDeleted, false)
				)
			),
		db
			.select({
				extension: sipExtensions.extension,
				isEnabled: sipExtensions.isEnabled,
				lastKnownStatus: sipExtensions.lastKnownStatus,
				operatorProfileId: sipExtensions.operatorProfileId,
			})
			.from(sipExtensions)
			.where(tenantWhere(sipExtensions, tenantId, inArray(sipExtensions.extension, extensions))),
		busyOperatorIds(tenantId),
	]);

	const operatorByExtension = new Map(operatorRows.map((row) => [row.extension, row]));
	const sipByExtension = new Map(sipRows.map((row) => [row.extension, row]));

	return extensions.map((extension) => {
		const operator = operatorByExtension.get(extension);
		const sip = sipByExtension.get(extension);
		const operatorProfileId = operator?.id ?? sip?.operatorProfileId ?? null;

		return {
			extension,
			operatorProfileId,
			status: operator?.currentStatus ?? sip?.lastKnownStatus ?? "unknown",
			isFree: operatorProfileId ? !busy.has(operatorProfileId) : true,
			source: "configured" as const,
		};
	});
}

async function findEnabledSipExtension(
	tenantId: TenantId,
	extension?: string
): Promise<TransferTarget | null> {
	const conditions = [
		eq(sipExtensions.isEnabled, true),
		// kind "ai" is extension 900, which is this agent itself.
		ne(sipExtensions.kind, "ai"),
		ne(sipExtensions.extension, getAiRuntimeConfig(tenantId).agentExtension.trim()),
	];

	if (extension) {
		conditions.push(eq(sipExtensions.extension, extension));
	}

	const [row] = await db
		.select({
			extension: sipExtensions.extension,
			lastKnownStatus: sipExtensions.lastKnownStatus,
			operatorProfileId: sipExtensions.operatorProfileId,
		})
		.from(sipExtensions)
		.where(tenantWhere(sipExtensions, tenantId, ...conditions))
		.orderBy(asc(sipExtensions.extension))
		.limit(1);

	if (!row) {
		return null;
	}

	return {
		extension: row.extension,
		operatorProfileId: row.operatorProfileId ?? null,
		status: row.lastKnownStatus ?? "unknown",
		isFree: true,
		source: "sip-extension",
	};
}

/**
 * Preferred extension first, then an online operator with a free line, then the
 * first enabled SIP extension we know about. The last step is deliberate: a
 * ringing phone that nobody picks up is still better than telling the caller
 * there is nobody to talk to.
 */
export async function chooseTransferTarget(
	tenantId: TenantId,
	preferredExtension?: string | null,
	callerNumber?: string | null
): Promise<TransferTarget | null> {
	const all = await listTransferTargets(tenantId);
	const preferred = preferredExtension?.trim();
	// An internal caller must never be transferred to a phone that is already in
	// this call. Dialling it either rings the handset they are holding or hits a
	// busy device, and the caller hears the transfer fail for no visible reason.
	const callerExtension = callerExtensionOf(callerNumber);
	const targets = all.filter((target) => !isSelfTransfer(target.extension, callerExtension));

	if (callerExtension !== null && targets.length < all.length) {
		logger.info(
			{ callerExtension, dropped: all.length - targets.length },
			"excluded the caller's own phone from the transfer pool"
		);
	}

	if (preferred) {
		if (isSelfTransfer(preferred, callerExtension)) {
			// Usually the model repeating back the extension the caller mentioned.
			logger.warn(
				{ preferred, callerExtension },
				"the requested transfer extension is the caller's own phone; choosing another"
			);
		} else {
			const configured = targets.find((target) => target.extension === preferred);

			if (configured) {
				return configured;
			}

			const adHoc = await findEnabledSipExtension(tenantId, preferred);

			if (adHoc) {
				return adHoc;
			}

			logger.warn(
				{ preferredExtension: preferred },
				"requested transfer extension is not a known target, choosing another one"
			);
		}
	}

	const free = targets.find((target) => target.status === "online" && target.isFree);

	if (free) {
		return free;
	}

	const fallback = await findEnabledSipExtension(tenantId);

	// Better to report "nobody available" than to ring the caller's own handset:
	// the orchestrator turns a null into an apology the caller can act on.
	return fallback !== null && isSelfTransfer(fallback.extension, callerExtension) ? null : fallback;
}

// ===========================================
// call_transfers row
// ===========================================

interface TransferRowPatch {
	status?: TransferStatus;
	toChannelId?: string | null;
	/**
	 * Set at connect time on the QUEUE path, where the answering operator is not
	 * known until one picks up (the row was inserted with the pre-selected target).
	 * to_extension is NOT NULL in the schema, so it is only ever set, never cleared.
	 */
	toExtension?: string;
	toOperatorId?: string | null;
	connectedAt?: Date | null;
	endedAt?: Date | null;
}

async function insertTransferRow(
	input: TransferToHumanInput,
	target: TransferTarget
): Promise<string> {
	const [row] = await db
		.insert(callTransfers)
		.values({
			tenantId: input.tenantId,
			callId: input.callId,
			aiSessionId: input.aiSessionId ?? null,
			fromChannelId: input.channelId,
			toExtension: target.extension,
			toOperatorId: target.operatorProfileId,
			reason: input.reason ?? null,
			status: "requested",
		})
		.returning({ id: callTransfers.id });

	if (!row) {
		throw databaseError("Inserting the call_transfers row returned nothing");
	}

	return row.id;
}

async function patchTransferRow(
	tenantId: TenantId,
	transferId: string,
	patch: TransferRowPatch
): Promise<void> {
	try {
		// Scoped like every other write here. The id came from insertTransferRow a few
		// lines earlier, so this is belt and braces - but a transfer row records who a
		// caller was handed to, and that is not a row another customer may touch.
		await db
			.update(callTransfers)
			.set(patch)
			.where(tenantWhere(callTransfers, tenantId, eq(callTransfers.id, transferId)));
	} catch (cause) {
		// The transfer outcome is already decided by the time this runs; failing to
		// record it must not turn a connected call into a thrown error.
		logger.error({ err: cause, transferId, patch }, "could not update the call_transfers row");
	}
}

// ===========================================
// ARI helpers
// ===========================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * A channel executing Stasis() reports app_name "Stasis"; one executing
 * AudioSocket() in [ai-bridge] reports "AudioSocket". That single field is what
 * decides which transfer strategy is even possible.
 */
function isChannelInStasis(channel: AsteriskChannel): boolean {
	return (channel.dialplan.app_name ?? "").toLowerCase() === "stasis";
}

type AnswerOutcome = "answered" | "gone" | "timeout";

/**
 * Poll until the originated leg is answered. Polling rather than waiting on an
 * ARI event keeps this module usable on its own (the click-to-call route and the
 * transfers endpoint call it too) instead of requiring an event stream to be
 * wired up first.
 */
async function waitForChannelAnswer(
	ari: AriClient,
	channelId: string,
	timeoutMs: number
): Promise<AnswerOutcome> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		let channel: AsteriskChannel | null;

		try {
			channel = await ari.getChannel(channelId);
		} catch (cause) {
			logger.warn({ err: cause, channelId }, "polling the transfer leg failed");
			return "gone";
		}

		if (!channel) {
			return "gone";
		}

		if (channel.state === "Up") {
			return "answered";
		}

		await sleep(ANSWER_POLL_INTERVAL_MS);
	}

	return "timeout";
}

/**
 * The AMI path cannot watch a channel it does not own, so the operator leg is
 * spotted by name: the dialplan Dials PJSIP/<slug>-<ext>, and Asterisk names that
 * channel "PJSIP/<slug>-<ext>-XXXXXXXX". A heuristic, but a cheap and specific one -
 * and one that now cannot match another customer's leg, because the tenant is in
 * the endpoint name.
 *
 * `endpoints` is the FULL ring set, not just the desk phone: [tenant-ai-transfer]
 * dials `PJSIP/<slug>-101 & PJSIP/<slug>-201` so the operator is reached on whichever
 * device they are logged into. Watching only the desk endpoint (`<slug>-101`) meant
 * that when the operator answered in the dashboard softphone (`<slug>-201`) - the
 * product's own operator phone, and the most common answer device - the caller was
 * bridged and could hear the operator, yet the backend saw no matching leg, timed
 * out, and recorded a connected transfer as "failed". So every endpoint in the ring
 * set is accepted.
 */
async function waitForOperatorLegByName(
	ari: AriClient,
	endpoints: readonly string[],
	callerChannelId: string,
	timeoutMs: number
): Promise<{ outcome: AnswerOutcome; channelId: string | null }> {
	const deadline = Date.now() + timeoutMs;
	const prefixes = endpoints.map((endpoint) => `PJSIP/${endpoint}-`);

	while (Date.now() < deadline) {
		let channels: AsteriskChannel[];

		try {
			channels = await ari.listChannels();
		} catch (cause) {
			logger.warn({ err: cause, endpoints }, "listing channels during a transfer failed");
			return { outcome: "timeout", channelId: null };
		}

		const caller = channels.find((channel) => channel.id === callerChannelId);

		if (!caller) {
			return { outcome: "gone", channelId: null };
		}

		const leg = channels.find(
			(channel) =>
				channel.state === "Up" &&
				prefixes.some((prefix) => channel.name.startsWith(prefix))
		);

		if (leg) {
			return { outcome: "answered", channelId: leg.id };
		}

		await sleep(ANSWER_POLL_INTERVAL_MS);
	}

	return { outcome: "timeout", channelId: null };
}

/**
 * Wait for ANY of this tenant's operator endpoints to answer.
 *
 * The queue strategy does not pre-pick an operator - app_queue rings the free
 * members and one of them answers - so unlike waitForOperatorLegByName there is no
 * known endpoint to watch. The answered leg is still named `PJSIP/<slug>-<ext>-...`,
 * so a leg that is not the caller, is Up, and carries this tenant's prefix is the
 * operator who took the call; the extension is pulled back out of the name so the
 * call can be attributed.
 */
async function waitForAnyOperatorLeg(
	ari: AriClient,
	slug: string,
	callerChannelId: string,
	timeoutMs: number,
	pollIntervalMs: number
): Promise<{ outcome: AnswerOutcome; channelId: string | null; extension: string | null }> {
	const deadline = Date.now() + timeoutMs;
	const prefix = `PJSIP/${slug}-`;

	while (Date.now() < deadline) {
		let channels: AsteriskChannel[];

		try {
			channels = await ari.listChannels();
		} catch (cause) {
			logger.warn({ err: cause, slug }, "listing channels during a queue transfer failed");
			return { outcome: "timeout", channelId: null, extension: null };
		}

		if (!channels.some((channel) => channel.id === callerChannelId)) {
			return { outcome: "gone", channelId: null, extension: null };
		}

		const leg = channels.find(
			(channel) =>
				channel.id !== callerChannelId &&
				channel.state === "Up" &&
				channel.name.startsWith(prefix)
		);

		if (leg) {
			return {
				outcome: "answered",
				channelId: leg.id,
				extension: operatorExtensionOf(leg.name),
			};
		}

		await sleep(pollIntervalMs);
	}

	return { outcome: "timeout", channelId: null, extension: null };
}

/**
 * `PJSIP/avilab-101-0000001a` -> `101`.
 *
 * A browser softphone answers as `avilab-201`, which maps back to its desk
 * extension `101`, because operator_profiles.extension carries the single desk
 * number and that is what the call is attributed to.
 */
export function operatorExtensionOf(channelName: string): string | null {
	const raw = channelName.startsWith("PJSIP/")
		? channelName.slice("PJSIP/".length)
		: channelName;
	const channelSuffix = raw.lastIndexOf("-");
	const endpoint = channelSuffix > 0 ? raw.slice(0, channelSuffix) : raw;
	const extSeparator = endpoint.lastIndexOf("-");

	if (extSeparator < 0) {
		return null;
	}

	const extension = endpoint.slice(extSeparator + 1);

	if (!/^\d{3}$/.test(extension)) {
		return /^\d+$/.test(extension) ? extension : null;
	}

	// A browser softphone (2XX) belongs to the desk operator (1XX).
	return extension.startsWith("2") ? `1${extension.slice(1)}` : extension;
}

/** Best-effort ARI teardown - every one of these is expected to 404 sometimes. */
async function quietly(label: string, work: () => Promise<unknown>): Promise<void> {
	try {
		await work();
	} catch (cause) {
		logger.debug({ err: cause }, `transfer cleanup step "${label}" failed, ignoring`);
	}
}

// ===========================================
// Strategy: ARI bridge
// ===========================================

interface StrategyContext {
	input: TransferToHumanInput;
	ari: AriClient;
	target: TransferTarget;
	transferId: string;
	timeoutMs: number;
	/** This tenant's own handover context, e.g. `ai-transfer-avilab`. */
	transferContext: string;
	/** This tenant's own ACD queue entry context, e.g. `queue-avilab`. */
	queueContext: string;
	/** This tenant's slug, e.g. `avilab` - used to spot any operator leg from the queue. */
	tenantSlug: string | null;
	/** This tenant's own endpoint for the target extension, e.g. `avilab-101`. */
	targetEndpoint: string;
	/**
	 * Every tenant endpoint the transfer rings, e.g. `[avilab-101, avilab-201]`.
	 *
	 * The desk phone and its paired browser softphone: [tenant-ai-transfer] dials
	 * both, so the answered leg can be either, and the answer detector must accept
	 * either.
	 */
	targetEndpoints: string[];
}

async function originateOperatorLeg(context: StrategyContext): Promise<AsteriskChannel> {
	const { ari, target, input, timeoutMs } = context;
	const appArgs = `transfer,${input.callId},${context.transferId}`;
	const callerId = input.callerNumber ?? undefined;
	const timeoutSeconds = Math.ceil(timeoutMs / 1000);

	try {
		// Local/<ext>@ai-transfer-<slug>: the ;2 half runs the tenant's dialplan Dial,
		// the ;1 half comes back to us in Stasis so it can be bridged.
		return await ari.originate({
			endpoint: `Local/${target.extension}@${context.transferContext}`,
			appArgs,
			callerId,
			timeout: timeoutSeconds,
		});
	} catch (cause) {
		logger.warn(
			{ err: cause, extension: target.extension, context: context.transferContext },
			"Local channel into the tenant transfer context failed, dialling the endpoint directly"
		);

		// The tenant's own endpoint, never the bare digits: dialling `PJSIP/101` here
		// would reach whichever customer's 101 Asterisk resolved first.
		return await ari.originate({
			endpoint: `PJSIP/${context.targetEndpoint}`,
			appArgs,
			callerId,
			timeout: timeoutSeconds,
		});
	}
}

async function transferViaAriBridge(context: StrategyContext): Promise<TransferResult> {
	const { ari, input, target, transferId, timeoutMs } = context;
	const base = {
		transferId,
		extension: target.extension,
		strategy: "ari-bridge" as const,
		callerRetained: true,
	};

	let bridge: AsteriskBridge;

	try {
		bridge = await ari.createBridge({ type: "mixing" });
		await ari.addToBridge(bridge.id, [input.channelId]);
	} catch (cause) {
		// Most likely the caller left Stasis (or hung up) between the check above
		// and this call, in which case ARI answers 409/404 for the bridge.
		logger.error(
			{ err: cause, callId: input.callId, channelId: input.channelId },
			"could not bridge the caller for a transfer"
		);
		await patchTransferRow(input.tenantId, transferId, { status: "failed", endedAt: new Date() });

		return { ...base, connected: false, toChannelId: null, failureReason: "bridge-failed" };
	}

	// MoH after the channel is in the bridge, so the hold music is what the
	// caller hears while the operator's phone rings.
	await quietly("startMoh", () => ari.startMoh(input.channelId));

	let leg: AsteriskChannel;

	try {
		leg = await originateOperatorLeg(context);
	} catch (cause) {
		logger.error(
			{ err: cause, callId: input.callId, extension: target.extension },
			"could not originate the operator leg"
		);
		await quietly("stopMoh", () => ari.stopMoh(input.channelId));
		await quietly("destroyBridge", () => ari.destroyBridge(bridge.id));
		await patchTransferRow(input.tenantId, transferId, { status: "failed", endedAt: new Date() });

		return {
			...base,
			connected: false,
			toChannelId: null,
			failureReason: "originate-failed",
		};
	}

	await patchTransferRow(input.tenantId, transferId, { status: "ringing", toChannelId: leg.id });

	const outcome = await waitForChannelAnswer(ari, leg.id, timeoutMs);

	if (outcome !== "answered") {
		logger.warn(
			{ callId: input.callId, extension: target.extension, outcome },
			"operator did not answer the transfer"
		);
		await quietly("hangupLeg", () => ari.hangup(leg.id, "normal"));
		await quietly("stopMoh", () => ari.stopMoh(input.channelId));
		await quietly("removeCaller", () => ari.removeFromBridge(bridge.id, [input.channelId]));
		await quietly("destroyBridge", () => ari.destroyBridge(bridge.id));
		await patchTransferRow(input.tenantId, transferId, {
			status: outcome === "gone" ? "abandoned" : "failed",
			endedAt: new Date(),
		});

		return {
			...base,
			connected: false,
			toChannelId: leg.id,
			failureReason: outcome === "gone" ? "leg-gone" : "no-answer",
		};
	}

	await quietly("stopMoh", () => ari.stopMoh(input.channelId));

	try {
		await ari.addToBridge(bridge.id, [leg.id]);
	} catch (cause) {
		logger.error(
			{ err: cause, callId: input.callId, legId: leg.id },
			"operator answered but could not be bridged to the caller"
		);
		await quietly("hangupLeg", () => ari.hangup(leg.id, "normal"));
		await patchTransferRow(input.tenantId, transferId, { status: "failed", endedAt: new Date() });

		return { ...base, connected: false, toChannelId: leg.id, failureReason: "bridge-failed" };
	}

	await patchTransferRow(input.tenantId, transferId, {
		status: "connected",
		toChannelId: leg.id,
		connectedAt: new Date(),
	});

	if (target.operatorProfileId) {
		await setCallOperator(input.tenantId, input.callId, target.operatorProfileId);
	}

	logger.info(
		{ callId: input.callId, extension: target.extension, bridgeId: bridge.id },
		"transfer connected through an ARI bridge"
	);

	return { ...base, connected: true, toChannelId: leg.id, failureReason: null };
}

// ===========================================
// Strategy: AMI redirect
// ===========================================

async function transferViaAmiRedirect(
	context: StrategyContext,
	ami: AmiClient,
	channel: AsteriskChannel
): Promise<TransferResult> {
	const { ari, input, target, transferId, timeoutMs } = context;
	const base = {
		transferId,
		extension: target.extension,
		strategy: "ami-redirect" as const,
		// [ai-transfer] hangs the caller up after a failed Dial, so once the
		// redirect has happened the caller is no longer ours to talk to.
		callerRetained: false,
	};

	try {
		await ami.action("Redirect", {
			Channel: channel.name,
			Context: context.transferContext,
			Exten: target.extension,
			Priority: 1,
		});
	} catch (cause) {
		logger.error(
			{ err: cause, callId: input.callId, channel: channel.name },
			"AMI Redirect into ai-transfer failed"
		);
		await patchTransferRow(input.tenantId, transferId, { status: "failed", endedAt: new Date() });

		return {
			...base,
			// The redirect never happened, so the caller is still on the AudioSocket
			// path and the agent can apologise.
			callerRetained: true,
			connected: false,
			toChannelId: null,
			failureReason: "redirect-failed",
		};
	}

	await patchTransferRow(input.tenantId, transferId, { status: "ringing" });

	const { outcome, channelId } = await waitForOperatorLegByName(
		ari,
		context.targetEndpoints,
		input.channelId,
		timeoutMs
	);

	if (outcome !== "answered") {
		logger.warn(
			{ callId: input.callId, extension: target.extension, outcome },
			"redirected transfer was not answered"
		);
		await patchTransferRow(input.tenantId, transferId, {
			status: outcome === "gone" ? "abandoned" : "failed",
			endedAt: new Date(),
		});

		return {
			...base,
			connected: false,
			toChannelId: null,
			failureReason: outcome === "gone" ? "caller-gone" : "no-answer",
		};
	}

	await patchTransferRow(input.tenantId, transferId, {
		status: "connected",
		toChannelId: channelId,
		connectedAt: new Date(),
	});

	if (target.operatorProfileId) {
		await setCallOperator(input.tenantId, input.callId, target.operatorProfileId);
	}

	logger.info(
		{ callId: input.callId, extension: target.extension },
		"transfer connected through an AMI redirect into ai-transfer"
	);

	return { ...base, connected: true, toChannelId: channelId, failureReason: null };
}

// ===========================================
// Strategy: ACD queue
// ===========================================

/**
 * Hand the caller to the tenant's ACD queue instead of one chosen operator.
 *
 * This is the professional hand-off: AMI Redirect drops the caller into
 * `queue-<slug>`, whose dialplan runs `Queue(<slug>-ops)`. app_queue then rings a
 * free operator at once, skips one already on a call (ringinuse=no), and - the part
 * a single Dial could never do - holds the caller on music-on-hold until an
 * operator frees up when they are all busy. The dialplan owns the caller after the
 * redirect (callerRetained=false), but the queue's own timeout plays an apology
 * rather than dropping them in silence.
 *
 * The answering operator is not known in advance, so the connected leg is spotted
 * by the tenant prefix and the call is attributed from its extension.
 */
async function transferViaQueue(
	context: StrategyContext,
	ami: AmiClient,
	channel: AsteriskChannel
): Promise<TransferResult> {
	const { ari, input, transferId } = context;
	const base = {
		transferId,
		// The queue, not the backend, decides who answers; filled in once one does.
		extension: "",
		strategy: "queue" as const,
		callerRetained: false,
	};

	try {
		await ami.action("Redirect", {
			Channel: channel.name,
			Context: context.queueContext,
			Exten: "s",
			Priority: 1,
		});
	} catch (cause) {
		logger.error(
			{ err: cause, callId: input.callId, channel: channel.name, context: context.queueContext },
			"AMI Redirect into the ACD queue failed"
		);
		await patchTransferRow(input.tenantId, transferId, { status: "failed", endedAt: new Date() });

		return {
			...base,
			// The redirect never happened, so the caller is still on the AudioSocket
			// path and the agent can apologise.
			callerRetained: true,
			connected: false,
			toChannelId: null,
			failureReason: "redirect-failed",
		};
	}

	await patchTransferRow(input.tenantId, transferId, { status: "ringing" });

	const { outcome, channelId, extension } = await waitForAnyOperatorLeg(
		ari,
		context.tenantSlug ?? "",
		input.channelId,
		QUEUE_WAIT_TIMEOUT_MS,
		QUEUE_POLL_INTERVAL_MS
	);

	if (outcome !== "answered") {
		logger.warn(
			{ callId: input.callId, outcome },
			"queued transfer was not answered within the wait window"
		);
		await patchTransferRow(input.tenantId, transferId, {
			status: outcome === "gone" ? "abandoned" : "failed",
			endedAt: new Date(),
		});

		return {
			...base,
			connected: false,
			toChannelId: null,
			failureReason: outcome === "gone" ? "caller-gone" : "no-answer",
		};
	}

	// Attribute the call to whoever the queue connected, resolved from the leg name.
	let operatorProfileId: string | null = null;

	if (extension !== null) {
		const operator = await resolveOperatorByExtension(input.tenantId, extension).catch(
			() => null
		);
		operatorProfileId = operator?.operatorProfileId ?? null;
	}

	await patchTransferRow(input.tenantId, transferId, {
		status: "connected",
		toChannelId: channelId,
		toExtension: extension ?? undefined,
		toOperatorId: operatorProfileId,
		connectedAt: new Date(),
	});

	if (operatorProfileId !== null) {
		await setCallOperator(input.tenantId, input.callId, operatorProfileId);
	}

	logger.info(
		{ callId: input.callId, extension, queue: context.queueContext },
		"transfer connected through the ACD queue"
	);

	return {
		...base,
		extension: extension ?? "",
		connected: true,
		toChannelId: channelId,
		failureReason: null,
	};
}

// ===========================================
// Entry point
// ===========================================

/**
 * Hand the caller to a human. Never throws for an operational outcome - a
 * missing target, a refused originate and a no-answer all come back as
 * `connected: false` with a reason, because the orchestrator has to keep talking
 * to the caller either way.
 */
async function resolveTenantSlug(input: TransferToHumanInput): Promise<string | null> {
	if (input.tenantSlug !== undefined) {
		return input.tenantSlug;
	}

	try {
		const tenant = await getTenantById(input.tenantId);

		return tenant?.slug ?? null;
	} catch (cause) {
		logger.warn({ err: cause, tenantId: input.tenantId }, "could not read the tenant slug");

		return null;
	}
}

export async function transferToHuman(input: TransferToHumanInput): Promise<TransferResult> {
	const ari = input.ari ?? getAriClient();
	const timeoutMs = input.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
	const target = await chooseTransferTarget(
		input.tenantId,
		input.preferredExtension,
		input.callerNumber
	);

	if (!target) {
		logger.error(
			{ callId: input.callId, callerNumber: input.callerNumber },
			"no transfer target is available: the pool and sip_extensions are empty, or every " +
				"target would ring the caller's own phone"
		);

		return {
			transferId: null,
			extension: "",
			connected: false,
			toChannelId: null,
			strategy: "none",
			callerRetained: true,
			failureReason: "no-target",
		};
	}

	const transferId = await insertTransferRow(input, target);

	let channel: AsteriskChannel | null;

	try {
		channel = await ari.getChannel(input.channelId);
	} catch (cause) {
		logger.error({ err: cause, channelId: input.channelId }, "could not read the caller channel");
		channel = null;
	}

	if (!channel) {
		await patchTransferRow(input.tenantId, transferId, {
			status: "abandoned",
			endedAt: new Date(),
		});

		return {
			transferId,
			extension: target.extension,
			connected: false,
			toChannelId: null,
			strategy: "none",
			callerRetained: false,
			failureReason: "caller-gone",
		};
	}

	// The tenant's Asterisk name decides where this transfer runs. Read from the row
	// when the caller did not pass it, because a transfer with no tenant in its
	// context name is a transfer that can ring the wrong company.
	const tenantSlug = await resolveTenantSlug(input);
	const contexts = tenantContextsFor(tenantSlug);
	const context: StrategyContext = {
		input,
		ari,
		target,
		transferId,
		timeoutMs,
		transferContext: contexts.aiTransfer,
		queueContext: contexts.queue,
		tenantSlug,
		targetEndpoint: tenantEndpointFor(tenantSlug, target.extension),
		targetEndpoints: ringsFor(target.extension).map((extension) =>
			tenantEndpointFor(tenantSlug, extension)
		),
	};

	// A channel still in Stasis (the AI never started, or the IVR fallback is
	// running) is ours to bridge directly, and the ARI path keeps the caller if
	// nobody answers - so that stays a single-operator bridge.
	if (isChannelInStasis(channel)) {
		return await transferViaAriBridge(context);
	}

	const ami = input.ami ?? getAmiClient();

	// A live AI call: prefer the ACD queue. It distributes across the whole operator
	// pool, rings a free operator at once, and holds the caller on music-on-hold
	// when everyone is busy instead of dropping them. It needs the generated
	// per-tenant config (the <slug>-ops queue and the queue-<slug> context) to be
	// live; until the first successful sync the single-operator redirect - which has
	// always worked and needs no generated context - is the safe fallback.
	if (tenantSlug !== null && isTenantConfigLive()) {
		return await transferViaQueue(context, ami, channel);
	}

	return await transferViaAmiRedirect(context, ami, channel);
}
