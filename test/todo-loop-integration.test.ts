import { strict as assert } from "node:assert";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import baseFactory from "../packages/base/index.js";
import todoFactory from "../packages/todo/index.js";
import { attachLoopDriver } from "../packages/base/index.js";
import { rmSync, existsSync } from "node:fs";

const STATE_DIR = "/tmp/test/.pi/dacmicu/state";
if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true });

function createMockPi(): ExtensionAPI & { events: Map<string, Function[]>; messages: any[] } {
	const events = new Map<string, Function[]>();
	const messages: any[] = [];
	const pi = {
		events,
		messages,
		on(event: string, handler: Function) {
			if (!events.has(event)) events.set(event, []);
			events.get(event)!.push(handler);
			return () => {
				const list = events.get(event);
				if (list) {
					const idx = list.indexOf(handler);
					if (idx >= 0) list.splice(idx, 1);
				}
			};
		},
		appendEntry(customType: string, data?: unknown) {
			messages.push({ type: "custom", customType, data });
		},
		sendMessage(msg: any, options?: any) {
			messages.push({ ...msg, options });
		},
		registerTool(tool: any) {},
		registerCommand(name: string, options: any) {
			(pi as any)[`_cmd_${name}`] = options.handler;
		},
	};
	return pi as any;
}

function createMockCtx(sessionId = "test-session"): ExtensionContext {
	return {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		hasPendingMessages: () => false,
		signal: undefined,
		ui: {
			notify: (msg: string, _type: string) => {
				console.log(`[notify] ${msg}`);
			},
		},
	} as unknown as ExtensionContext;
}

// Load test
{
	const pi = createMockPi();
	baseFactory(pi);
	assert.equal(pi.messages.length, 0);
	console.log("✓ Base extension loads without error");

	todoFactory(pi);
	const handlers = pi.events.get("agent_end") || [];
	assert.ok(handlers.length > 0, "agent_end handler registered by todo factory");
	console.log("✓ Todo extension loads, loop driver auto-attached");
}

// No todos → no fire
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctx = createMockCtx("test-session-a");
	const beforeCount = pi.messages.length;
	const agentEndHandlers = pi.events.get("agent_end") || [];
	assert.ok(agentEndHandlers.length > 0, "agent_end handlers registered");

	for (const h of agentEndHandlers) {
		await h({ type: "agent_end", messages: [] }, ctx);
	}

	assert.equal(pi.messages.length, beforeCount, "Loop does not fire when no todos exist");
	console.log("✓ Loop does not fire when no todos exist");
}

// Todos exist → fire followUp
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctxWithTodos = {
		...createMockCtx("test-session-b"),
		sessionManager: {
			getSessionId: () => "test-session-b",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
	} as unknown as ExtensionContext;

	const beforeCount = pi.messages.length;
	const agentEndHandlers = pi.events.get("agent_end") || [];
	for (const h of agentEndHandlers) {
		await h({ type: "agent_end", messages: [] }, ctxWithTodos);
	}

	assert.ok(pi.messages.length > beforeCount, "Loop fires followUp when todos exist");
	const lastMsg = pi.messages[pi.messages.length - 1];
	assert.equal(lastMsg.customType, "todo-iterate", "FollowUp is a unified iterate prompt");
	assert.equal(lastMsg.options.triggerTurn, true, "triggerTurn is true");
	console.log("✓ Loop fires followUp with triggerTurn:true when todos exist");
}

// Repeated iterations
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctxWithTodos = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => "test-session-c",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const handlers = pi.events.get("agent_end") || [];
	for (let i = 1; i <= 3; i++) {
		for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxWithTodos);
		const msg = pi.messages[pi.messages.length - 1];
		assert.equal(msg.customType, "todo-iterate", `Cycle ${i}: customType is todo-iterate`);
	}
	console.log("✓ Every iteration emits a unified todo-iterate prompt (no phase machinery)");
}

// All completed → exit
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctxAllDone = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => "test-session-d",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Done", description: "Done", status: "completed" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const beforeCount = pi.messages.length;
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxAllDone);
	assert.equal(pi.messages.length, beforeCount, "No followUp when every item is completed");
	console.log("✓ Loop exits when all items are completed");
}

// Bail: pending messages
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctxPending = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => "test-session-pending",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => true,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const beforeCount = pi.messages.length;
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxPending);
	assert.equal(pi.messages.length, beforeCount, "No followUp when user has pending messages");
	console.log("✓ Loop bails when user has pending messages");
}

