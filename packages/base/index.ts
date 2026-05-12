import type { ExtensionAPI, ExtensionContext, AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent, AssistantMessage } from "@earendil-works/pi-ai";

export interface LoopDriver {
	iterate(ctx: ExtensionContext):
		| { content: (TextContent | ImageContent)[]; customType: string }
		| null
		| Promise<{ content: (TextContent | ImageContent)[]; customType: string } | null>;
}

const pausedSessions = new Set<string>();

function wasAborted(event: AgentEndEvent, ctx: ExtensionContext): boolean {
	if (ctx.signal?.aborted) return true;
	return event.messages.some(
		(m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "aborted",
	);
}

export function attachLoopDriver(pi: ExtensionAPI, driver: LoopDriver): void {
	pi.on("agent_end", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();

		if (ctx.hasPendingMessages()) {
			pausedSessions.delete(sid);
			return;
		}

		if (wasAborted(event, ctx)) {
			pausedSessions.add(sid);
			return;
		}

		if (pausedSessions.has(sid)) return;

		let prompt: { content: (TextContent | ImageContent)[]; customType: string } | null;
		try {
			prompt = await driver.iterate(ctx);
		} catch (err) {
			ctx.ui?.notify?.(`Loop iterate failed: ${err}`, "error");
			return;
		}

		if (!prompt) return;

		try {
			await pi.sendMessage(
				{
					customType: prompt.customType,
					content: prompt.content,
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (err) {
			ctx.ui?.notify?.(`Loop sendMessage failed: ${err}`, "error");
		}
	});
}

export default function (_pi: ExtensionAPI) {
	// Consumers call attachLoopDriver(pi, driver).
}
