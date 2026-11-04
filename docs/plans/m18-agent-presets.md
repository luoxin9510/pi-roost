# M18: agent presets, as in Claude Code

Status: implemented (2026-11-04). Claude Code's agent view: "`<agent-name> <prompt>`:
that subagent runs as the session's main agent with the configuration from its
frontmatter", `@name`, `claude --agent`, and an `a:` filter. pi has no agent files of
its own; pi-subagents does, so pi-roost reads those.

## Definitions

`lib/agents.ts` reads pi-subagents' markdown files (frontmatter: `name`, `description`,
`model`, `thinking`, `tools`, `systemPromptMode`; the body is the system prompt), in
pi-subagents' order, lowest priority first:

1. pi-subagents' builtins (`npm/node_modules/pi-subagents/agents`);
2. folders packages declare (`pi-subagents.agents` or `pi.subagents.agents`);
3. the user's `~/.pi/agent/agents/**` (`PI_CODING_AGENT_DIR`);
4. the project's `.agents/**` and `.pi/agents/**`, from the repository root down to the cwd.

A later file with the same name wins. Skipped: `*.chain.md`, files with a `runner`
(another CLI), `disabled: true`, names that are not plain identifiers.

## Launch

`agentArgs` turns a definition into pi flags: `--model`, `--thinking`, `--tools`
(plus `roost_*`, so the child still reports and talks), and `--system-prompt` (replace,
pi-subagents' default) or `--append-system-prompt`. `buildLaunch` drops the foreground
pi's own `--model`/`--thinking` when the agent sets them; a `/model` or `/thinking`
chosen in the view, or `roost_spawn`'s `model`/`thinking`, still wins. A resumed session
keeps the agent's tools and prompt flags (they are not session-restored flags).

The record keeps the agent's name (`JobRow.agent`): the peek shows it and `a:` matches it.

## Picking

- Agent view: the first word, or `@name`, followed by a task; a lone name is a task.
  Commands (`/…`) and shell (`!…`) are not read.
- `dispatchAgent` (config) is the default for the view and `--bg`; an unknown one is
  refused with a message rather than ignored.
- `pi --bg "task" --agent name`; `roost_spawn { agent }`.

## Not ported

- Claude's agent picker UI and per-agent colours.
- pi-subagents' `chains`, `skills`, `extensions` and runner options.
