import { createRouter } from "../lib";
import aiAgent from "./ai-agent";
import aiAnalyses from "./ai-analyses";
import aiAssistant from "./ai-assistant";
import aiCosts from "./ai-costs";
import asterisk from "./asterisk";
import auditLogs from "./audit-logs";
import auth from "./auth";
import bookings from "./bookings";
import calls from "./calls";
import campaigns from "./campaigns";
import contacts from "./contacts";
import dashboard from "./dashboard";
import followUps from "./follow-ups";
import health from "./health";
import knowledgeBase from "./knowledge-base";
import liveCalls from "./live-calls";
import operatorProfiles from "./operator-profiles";
import reports from "./reports";
import settings from "./settings";
import tickets from "./tickets";
import transcripts from "./transcripts";
import uploads from "./uploads";
import users from "./users";
import vendor from "./vendor";
import webhooks from "./webhooks";
import ws from "./ws";

const router = createRouter()
	// --- Pre-existing groups. Order and paths unchanged: every one of these
	// --- was verified returning 200 before the AI voice layer was added, and
	// --- /webhooks still carries the legacy FreePBX endpoints for backward
	// --- compatibility even though Asterisk has replaced FreePBX.
	.route("/", health)
	.route("/auth", auth)
	.route("/audit-logs", auditLogs)
	.route("/calls", calls)
	.route("/contacts", contacts)
	.route("/operator-profiles", operatorProfiles)
	.route("/tickets", tickets)
	.route("/dashboard", dashboard)
	.route("/users", users)
	.route("/webhooks", webhooks)
	.route("/ws", ws)
	.route("/uploads", uploads)
	// --- AI voice layer. Additive: new paths only, no existing path reused.
	.route("/asterisk", asterisk)
	.route("/live-calls", liveCalls)
	.route("/ai-assistant", aiAssistant)
	.route("/transcripts", transcripts)
	.route("/follow-ups", followUps)
	.route("/bookings", bookings)
	// --- MVP completion: real reports, persisted settings, AI analysis review.
	.route("/reports", reports)
	.route("/settings", settings)
	.route("/ai-analyses", aiAnalyses)
	// --- Business-configurable agent: who the AI is, and what it may tell callers.
	.route("/ai-agent", aiAgent)
	.route("/knowledge-base", knowledgeBase)
	// --- What the AI costs. Priced on read from the editable rate table.
	.route("/ai-costs", aiCosts)
	// --- Outbound campaigns: a list of people, a reason for the call, and the AI
	// --- doing the calling. Additive: new paths only, and the inbound call path is
	// --- untouched. The do-not-call list lives here because it is the one guardrail
	// --- every outbound dial passes through.
	.route("/campaigns", campaigns)
	// --- The vendor console. Platform-level, above every tenant: the only routes a
	// --- customer's own supervisor can never reach. Everything a vendor does INSIDE a
	// --- customer's account goes through the ordinary routes above, with an
	// --- impersonation token - see routes/vendor/vendor.handlers.ts.
	.route("/vendor", vendor);

export default router;
