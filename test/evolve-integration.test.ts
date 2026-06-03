import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
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
		tools: new Map<string, any>(),
		registerTool(tool: any) {
			pi.tools.set(tool.name, tool);
		},
	};
	const fireAgentEnd = async (ctx: ExtensionCommandContext, messages: any[] = []) => {
		const list = handlers.get("__pi:agent_end") || [];
		for (const h of list) await (h as any)({ type: "agent_end", messages }, ctx);
	};
	const invokeCommand = async (name: string, args: string, ctx: ExtensionCommandContext) => {
		const handler = commands.get(name);
		if (!handler) throw new Error(`Command ${name} not registered`);
		await handler(args, ctx);
	};
	const fireBeforeAgentStart = async (ctx: ExtensionCommandContext): Promise<any> => {
		const list = handlers.get("__pi:before_agent_start") || [];
		let res: any;
		for (const h of list) res = await (h as any)({ type: "before_agent_start", prompt: "", systemPrompt: "" }, ctx);
		return res;
	};
	return { pi, fireAgentEnd, fireBeforeAgentStart, invokeCommand };
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

const LEDGER_HEAD = "# Evolve: test\n\n## Ledger\n\n| Branch | Parents | Score | Idea |\n|---|---|---|---|\n";
function addRow(cwd: string, n: number) {
	appendFileSync(join(cwd, "evolve.md"), `| dacmicu/evolve/v${n}/x | main | ${n} | idea |\n`);
}

const tmp = mkdtempSync(join(tmpdir(), "evolve-test-"));

// 1. No evolve.md
{
	const { pi, invokeCommand } = createMockPi();
	evolveFactory(pi);
	let notifyMsg = "";
	const ctx = { ...makeCtx(tmp), ui: { notify: (m: string) => (notifyMsg = m) } } as unknown as ExtensionCommandContext;
	await invokeCommand("evolve", "", ctx);
	assert.equal(pi.messages.length, 0);
	assert.match(notifyMsg, /No evolve\.md found/);
	console.log("✓ /evolve: missing evolve.md");
}

// 2. /evolve activates; loop advances only when a new Ledger row lands
{
	const sub = join(tmp, "activate");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), LEDGER_HEAD);
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(sub));
	assert.equal(pi.messages.length, 1, "kick message");
	assert.equal(pi.messages[0].customType, "evolve");
	// No new Ledger row yet -> agent_end must NOT re-iterate (async-safe gate).
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 1, "no reminder until a Ledger row lands");
	// A row lands -> next agent_end re-iterates.
	addRow(sub, 1);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "kick + iterate after row");
	assert.equal(pi.messages[1].customType, "evolve");
	assert.match((pi.messages[1].content[0] as { text: string }).text, /evolve\.md/, "reminder references evolve.md");
	console.log("✓ /evolve activates; advances only after a new Ledger row");
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
	const ctx = { ...makeCtx(tmp), ui: { notify: (m: string) => (notifyMsg = m) } } as unknown as ExtensionCommandContext;
	await invokeCommand("evolve", "stop", ctx);
	assert.match(notifyMsg, /not active/);
	console.log("✓ /evolve stop when inactive");
}

// 5. /evolve stop halts active loop
{
	const sub = join(tmp, "stop-mid");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), LEDGER_HEAD);
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(sub));
	addRow(sub, 1);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "kick + iterate");
	let notifyMsg = "";
	await invokeCommand("evolve", "stop", { ...makeCtx(sub), ui: { notify: (m: string) => (notifyMsg = m) } } as unknown as ExtensionCommandContext);
	assert.match(notifyMsg, /Evolve stopped/);
	addRow(sub, 2);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "no reminder after stop");
	console.log("✓ /evolve stop halts loop");
}

