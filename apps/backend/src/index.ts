import { websocket } from "hono/bun";
import pino from "pino";
import pretty from "pino-pretty";
import { configureOpenAPI, createApp } from "./lib";
import { syncAsteriskTenantConfig } from "./lib/asterisk";
import { releaseInFlightClaims, startCampaignDialer, stopCampaignDialer } from "./lib/campaigns";
import {
	startNotificationMonitor,
	stopNotificationMonitor,
} from "./lib/integrations/notifications";
import { getCallOrchestrator } from "./lib/telephony";
import routes from "./routes";

const app = createApp();

app.route("/api", routes);

configureOpenAPI(app);

// ===========================================
// AI voice layer bootstrap
// ===========================================

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{ level: isProduction ? "info" : "debug" },
	isProduction ? undefined : pretty({ colorize: true })
).child({ module: "bootstrap" });

/**
 * Brings up the Asterisk event stream and the AudioSocket listener.
 *
 * Deliberately isolated from the HTTP server: this CRM was in production
 * serving 28 routes before telephony existed, and a missing or unreachable
 * Asterisk must degrade to CRM-only mode rather than take the API down. Every
 * failure path here logs and returns.
 */
async function startVoicePlatform(): Promise<void> {
	// An empty ARI password is how a host says "no telephony configured here"
	// (see shared/env.ts, where every Asterisk field defaults rather than being
	// required). Starting anyway would just log reconnect attempts forever.
	if (!process.env.ASTERISK_ARI_PASSWORD) {
		logger.warn("ASTERISK_ARI_PASSWORD is not set - AI voice layer disabled, CRM API only");
		return;
	}

	// WHOSE PHONES IS ASTERISK CONFIGURED WITH - answered before the first call.
	//
	// Every customer's endpoints, trunks and dialplan contexts are generated from
	// the tenants table and reloaded over AMI (lib/asterisk/tenant-config.ts). This
	// runs FIRST because until it has succeeded the backend deliberately keeps using
	// the pre-tenancy context names: naming a context Asterisk does not have would
	// drop the call rather than misroute it, but dropping calls is still an outage.
	// It never throws - a failure leaves the platform on the legacy contexts, which
	// is exactly how it behaved before tenancy.
	const asterisk = await syncAsteriskTenantConfig();

	logger.info(
		asterisk,
		asterisk.reloaded
			? "per-tenant Asterisk config generated and reloaded"
			: "per-tenant Asterisk config NOT live - calls will use the pre-tenancy contexts"
	);

	try {
		const orchestrator = getCallOrchestrator();
		await orchestrator.start();
		logger.info("AI voice layer started (ARI events + AudioSocket listening)");
	} catch (err) {
		logger.error(
			{ err },
			"AI voice layer failed to start - continuing in CRM-only mode. Calls will not be answered by the AI."
		);
	}
}

/**
 * Starts the outbound campaign dialer.
 *
 * After the voice platform and only when it is configured: a dialer with nothing
 * to originate through would claim leads, be refused, and put them back for
 * ever. It is started even if the orchestrator failed to come up, because the
 * loop checks `isRunning` on every tick and simply waits - a telephony outage
 * pauses the calling instead of needing a restart to resume it.
 *
 * startCampaignDialer also registers the do-not-call hooks the telephony layer
 * needs, so this call is what makes "don't call me again" enforceable at all.
 */
function startCampaignRunner(): void {
	if (!process.env.ASTERISK_ARI_PASSWORD) {
		logger.warn("ASTERISK_ARI_PASSWORD is not set - outbound campaign dialer disabled");
		return;
	}

	try {
		startCampaignDialer();
	} catch (err) {
		logger.error({ err }, "campaign dialer failed to start - campaigns will not place calls");
	}
}

/**
 * Hand back every lead this process had claimed before it goes away.
 *
 * Without this a planned restart costs the owner ten minutes per in-flight lead,
 * because the reclaim sweep deliberately waits that long before touching a claim
 * it cannot prove is dead. Here we can prove it: we are the process that made it.
 */
async function stopCampaignRunner(): Promise<void> {
	stopCampaignDialer();

	try {
		await releaseInFlightClaims();
	} catch (err) {
		logger.error({ err }, "could not requeue in-flight campaign leads on shutdown");
	}
}

/**
 * Starts the alert watchdog behind the Settings page's "Bildirishnomalar" tab.
 *
 * It was written, tested and then never wired up, so ten settings fields
 * configured alerts that nothing could ever send. Starting it here is what makes
 * that tab honest. Nothing is delivered until an operator turns
 * `notifications.enabled` on AND fills in a channel - the default is off, and
 * every channel reports itself unconfigured rather than throwing.
 *
 * Isolated like the voice platform: a monitor that cannot start must not take
 * the API down with it.
 */
async function startAlertMonitor(): Promise<void> {
	try {
		await startNotificationMonitor();
	} catch (err) {
		logger.error({ err }, "notification monitor failed to start - alerts will not be sent");
	}
}

async function stopVoicePlatform(signal: string): Promise<void> {
	logger.info({ signal }, "shutting down AI voice layer");
	try {
		await getCallOrchestrator().stop();
	} catch (err) {
		logger.error({ err }, "error while stopping the AI voice layer");
	}
}

/**
 * `bun --hot` keeps the process alive and re-evaluates changed modules, so a
 * bare call here would try to bind the AudioSocket port a second time and fail
 * with EADDRINUSE on every save. A key on globalThis survives module
 * re-evaluation, which module-level state does not.
 */
const BOOTSTRAP_KEY = Symbol.for("callcenter.voicePlatformBootstrapped");
const globalState = globalThis as unknown as Record<symbol, boolean | undefined>;

if (!globalState[BOOTSTRAP_KEY]) {
	globalState[BOOTSTRAP_KEY] = true;

	// Ataylab kutilmaydi (fire-and-forget): startVoicePlatform o'z xatolarini
	// ichida qayd etadi va server ishga tushishini bloklamasligi kerak.
	startVoicePlatform();
	startAlertMonitor();
	startCampaignRunner();

	let shuttingDown = false;
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			if (shuttingDown) {
				return;
			}
			shuttingDown = true;
			stopNotificationMonitor();
			// Ataylab kutilmaydi: process.exit finally ichida chaqiriladi. Dialer
			// birinchi to'xtaydi — yangi qo'ng'iroq boshlanmasligi kerak, undan keyin
			// ovoz qatlami jonli qo'ng'iroqlarni yopadi.
			stopCampaignRunner()
				.then(() => stopVoicePlatform(signal))
				.finally(() => process.exit(0));
		});
	}
}

/** Bun: fetch + websocket (Hono Bun adapter) — server upgrade uchun env ga beramiz */
export default {
	fetch: (req: Request, server: unknown) => app.fetch(req, server),
	websocket,
};
