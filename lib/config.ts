// pi-roost settings (PRD §8.1): ~/.pi/agent/roost.json, overridden per project
// by <cwd>/.pi/roost.json. Unknown keys are ignored; bad files are skipped.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type ConciergeConfig, conciergeFrom } from "./concierge.ts";
import { type AgentProfile, profileName, profilesFrom } from "./profiles.ts";
import { homedir } from "node:os";
import { readJson, writeJsonAtomic } from "./atomic.ts";
import { roostEnv } from "./identity.ts";

export interface RoostConfig {
	leftArrowOpensAgents: boolean;
	defaultToAgentsView: boolean;
	reapIdleMinutes: number;
	/** M15: records of sessions ended this many days ago are removed (0: never). */
	cleanupDays: number;
	summaryModel?: string;
	dispatchModel?: string;
	dispatchThinking?: string;
	/** M18: the agent a dispatch runs as when the task names none (Claude Code's --agent). */
	dispatchAgent?: string;
	envAllowList: string[];
	/** M20: workers start with the launching shell's environment (false: envAllowList only). */
	inheritEnv: boolean;
	/** M20: names (or `PREFIX*`) never carried. */
	envDenyList: string[];
	/** M20: the workspace's environment on top: its shell's cd hooks (direnv, mise, fnm), direnv only, or off. */
	workspaceEnv: "shell" | "direnv" | "off";
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
	/**
	 * M38: what the background service restarts by itself: "interrupted" (a run cut short by
	 * a crash, its host going away, or the machine or the service going down), "crash" (a
	 * worker crashing mid-run only), "off". Bounded: a few times in a row, with a pause.
	 */
	autoResume: "interrupted" | "crash" | "off";
	/** M13: as in Claude Code, subagents a session spawns are not rows of the agent view (inline: they are). */
	agentViewSubagents: "hide" | "inline";
	/** M10: new sessions in their own git worktree: none, roost_spawn children, or every pi dispatch. */
	worktreeIsolation: "off" | "children" | "all";
	/** M55: how /tasks merge goes into base: a fast-forward, or always a merge commit. */
	taskMerge: "ff" | "no-ff";
	/** M9: the roost_agents / roost_send / roost_spawn tools in every session. */
	agentTools: boolean;
	/** M9: messages to sessions outside the sender's spawn tree (user config only). */
	agentExternalMessages: boolean;
	/** M9 spawn limits (user config only). */
	agentMaxDepth: number;
	agentMaxChildren: number;
	agentMaxTree: number;
	agentMaxTotal: number;
	/** M27: saved choices for new sessions, by name (the user's and a project's, merged). */
	presets?: Record<string, Preset>;
	/** M30: terminal agents roost can run besides pi, by name (user config only). */
	agentProfiles?: Record<string, AgentProfile>;
	/** M44: the hub's resident agent (user config only); absent: the defaults, once turned on in the hub. */
	concierge?: ConciergeConfig;
}

/** M27: what a preset sets for new sessions; everything is optional. */
export interface Preset {
	model?: string;
	thinking?: string;
	worktree?: boolean;
	/** An agent preset (pi-subagents definition) by name. */
	agent?: string;
	/** Relative to the hub's directory, as `@dir` takes it. */
	dir?: string;
	/** Two to six models: the next task runs once per model (M26). */
	fanout?: string[];
	/** M30: an agent profile by name (or "pi"); the profile itself is the user's. */
	profile?: string;
}

export const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
/** The /preset subcommands: not names. */
const PRESET_WORDS = new Set(["off", "save", "rm"]);
export function presetName(name: string): boolean {
	return PRESET_NAME.test(name) && !PRESET_WORDS.has(name);
}
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** M27: a preset from JSON, or undefined when it is not one. */
export function presetFrom(v: unknown): Preset | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	const model = (m: unknown): m is string => typeof m === "string" && m.includes("/") && m.length <= 200;
	const p: Preset = {};
	// M30: a profile's agent names its models its own way (no provider/id)
	const other = typeof o.profile === "string" && o.profile !== "pi" && profileName(o.profile);
	if (model(o.model) || (other && typeof o.model === "string" && /^[^\s\x00-\x1f-][^\s\x00-\x1f]{0,199}$/.test(o.model))) p.model = o.model as string;
	if (typeof o.thinking === "string" && /^[a-z]{1,16}$/.test(o.thinking)) p.thinking = o.thinking;
	if (typeof o.worktree === "boolean") p.worktree = o.worktree;
	if (typeof o.agent === "string" && AGENT_NAME.test(o.agent)) p.agent = o.agent;
	// a directory under the hub's: a cloned project's preset cannot point elsewhere
	// (the view checks again, after links, that it stays under the hub's directory)
	if (typeof o.dir === "string" && o.dir && o.dir.length <= 200 && relativeDir(o.dir)) p.dir = o.dir;
	if (typeof o.profile === "string" && (o.profile === "pi" || profileName(o.profile))) p.profile = o.profile;
	if (Array.isArray(o.fanout)) {
		const list = [...new Set(o.fanout.filter(model))];
		if (list.length >= 2 && list.length <= 6) p.fanout = list;
	}
	return p;
}

