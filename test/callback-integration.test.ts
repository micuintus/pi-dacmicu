import { strict as assert } from "node:assert";
import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import callbackFactory from "../packages/callback/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "packages", "callback", "bin", "pi-callback");

type Handler = (data: any) => void;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const piHandlers = new Map<string, Function[]>();
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
		on(event: string, handler: Function) {
			if (!piHandlers.has(event)) piHandlers.set(event, []);
			piHandlers.get(event)!.push(handler);
		},
	};
	const fireToolCall = (event: any) => {
		const list = piHandlers.get("tool_call") || [];
		for (const h of list) h(event);
	};
	const shutdown = () => {
		const list = piHandlers.get("session_shutdown") || [];
		for (const h of list) h();
	};
	return { pi, fireToolCall, shutdown };
}

function attachFakeProvider(pi: any, behaviour: "ok" | "fail-spawn" | "fail-agent" | "no-ping" | "no-id", text = "STOP") {
	if (behaviour !== "no-ping") {
		pi.events.on("subagents:rpc:ping", (d: any) => {
			pi.events.emit(`subagents:rpc:ping:reply:${d.requestId}`, { success: true, data: { version: 2 } });
		});
	}
	pi.events.on("subagents:rpc:spawn", (d: any) => {
		if (behaviour === "fail-spawn") {
			pi.events.emit(`subagents:rpc:spawn:reply:${d.requestId}`, { success: false, error: "no agent type" });
			return;
		}
		if (behaviour === "no-id") {
			pi.events.emit(`subagents:rpc:spawn:reply:${d.requestId}`, { success: true, data: {} });
			return;
		}
		const id = `agent-${Math.random().toString(36).slice(2, 8)}`;
		pi.events.emit(`subagents:rpc:spawn:reply:${d.requestId}`, { success: true, data: { id } });
		setImmediate(() => {
			if (behaviour === "fail-agent") {
				pi.events.emit("subagents:failed", { id, error: "subagent boom" });
			} else {
				pi.events.emit("subagents:completed", { id, result: text });
			}
		});
	});
}

function sendRequest(prompt: unknown): Promise<{ ok: boolean; text?: string; error?: string }> {
	return new Promise((resolve, reject) => {
		const client = connect(`/tmp/pi-callback-${process.pid}.sock`);
		let buf = "";
		const timer = setTimeout(() => { client.destroy(); reject(new Error("timeout")); }, 10000);
		client.on("connect", () => client.write(JSON.stringify({ prompt }) + "\n"));
		client.on("data", (chunk) => { buf += chunk.toString("utf8"); });
		client.on("end", () => {
			clearTimeout(timer);
			try { resolve(JSON.parse(buf.split("\n")[0])); }
			catch (e) { reject(e); }
		});
		client.on("error", (e) => { clearTimeout(timer); reject(e); });
	});
}

function sendRaw(line: string): Promise<{ ok: boolean; text?: string; error?: string }> {
	return new Promise((resolve, reject) => {
		const client = connect(`/tmp/pi-callback-${process.pid}.sock`);
		let buf = "";
		const timer = setTimeout(() => { client.destroy(); reject(new Error("timeout")); }, 10000);
		client.on("connect", () => client.write(line));
		client.on("data", (chunk) => { buf += chunk.toString("utf8"); });
		client.on("end", () => {
			clearTimeout(timer);
			try { resolve(JSON.parse(buf.split("\n")[0])); }
			catch (e) { reject(e); }
		});
		client.on("error", (e) => { clearTimeout(timer); reject(e); });
	});
}

// 1. Happy path: prompt → subagent completes with text
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	attachFakeProvider(pi, "ok", "STOP");
	const reply = await sendRequest("Is this run done?");
	assert.equal(reply.ok, true);
	assert.equal(reply.text, "STOP");
	console.log("✓ Happy path: prompt → subagent returns text");
	shutdown();
}

// 2. Subagent fails → ok:false with error
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	attachFakeProvider(pi, "fail-agent");
	const reply = await sendRequest("anything");
	assert.equal(reply.ok, false);
	assert.match(reply.error!, /subagent boom/);
	console.log("✓ Subagent failure: surfaced as ok:false");
	shutdown();
}

