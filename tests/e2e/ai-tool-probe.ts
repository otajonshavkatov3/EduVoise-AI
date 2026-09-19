/**
 * Does the AI actually CALL the CRM tools?
 *
 * Uses the project's real TOOL_DEFINITIONS and a realistic Uzbek complaint,
 * driven by TEXT so no microphone is needed. A caller describing a pothole with
 * an address should make the model call save_contact_details and create_ticket.
 * If it never calls a tool, "the AI fills the CRM" is decoration.
 *
 * Run:  bun --env-file=.env run tests/e2e/ai-tool-probe.ts
 */
import { TOOL_DEFINITIONS } from "../../apps/backend/src/lib/ai/tools";

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";

if (!KEY) {
	console.log("OPENAI_API_KEY is not set - skipping");
	process.exit(0);
}

const tools = TOOL_DEFINITIONS as Array<{ name: string }>;
console.log(`tools declared: ${tools.length}`);
for (const t of tools) {
	console.log(`   - ${t.name}`);
}
console.log("");

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
	headers: { Authorization: `Bearer ${KEY}` },
} as unknown as string[]);

const toolCalls: Array<{ name: string; args: string }> = [];
let assistantText = "";
const errors: unknown[] = [];

await new Promise<void>((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("open timeout")), 15000);
	ws.onopen = () => {
		clearTimeout(t);
		resolve();
	};
	ws.onerror = () => {
		clearTimeout(t);
		reject(new Error("ws error"));
	};
});
console.log("connected\n");

const send = (o: unknown) => ws.send(JSON.stringify(o));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

ws.onmessage = (ev) => {
	let m: Record<string, unknown>;
	try {
		m = JSON.parse(String(ev.data));
	} catch {
		return;
	}
	if (m.type === "response.function_call_arguments.done") {
		toolCalls.push({ name: String(m.name ?? "?"), args: String(m.arguments ?? "") });
		console.log(`>>> TOOL CALL: ${m.name}  ${String(m.arguments).slice(0, 240)}`);
		// Reply exactly as the orchestrator does, so the model can continue.
		send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: m.call_id,
				output: JSON.stringify({ ok: true, id: "test-123" }),
			},
		});
		send({ type: "response.create" });
	} else if (m.type === "response.output_text.delta") {
		assistantText += String(m.delta ?? "");
	} else if (m.type === "response.output_audio_transcript.done") {
		assistantText += `${String(m.transcript ?? "")}\n`;
	} else if (m.type === "error") {
		errors.push(m.error);
		console.log(`--- error: ${JSON.stringify(m.error).slice(0, 300)}`);
	}
};

// Text modality: we are testing tool SELECTION, not speech synthesis.
send({
	type: "session.update",
	session: {
		type: "realtime",
		output_modalities: ["text"],
		instructions:
			"Siz 'Aqlli Shahar' ishonch telefoni operatori. Murojaatchi muammosini aytganda " +
			"MAJBURIY: save_contact_details bilan ism va manzilni saqlang, so'ng create_ticket bilan " +
			"murojaatni ro'yxatga oling. Kategoriyalar: Yo'l, Suv, Gaz, Elektr, Obodonlashtirish, Boshqa.",
		tools,
		tool_choice: "auto",
	},
});
await wait(2000);

send({
	type: "conversation.item.create",
	item: {
		type: "message",
		role: "user",
		content: [
			{
				type: "input_text",
				text:
					"Assalomu alaykum. Mening ismim Ali Karimov. Chilonzor tumani, Bunyodkor ko'chasi, " +
					"45-uy oldida yo'lda katta o'ra bor, mashinalar buzilyapti. Iltimos chora ko'ring.",
			},
		],
	},
});
send({ type: "response.create" });

await wait(25000);

console.log("\n================ RESULT ================");
console.log(`tool calls made: ${toolCalls.length}`);
for (const c of toolCalls) {
	console.log(`   ${c.name}: ${c.args.slice(0, 300)}`);
}
console.log(`\nassistant text:\n${assistantText.slice(0, 600) || "(none)"}`);
console.log(`\nerrors: ${errors.length ? JSON.stringify(errors).slice(0, 400) : "none"}`);

const names = toolCalls.map((c) => c.name);
const checks: Array<[string, boolean]> = [
	["model called at least one tool", names.length > 0],
	["create_ticket was called", names.includes("create_ticket")],
	["save_contact_details was called", names.includes("save_contact_details")],
	["no protocol errors (tool schemas accepted)", errors.length === 0],
];
console.log("\n--- checks ---");
for (const [label, ok] of checks) {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
}

try {
	ws.close();
} catch {
	// already closed
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