function relativeDir(d: string): boolean {
	if (d.startsWith("/") || d.startsWith("\\") || d.startsWith("~") || /^[A-Za-z]:/.test(d)) return false;
	return !d.split(/[\\/]/).includes("..") && !/[\x00-\x1f]/.test(d);
}

function presetsFrom(v: unknown): Record<string, Preset> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, Preset> = Object.create(null);
	for (const [name, raw] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
		const p = presetName(name) ? presetFrom(raw) : undefined;
		if (p) out[name] = p;
	}
	return out;
}

/** Keys a project's .pi/roost.json may not set. */
const USER_ONLY = [
	"envAllowList",
	"inheritEnv",
	"envDenyList",
	"workspaceEnv",
	"summaryModel",
	"agentExternalMessages",
	"agentMaxDepth",
	"agentMaxChildren",
	"agentMaxTree",
	"agentMaxTotal",
	// M30: a profile is a command to run: a cloned project cannot define one
	"agentProfiles",
	// M44: what answers for you, and what it may spend, is yours to set
	"concierge",
] as const;

export const DEFAULTS: RoostConfig = {
	leftArrowOpensAgents: true,
	defaultToAgentsView: false,
	reapIdleMinutes: 60,
	cleanupDays: 30,
	envAllowList: [],
	inheritEnv: true,
	envDenyList: [],
	workspaceEnv: "shell",
	groupBy: "state",
	fullscreen: true,
	rowDetails: true,
	notify: "auto",
	worktreeIsolation: "off",
	taskMerge: "ff",
	subagentPanel: true,
	subagentPanelRows: 5,
	subagentAutoClose: true,
	autoResume: "interrupted",
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
	for (const k of ["summaryModel", "dispatchModel", "dispatchThinking", "dispatchAgent"] as const) {
		if (typeof r[k] === "string" && r[k]) out[k] = r[k] as string;
	}
	if (Array.isArray(r.envAllowList)) out.envAllowList = r.envAllowList.filter((v): v is string => typeof v === "string");
	if (typeof r.inheritEnv === "boolean") out.inheritEnv = r.inheritEnv;
	if (r.workspaceEnv === "shell" || r.workspaceEnv === "direnv" || r.workspaceEnv === "off") out.workspaceEnv = r.workspaceEnv;
	if (Array.isArray(r.envDenyList)) out.envDenyList = r.envDenyList.filter((v): v is string => typeof v === "string" && v !== "");
	if (typeof r.fullscreen === "boolean") out.fullscreen = r.fullscreen;
	if (typeof r.rowDetails === "boolean") out.rowDetails = r.rowDetails;
	if (r.groupBy === "state" || r.groupBy === "directory") out.groupBy = r.groupBy;
	if (typeof r.subagentPanel === "boolean") out.subagentPanel = r.subagentPanel;
	if (typeof r.subagentPanelRows === "number" && Number.isInteger(r.subagentPanelRows) && r.subagentPanelRows >= 1 && r.subagentPanelRows <= 10) {
		out.subagentPanelRows = r.subagentPanelRows;
	}
	if (typeof r.subagentAutoClose === "boolean") out.subagentAutoClose = r.subagentAutoClose;
	if (r.autoResume === "interrupted" || r.autoResume === "crash" || r.autoResume === "off") out.autoResume = r.autoResume;
	if (r.agentViewSubagents === "hide" || r.agentViewSubagents === "inline") out.agentViewSubagents = r.agentViewSubagents;
	if (r.worktreeIsolation === "off" || r.worktreeIsolation === "children" || r.worktreeIsolation === "all") out.worktreeIsolation = r.worktreeIsolation;
	if (r.taskMerge === "ff" || r.taskMerge === "no-ff") out.taskMerge = r.taskMerge;
	for (const k of ["agentTools", "agentExternalMessages"] as const) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
	for (const k of ["agentMaxDepth", "agentMaxChildren", "agentMaxTree", "agentMaxTotal"] as const) {
		const v = r[k];
		if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000) out[k] = v;
	}
	const presets = presetsFrom(r.presets);
	if (presets) out.presets = presets;
	const profiles = profilesFrom(r.agentProfiles);
	if (profiles) out.agentProfiles = profiles;
	const concierge = conciergeFrom(r.concierge);
	if (concierge) out.concierge = concierge;
	if (r.notify === "auto" || r.notify === "osc9" || r.notify === "osc777" || r.notify === "bell" || r.notify === "off") {
		out.notify = r.notify;
	}
	return out;
}

