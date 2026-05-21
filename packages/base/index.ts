import type { ExtensionAPI, ExtensionContext, AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

export type IterateResult = { content: (TextContent | ImageContent)[]; customType: string };

/** Loop driver contract. iterate() may be sync or async, but if it
 *  returns a Promise that outlives Pi's runLoop, sendMessage may not
 *  auto-trigger the next turn until user input. Prefer sync iterate. */
export interface LoopDriver {
	iterate(ctx: ExtensionContext): IterateResult | null | Promise<IterateResult | null>;
}

function wasAborted(event: AgentEndEvent, ctx: ExtensionContext): boolean {
	if (ctx.signal?.aborted) return true;
	return event.messages.some(
		(m) => m.role === "assistant" && (m as any).stopReason === "aborted",
	);
}

export function attachLoopDriver(pi: ExtensionAPI, driver: LoopDriver): void {
	pi.on("agent_end", async (event, ctx) => {
		if (ctx.hasPendingMessages()) return;
		if (wasAborted(event, ctx)) return;

		let prompt: IterateResult | null;
		try {
			prompt = await driver.iterate(ctx);
		} catch (err) {
			ctx.ui.notify(`Loop iterate failed: ${err}`, "error");
			return;
		}

		if (!prompt) return;

		try {
			pi.sendMessage(
				{ customType: prompt.customType, content: prompt.content, display: true },
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
