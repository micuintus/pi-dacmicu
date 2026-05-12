import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachLoopDriver } from "../base/index.js";

interface TodoItem {
	id: number;
	title: string;
	description: string;
	status: "not-started" | "in-progress" | "completed";
}

// CONTRACT: couples to tintinweb/pi-manage-todo-list tool results.
//   1. toolName === "manage_todo_list"
//   2. details has shape { todos: TodoItem[] }
// Both are tintinweb's public API. Session log is append-only; getBranch()
// returns full history including pre-compaction toolResults.
export function loadTodosFromSession(ctx: ExtensionContext): TodoItem[] {
	for (const entry of ctx.sessionManager.getBranch().reverse()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "manage_todo_list") continue;
		const details = msg.details as { todos?: TodoItem[] } | undefined;
		if (details?.todos) return details.todos.map((t) => ({ ...t }));
	}
	return [];
}

const STATUS_ICON: Record<TodoItem["status"], string> = {
	completed: "[x]",
	"in-progress": "[>]",
	"not-started": "[ ]",
};

function formatTodoList(todos: TodoItem[]): string {
	if (todos.length === 0) return "  (empty)";
	return todos.map((t) => `  ${STATUS_ICON[t.status]} #${t.id}: ${t.title}`).join("\n");
}

const ITERATION_PROMPT = (formatted: string): string =>
	`The TODO loop is iterating. Current list:\n${formatted}\n\n` +
	`Before working the next item:\n` +
	`1. Reassess the list. Given what we learned in the last turn, are items still in the right order? ` +
	`Should anything be added, removed, merged, or split?\n` +
	`2. If yes, call manage_todo_list(write, todoList=...) to update the list.\n` +
	`3. Then pick the top not-completed item and work on it. Mark it completed via manage_todo_list when done.\n\n` +
	`If you genuinely cannot make progress (need user input, blocked by an external problem), ` +
	`update the list to reflect that — clear it, or mark items completed — and the loop will stop.`;

export default function (pi: ExtensionAPI) {
	attachLoopDriver(pi, {
		iterate(ctx) {
			const todos = loadTodosFromSession(ctx);
			if (!todos.some((t) => t.status !== "completed")) return null;
			return {
				customType: "todo-iterate",
				content: [{ type: "text", text: ITERATION_PROMPT(formatTodoList(todos)) }],
			};
		},
	});
}
