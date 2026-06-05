import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { attachLoopDriver } from "../base/index.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

const LOOP_PROMPT = `Evolve iteration.

Your role (orchestrator):
1. Read evolve.md (Goal, Metric, Base, Gates, Termination, Inspiration, Ledger). The code being evolved lives in ./target.
2. Evaluate the ## Termination section against the Ledger. The user wrote those conditions in free form; interpret them faithfully. If any condition is met, call the evolve tool with "stop".
3. Otherwise delegate exactly one iteration to a subagent and do no evolving yourself, using the most capable subagent system available — ideally one with a good subagent view and plain general-purpose, unopinionated agents (e.g. HazAT/pi-interactive-subagents). Pass the instructions in the next block verbatim; the subagent reads evolve.md on its own. Do NOT pass an \`agent\` name (no worker/scout/reviewer persona), do NOT use fork mode (no inherited parent transcript), and do NOT pass a model override — the child should use the same default model as the parent. The iteration is AUTONOMOUS and the child MUST self-terminate, because this loop is woken ONLY by the subagent's completion steer — a child that never closes stalls the whole run silently (the stall watchdog cannot recover an orchestrator that is idle-waiting). Use BOTH safeguards, not either alone: (a) pass the autonomous/self-terminating spawn flag — for HazAT/pi-interactive-subagents \`autoExit: true\` (equivalent flag on other systems) — since a subagent spawned WITHOUT an agent persona defaults to INTERACTIVE on some systems (incl. HazAT) and an interactive child does not auto-close; AND (b) the verbatim subagent instructions below MANDATE that the child call the explicit done/exit tool (\`subagent_done\`) as its final action. Pick a subagent system that can actually honor self-termination (a good autonomous subagent view, e.g. HazAT/pi-interactive-subagents).
4. **After spawning the subagent, END YOUR TURN immediately.** Do not read files, do not re-check the ledger, and do not spawn another subagent on this same turn. The loop driver will wake you when the subagent finishes and a new Ledger row appears. Once the iteration completes, confirm that exactly one new ## Ledger row was appended (failed iterations append a GATE_FAILED row too); a hard crash that appends no row pauses the loop rather than racing ahead.
5. **Duplicate-spawn defence (orchestrator):** if you ever read evolve.md mid-turn and the row count has not grown since your previous read, do NOT spawn again — a subagent is already in flight. End your turn and wait.

Subagent instructions (pass verbatim):

You are one iteration of an evolutionary code-optimization run. Your job:
1. Read evolve.md: Goal, Metric, Base, Gates, Inspiration, Ledger. <base-ref> is the Base field. The codebase is in ./target.
2. Study the Ledger. Each row has an implicit ID (#1, #2, …) by position. You are strongly encouraged to git checkout (inside target/) and inspect any existing dacmicu/evolve/* branch whose Idea or Score interests you. The Ledger is a compressed map; the branches are the territory.
3. Consider the Ledger and pick a strategy (mental aid only): evolve (refine the top scorer), diverge (try something unrelated), combine (merge two prior ideas), creative (free invention). Once you have an idea you think could work, stick to it — build it, gate it, benchmark it. Do not abandon it to chase a better alternative mid-iteration; this variant gets one shot.
4. cd target. Create branch: git checkout -b dacmicu/evolve/vN/<slug> <base-ref>, where N is the new row's implicit ID (ledger row count + 1) and <slug> is a 1-3 word kebab-case label. The version number N must always equal the row ID.
5. Make the change.
6. Evaluate every Gate ON THIS VARIANT ONLY. Previous rows were already gated and scored; never re-run gates or benchmarks for them. Gates may be shell commands, LLM judgments, or manual checks — follow what the Gate text says. If any Gate fails, set <score> = "GATE_FAILED:<which>" and skip to step 8. Do not delete the branch; failed branches stay for inspection.
7. If Gates pass, run the benchmark ONCE for this variant and capture the primary-metric score. Do not benchmark any other branch.
8. git checkout <base-ref>. Append exactly one row to ## Ledger (in the parent directory, not in target/): | dacmicu/evolve/vN/<slug> | <parents> | <score> | <one-sentence idea> |. N in vN must match the row's implicit ID. Score is "<value> <unit>" on success, "GATE_FAILED:<which>" on failure. Parents is "<base-ref>" when starting from the base, "#N" when building on row N, "#N,#M" when combining rows N and M.
9. **TERMINATE — MANDATORY, this is how the loop is woken.** Write your one-paragraph summary as your final assistant message (it becomes the result returned to the orchestrator), then IMMEDIATELY call the explicit done/exit tool — \`subagent_done\` (or your system's equivalent: \`task_done\`/\`exit\`/\`done\`). DO NOT just end your turn expecting auto-exit to close the session: ending a turn without calling the done tool leaves the session OPEN and the orchestrator is NEVER woken (no completion steer is emitted), silently stalling the entire run. The done-tool call is REQUIRED even if you believe auto-exit is configured — it is the only reliable termination signal. Only if no done/exit tool exists in your toolset at all may you fall back to just ending your turn; whenever such a tool is available, calling it is non-negotiable and must be your last action.`;

