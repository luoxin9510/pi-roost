// pi-roost settings (PRD §8.1): ~/.pi/agent/roost.json, overridden per project
// by <cwd>/.pi/roost.json. Unknown keys are ignored; bad files are skipped.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readJson, writeJsonAtomic } from "./atomic.ts";

export interface RoostConfig {
	leftArrowOpensAgents: boolean;
	defaultToAgentsView: boolean;
	reapIdleMinutes: number;
	/** M15: records of sessions ended this many days ago are removed (0: never). */
	cleanupDays: number;
	summaryModel?: string;
	dispatchModel?: string;
	dispatchThinking?: string;
	envAllowList: string[];
	groupBy: "state" | "directory";
	/** The agent view covers the whole terminal (false: below the conversation, like the editor). */
	fullscreen: boolean;
	/** M8: each row shows its model and context window use. */
	rowDetails: boolean;
	/** NT-1: how the agent view makes the terminal notify. */
	notify: "auto" | "osc9" | "osc777" | "bell" | "off";
	/** M12: this session's subagents in a panel below the prompt (↓ selects, Enter opens). */
	subagentPanel: boolean;
	subagentPanelRows: number;
	/** M13: stop a subagent's worker once it finished and reported (a message starts it again). */
	subagentAutoClose: boolean;
	/** M13: as in Claude Code, subagents a session spawns are not rows of the agent view (inline: they are). */
	agentViewSubagents: "hide" | "inline";
	/** M10: new sessions in their own git worktree: none, roost_spawn children, or every pi dispatch. */
	worktreeIsolation: "off" | "children" | "all";
	/** M9: the roost_agents / roost_send / roost_spawn tools in every session. */
	agentTools: boolean;
	/** M9: messages to sessions outside the sender's spawn tree (user config only). */
	agentExternalMessages: boolean;
	/** M9 spawn limits (user config only). */
	agentMaxDepth: number;
	agentMaxChildren: number;
	agentMaxTree: number;
	agentMaxTotal: number;
}

/** Keys a project's .pi/roost.json may not set. */
const USER_ONLY = [
	"envAllowList",
	"summaryModel",
	"agentExternalMessages",
	"agentMaxDepth",
	"agentMaxChildren",
	"agentMaxTree",
	"agentMaxTotal",
] as const;

export const DEFAULTS: RoostConfig = {
	leftArrowOpensAgents: true,
	defaultToAgentsView: false,
	reapIdleMinutes: 60,
	cleanupDays: 30,
	envAllowList: [],
	groupBy: "state",
	fullscreen: true,
	rowDetails: true,
	notify: "auto",
	worktreeIsolation: "off",
	subagentPanel: true,
	subagentPanelRows: 5,
	subagentAutoClose: true,
	agentViewSubagents: "hide",
	agentTools: true,
	agentExternalMessages: false,
	agentMaxDepth: 3,
	agentMaxChildren: 8,
	agentMaxTree: 16,
	agentMaxTotal: 32,
};

function pick(raw: unknown): Partial<RoostConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<RoostConfig> = {};
	if (typeof r.leftArrowOpensAgents === "boolean") out.leftArrowOpensAgents = r.leftArrowOpensAgents;
	if (typeof r.defaultToAgentsView === "boolean") out.defaultToAgentsView = r.defaultToAgentsView;
	if (typeof r.reapIdleMinutes === "number" && r.reapIdleMinutes > 0) out.reapIdleMinutes = r.reapIdleMinutes;
	if (typeof r.cleanupDays === "number" && r.cleanupDays >= 0 && r.cleanupDays <= 3650) out.cleanupDays = r.cleanupDays;
	for (const k of ["summaryModel", "dispatchModel", "dispatchThinking"] as const) {
		if (typeof r[k] === "string" && r[k]) out[k] = r[k] as string;
	}
	if (Array.isArray(r.envAllowList)) out.envAllowList = r.envAllowList.filter((v): v is string => typeof v === "string");
	if (typeof r.fullscreen === "boolean") out.fullscreen = r.fullscreen;
	if (typeof r.rowDetails === "boolean") out.rowDetails = r.rowDetails;
	if (r.groupBy === "state" || r.groupBy === "directory") out.groupBy = r.groupBy;
	if (typeof r.subagentPanel === "boolean") out.subagentPanel = r.subagentPanel;
	if (typeof r.subagentPanelRows === "number" && Number.isInteger(r.subagentPanelRows) && r.subagentPanelRows >= 1 && r.subagentPanelRows <= 10) {
		out.subagentPanelRows = r.subagentPanelRows;
	}
	if (typeof r.subagentAutoClose === "boolean") out.subagentAutoClose = r.subagentAutoClose;
	if (r.agentViewSubagents === "hide" || r.agentViewSubagents === "inline") out.agentViewSubagents = r.agentViewSubagents;
	if (r.worktreeIsolation === "off" || r.worktreeIsolation === "children" || r.worktreeIsolation === "all") out.worktreeIsolation = r.worktreeIsolation;
	for (const k of ["agentTools", "agentExternalMessages"] as const) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
	for (const k of ["agentMaxDepth", "agentMaxChildren", "agentMaxTree", "agentMaxTotal"] as const) {
		const v = r[k];
		if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000) out[k] = v;
	}
	if (r.notify === "auto" || r.notify === "osc9" || r.notify === "osc777" || r.notify === "bell" || r.notify === "off") {
		out.notify = r.notify;
	}
	return out;
}

export function userConfigPath(): string {
	return join(process.env.PI_ROOST_CONFIG_DIR || join(homedir(), ".pi", "agent"), "roost.json");
}

export function loadConfig(cwd: string): RoostConfig {
	const user = pick(readJson(userConfigPath()));
	const project = pick(readJson(join(cwd, ".pi", "roost.json")));
	// A cloned repository must not choose which of your environment reaches its workers,
	// which provider receives transcript excerpts (or what they cost), nor how far its
	// agents may reach and multiply.
	for (const k of USER_ONLY) delete project[k];
	return { ...DEFAULTS, ...user, ...project };
}

/** Change user settings (AV-K6 persists the grouping); other keys are kept as written. */
export function saveUserConfig(patch: Partial<RoostConfig>): void {
	const file = userConfigPath();
	const cur = readJson<Record<string, unknown>>(file) ?? {};
	mkdirSync(dirname(file), { recursive: true });
	writeJsonAtomic(file, { ...cur, ...patch });
}

/** Settings that belong to the user, not a project (the daemon has no project). */
export function loadUserConfig(): RoostConfig {
	return { ...DEFAULTS, ...pick(readJson(userConfigPath())) };
}
