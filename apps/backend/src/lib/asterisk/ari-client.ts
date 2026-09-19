/**
 * ARI REST client.
 *
 * Call control for the AI voice layer: answer, variables, dialplan handoff,
 * playback, MoH, originate and bridges. Implemented with `fetch` and HTTP
 * Basic auth because that is all ARI needs - no client library, no extra
 * dependency.
 *
 * Two behaviours here are deliberate and load-bearing:
 *
 *   - `getVariable` resolves to null for an unset variable. Asterisk answers
 *     404 both for "no such channel" and for "no such variable", so the two
 *     are told apart by the error message; only a genuinely missing channel
 *     throws. Without this, reading an optional channel variable would need a
 *     try/catch at every call site.
 *
 *   - Teardown verbs (hangup, stopPlayback, stopMoh, destroyBridge,
 *     removeFromBridge) treat 404 as success. A call that has already gone
 *     away is the normal outcome of a race between the caller hanging up and
 *     our cleanup path, and it must not surface as an error.
 */
import pino from "pino";
import pretty from "pino-pretty";
import type {
	AriClient,
	AriContinueTarget,
	AriCreateBridgeOptions,
	AriOriginateOptions,
	AsteriskBridge,
	AsteriskChannel,
	AsteriskPlayback,
} from "@/lib/telephony/contracts";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "asterisk:ari-client",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

const DEFAULT_ARI_URL = "http://localhost:8088/ari";
const DEFAULT_ARI_APP = "callcenter-ai";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BRIDGE_TYPE = "mixing";

export interface AriClientOptions {
	/** Defaults to ASTERISK_ARI_URL, then http://localhost:8088/ari. */
	baseUrl?: string;
	username?: string;
	password?: string;
	/** Per-request timeout. Defaults to 10s - ARI verbs are local and fast. */
	timeoutMs?: number;
	/** Stasis application used when originating a channel into our own app. */
	appName?: string;
}

type QueryValue = string | number | boolean | undefined;

interface AriRequestOptions {
	query?: Record<string, QueryValue>;
	body?: unknown;
	/** 404 means "already gone" for this verb - resolve instead of throwing. */
	tolerate404?: boolean;
}

/**
 * Any non-2xx ARI reply, plus transport failures (status 0). Carries the raw
 * response body because ARI's own error text ("Channel not found",
 * "Endpoint not found", "Allocation failed") is the useful part.
 */
export class AriRequestError extends Error {
	public readonly status: number;
	public readonly body: string;
	public readonly method: string;
	public readonly path: string;

	constructor(method: string, path: string, status: number, body: string) {
		const where = `ARI ${method} ${path}`;
		super(
			status === 0
				? `${where} could not reach Asterisk: ${body}`
				: `${where} failed with HTTP ${status}: ${body || "<empty body>"}`
		);
		this.name = "AriRequestError";
		this.method = method;
		this.path = path;
		this.status = status;
		this.body = body;

		Error.captureStackTrace(this, this.constructor);
	}
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
	if (!query) {
		return "";
	}

	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) {
			continue;
		}
		params.set(key, String(value));
	}

	const serialised = params.toString();
	return serialised ? `?${serialised}` : "";
}

/** ARI errors come back as `{"message": "..."}`; fall back to the raw text. */
function extractMessage(body: string): string {
	if (!body) {
		return "";
	}

	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object" && "message" in parsed) {
			const { message } = parsed as { message?: unknown };
			if (typeof message === "string") {
				return message;
			}
		}
	} catch {
		// Not JSON (Asterisk sometimes returns plain text) - use it as-is.
	}

	return body;
}

/**
 * Builds an ARI client. Credentials come from the environment unless
 * overridden, which is what the tests use.
 *
 * A missing username/password is logged as a warning rather than thrown here:
 * the backend must still boot (and keep the existing 28 CRM routes serving)
 * on a machine with no Asterisk configured. The first ARI call then fails with
 * a clear message.
 */
