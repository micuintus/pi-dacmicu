import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import baseFactory from "../packages/base/index.js";
import evolveFactory from "../packages/evolve/index.js";

type Handler = (data: any) => void;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const messages: any[] = [];
	const pi: any = {
		events: {
			on(ch: string, h: Handler) {
				if (!handlers.has(ch)) handlers.set(ch, []);
				handlers.get(ch)!.push(h);
				return () => {
					const list = handlers.get(ch);
					if (!list) return;
					const i = list.indexOf(h);
					if (i >= 0) list.splice(i, 1);
				};
			},
			emit(ch: string, data: any) {
				const list = handlers.get(ch);
				if (!list) return;
				for (const h of [...list]) h(data);
			},
		},
		messages,
		on(event: string, handler: Function) {
			const ch = `__pi:${event}`;
			if (!handlers.has(ch)) handlers.set(ch, []);
			handlers.get(ch)!.push(handler as Handler);
		},
		sendMessage(msg: any, options?: any) {
			messages.push({ ...msg, options });
		},
		appendEntry() {},
		registerTool() {},
		registerCommand() {},
	};
	const fireAgentEnd = async (ctx: ExtensionContext) => {
		const list = handlers.get("__pi:agent_end") || [];
		for (const h of list) await (h as any)({ type: "agent_end", messages: [] }, ctx);
	};
	return { pi, fireAgentEnd };
}

function attachFakeProvider(pi: any) {
	let spawnCount = 0;
	pi.events.on("subagents:rpc:ping", (data: any) => {
		pi.events.emit(`subagents:rpc:ping:reply:${data.requestId}`, {
			success: true,
			data: { version: 2 },
		});
	});
	pi.events.on("subagents:rpc:spawn", (data: any) => {
		const id = `agent-${spawnCount}`;
		pi.events.emit(`subagents:rpc:spawn:reply:${data.requestId}`, {
			success: true,
			data: { id },
		});
		setImmediate(() => {
			pi.events.emit("subagents:completed", { id });
		});
		spawnCount++;
	});
	return {
		get spawnCount() {
			return spawnCount;
		},
	};
}

function makeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "evolve-test", getBranch: () => [] },
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

const tmp = mkdtempSync(join(tmpdir(), "evolve-test-"));

// 1. No evolve.md → no fire, no spawn
{
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	const fake = attachFakeProvider(pi);
	await fireAgentEnd(makeCtx(tmp));
	assert.equal(fake.spawnCount, 0, "no spawn when evolve.md missing");
	assert.equal(pi.messages.length, 0, "no follow-up when evolve.md missing");
	console.log("✓ Absent evolve.md: loop does not fire, no spawn");
}

// 2. evolve.md present → spawn, follow-up fires
{
	const sub = join(tmp, "present");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	const fake = attachFakeProvider(pi);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(fake.spawnCount, 1, "subagent spawned");
	assert.equal(pi.messages.length, 1, "follow-up dispatched");
	assert.equal(pi.messages[0].customType, "evolve-iterate");
	assert.equal(pi.messages[0].options.triggerTurn, true);
	console.log("✓ Present evolve.md: spawn + follow-up");
}

