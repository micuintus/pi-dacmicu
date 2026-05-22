import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { attachLoopDriver } from "../base/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const LOOP_PROMPT = `Evolve iteration.

Your role (orchestrator):
1. Read evolve.md (Goal, Metric, Base, Gates, Termination, Inspiration, Ledger). The code being evolved lives in ./target.
2. Evaluate the ## Termination section against the Ledger. The user wrote those conditions in free form; interpret them faithfully. If any condition is met, call the evolve tool with "stop".
3. Otherwise spawn a subagent with fresh context (no parent inheritance) using whatever subagent-spawning tool the session offers. Pass it the subagent instructions in the next block. The subagent reads evolve.md on its own.
4. When the subagent returns, verify a new row was appended to ## Ledger.

Subagent instructions (pass verbatim):

You are one iteration of an evolutionary code-optimization run. Your job:
1. Read evolve.md: Goal, Metric, Base, Gates, Inspiration, Ledger. <base-ref> is the Base field. The codebase is in ./target.
2. Study the Ledger. Each row has an implicit ID (#1, #2, …) by position. You are strongly encouraged to git checkout (inside target/) and inspect any existing dacmicu/evolve/* branch whose Idea or Score interests you. The Ledger is a compressed map; the branches are the territory.
3. Pick a strategy (mental aid, not recorded): evolve (refine the top scorer), diverge (try something unrelated), combine (merge two prior ideas), creative (free invention).
4. cd target. Create branch: git checkout -b dacmicu/evolve/vN/<slug> <base-ref>, where N = ledger row count + 1 and <slug> is a 1-3 word kebab-case label.
5. Make the change.
6. Evaluate every Gate. Gates may be shell commands, LLM judgments, or manual checks — follow what the Gate text says. If any Gate fails, set <score> = "GATE_FAILED:<which>" and skip to step 8. Do not delete the branch; failed branches stay for inspection.
7. If Gates pass, run the benchmark and capture the primary-metric score.
8. git checkout <base-ref>. Append exactly one row to ## Ledger (in the parent directory, not in target/): | dacmicu/evolve/vN/<slug> | <parents> | <score> | <one-sentence idea> |. Score is "<value> <unit>" on success, "GATE_FAILED:<which>" on failure. Parents is "<base-ref>" when starting from the base, "#N" when building on row N, "#N,#M" when combining rows N and M.
9. Exit DONE.`;

export default function (pi: ExtensionAPI) {
	const active = new Set<string>();

	function activate(cwd: string, hint: string, notify: (m: string, l?: "info" | "warning" | "error") => void): boolean {
		if (active.has(cwd)) {
			notify("Evolve is already active.", "info");
			return false;
		}
		if (!existsSync(join(cwd, "evolve.md"))) {
			notify("No evolve.md found in current directory.", "warning");
			return false;
		}
		active.add(cwd);
		notify(hint ? `Evolve started. Hint: "${hint}"` : "Evolve started.", "info");
		const text = hint ? `${LOOP_PROMPT}\n\nUser hint: ${hint}` : LOOP_PROMPT;
		pi.sendMessage({ customType: "evolve", content: [{ type: "text", text }] }, { triggerTurn: true });
		return true;
	}

	function deactivate(cwd: string, reason: string, notify: (m: string, l?: "info" | "warning" | "error") => void) {
		if (!active.has(cwd)) {
			notify("Evolve is not active.", "info");
			return false;
		}
		active.delete(cwd);
		notify(reason, "info");
		return true;
	}

	function handle(args: string, ctx: { cwd: string; ui: { notify: (m: string, l?: "info" | "warning" | "error") => void } }): { action: "started" | "stopped" | "noop"; message: string } {
		const trimmed = args.trim();
		if (trimmed.toLowerCase() === "stop") {
			const stopped = deactivate(ctx.cwd, "Evolve stopped.", ctx.ui.notify);
			return { action: stopped ? "stopped" : "noop", message: stopped ? "Evolve stopped." : "Evolve was not active." };
		}
		const started = activate(ctx.cwd, trimmed, ctx.ui.notify);
		return {
			action: started ? "started" : "noop",
			message: started ? (trimmed ? `Evolve started with hint: ${trimmed}` : "Evolve started.") : "Evolve was already active or evolve.md missing.",
		};
	}

	pi.registerCommand("evolve", {
		description: "Activate or stop the evolve optimization loop. Usage: /evolve [hint] or /evolve stop",
		async handler(args: string, ctx: ExtensionCommandContext) {
			handle(args, ctx);
		},
	});

	pi.registerTool({
		name: "evolve",
		label: "Evolve",
		description:
			"Control the evolve optimization loop. Pass 'stop' to halt the loop. Pass any other string as an optional hint to start a fresh run; pass empty string to start without a hint. Mirrors the /evolve slash command exactly.",
		parameters: Type.Object({
			args: Type.String({ description: "Either 'stop', a free-form hint to start with, or '' to start without a hint." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const result = handle(params.args, ctx);
			return {
				content: [{ type: "text", text: result.message }],
				details: result,
			};
		},
	});

	attachLoopDriver(pi, {
		iterate(ctx) {
			if (!active.has(ctx.cwd)) return null;
			return {
				customType: "evolve",
				content: [{ type: "text", text: LOOP_PROMPT }],
			};
		},
	});
}
