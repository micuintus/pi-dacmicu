import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SOCKET_PATH = `/tmp/pi-callback-${process.pid}.sock`;
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "bin");
const PING_TIMEOUT_MS = 5000;
const SPAWN_TIMEOUT_MS = 5000;

type Reply = { ok: true; text: string } | { ok: false; error: string };

export default function (pi: ExtensionAPI) {
	try { unlinkSync(SOCKET_PATH); } catch { /* stale or absent */ }

	const server: Server = createServer((socket) => handleConnection(pi, socket));
	server.listen(SOCKET_PATH);

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash") return;
		const cmd = (event as { input: { command: string } }).input.command;
		if (cmd.startsWith('export PI_CALLBACK_SOCKET="')) return;
		(event as { input: { command: string } }).input.command =
			`export PI_CALLBACK_SOCKET="${SOCKET_PATH}"; export PATH="${BIN_DIR}:$PATH"; ${cmd}`;
	});

	pi.on("session_shutdown", () => {
		server.close();
		try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
	});
}

function handleConnection(pi: ExtensionAPI, socket: Socket) {
	let buf = "";
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		const nl = buf.indexOf("\n");
		if (nl < 0) return;
		const line = buf.slice(0, nl);
		buf = "";
		void processRequest(pi, line, socket);
	});
	socket.on("error", () => { /* client disconnect; nothing to do */ });
}

async function processRequest(pi: ExtensionAPI, line: string, socket: Socket) {
	const reply = (r: Reply) => {
		try { socket.end(JSON.stringify(r) + "\n"); } catch { /* socket gone */ }
	};

	let req: { prompt?: unknown };
	try { req = JSON.parse(line); }
	catch { return reply({ ok: false, error: "invalid JSON" }); }
	if (typeof req.prompt !== "string" || !req.prompt.trim()) {
		return reply({ ok: false, error: "missing or empty 'prompt'" });
	}

	const ping = await rpc(pi, "subagents:rpc:ping", {}, PING_TIMEOUT_MS);
	if (!ping.success) {
		return reply({ ok: false, error: "tintinweb/pi-subagents not installed or not responding" });
	}

	const agentIdPromise = makeDeferred<string>();
	const completion = waitForCompletion(pi, agentIdPromise.promise);

	const spawn = await rpc(pi, "subagents:rpc:spawn", {
		type: "general-purpose",
		prompt: req.prompt,
		options: { description: "pi-callback", isBackground: true, inheritContext: false },
	}, SPAWN_TIMEOUT_MS);
	if (!spawn.success) {
		agentIdPromise.resolve("");
		completion.cancel();
		return reply({ ok: false, error: `spawn failed: ${spawn.error ?? "unknown"}` });
	}
	const agentId = (spawn.data as { id?: string })?.id;
	if (!agentId) {
		agentIdPromise.resolve("");
		completion.cancel();
		return reply({ ok: false, error: "spawn returned no agent id" });
	}
	agentIdPromise.resolve(agentId);

	const done = await completion.promise;
	if (done.ok) reply({ ok: true, text: done.text });
	else reply({ ok: false, error: done.error });
}

function rpc(
	pi: ExtensionAPI,
	channel: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
	const requestId = randomUUID();
	const replyChannel = `${channel}:reply:${requestId}`;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsub();
			resolve({ success: false, error: `RPC timeout on ${channel}` });
		}, timeoutMs);
		const unsub = pi.events.on(replyChannel, (r: unknown) => {
			clearTimeout(timer);
			unsub();
			resolve(r as { success: boolean; data?: unknown; error?: string });
		});
		pi.events.emit(channel, { requestId, ...payload });
	});
}

interface CompletionWait {
	promise: Promise<{ ok: true; text: string } | { ok: false; error: string }>;
	cancel: () => void;
}

function waitForCompletion(pi: ExtensionAPI, agentIdPromise: Promise<string>): CompletionWait {
	let pending: Array<{ kind: "ok" | "fail"; data: any }> = [];
	let resolveOuter!: (r: { ok: true; text: string } | { ok: false; error: string }) => void;
	const promise = new Promise<{ ok: true; text: string } | { ok: false; error: string }>((res) => {
		resolveOuter = res;
	});

	const tryResolve = (id: string) => {
		for (const e of pending) {
			if (e.data?.id !== id) continue;
			cleanup();
			if (e.kind === "ok") resolveOuter({ ok: true, text: typeof e.data?.result === "string" ? e.data.result : "" });
			else resolveOuter({ ok: false, error: typeof e.data?.error === "string" ? e.data.error : "subagent failed" });
			return true;
		}
		return false;
	};

	const onOk = pi.events.on("subagents:completed", (d: any) => {
		pending.push({ kind: "ok", data: d });
		agentIdPromise.then((id) => { if (id) tryResolve(id); });
	});
	const onFail = pi.events.on("subagents:failed", (d: any) => {
		pending.push({ kind: "fail", data: d });
		agentIdPromise.then((id) => { if (id) tryResolve(id); });
	});

	agentIdPromise.then((id) => { if (id) tryResolve(id); });

	const cleanup = () => { onOk(); onFail(); pending = []; };
	return { promise, cancel: () => { cleanup(); resolveOuter({ ok: false, error: "cancelled" }); } };
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