// Bail: signal aborted
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctxAborted = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => "test-session-aborted",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => false,
		signal: { aborted: true },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const beforeCount = pi.messages.length;
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxAborted);
	assert.equal(pi.messages.length, beforeCount, "No followUp when signal is aborted");
	console.log("✓ Loop bails when signal is aborted");
}

// Bail: assistant stopReason aborted (fallback when signal is missing)
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctx = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => "test-session-stop-aborted",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const event = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		],
	};

	const beforeCount = pi.messages.length;
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h(event, ctx);
	assert.equal(pi.messages.length, beforeCount, "No followUp on the aborted turn itself");

	// Next non-aborted turn re-engages the loop (option 2: skip aborted turn only).
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctx);
	assert.equal(pi.messages.length, beforeCount + 1, "Loop resumes on next non-aborted turn");

	console.log("✓ Loop bails on aborted turn, resumes on next non-aborted turn");
}

// Error: iterate() throws → notify, no crash
{
	const pi = createMockPi();
	let notified = false;
	attachLoopDriver(pi, {
		iterate() {
			throw new Error("simulate iterate crash");
		},
	});

	const ctx = {
		cwd: "/tmp/test",
		sessionManager: { getSessionId: () => "test-session-err", getBranch: () => [] },
		hasPendingMessages: () => false,
		signal: undefined,
		ui: {
			notify: (msg: string, _type: string) => {
				notified = true;
				assert.ok(msg.includes("iterate failed"), "Error message mentions iterate failure");
			},
		},
	} as unknown as ExtensionContext;

	const beforeCount = pi.messages.length;
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctx);
	assert.equal(pi.messages.length, beforeCount, "No followUp when iterate throws");
	assert.ok(notified, "UI notification fired on iterate error");
	console.log("✓ Loop survives iterate() throwing and notifies UI");
}

// Error: sendMessage() rejects → notify, no crash
{
	const pi = createMockPi();
	let notified = false;
	const piWithFailingSend = {
		...pi,
		sendMessage() {
			throw new Error("simulate sendMessage crash");
		},
	};

	attachLoopDriver(piWithFailingSend, {
		iterate() {
			return {
				customType: "test",
				content: [{ type: "text", text: "hello" }],
			};
		},
	});

	const ctx = {
		cwd: "/tmp/test",
		sessionManager: { getSessionId: () => "test-session-send-err", getBranch: () => [] },
		hasPendingMessages: () => false,
		signal: undefined,
		ui: {
			notify: (msg: string, _type: string) => {
				notified = true;
				assert.ok(msg.includes("sendMessage failed"), "Error message mentions sendMessage failure");
			},
		},
	} as unknown as ExtensionContext;

	const handlers = piWithFailingSend.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctx);
	assert.ok(notified, "UI notification fired on sendMessage error");
	console.log("✓ Loop survives sendMessage() rejecting and notifies UI");
}

// Escape skips the aborted turn; loop resumes next turn
{
	const pi = createMockPi();
	todoFactory(pi);

	const sid = "test-session-pause";
	const ctxWithTodos = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => sid,
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const handlers = pi.events.get("agent_end") || [];

	// Normal → fires
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxWithTodos);
	assert.equal(pi.messages.length, 1, "Loop fires on first agent_end");

	// Aborted → bails on this turn only
	const ctxAborted = { ...ctxWithTodos, signal: { aborted: true } };
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxAborted);
	assert.equal(pi.messages.length, 1, "No followUp on aborted turn");

	// Next non-aborted turn → loop resumes (option 2)
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxWithTodos);
	assert.equal(pi.messages.length, 2, "Loop resumes on next non-aborted turn");

	console.log("✓ Escape skips the aborted turn; loop resumes next turn");
}

// Multiple consecutive aborts all skip; first non-aborted turn resumes
{
	const pi = createMockPi();
	todoFactory(pi);

	const sid = "test-session-multi-abort";
	const ctxWithTodos = {
		cwd: "/tmp/test",
		sessionManager: {
			getSessionId: () => sid,
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "manage_todo_list",
						details: {
							todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
						},
					},
				},
			],
		},
		hasPendingMessages: () => false,
		signal: { aborted: true },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const handlers = pi.events.get("agent_end") || [];

	// Three consecutive aborted agent_end events → no followUp
	for (let i = 0; i < 3; i++) {
		for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxWithTodos);
	}
	assert.equal(pi.messages.length, 0, "Loop bails on every aborted turn");

	// Next non-aborted turn → loop resumes
	const ctxNormal = { ...ctxWithTodos, signal: undefined };
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxNormal);
	assert.equal(pi.messages.length, 1, "Loop resumes after the abort streak");

	console.log("✓ Loop resumes after a streak of aborted turns");
}

