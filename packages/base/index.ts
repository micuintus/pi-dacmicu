import type { ExtensionAPI, ExtensionContext, AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

export type IterateResult = { content: (TextContent | ImageContent)[]; customType: string; display?: boolean };

/** Loop driver contract. iterate() runs on each agent_end: return a prompt to
 *  stack a follow-up turn, or null to stay idle. `event.messages` is only THIS
 *  run's messages (not the full history), so a driver can branch on what the
 *  just-ended turn did. Prefer sync; a Promise that outlives Pi's runLoop may
 *  not auto-trigger the next turn until user input. */
export interface LoopDriver {
	iterate(ctx: ExtensionContext, event: AgentEndEvent): IterateResult | null | Promise<IterateResult | null>;
}

function wasAborted(event: AgentEndEvent, ctx: ExtensionContext): boolean {
	if (ctx.signal?.aborted) return true;
	return event.messages.some(
		(m) => m.role === "assistant" && (m as any).stopReason === "aborted",
	);
}

/** Attach a driver. Each call adds an independent agent_end listener.
 *  Drivers MUST return null when their preconditions aren't met; multiple
 *  drivers returning non-null in the same agent_end stack follow-ups in one
 *  turn — that is a driver-design bug, not a base-layer concern. */
export function attachLoopDriver(pi: ExtensionAPI, driver: LoopDriver): void {
	pi.on("agent_end", async (event, ctx) => {
		if (ctx.hasPendingMessages()) return;
		if (wasAborted(event, ctx)) return;

		let prompt: IterateResult | null;
		try {
			prompt = await driver.iterate(ctx, event);
		} catch (err) {
			ctx.ui.notify(`Loop iterate failed: ${err}`, "error");
			return;
		}

		if (!prompt) return;

		try {
			pi.sendMessage(
				{ customType: prompt.customType, content: prompt.content, display: prompt.display ?? true },
				{ triggerTurn: true },
			);
		} catch (err) {
			ctx.ui.notify(`Loop sendMessage failed: ${err}`, "error");
		}
	});
}

export default function (_pi: ExtensionAPI) {
	// Consumers call attachLoopDriver(pi, driver).
}
