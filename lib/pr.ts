// M16 (Claude Code's pull request status): which pull requests a session works on, and
// how each one stands. Pure: the worker finds links, the daemon asks gh, the view colours.

export type PrStatus = "pending" | "failing" | "passing" | "merged" | "closed" | "draft";

export interface PrInfo {
	number: number;
	url: string;
	status: PrStatus;
	/** Open, not a draft, and either checks failed or no approval yet: the user's turn. */
	needsReview: boolean;
	title?: string;
}

const PR_URL = /https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)(?![A-Za-z0-9_])/g;

/** Not a forge: gh is never pointed at this machine or a bare address. */
const LOCAL_HOST = /^(localhost|[\d.]+|.*\.local|.*\.internal)$/i;

/** Pull request URLs in a text, each once, without a trailing path (`/files`, `#…`). */
export function prUrlsIn(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(PR_URL)) if (!LOCAL_HOST.test(m[1]!)) out.add(m[0]);
	return [...out];
}

export function isPrUrl(s: string): boolean {
	return prUrlsIn(s).length === 1 && prUrlsIn(s)[0] === s;
}

export function prNumber(url: string): number | undefined {
	const m = /\/pull\/(\d+)$/.exec(url);
	return m ? Number(m[1]) : undefined;
}

/** gh pr subcommands whose output names the pull request (Claude Code: edit, comment, close, ready; and create). */
const NAMING = /\bgh\s+pr\s+(create|edit|comment|close|ready|reopen|review)\b/;
/** Commands after which the branch's pull request is looked up (Claude Code: checkout and push). */
const LOOKUP = /\b(gh\s+pr\s+checkout|git\s+push)\b/;
/** Commands that count towards the retries of a pending lookup. */
const RETRY = /\b(git|gh|glab|curl)\b/;

export interface LinkStep {
	/** Pull requests the command's output names. */
	urls: string[];
	/** Look the branch up now (and after later commands until one is found). */
	lookup: boolean;
	/** A command that retries a pending lookup. */
	retry: boolean;
}

/** What a finished shell command means for the session's pull requests. */
export function linkStep(command: string, output: string): LinkStep {
	return {
		urls: NAMING.test(command) ? prUrlsIn(output) : [],
		lookup: LOOKUP.test(command),
		retry: RETRY.test(command),
	};
}

/** Claude Code retries the branch lookup after up to five later commands. */
export const LOOKUP_RETRIES = 5;

interface GhCheck {
	conclusion?: string | null;
	state?: string | null;
	status?: string | null;
}

export interface GhPr {
	number?: number;
	url?: string;
	state?: string;
	isDraft?: boolean;
	reviewDecision?: string | null;
	statusCheckRollup?: GhCheck[] | null;
	title?: string;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
// a run cancelled (a newer push, by hand) is not a failure of the change
const DONE_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "CANCELLED"]);

/** Checks of `gh pr view --json statusCheckRollup`: check runs carry conclusion, statuses state. */
export function checksOf(rollup: GhCheck[] | null | undefined): "none" | "pending" | "failing" | "passing" {
	const list = rollup ?? [];
	if (list.length === 0) return "none";
	let pending = false;
	for (const c of list) {
		const v = (c.conclusion || c.state || "").toUpperCase();
		if (FAILED.has(v)) return "failing";
		if (!DONE_OK.has(v)) pending = true;
	}
	return pending ? "pending" : "passing";
}

/** One pull request from `gh pr view <url> --json number,url,state,isDraft,reviewDecision,statusCheckRollup,title`. */
export function prFromGh(pr: GhPr): PrInfo | undefined {
	if (typeof pr.number !== "number" || typeof pr.url !== "string") return undefined;
	const state = (pr.state ?? "").toUpperCase();
	const base = { number: pr.number, url: pr.url, ...(pr.title ? { title: pr.title.slice(0, 200) } : {}) };
	if (state === "MERGED") return { ...base, status: "merged", needsReview: false };
	if (state === "CLOSED") return { ...base, status: "closed", needsReview: false };
	if (pr.isDraft) return { ...base, status: "draft", needsReview: false };
	const checks = checksOf(pr.statusCheckRollup);
	const review = (pr.reviewDecision ?? "").toUpperCase();
	const blocking = review === "CHANGES_REQUESTED" || review === "REVIEW_REQUIRED";
	const status: PrStatus = checks === "failing" ? "failing" : checks === "pending" || blocking ? "pending" : "passing";
	return { ...base, status, needsReview: checks === "failing" || review !== "APPROVED" };
}

/** Claude Code's colours: yellow waiting or failed, green passed, purple merged, grey draft or closed. */
export function prTone(s: PrStatus): "warning" | "success" | "accent" | "dim" {
	if (s === "passing") return "success";
	if (s === "merged") return "accent";
	if (s === "draft" || s === "closed") return "dim";
	return "warning";
}

const ATTENTION: Record<PrStatus, number> = { failing: 0, pending: 1, passing: 2, draft: 3, merged: 4, closed: 5 };

/** The pull request that most needs attention (its colour is the label's when there are several). */
export function mostUrgent(prs: PrInfo[]): PrInfo | undefined {
	return [...prs].sort((a, b) => ATTENTION[a.status] - ATTENTION[b.status] || b.number - a.number)[0];
}

/** The row's label: `#1234`, or `3 PRs`. */
export function prLabel(prs: PrInfo[] | undefined): { text: string; tone: ReturnType<typeof prTone>; url?: string } | undefined {
	if (!prs || prs.length === 0) return undefined;
	const top = mostUrgent(prs)!;
	if (prs.length === 1) return { text: `#${top.number}`, tone: prTone(top.status), url: top.url };
	return { text: `${prs.length} PRs`, tone: prTone(top.status) };
}

/** OSC 8 hyperlink, unless FORCE_HYPERLINK=0 (Claude Code emits it even over SSH or tmux). */
export function hyperlink(text: string, url: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (!url || env.FORCE_HYPERLINK === "0") return text;
	return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/** Claude Code's "Ready for review": an open pull request that needs review or has failing checks. */
export function readyForReview(prs: PrInfo[] | undefined): boolean {
	return !!prs?.some((p) => p.needsReview);
}

/** `#1234` or a pull request URL typed into the agent view's input. */
export function prQuery(text: string): { number: number; url?: string } | undefined {
	const t = text.trim();
	const m = /^#(\d+)$/.exec(t);
	if (m) return { number: Number(m[1]) };
	// a URL from the browser may go on (`/files`, `#discussion…`, `?w=1`)
	const url = /^\S+$/.test(t) ? prUrlsIn(t)[0] : undefined;
	if (url && t.startsWith(url)) return { number: prNumber(url)!, url };
	return undefined;
}

/** host/owner/repo/number, whatever the scheme or case. */
const prKey = (url: string) => url.replace(/^https?:\/\//i, "").toLowerCase();

export function rowHasPr(prs: PrInfo[] | undefined, q: { number: number; url?: string }): boolean {
	return !!prs?.some((p) => (q.url ? prKey(p.url) === prKey(q.url) : p.number === q.number));
}
