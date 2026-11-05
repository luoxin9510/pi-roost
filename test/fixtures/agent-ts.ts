// M31: a scripted agent on the TypeScript client, for the conformance tests (agent-py.py
// does the same in Python). Each reply is worked on for a moment and then done; "exit"
// ends it. The summary counts the replies handled, so a duplicate would show.
import { RoostAgent } from "../../lib/agent-client.ts";

let handled = 0;
const agent = RoostAgent.fromEnv({
	name: "scripted-ts",
	version: "1.0",
	capabilities: ["usage"],
	onReply: async (r) => {
		if (r.text === "exit") {
			agent!.report({ state: "done", summary: "bye" });
			// after this handler returns the reply is acked; then it goes
			setTimeout(() => void agent!.close().then(() => process.exit(0)), 300);
			return;
		}
		if (r.text === "crash") {
			// M40: dies mid-work, the reply acked (this handler returned)
			agent!.report({ state: "working", summary: "on crash" });
			setTimeout(() => process.exit(2), 150);
			return;
		}
		if (r.text === "board") {
			// M47: the board through the client: a task put on, claimed, done
			agent!.report({ state: "working", summary: "on board" });
			const t = await agent!.addTask("from the agent", { detail: "a task it put on" });
			await agent!.claimTask(t.id);
			await agent!.taskDone(t.id, "done by the agent");
			agent!.report({ state: "done", summary: `board #${t.id}` });
			return;
		}
		handled++;
		agent!.report({ state: "working", summary: `on ${r.text}` });
		await new Promise((res) => setTimeout(res, 200));
		agent!.report({ state: "done", summary: `did ${r.text} (#${handled})`, model: "scripted-1" });
	},
});
if (!agent) {
	console.error("not in a roost job");
	process.exit(2);
}
agent.report({ state: "blocked", waitingFor: "first-prompt", summary: "ready" });
setInterval(() => {}, 60_000);
