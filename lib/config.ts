// pi-roost settings (PRD §8.1): ~/.pi/agent/roost.json, overridden per project
// by <cwd>/.pi/roost.json. Unknown keys are ignored; bad files are skipped.
import { join } from "node:path";
import { homedir } from "node:os";
import { readJson } from "./atomic.ts";

export interface RoostConfig {
	leftArrowOpensAgents: boolean;
	defaultToAgentsView: boolean;
	reapIdleMinutes: number;
	summaryModel?: string;
	dispatchModel?: string;
	dispatchThinking?: string;
	envAllowList: string[];
	groupBy: "state" | "directory";
}

export const DEFAULTS: RoostConfig = {
	leftArrowOpensAgents: true,
	defaultToAgentsView: false,
	reapIdleMinutes: 60,
	envAllowList: [],
	groupBy: "state",
};

function pick(raw: unknown): Partial<RoostConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<RoostConfig> = {};
	if (typeof r.leftArrowOpensAgents === "boolean") out.leftArrowOpensAgents = r.leftArrowOpensAgents;
	if (typeof r.defaultToAgentsView === "boolean") out.defaultToAgentsView = r.defaultToAgentsView;
	if (typeof r.reapIdleMinutes === "number" && r.reapIdleMinutes > 0) out.reapIdleMinutes = r.reapIdleMinutes;
	for (const k of ["summaryModel", "dispatchModel", "dispatchThinking"] as const) {
		if (typeof r[k] === "string" && r[k]) out[k] = r[k] as string;
	}
	if (Array.isArray(r.envAllowList)) out.envAllowList = r.envAllowList.filter((v): v is string => typeof v === "string");
	if (r.groupBy === "state" || r.groupBy === "directory") out.groupBy = r.groupBy;
	return out;
}

export function userConfigPath(): string {
	return join(process.env.PI_ROOST_CONFIG_DIR || join(homedir(), ".pi", "agent"), "roost.json");
}

export function loadConfig(cwd: string): RoostConfig {
	const user = pick(readJson(userConfigPath()));
	const project = pick(readJson(join(cwd, ".pi", "roost.json")));
	// A cloned repository must not choose which of your environment reaches its workers.
	delete project.envAllowList;
	return { ...DEFAULTS, ...user, ...project };
}

/** Settings that belong to the user, not a project (the daemon has no project). */
export function loadUserConfig(): RoostConfig {
	return { ...DEFAULTS, ...pick(readJson(userConfigPath())) };
}