// 3. continue.sh exits nonzero → loop stops
{
	const sub = join(tmp, "continue-stop");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	writeFileSync(join(sub, "continue.sh"), "#!/bin/bash\nexit 1\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	const fake = attachFakeProvider(pi);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(fake.spawnCount, 1, "one spawn");
	assert.equal(pi.messages.length, 0, "no follow-up when continue.sh exits nonzero");
	console.log("✓ continue.sh exits nonzero: loop stops");
}

// 4. continue.sh exits 0 → loop continues
{
	const sub = join(tmp, "continue-ok");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	writeFileSync(join(sub, "continue.sh"), "#!/bin/bash\nexit 0\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	const fake = attachFakeProvider(pi);
	await fireAgentEnd(makeCtx(sub));
	assert.equal(fake.spawnCount, 1, "one spawn");
	assert.equal(pi.messages.length, 1, "follow-up dispatched when continue.sh exits 0");
	console.log("✓ continue.sh exits 0: loop continues");
}

// 5. Multiple iterations: spawn each turn while file present
{
	const sub = join(tmp, "multi");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	const fake = attachFakeProvider(pi);

	for (let i = 0; i < 3; i++) await fireAgentEnd(makeCtx(sub));
	assert.equal(fake.spawnCount, 3, "three spawns over three agent_end events");
	assert.equal(pi.messages.length, 3, "three follow-ups");
	console.log("✓ Multiple iterations: driver re-spawns each turn while file present");
}

// 6. Provider missing → notify and return null
{
	const sub = join(tmp, "no-provider");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	let notifyMsg = "";
	const ctx = {
		...makeCtx(sub),
		ui: { notify: (m: string) => (notifyMsg = m) },
	} as ExtensionContext;
	await fireAgentEnd(ctx);
	assert.match(notifyMsg, /requires tintinweb\/pi-subagents/, "notifies on missing provider");
	assert.equal(pi.messages.length, 0, "no follow-up when provider missing");
	console.log("✓ Provider-not-installed: ping times out, user notified, loop pauses");
}

// 7. Spawn RPC fails → notify, no follow-up
{
	const sub = join(tmp, "spawn-fail");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	pi.events.on("subagents:rpc:ping", (data: any) => {
		pi.events.emit(`subagents:rpc:ping:reply:${data.requestId}`, {
			success: true,
			data: { version: 2 },
		});
	});
	pi.events.on("subagents:rpc:spawn", (data: any) => {
		pi.events.emit(`subagents:rpc:spawn:reply:${data.requestId}`, {
			success: false,
			error: "no agent type",
		});
	});
	let notifyMsg = "";
	const ctx = {
		...makeCtx(sub),
		ui: { notify: (m: string) => (notifyMsg = m) },
	} as ExtensionContext;
	await fireAgentEnd(ctx);
	assert.match(notifyMsg, /spawn failed/, "notifies on spawn failure");
	assert.equal(pi.messages.length, 0, "no follow-up on spawn failure");
	console.log("✓ Spawn RPC failure: user notified, loop pauses");
}

// 8. Subagent fails → notify but follow-up still fires (next iteration can retry)
{
	const sub = join(tmp, "subagent-fail");
	mkdirSync(sub);
	writeFileSync(join(sub, "evolve.md"), "# Evolve: t\n");
	const { pi, fireAgentEnd } = createMockPi();
	baseFactory(pi);
	evolveFactory(pi);
	pi.events.on("subagents:rpc:ping", (data: any) => {
		pi.events.emit(`subagents:rpc:ping:reply:${data.requestId}`, {
			success: true,
			data: { version: 2 },
		});
	});
	let spawnCount = 0;
	pi.events.on("subagents:rpc:spawn", (data: any) => {
		const id = `agent-${spawnCount}`;
		pi.events.emit(`subagents:rpc:spawn:reply:${data.requestId}`, {
			success: true,
			data: { id },
		});
		setImmediate(() => pi.events.emit("subagents:failed", { id, error: "boom" }));
		spawnCount++;
	});
	let notifyMsg = "";
	const ctx = {
		...makeCtx(sub),
		ui: { notify: (m: string) => (notifyMsg = m) },
	} as ExtensionContext;
	await fireAgentEnd(ctx);
	assert.match(notifyMsg, /iteration failed/, "notifies on subagent failure");
	assert.equal(pi.messages.length, 1, "follow-up still fires so loop can retry");
	console.log("✓ Subagent failure: user notified, loop continues to retry");
}

// Cleanup
rmSync(tmp, { recursive: true, force: true });

console.log("\n🎉 All evolve integration tests passed.");
