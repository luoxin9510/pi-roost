// M77: a pi tool's field that is a protocol field takes the protocol's schema and limits
// (docs/plans/protocol-schema.md, decision 6), as plain JSON Schema that pi's validator reads.
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { registerAgentTools, TOOL_FIELDS } from "../adapters/pi/agent-tools.ts";
import { MESSAGE_MAX } from "../lib/comms.ts";
import { TASK_TEXT_MAX, TASK_TITLE_MAX } from "../lib/board.ts";
import { jsonSchemaOf } from "../lib/schema.ts";

type Tool = { name: string; parameters: Record<string, unknown> };
function tools(): Map<string, Tool> {
	const out = new Map<string, Tool>();
	const pi = { registerTool: (t: Tool) => out.set(t.name, t), registerMessageRenderer: () => {}, on: () => {} };
	registerAgentTools(pi as never, { call: async () => ({}) as never } as never);
	return out;
}
const valid = (tool: Tool, args: Record<string, unknown>) => {
	try {
		validateToolArguments(tool as never, { type: "toolCall", id: "1", name: tool.name, arguments: args } as never);
		return true;
	} catch {
		return false;
	}
};
const keys = (v: unknown): string[] => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);

describe("the tools' protocol fields", () => {
	it("are plain JSON Schema: no words for the daemon, no marks", () => {
		for (const s of Object.values(TOOL_FIELDS)) {
			const j = jsonSchemaOf(s);
			expect(keys(j).filter((k) => k === "message" || k.startsWith("x-") || k === "~type")).toEqual([]);
		}
		expect(jsonSchemaOf(TOOL_FIELDS.sendMessage)).toEqual({ type: "string", minLength: 1, maxLength: MESSAGE_MAX });
		// a maximum the daemon cuts is not refused by the tool
		expect(jsonSchemaOf(TOOL_FIELDS.taskTitle)).toEqual({ type: "string", minLength: 1 });
		expect(jsonSchemaOf(TOOL_FIELDS.taskDetail)).toEqual({ type: "string" });
	});

	it("are what pi checks a tool call against", () => {
		const t = tools();
		const send = t.get("roost_send")!;
		expect(valid(send, { to: "a", message: "hi" })).toBe(true);
		expect(valid(send, { to: "", message: "hi" })).toBe(false);
		expect(valid(send, { to: "a", message: "" })).toBe(false);
		expect(valid(send, { to: "a", message: "m".repeat(MESSAGE_MAX) })).toBe(true);
		expect(valid(send, { to: "a", message: "m".repeat(MESSAGE_MAX + 1) })).toBe(false);
		const watch = t.get("roost_watch")!;
		expect(valid(watch, { to: "a" })).toBe(true);
		expect(valid(watch, { to: "" })).toBe(false);
		const add = t.get("roost_task_add")!;
		expect(valid(add, { title: "t".repeat(TASK_TITLE_MAX + 50), detail: "d".repeat(TASK_TEXT_MAX + 50) })).toBe(true);
		expect(valid(add, { title: "" })).toBe(false);
		// the tool's own words for the model
		const props = (send.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(props.message?.description).toContain(String(MESSAGE_MAX));
	});
});
