import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import evolveFactory from "../packages/evolve/index.js";

function createMockPi() {
	const handlers = new Map<string, ((data: any) => void)[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const messages: any[] = [];
	const pi: any = {
		handlers, commands, messages,
		on(event: string, h: Function) {
			const ch = `__pi:${event}`;
			if (!handlers.has(ch)) handlers.set(ch, []);
			handlers.get(ch)!.push(h as (data: any) => void);
		},
		sendMessage(msg: any, options?: any) {
			messages.push({ ...msg, options });
			return Promise.resolve();
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options.handler);
		},
	};
	const fireAgentEnd = async (ctx: ExtensionCommandContext) => {
		const list = handlers.get("__pi:agent_end") || [];
		for (const h of list) await (h as any)({ type: "agent_end", messages: [] }, ctx);
	};
	const invokeCommand = async (name: string, args: string, ctx: ExtensionCommandContext) => {
		const handler = commands.get(name);
		if (!handler) throw new Error(`Command ${name} not registered`);
		await handler(args, ctx);
	};
	return { pi, fireAgentEnd, invokeCommand };
}

function makeCtx(cwd: string): ExtensionCommandContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "evolve-test", getBranch: () => [] },
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
	} as unknown as ExtensionCommandContext;
}

const tmp = mkdtempSync(join(tmpdir(), "evolve-test-"));

// 1. No evolve.md
{
	const { pi, invokeCommand } = createMockPi();
	evolveFactory(pi);
	let notifyMsg = "";
	const ctx = { ...makeCtx(tmp), ui: { notify: (m: string) => (notifyMsg = m) } } as ExtensionCommandContext;
	await invokeCommand("evolve", "", ctx);
	assert.equal(pi.messages.length, 0);
	assert.match(notifyMsg, /No evolve\.md found/);
	console.log("✓ /evolve: missing evolve.md");
}

// 2. /evolve activates, agent_end fires reminder
{
	const sub = join(tmp, "activate");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: test\n");
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(sub));
	assert.equal(pi.messages.length, 1, "kick message");
	assert.equal(pi.messages[0].customType, "evolve");
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "kick + iterate reminder");
	assert.equal(pi.messages[1].customType, "evolve");
	const reminderText = (pi.messages[1].content[0] as { text: string }).text;
	assert.match(reminderText, /evolve\.md/, "reminder references evolve.md");
	console.log("✓ /evolve activates, agent_end fires reminder");
}

// 3. Inactive: no reminder
{
	const sub = join(tmp, "inactive");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: test\n");
	const { pi, fireAgentEnd } = createMockPi();
	evolveFactory(pi);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 0);
	console.log("✓ Inactive: no reminder");
}

// 4. /evolve stop when inactive
{
	const { pi, invokeCommand } = createMockPi();
	evolveFactory(pi);
	let notifyMsg = "";
	const ctx = { ...makeCtx(tmp), ui: { notify: (m: string) => (notifyMsg = m) } } as ExtensionCommandContext;
	await invokeCommand("evolve", "stop", ctx);
	assert.match(notifyMsg, /not active/);
	console.log("✓ /evolve stop when inactive");
}

// 5. /evolve stop halts active loop
{
	const sub = join(tmp, "stop-mid");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: test\n");
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(sub));
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "kick + iterate");
	let notifyMsg = "";
	await invokeCommand("evolve", "stop", { ...makeCtx(sub), ui: { notify: (m: string) => (notifyMsg = m) } } as ExtensionCommandContext);
	assert.match(notifyMsg, /Evolve stopped/);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "no reminder after stop");
	console.log("✓ /evolve stop halts loop");
}

// 6. Per-cwd isolation: active in A does not fire in B
{
	const subA = join(tmp, "cwd-a");
	const subB = join(tmp, "cwd-b");
	mkdirSync(subA);
	mkdirSync(subB);
	writeFileSync(join(subA, "evolve.md"), "# A\n");
	writeFileSync(join(subB, "evolve.md"), "# B\n");
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(subA));
	await fireAgentEnd(makeCtx(subA));
	await fireAgentEnd(makeCtx(subB));
	assert.equal(pi.messages.length, 2, "only A's kick + A's reminder");
	console.log("✓ Per-cwd isolation: active in A does not fire in B");
}

rmSync(tmp, { recursive: true, force: true });
console.log("\n🎉 All evolve integration tests passed.");