// Per-wake nudge; the full LOOP_PROMPT is sent only once, at activation.
const SHORT_REMINDER = `[evolve] You are the orchestrator of an ACTIVE evolve run (see evolve.md). When woken by a finished iteration: evaluate ## Termination against the Ledger; if any condition is met, call the evolve tool with "stop". Otherwise delegate exactly ONE new iteration to a subagent (pass the subagent instructions verbatim; no agent persona, no fork, no model override; autonomous/self-closing so it reports back and wakes you — \`autoExit: true\` on HazAT), then END YOUR TURN. Never spawn twice for the same Ledger state.`;

// A spawn in the just-ended turn means the orchestrator already advanced.
const SPAWN_TOOLS = new Set(["subagent", "subagent_resume"]);

function turnSpawnedSubagent(event: AgentEndEvent): boolean {
	for (const m of event.messages) {
		if (m.role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "toolCall" && SPAWN_TOOLS.has(block?.name)) return true;
		}
	}
	return false;
}

/** Count appended Ledger rows (lines whose first table cell names a
 *  dacmicu/evolve/vN branch). This is the tool-agnostic completion signal:
 *  one finished iteration == one new row, regardless of how the subagent
 *  was spawned. */
function ledgerRowCount(cwd: string): number {
	try {
		const md = readFileSync(join(cwd, "evolve.md"), "utf8");
		return (md.match(/^[^\S\n]*\|[^\n]*dacmicu\/evolve\/v\d+/gim) || []).length;
	} catch {
		return 0;
	}
}

export default function (pi: ExtensionAPI) {
	const active = new Set<string>();
	// Ledger row count last reconciled, per cwd.
	const ledgerAt = new Map<string, number>();

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
		ledgerAt.set(cwd, ledgerRowCount(cwd));
		notify(hint ? `Evolve started. Hint: "${hint}"` : "Evolve started.", "info");
		const text = hint ? `${LOOP_PROMPT}\n\nUser hint: ${hint}` : LOOP_PROMPT;
		pi.sendMessage({ customType: "evolve", content: [{ type: "text", text }], display: true }, { triggerTurn: true });
		return true;
	}

	function deactivate(cwd: string, reason: string, notify: (m: string, l?: "info" | "warning" | "error") => void) {
		if (!active.has(cwd)) {
			notify("Evolve is not active.", "info");
			return false;
		}
		active.delete(cwd);
		ledgerAt.delete(cwd);
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

	// Re-anchor the orchestrator on every wake (survives compaction).
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!active.has(ctx.cwd)) return {};
		return { message: { customType: "evolve-reminder", content: [{ type: "text", text: SHORT_REMINDER }], display: false } };
	});

	// Stall watchdog only: the completion steer paces the loop; this kicks
	// solely when an iteration finished but the orchestrator didn't advance.
	attachLoopDriver(pi, {
		iterate(ctx, event) {
			if (!active.has(ctx.cwd)) return null;
			const rows = ledgerRowCount(ctx.cwd);
			// Already advanced this turn — reconcile and stay quiet (no double-wake).
			if (turnSpawnedSubagent(event)) {
				ledgerAt.set(ctx.cwd, rows);
				return null;
			}
			const seen = ledgerAt.get(ctx.cwd) ?? rows;
			if (rows <= seen) return null; // no iteration finished since last reconcile
			ledgerAt.set(ctx.cwd, rows); // row landed without a spawn → stalled; nudge
			return {
				customType: "evolve",
				content: [{ type: "text", text: SHORT_REMINDER }],
			};
		},
	});

	pi.on("resources_discover", async () => ({ skillPaths: [SKILLS_DIR] }));
}