// Async iterate
{
	const pi = createMockPi();
	let calls = 0;
	attachLoopDriver(pi, {
		async iterate() {
			calls++;
			return {
				customType: "async-test",
				content: [{ type: "text", text: "async" }],
			};
		},
	});

	const ctx = createMockCtx("test-session-async");
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctx);
	assert.equal(calls, 1, "Async iterate was called once");
	assert.equal(pi.messages.length, 1, "Loop fires with async iterate");
	assert.equal(pi.messages[0].customType, "async-test", "Async prompt dispatched");
	assert.equal(pi.messages[0].display, true, "display is true on followUp");
	console.log("✓ Async iterate works and display is true");
}

// Cross-session isolation: pause A does not pause B
{
	const pi = createMockPi();
	todoFactory(pi);

	const branch = () => [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "manage_todo_list",
				details: {
					todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
				},
			},
		},
	];

	const ctxA = {
		cwd: "/tmp/test",
		sessionManager: { getSessionId: () => "session-a", getBranch: branch },
		hasPendingMessages: () => false,
		signal: { aborted: true },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const ctxB = {
		cwd: "/tmp/test",
		sessionManager: { getSessionId: () => "session-b", getBranch: branch },
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const handlers = pi.events.get("agent_end") || [];

	// Abort session A
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxA);

	// Session B should still fire (per-turn evaluation, no shared pause state)
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxB);
	assert.equal(pi.messages.length, 1, "Session B fires while A's turn was aborted");

	console.log("✓ Cross-session isolation: abort in A does not affect B");
}

// Branch with other messages but no todo toolResult
{
	const pi = createMockPi();
	baseFactory(pi);
	todoFactory(pi);

	const ctxOtherMessages = {
		...createMockCtx("test-session-other"),
		sessionManager: {
			getSessionId: () => "test-session-other",
			getBranch: () => [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "hello" }] },
				},
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
				},
			],
		},
	} as unknown as ExtensionContext;

	const beforeCount = pi.messages.length;
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxOtherMessages);
	assert.equal(pi.messages.length, beforeCount, "No followUp when branch has no todo toolResult");
	console.log("✓ No fire when branch has other messages but no todo toolResult");
}

// Multiple drivers attached to same Pi
{
	const pi = createMockPi();
	let driverACalls = 0;
	let driverBCalls = 0;

	attachLoopDriver(pi, {
		iterate() {
			driverACalls++;
			return { customType: "driver-a", content: [{ type: "text", text: "a" }] };
		},
	});

	attachLoopDriver(pi, {
		iterate() {
			driverBCalls++;
			return { customType: "driver-b", content: [{ type: "text", text: "b" }] };
		},
	});

	const ctx = createMockCtx("test-session-multi");
	const handlers = pi.events.get("agent_end") || [];
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctx);

	assert.equal(driverACalls, 1, "Driver A was called");
	assert.equal(driverBCalls, 1, "Driver B was called");
	assert.equal(pi.messages.length, 2, "Both drivers dispatched a followUp");

	console.log("✓ Multiple drivers attached to same Pi fire independently");
}

// Pause cleared by user message, then loop resumes
{
	const pi = createMockPi();
	todoFactory(pi);

	const sid = "test-session-resume";
	const branch = () => [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "manage_todo_list",
				details: {
					todos: [{ id: 1, title: "Test", description: "Desc", status: "not-started" }],
				},
			},
		},
	];

	const ctxNormal = {
		cwd: "/tmp/test",
		sessionManager: { getSessionId: () => sid, getBranch: branch },
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	const ctxAborted = {
		...ctxNormal,
		signal: { aborted: true },
	};

	const ctxPending = {
		...ctxNormal,
		hasPendingMessages: () => true,
	};

	const handlers = pi.events.get("agent_end") || [];

	// Abort → pause
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxAborted);
	assert.equal(pi.messages.length, 0, "Loop bails on abort");

	// Pending messages → pause cleared, but bails for this turn
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxPending);
	assert.equal(pi.messages.length, 0, "Loop bails on pending messages");

	// Next normal turn → loop resumes
	for (const h of handlers) await h({ type: "agent_end", messages: [] }, ctxNormal);
	assert.equal(pi.messages.length, 1, "Loop resumes after user message clears pause");

	console.log("✓ Pause cleared by user message, then loop resumes");
}

console.log("\n🎉 All integration tests passed. Loop driver verified.");
