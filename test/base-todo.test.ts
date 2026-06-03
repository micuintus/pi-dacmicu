import { strict as assert } from "node:assert";
import baseFactory from "../packages/base/index.js";
import { attachLoopDriver } from "../packages/base/index.js";

assert.equal(typeof attachLoopDriver, "function");
console.log("✓ attachLoopDriver exported");

const mockPi = {
	on: () => {},
	registerCommand: () => {},
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

baseFactory(mockPi);
console.log("✓ Base extension factory loads without error");

// attachLoopDriver forwards the agent_end event (incl. its per-run messages) to
// iterate — the contract the evolve watchdog's spawn-detection relies on.
{
	const agentEndHandlers: ((event: any, ctx: any) => unknown)[] = [];
	const pi = {
		on: (ev: string, h: (event: any, ctx: any) => unknown) => { if (ev === "agent_end") agentEndHandlers.push(h); },
		sendMessage: () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	let seen: any = null;
	attachLoopDriver(pi, { iterate: (_ctx, event) => { seen = event; return null; } });
	const ctx = { hasPendingMessages: () => false, signal: undefined, ui: { notify: () => {} } } as any;
	const event = { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "toolCall", name: "x", id: "1", arguments: {} }] }] };
	await agentEndHandlers[0](event, ctx);
	assert.equal(seen, event, "iterate receives the agent_end event");
	assert.equal(seen.messages.length, 1, "event.messages is forwarded intact");
	console.log("✓ attachLoopDriver forwards event+messages to iterate");
}

console.log("\n🎉 Base minimal tests passed.");