export function createAriClient(options: AriClientOptions = {}): AriClient {
	const baseUrl = (options.baseUrl ?? process.env.ASTERISK_ARI_URL ?? DEFAULT_ARI_URL).replace(
		/\/+$/,
		""
	);
	const username = options.username ?? process.env.ASTERISK_ARI_USERNAME ?? "";
	const password = options.password ?? process.env.ASTERISK_ARI_PASSWORD ?? "";
	const appName = options.appName ?? process.env.ASTERISK_ARI_APP ?? DEFAULT_ARI_APP;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	if (!(username && password)) {
		logger.warn(
			{ baseUrl },
			"ARI credentials are not configured (ASTERISK_ARI_USERNAME / ASTERISK_ARI_PASSWORD); ARI calls will fail"
		);
	}

	const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

	async function request(
		method: string,
		path: string,
		requestOptions: AriRequestOptions = {}
	): Promise<Response | null> {
		if (!(username && password)) {
			throw new AriRequestError(
				method,
				path,
				0,
				"ARI credentials are not configured (ASTERISK_ARI_USERNAME / ASTERISK_ARI_PASSWORD)"
			);
		}

		const url = `${baseUrl}${path}${buildQuery(requestOptions.query)}`;
		const headers: Record<string, string> = { Authorization: authorization };
		let payload: string | undefined;

		if (requestOptions.body !== undefined) {
			payload = JSON.stringify(requestOptions.body);
			headers["Content-Type"] = "application/json";
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body: payload,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			throw new AriRequestError(method, path, 0, `${reason} (base URL ${baseUrl})`);
		}

		if (response.ok) {
			return response;
		}

		const body = await response.text().catch(() => "");

		if (response.status === 404 && requestOptions.tolerate404) {
			logger.debug({ method, path }, "ARI resource already gone, treating 404 as success");
			return null;
		}

		throw new AriRequestError(method, path, response.status, extractMessage(body));
	}

	async function requestJson<T>(
		method: string,
		path: string,
		requestOptions: AriRequestOptions = {}
	): Promise<T> {
		const response = await request(method, path, requestOptions);
		if (!response) {
			// Only reachable with tolerate404, which no JSON-returning verb uses.
			throw new AriRequestError(method, path, 404, "resource not found");
		}
		return (await response.json()) as T;
	}

	async function requestVoid(
		method: string,
		path: string,
		requestOptions: AriRequestOptions = {}
	): Promise<void> {
		const response = await request(method, path, requestOptions);
		// Drain the body so the connection can be reused.
		await response?.text().catch(() => "");
	}

	const channelPath = (channelId: string) => `/channels/${encodeURIComponent(channelId)}`;
	const bridgePath = (bridgeId: string) => `/bridges/${encodeURIComponent(bridgeId)}`;

	return {
		async answer(channelId) {
			await requestVoid("POST", `${channelPath(channelId)}/answer`);
		},

		async hangup(channelId, reason) {
			await requestVoid("DELETE", channelPath(channelId), {
				query: { reason },
				tolerate404: true,
			});
		},

		async ringing(channelId) {
			await requestVoid("POST", `${channelPath(channelId)}/ring`);
		},

		async setVariable(channelId, name, value) {
			// Both go in the query string: that is the shape ARI's swagger declares
			// for setChannelVar, and it is the form every Asterisk 13+ accepts.
			await requestVoid("POST", `${channelPath(channelId)}/variable`, {
				query: { variable: name, value },
			});
		},

		async getVariable(channelId, name) {
			const path = `${channelPath(channelId)}/variable`;
			let response: Response | null;

			try {
				response = await request("GET", path, { query: { variable: name } });
			} catch (cause) {
				// 404 covers both "channel gone" and "variable never set". Only the
				// first is an error worth propagating.
				if (
					cause instanceof AriRequestError &&
					cause.status === 404 &&
					!/channel not found/i.test(cause.body)
				) {
					return null;
				}
				throw cause;
			}

			if (!response) {
				return null;
			}

			const parsed = (await response.json()) as { value?: string };
			return parsed.value ?? null;
		},

		async continueInDialplan(channelId, target: AriContinueTarget) {
			await requestVoid("POST", `${channelPath(channelId)}/continue`, {
				query: {
					context: target.context,
					extension: target.extension,
					priority: target.priority,
					label: target.label,
				},
			});
		},

		async playback(channelId, media) {
			// The id is chosen here, not read back from the response: PlaybackFinished
			// can arrive before this POST resolves, and the caller needs to be able to
			// match it either way.
			const playbackId = crypto.randomUUID();
			await requestJson<AsteriskPlayback>("POST", `${channelPath(channelId)}/play`, {
				query: { media, playbackId },
			});
			return playbackId;
		},

		async stopPlayback(playbackId) {
			await requestVoid("DELETE", `/playbacks/${encodeURIComponent(playbackId)}`, {
				tolerate404: true,
			});
		},

		async record(channelId, recordOptions) {
			// ifExists defaults to overwrite: a call id is unique per call, so the
			// only way the file already exists is a retry of the same call, and
			// failing the recording in that case would lose audio for no reason.
			await requestJson<{ name: string }>("POST", `${channelPath(channelId)}/record`, {
				query: {
					name: recordOptions.name,
					format: recordOptions.format ?? "wav",
					maxDurationSeconds: recordOptions.maxDurationSeconds,
					maxSilenceSeconds: recordOptions.maxSilenceSeconds,
					ifExists: recordOptions.ifExists ?? "overwrite",
					beep: recordOptions.beep,
				},
			});
			// Return the name we asked for rather than the response body's: the
			// recording is addressed by name in every later call, and ARI echoes
			// exactly what was sent.
			return recordOptions.name;
		},

		async stopRecording(recordingName) {
			// "stop" finalises the file and keeps it, unlike DELETE which discards.
			// 404 is tolerated because the recording ends on its own when the
			// channel hangs up, which is the common case.
			await requestVoid("POST", `/recordings/live/${encodeURIComponent(recordingName)}/stop`, {
				tolerate404: true,
			});
		},

		async startMoh(channelId) {
			await requestVoid("POST", `${channelPath(channelId)}/moh`);
		},

		async stopMoh(channelId) {
			await requestVoid("DELETE", `${channelPath(channelId)}/moh`, { tolerate404: true });
		},

		async originate(originateOptions: AriOriginateOptions) {
			const query: Record<string, QueryValue> = {
				endpoint: originateOptions.endpoint,
				callerId: originateOptions.callerId,
				timeout: originateOptions.timeout,
				// Omitted for every existing caller, so Asterisk keeps assigning the id.
				// A campaign dial supplies one so ChannelDestroyed can be attributed to a
				// dial whose HTTP response has not come back yet.
				channelId: originateOptions.channelId,
			};

			if (originateOptions.extension) {
				// Dialplan mode - used to ring an operator via [ai-transfer] or
				// [click-to-call].
				query.extension = originateOptions.extension;
				query.context = originateOptions.context;
				query.priority = originateOptions.priority;
			} else {
				// Stasis mode - the new channel lands back in our own application.
				query.app = appName;
				query.appArgs = originateOptions.appArgs ?? "";
			}

			return await requestJson<AsteriskChannel>("POST", "/channels", {
				query,
				body: originateOptions.variables ? { variables: originateOptions.variables } : undefined,
			});
		},

		async createBridge(bridgeOptions: AriCreateBridgeOptions = {}) {
			return await requestJson<AsteriskBridge>("POST", "/bridges", {
				query: {
					type: bridgeOptions.type ?? DEFAULT_BRIDGE_TYPE,
					bridgeId: bridgeOptions.bridgeId,
				},
			});
		},

		async addToBridge(bridgeId, channelIds) {
			if (channelIds.length === 0) {
				return;
			}
			await requestVoid("POST", `${bridgePath(bridgeId)}/addChannel`, {
				query: { channel: channelIds.join(",") },
			});
		},

		async removeFromBridge(bridgeId, channelIds) {
			if (channelIds.length === 0) {
				return;
			}
			await requestVoid("POST", `${bridgePath(bridgeId)}/removeChannel`, {
				query: { channel: channelIds.join(",") },
				tolerate404: true,
			});
		},

		async destroyBridge(bridgeId) {
			await requestVoid("DELETE", bridgePath(bridgeId), { tolerate404: true });
		},

		async listChannels() {
			return await requestJson<AsteriskChannel[]>("GET", "/channels");
		},

		async getChannel(channelId) {
			const response = await request("GET", channelPath(channelId), { tolerate404: true });
			if (!response) {
				return null;
			}
			return (await response.json()) as AsteriskChannel;
		},

		async info() {
			return await requestJson<Record<string, unknown>>("GET", "/asterisk/info");
		},
	};
}

let sharedClient: AriClient | null = null;

/**
 * Process-wide ARI client. ARI is stateless over HTTP, so one instance is
 * enough and it saves every module re-reading the environment.
 */
export function getAriClient(): AriClient {
	if (!sharedClient) {
		sharedClient = createAriClient();
	}
	return sharedClient;
}