// 6. evolve tool is symmetric to /evolve (start + stop)
{
	const sub = join(tmp, "tool-symmetry");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), LEDGER_HEAD);
	const { pi, fireAgentEnd } = createMockPi();
	evolveFactory(pi);
	const tool = pi.tools.get("evolve");
	assert.ok(tool, "evolve tool registered");

	let notifyMsg = "";
	const ctx = { ...makeCtx(sub), ui: { notify: (m: string) => (notifyMsg = m) } };

	const startResult = await tool.execute("c1", { args: "speed up" }, undefined, undefined, ctx);
	assert.equal(startResult.details.action, "started");
	assert.equal(pi.messages.length, 1, "tool start fires kick message");
	addRow(sub, 1);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "kick + iterate");

	const stopResult = await tool.execute("c2", { args: "stop" }, undefined, undefined, ctx);
	assert.equal(stopResult.details.action, "stopped");
	addRow(sub, 2);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "no reminder after tool stop");
	console.log("✓ evolve tool: start + stop symmetric with /evolve");
}

// 7. Per-cwd isolation: active in A does not fire in B
{
	const subA = join(tmp, "cwd-a");
	const subB = join(tmp, "cwd-b");
	mkdirSync(subA);
	mkdirSync(subB);
	writeFileSync(join(subA, "evolve.md"), LEDGER_HEAD);
	writeFileSync(join(subB, "evolve.md"), LEDGER_HEAD);
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(subA));
	addRow(subA, 1);
	await fireAgentEnd(makeCtx(subA));
	addRow(subB, 1); // B not active -> must not fire even though its Ledger grew
	await fireAgentEnd(makeCtx(subB));
	assert.equal(pi.messages.length, 2, "only A's kick + A's reminder");
	console.log("✓ Per-cwd isolation: active in A does not fire in B");
}

// 8. Spawn in the just-ended turn suppresses the watchdog (the double-wake fix):
// the subagent's completion steer is the pacer, so a turn that already spawned
// must NOT also get a redundant reminder/turn.
{
	const sub = join(tmp, "spawn-suppress");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), LEDGER_HEAD);
	const { pi, fireAgentEnd, invokeCommand } = createMockPi();
	evolveFactory(pi);
	await invokeCommand("evolve", "", makeCtx(sub));
	assert.equal(pi.messages.length, 1, "kick");
	// Iteration completes (row lands) AND the orchestrator already spawned the
	// next one in that same turn -> watchdog stays silent.
	addRow(sub, 1);
	const spawnTurn = [{ role: "assistant", content: [{ type: "toolCall", name: "subagent", id: "t1", arguments: {} }] }];
	await fireAgentEnd(makeCtx(sub), spawnTurn);
	assert.equal(pi.messages.length, 1, "no redundant reminder when the turn already spawned");
	// A later row lands but the orchestrator stalls (no spawn) -> watchdog kicks,
	// proving the spawn-path ledger reconciliation didn't wedge the loop.
	addRow(sub, 2);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(pi.messages.length, 2, "watchdog kicks on a genuine stall");
	console.log("✓ Spawn-suppression: silent on happy path, kicks on stall");
}

// 9. before_agent_start injects the short reminder only while active.
{
	const sub = join(tmp, "reminder");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), LEDGER_HEAD);
	const { pi, fireBeforeAgentStart, invokeCommand } = createMockPi();
	evolveFactory(pi);
	assert.ok(!(await fireBeforeAgentStart(makeCtx(sub)))?.message, "no reminder when inactive");
	await invokeCommand("evolve", "", makeCtx(sub));
	const res = await fireBeforeAgentStart(makeCtx(sub));
	assert.ok(res?.message, "reminder injected when active");
	assert.equal(res.message.display, false, "reminder hidden from UI");
	assert.match((res.message.content[0] as { text: string }).text, /orchestrator/i, "reminder anchors the role");
	await invokeCommand("evolve", "stop", makeCtx(sub));
	assert.ok(!(await fireBeforeAgentStart(makeCtx(sub)))?.message, "no reminder after stop");
	console.log("✓ before_agent_start: reminder injected only while active");
}

rmSync(tmp, { recursive: true, force: true });
console.log("\n🎉 All evolve integration tests passed.");
