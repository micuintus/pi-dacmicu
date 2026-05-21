import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDeferred, rpcCall, waitForCompletion } from "./tintinweb-subagent.js";

const SOCKET_PATH = `/tmp/pi-callback-${process.pid}.sock`;
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "bin");
const PING_TIMEOUT_MS = 5000;
const SPAWN_TIMEOUT_MS = 5000;

type Reply = { ok: true; text: string } | { ok: false; error: string };

export default function (pi: ExtensionAPI) {
	try { unlinkSync(SOCKET_PATH); } catch { /* stale or absent */ }

	const server: Server = createServer((socket) => handleConnection(pi, socket, sockets));
	server.listen(SOCKET_PATH);

const sockets = new Set<Socket>();

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash") return;
		// NOTE: mutates event.input in place. Pi passes tool_call events by
		// reference; cloning would break the downstream executor's view.
		const input = (event as { input: { command: string } }).input;
		if (input.command.startsWith('export PI_CALLBACK_SOCKET="')) return;
		input.command =
			`export PI_CALLBACK_SOCKET="${SOCKET_PATH}"; export PATH="${BIN_DIR}:$PATH"; ${input.command}`;
	});

	pi.on("session_shutdown", () => {
		for (const s of sockets) s.destroy();
		sockets.clear();
		server.close();
		try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
	});
}

/** One request per connection. Second lines are ignored. */
function handleConnection(pi: ExtensionAPI, socket: Socket, sockets: Set<Socket>) {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
	let buf = "";
	const onData = (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		const nl = buf.indexOf("\n");
		if (nl < 0) return;
		const line = buf.slice(0, nl);
		socket.off("data", onData);
		void processRequest(pi, line, socket);
	};
	socket.on("data", onData);
	socket.on("error", () => socket.destroy());
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

	const ping = await rpcCall(pi.events, "subagents:rpc:ping", {}, PING_TIMEOUT_MS);
	if (!ping.success) {
		return reply({ ok: false, error: "tintinweb/pi-subagents not installed or not responding" });
	}

	const agentIdDeferred = makeDeferred<string | null>();
	const completion = waitForCompletion(pi.events, agentIdDeferred.promise);

	const spawn = await rpcCall(pi.events, "subagents:rpc:spawn", {
		type: "general-purpose",
		prompt: req.prompt,
		options: { description: "pi-callback", isBackground: false, inheritContext: false },
	}, SPAWN_TIMEOUT_MS);
	if (!spawn.success) {
		agentIdDeferred.resolve(null);
		completion.cancel();
		return reply({ ok: false, error: `spawn failed: ${spawn.error ?? "unknown"}` });
	}
	const agentId = (spawn.data as { id?: string })?.id;
	if (!agentId) {
		agentIdDeferred.resolve(null);
		completion.cancel();
		return reply({ ok: false, error: "spawn returned no agent id" });
	}
	agentIdDeferred.resolve(agentId);

	const done = await completion.promise;
	if (done.ok) {
		const text = typeof done.data.result === "string" ? done.data.result : "";
		reply({ ok: true, text });
	} else {
		const error = typeof done.data.error === "string" ? done.data.error : "subagent failed";
		reply({ ok: false, error });
	}
}
