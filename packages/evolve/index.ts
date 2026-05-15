import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachLoopDriver } from "../base/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function rpcCall(
	events: ExtensionAPI["events"],
	channel: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<{ success: boolean; data?: any; error?: string }> {
	const requestId = randomUUID();
	const replyChannel = `${channel}:reply:${requestId}`;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsub();
			resolve({ success: false, error: `RPC timeout on ${channel} after ${timeoutMs}ms` });
		}, timeoutMs);
		const unsub = events.on(replyChannel, (reply: any) => {
			clearTimeout(timer);
			unsub();
			resolve(reply);
		});
		events.emit(channel, { requestId, ...payload });
	});
}

function waitForCompletion(
	events: ExtensionAPI["events"],
	agentIdPromise: Promise<string>,
): Promise<{ ok: boolean; data: any }> {
	let pending: Array<{ kind: "ok" | "fail"; data: any }> = [];
	let resolveOuter!: (r: { ok: boolean; data: any }) => void;
	const promise = new Promise<{ ok: boolean; data: any }>((res) => {
		resolveOuter = res;
	});

	const tryResolve = (id: string) => {
		for (const e of pending) {
			if (e.data?.id !== id) continue;
			cleanup();
			resolveOuter({ ok: e.kind === "ok", data: e.data });
			return true;
		}
		return false;
	};

	const onOk = events.on("subagents:completed", (d: any) => {
		pending.push({ kind: "ok", data: d });
		agentIdPromise.then((id) => { if (id) tryResolve(id); });
	});
	const onFail = events.on("subagents:failed", (d: any) => {
		pending.push({ kind: "fail", data: d });
		agentIdPromise.then((id) => { if (id) tryResolve(id); });
	});

	agentIdPromise.then((id) => { if (id) tryResolve(id); });

	const cleanup = () => { onOk(); onFail(); pending = []; };
	return promise;
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

const SUBAGENT_PROMPT = `You are one iteration in an evolutionary code-optimization run. A series of subagents like you, each with fresh context, takes turns proposing and benchmarking variants. The ledger in evolve.md is the collective memory — your only window into what's already been tried.

Read evolve.md in this directory. It contains:
  - ## Goal       — what you're optimizing for
  - ## Metric     — primary metric, unit, direction (lower/higher is better)
  - ## Termination — user's hints for when to stop (e.g. max_iterations, target_score, stale_streak). Treat as guidance; you have the full ledger and can judge for yourself.
  - ## Gates      — shell commands that must pass before recording a row
  - ## Inspiration — free-form notes from the user
  - ## Ledger     — table of prior runs: Branch | Parents | Score | Core idea

Your job this iteration:

1. Pick a direction. You can diverge (try something experimental), converge (refine a promising approach), or combine (merge ideas from multiple runs). The ledger's "Core idea" column and scores are your only guidance — lower-scoring rows may still hold useful structure for combination. All previous variants are git branches in target/:
     cd target && git checkout evolving/vN/<slug>
   to inspect any prior attempt.

2. cd target. Sweep orphan evolving/* branches that have no corresponding ledger row; delete them.

3. If the ledger is empty, run a baseline (no code changes) on main. Otherwise, branch from your chosen base:
     git checkout -b evolving/vN/<slug> <base-branch>
   where N = (number of rows in ledger) + 1. <base-branch> is whichever git ref you want as the actual starting point; it is independent of the conceptual Parents column.

4. Make your changes (skip for baseline).

5. Run every gate command in evolve.md's ## Gates section. If any fails:
     git checkout main
     git branch -D evolving/vN/<slug>
     exit with: GATE_FAILED: <which gate>
     Do NOT write to evolve.md.
   Gate failure leaves no ledger row by design — the failure is about your implementation, not the approach. The next subagent may retry the same direction with a different implementation.

6. If all gates pass, run the benchmark, capture the metric. Append one row to ## Ledger:
     | evolving/vN/<slug> | <parents> | <score> <unit> | <one-sentence core idea> |
   Parents column:
     - \`main\` if your approach is from scratch with no inspiration from prior runs
     - \`#N\` if built on or inspired by run N
     - \`#N,#M,...\` if combining multiple runs
   Parents is conceptual lineage — what informed your design — not git topology.

7. Exit with: DONE.`;

export default function (pi: ExtensionAPI) {
	attachLoopDriver(pi, {
		async iterate(ctx: ExtensionContext) {
			if (!existsSync(join(ctx.cwd, "evolve.md"))) return null;

			const ping = await rpcCall(pi.events, "subagents:rpc:ping", {}, 5000);
			if (!ping.success) {
				ctx.ui?.notify?.(
					"@pi-dacmicu/evolve requires tintinweb/pi-subagents. Install it and reload Pi.",
					"error",
				);
				return null;
			}

			const agentIdDeferred = makeDeferred<string>();
			const completion = waitForCompletion(pi.events, agentIdDeferred.promise);

			const spawn = await rpcCall(
				pi.events,
				"subagents:rpc:spawn",
				{
					type: "general-purpose",
					prompt: SUBAGENT_PROMPT,
					options: {
						description: "evolve iteration",
						isBackground: true,
						inheritContext: false,
					},
				},
				5000,
			);
			if (!spawn.success) {
				agentIdDeferred.resolve("");
				ctx.ui?.notify?.(`evolve spawn failed: ${spawn.error}`, "error");
				return null;
			}
			const agentId = spawn.data?.id;
			if (!agentId) {
				agentIdDeferred.resolve("");
				ctx.ui?.notify?.("evolve spawn returned no agent id", "error");
				return null;
			}
			agentIdDeferred.resolve(agentId);

			const done = await completion;
			if (!done.ok) {
				ctx.ui?.notify?.(`evolve iteration failed: ${done.data?.error ?? "unknown"}`, "warning");
			}

			if (existsSync(join(ctx.cwd, "continue.sh"))) {
				try {
					execSync("bash continue.sh", { cwd: ctx.cwd, stdio: "pipe" });
				} catch {
					return null;
				}
			}

			return {
				customType: "evolve-iterate",
				content: [
					{
						type: "text",
						text: "Iteration complete. Acknowledge briefly; next iteration will fire on the next agent_end.",
					},
				],
			};
		},
	});
}
