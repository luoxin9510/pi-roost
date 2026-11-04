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
2. folders packages declare (`pi-subagents.agents` or `pi.subagents.agents`); between
   packages the first one with a name keeps it;
3. the user's `~/.pi/agent/agents/**` (`PI_CODING_AGENT_DIR`), then `~/.agents/**`;
4. the project's `.agents/**` and `.pi/agents/**`, from the repository root down to the
   cwd; outside a repository the cwd's own only. The home folder is never a project.

A later file with the same name wins. Skipped: `*.chain.md`, files with a `runner`
(another CLI), `disabled: true`, no `description`, names that are not plain identifiers.
`aliases` are names too. `excludeTools` becomes `--exclude-tools` (never pi-roost's own).

## Launch

`agentArgs` turns a definition into pi flags: `--model`, `--thinking`, `--tools`
(plus `roost_*`, so the child still reports and talks), and `--system-prompt` (replace,
pi-subagents' default) or `--append-system-prompt`; `tools` with `+x`/`-x` modifiers are
passed as they are (the defaults, pi-roost's tools among them, stay). `buildLaunch` drops
the foreground pi's own `--model`/`--thinking` when the agent sets them. Order, strongest
first: a `/model` or `/thinking` chosen in the view, `roost_spawn`'s `model`/`thinking`,
or a `--model`/`--thinking` typed with `--bg`; the agent's; `dispatchModel`/`dispatchThinking`. A resumed session
keeps the agent's tools and prompt flags (they are not session-restored flags).

The record keeps the agent's name (`JobRow.agent`): the peek shows it and `a:` matches it.

## Picking

- Agent view: the first word (a name or an alias), or `@name`, followed by a task; a
  lone name is a task. A project's agent comes with the repository someone cloned, so
  only `@name` picks it (pi-subagents asks before it trusts a project's). Commands
  (`/…`) and shell (`!…`) are not read; `name !cmd` is refused.
- `dispatchAgent` (config) is the default for tasks from the view and `--bg`; an unknown
  one refuses the task with a message (commands and `!` still work).
- `pi --bg "task" --agent name`; `roost_spawn { agent }`.

## Not ported

- Claude's agent picker UI and per-agent colours.
- pi-subagents' `chains`, `skills`, `extensions`, `inheritProjectContext`,
  `inheritSkills` and runner options; `package:`-scoped names; packages listed in pi's
  `settings.json` by path (only `npm/node_modules` is read).
- `pi --session <written file> --bg --agent x`: the agent's model and thinking level
  replace the ones the session had (asking for the agent is asking for its model).
- The agents of an `@dir` target: agents are found from the view's directory.
