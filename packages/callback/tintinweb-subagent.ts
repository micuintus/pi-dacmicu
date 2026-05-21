/** RPC + completion helpers for tintinweb/pi-subagents. Event names are
 *  hardcoded to that provider's contract. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export type RPCReply = { success: boolean; data?: unknown; error?: string };
export type CompletionData = { id?: string; result?: unknown; error?: unknown };
export type CompletionResult = { ok: boolean; data: CompletionData };

export interface CompletionWait {
	promise: Promise<CompletionResult>;
	cancel: () => void;
}

export function rpcCall(
	events: ExtensionAPI["events"],
	channel: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<RPCReply> {
	const requestId = randomUUID();
	const replyChannel = `${channel}:reply:${requestId}`;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsub();
			resolve({ success: false, error: `RPC timeout on ${channel}` });
		}, timeoutMs);
		const unsub = events.on(replyChannel, (reply: unknown) => {
			clearTimeout(timer);
			unsub();
			resolve(reply as RPCReply);
		});
		events.emit(channel, { requestId, ...payload });
	});
}

/** Buffers completion events until agentId is known (race fix). Pass
 *  `signal` for Escape-abort. Caller must call cancel() on early exit. */
export function waitForCompletion(
	events: ExtensionAPI["events"],
	agentIdPromise: Promise<string | null>,
	signal?: AbortSignal,
): CompletionWait {
	const pending: CompletionResult[] = [];
	let settled = false;
	let resolveOuter!: (r: CompletionResult) => void;
	const promise = new Promise<CompletionResult>((res) => { resolveOuter = res; });

	let onOk: () => void;
	let onFail: () => void;
	let onAbort: (() => void) | undefined;

	const settle = (r: CompletionResult) => {
		if (settled) return;
		settled = true;
		onOk();
		onFail();
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		resolveOuter(r);
	};

	const tryResolve = (id: string) => {
		const e = pending.find((p) => p.data.id === id);
		if (e) settle(e);
	};

	const handle = (ok: boolean) => (d: unknown) => {
		pending.push({ ok, data: (d ?? {}) as CompletionData });
		agentIdPromise.then((id) => { if (id && !settled) tryResolve(id); });
	};
	onOk = events.on("subagents:completed", handle(true));
	onFail = events.on("subagents:failed", handle(false));
	onAbort = signal ? () => settle({ ok: false, data: { error: "aborted" } }) : undefined;

	agentIdPromise.then((id) => { if (id && !settled) tryResolve(id); });
	if (signal && onAbort) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	return { promise, cancel: () => settle({ ok: false, data: { error: "cancelled" } }) };
}

export function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