/**
 * The user's settings file: ROOST_CONFIG_DIR (or PI_ROOST_CONFIG_DIR), else
 * ~/.config/roost/roost.json when it exists (M29: a home not named after one agent),
 * else ~/.pi/agent/roost.json, where it has always been. Nothing is moved.
 */
export function userConfigPath(): string {
	const dir = roostEnv("CONFIG_DIR");
	if (dir) return join(dir, "roost.json");
	// XDG: a relative XDG_CONFIG_HOME is ignored (it would resolve against each process's cwd).
	const xdg = process.env.XDG_CONFIG_HOME;
	const neutral = join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "roost", "roost.json");
	return existsSync(neutral) ? neutral : join(homedir(), ".pi", "agent", "roost.json");
}

/** M29: a project's settings: .roost/roost.json, else .pi/roost.json. */
export function projectConfigPath(cwd: string): string {
	const neutral = join(cwd, ".roost", "roost.json");
	return existsSync(neutral) ? neutral : join(cwd, ".pi", "roost.json");
}

export function loadConfig(cwd: string): RoostConfig {
	const user = pick(readJson(userConfigPath()));
	const project = pick(readJson(projectConfigPath(cwd)));
	// A cloned repository must not choose which of your environment reaches its workers,
	// which provider receives transcript excerpts (or what they cost), nor how far its
	// agents may reach and multiply.
	for (const k of USER_ONLY) delete project[k];
	// M27: presets merge by name (a project's wins)
	const presets = user.presets || project.presets ? Object.assign(Object.create(null) as Record<string, Preset>, user.presets, project.presets) : undefined;
	return { ...DEFAULTS, ...user, ...project, ...(presets ? { presets } : {}) };
}

/** Change user settings (AV-K6 persists the grouping); other keys are kept as written. */
export function saveUserConfig(patch: Partial<RoostConfig>): void {
	const file = userConfigPath();
	const cur = readJson<Record<string, unknown>>(file) ?? {};
	mkdirSync(dirname(file), { recursive: true });
	writeJsonAtomic(file, { ...cur, ...patch });
}

/** M27: save a preset to the user's file (null removes it); other presets and keys stay. */
export function saveUserPreset(name: string, preset: Preset | null): void {
	if (!presetName(name)) throw new Error("a preset name is letters, digits, . _ - (up to 32), not off, save or rm");
	const file = userConfigPath();
	const cur = readJson<Record<string, unknown>>(file);
	// a file that does not parse is never replaced by one with only the presets
	if (!cur && existsSync(file)) throw new Error(`${file} does not parse: fix it first`);
	const old = cur?.presets;
	const presets = old && typeof old === "object" && !Array.isArray(old) ? { ...(old as Record<string, unknown>) } : {};
	if (preset) presets[name] = preset;
	else delete presets[name];
	mkdirSync(dirname(file), { recursive: true });
	writeJsonAtomic(file, { ...(cur ?? {}), presets });
}

/** Settings that belong to the user, not a project (the daemon has no project). */
export function loadUserConfig(): RoostConfig {
	return { ...DEFAULTS, ...pick(readJson(userConfigPath())) };
}

/** M20: the environment settings, as buildLaunch takes them. */
export function envPolicy(config: Pick<RoostConfig, "envAllowList" | "inheritEnv" | "envDenyList" | "workspaceEnv">): {
	extraEnv: string[];
	inheritEnv: boolean;
	envDenyList: string[];
	workspaceEnv: "shell" | "direnv" | "off";
} {
	return { extraEnv: config.envAllowList, inheritEnv: config.inheritEnv, envDenyList: config.envDenyList, workspaceEnv: config.inheritEnv ? config.workspaceEnv : "off" };
}