// 3. Spawn RPC fails → ok:false
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	attachFakeProvider(pi, "fail-spawn");
	const reply = await sendRequest("anything");
	assert.equal(reply.ok, false);
	assert.match(reply.error!, /spawn failed/);
	console.log("✓ Spawn RPC failure: surfaced as ok:false");
	shutdown();
}

// 4. Provider missing → ping times out (5s default; we shrink that path via no ping handler)
//    Using a short manual timeout would couple to PING_TIMEOUT_MS; instead we verify the
//    error wording on a separately-mocked path. To avoid a 5s wait, we install a ping
//    handler that returns success:false instead of nothing.
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	pi.events.on("subagents:rpc:ping", (d: any) => {
		pi.events.emit(`subagents:rpc:ping:reply:${d.requestId}`, { success: false, error: "no provider" });
	});
	const reply = await sendRequest("anything");
	assert.equal(reply.ok, false);
	assert.match(reply.error!, /tintinweb\/pi-subagents/);
	console.log("✓ Provider not responding: returns clean error");
	shutdown();
}

// 5. Spawn returns no id → ok:false
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	attachFakeProvider(pi, "no-id");
	const reply = await sendRequest("anything");
	assert.equal(reply.ok, false);
	assert.match(reply.error!, /no agent id/);
	console.log("✓ Spawn returned without id: error");
	shutdown();
}

// 6. Invalid JSON → ok:false
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	attachFakeProvider(pi, "ok");
	const reply = await sendRaw("not json\n");
	assert.equal(reply.ok, false);
	assert.match(reply.error!, /invalid JSON/);
	console.log("✓ Invalid JSON: error");
	shutdown();
}

// 7. Missing prompt → ok:false
{
	const { pi, shutdown } = createMockPi();
	callbackFactory(pi);
	attachFakeProvider(pi, "ok");
	const reply = await sendRequest("");
	assert.equal(reply.ok, false);
	assert.match(reply.error!, /missing or empty/);
	console.log("✓ Missing prompt: error");
	shutdown();
}

// 8. Bash env injection: tool_call rewrites command to include PI_CALLBACK_SOCKET and PATH
{
	const { pi, fireToolCall, shutdown } = createMockPi();
	callbackFactory(pi);
	const event = { type: "tool_call", toolName: "bash", input: { command: "echo hi" } };
	fireToolCall(event);
	assert.match(event.input.command, /PI_CALLBACK_SOCKET=/);
	assert.match(event.input.command, /pi-callback/); // PATH includes the bin/ dir
	assert.match(event.input.command, /; echo hi$/);
	console.log("✓ tool_call: bash command prefixed with PI_CALLBACK_SOCKET + PATH");
	shutdown();
}

// 9. Bash env injection: re-entry is a no-op (already injected → don't double-prepend)
{
	const { pi, fireToolCall, shutdown } = createMockPi();
	callbackFactory(pi);
	const event = { type: "tool_call", toolName: "bash", input: { command: "export PI_CALLBACK_SOCKET=\"/x\"; cmd" } };
	const before = event.input.command;
	fireToolCall(event);
	assert.equal(event.input.command, before, "no double-prepend");
	console.log("✓ tool_call: re-entry is idempotent");
	shutdown();
}

// 10. Sequential bash tool_calls both get env injection
{
	const { pi, fireToolCall, shutdown } = createMockPi();
	callbackFactory(pi);
	const e1 = { type: "tool_call", toolName: "bash", input: { command: "echo a" } };
	const e2 = { type: "tool_call", toolName: "bash", input: { command: "echo b" } };
	fireToolCall(e1);
	fireToolCall(e2);
	assert.match(e1.input.command, /PI_CALLBACK_SOCKET=/);
	assert.match(e2.input.command, /PI_CALLBACK_SOCKET=/);
	shutdown();
	console.log("✓ tool_call: sequential calls both get env injection");
}

// 11. Non-bash tools are not touched
{
	const { pi, fireToolCall, shutdown } = createMockPi();
	callbackFactory(pi);
	const event = { type: "tool_call", toolName: "read", input: { file_path: "/tmp/x" } };
	fireToolCall(event);
	assert.deepEqual(event.input, { file_path: "/tmp/x" });
	console.log("✓ tool_call: non-bash tools untouched");
	shutdown();
}

// ─── CLI binary tests: spawn the real bin/pi-callback as a subprocess against a
//     test server. Verifies arg parsing, env-var handling, exit codes, stdout/stderr.

function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(CLI_PATH, args, { env: { ...process.env, ...env } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
		child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

function startTestServer(handler: (line: string, write: (s: string) => void, end: () => void) => void): Promise<{ path: string; close: () => Promise<void> }> {
	const path = `/tmp/pi-callback-cli-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
	try { unlinkSync(path); } catch { /* ignore */ }
	return new Promise((resolve) => {
		const server = createServer((socket) => {
			let buf = "";
			socket.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const line = buf.slice(0, nl);
				buf = "";
				handler(line, (s) => socket.write(s), () => socket.end());
			});
		});
		server.listen(path, () => {
			resolve({
				path,
				close: () => new Promise<void>((res) => {
					server.close(() => {
						try { unlinkSync(path); } catch { /* ignore */ }
						res();
					});
				}),
			});
		});
	});
}

// 12. CLI binary: happy path — receives prompt, prints text, exits 0
{
	const server = await startTestServer((line, write, end) => {
		const req = JSON.parse(line);
		assert.equal(req.prompt, "hello world");
		write(JSON.stringify({ ok: true, text: "HELLO_WORLD" }) + "\n");
		end();
	});
	const res = await runCli(["hello", "world"], { PI_CALLBACK_SOCKET: server.path });
	assert.equal(res.code, 0, `expected exit 0, got ${res.code}; stderr=${res.stderr}`);
	assert.equal(res.stdout.trim(), "HELLO_WORLD");
	assert.equal(res.stderr, "");
	await server.close();
	console.log("✓ CLI happy path: prompt → stdout text, exit 0");
}

// 13. CLI binary: server reports ok:false → exit 1, error to stderr
{
	const server = await startTestServer((_line, write, end) => {
		write(JSON.stringify({ ok: false, error: "spawn failed: no agent type" }) + "\n");
		end();
	});
	const res = await runCli(["anything"], { PI_CALLBACK_SOCKET: server.path });
	assert.equal(res.code, 1);
	assert.equal(res.stdout, "");
	assert.match(res.stderr, /spawn failed/);
	await server.close();
	console.log("✓ CLI server-error: exit 1, error on stderr");
}

// 14. CLI binary: missing $PI_CALLBACK_SOCKET → exit 2, helpful error
{
	const res = await runCli(["anything"], { PI_CALLBACK_SOCKET: undefined });
	assert.equal(res.code, 2);
	assert.match(res.stderr, /PI_CALLBACK_SOCKET not set/);
	console.log("✓ CLI no-socket: exit 2 with helpful error");
}

// 15. CLI binary: missing prompt → exit 2, usage help
{
	const res = await runCli([], { PI_CALLBACK_SOCKET: "/tmp/never-used.sock" });
	assert.equal(res.code, 2);
	assert.match(res.stderr, /missing prompt/);
	assert.match(res.stderr, /usage:/);
	console.log("✓ CLI no-prompt: exit 2 with usage");
}

// 16. CLI binary: connecting to nonexistent socket → exit 1, socket error on stderr
{
	const res = await runCli(["x"], { PI_CALLBACK_SOCKET: "/tmp/this-socket-does-not-exist.sock" });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /socket error/);
	console.log("✓ CLI broken-socket: exit 1 with socket error");
}

// 17. CLI binary: malformed reply line → exit 1, parse error
{
	const server = await startTestServer((_line, write, end) => {
		write("not valid json\n");
		end();
	});
	const res = await runCli(["x"], { PI_CALLBACK_SOCKET: server.path });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /malformed reply/);
	await server.close();
	console.log("✓ CLI malformed-reply: exit 1 with parse error");
}

// 18. CLI binary: multi-word prompt joined with spaces (sanity for shell args)
{
	let received = "";
	const server = await startTestServer((line, write, end) => {
		received = JSON.parse(line).prompt;
		write(JSON.stringify({ ok: true, text: "ok" }) + "\n");
		end();
	});
	const res = await runCli(["the", "quick", "brown", "fox"], { PI_CALLBACK_SOCKET: server.path });
	assert.equal(res.code, 0);
	assert.equal(received, "the quick brown fox");
	await server.close();
	console.log("✓ CLI multi-arg: prompt joined with single spaces");
}

console.log("\n🎉 All callback integration tests passed.");
