# M20: background sessions see what your shell sees

Status: implemented (2026-11-04). Two user requests: "pi-roost should be compatible
with every environment variable of the current shell", and "a hub opened in a central
folder runs sessions in different workspaces: how do their environments switch
seamlessly?".

Until now a worker got an allowlist (`PATH`, `HOME`, `LANG`, proxies, … plus
`envAllowList`). Variables such as API keys, `NODE_OPTIONS`, `AWS_PROFILE`,
`JAVA_HOME` or a corporate CA were missing unless listed one by one.

## 1. Inherit (dispatch time)

`workerEnv()` (lib/dispatch.ts) takes the launching process's whole environment,
except:

- a job's identity: `PI_JOB_*`, `PI_DAEMON_SOCK`, `PI_ROOST_RESTORE`; the worker gets
  its own;
- what names the launching terminal: `TERM*`, `TMUX*`, `STY`, `WINDOWID`, iTerm, kitty,
  WezTerm, Alacritty, Ghostty and Zellij ids, `COLUMNS`/`LINES`, `PWD`/`OLDPWD`,
  `SHLVL`, `_`, the launching tty (`GPG_TTY`, `SSH_TTY`), and editor/terminal prefixes
  (`VSCODE_*`, `KONSOLE_*`, …). The session runs in its own PTY and is opened later from
  any terminal, or a phone;
- `envDenyList` (exact names, or `PREFIX*`); an `envAllowList` name passes it anyway;
- names that cannot be set (with `=` or NUL).

`inheritEnv: false` keeps the old allowlist.

## 2. The workspace (each start, in the PTY host)

Inheriting alone is wrong for a hub: the hub's folder's `.envrc` would follow every
session, and the workspace's own would not load. Shell tools do this on `cd`, from
shell hooks, so pi-roost runs them.

The host, before it spawns the worker (`lib/workspace-env.ts`):

1. runs `$SHELL -i -c` in the session's folder:
   - zsh: `cd`, then every `chpwd_functions` and `precmd_functions` hook;
   - bash: `PROMPT_COMMAND`;
   - fish: `emit fish_prompt`; the PWD handlers run on `cd`;
   - tcsh/csh (`.cshrc`, `.tcshrc`): `cd`, then the `cwdcmd` and `precmd` aliases
     (direnv's tcsh hook is a `precmd` alias); csh on macOS is tcsh;
   - then `env -0` after a marker.

   direnv's hook unloads the old directory's variables (`DIRENV_DIFF`) and loads the
   new ones. mise, fnm and nvm switch versions the same way. Their trust rules stay
   theirs.
2. without a supported shell, or when that fails, runs `direnv export json` (when
   direnv is on PATH) and applies its diff;
3. otherwise keeps the environment as carried.

The rest:

- From the probe's result the host drops the probe's own variables and anything
  `envKept` refuses, so the deny list holds against an rc that exports a secret again.
- `PWD` is set to the session's folder.
- The probe has stdin closed and the session's `TERM` (not `dumb`: many rc files stop
  early for dumb terminals). It runs in its own process group, which is killed when the
  probe is done, so whatever the rc left in the background goes too. The shell's exit is
  enough: a background child holding stdout open does not keep the probe waiting.
- The probe's output counts even when an exit hook fails afterwards.
- Variables a shell cannot hold (`FOO-BAR`) are kept from the base.
- If direnv had loaded the hub's folder and the shell did not move it (direnv installed,
  no hook in the rc), `direnv export json` runs on top.
- The dump ends with an end marker; output cut short is not taken.
- Something the rc starts in the background (`nohup x &`) is killed with the probe's
  group; daemons that leave the group themselves (ssh-agent, gpg-agent) are not.
- `envAllowList` names pass `envDenyList` at dispatch and in the host (`envForce`).
- Time budget: 8 s in all (70 % for the shell, the rest for direnv), under attach's 15 s.
  A stop while probing kills the probe and ends the job.
- It is measured at ~40 ms with a direnv-hooked zsh.
- It runs at every start, so an `.envrc` changed since is picked up when a reaped
  session wakes.
- Shell jobs (`!cmd`) get the same treatment.
- Records made before M20 have no `workspaceEnv` and start as before.

`workspaceEnv: "direnv"` skips the shell, and `"off"` skips both.

## Security

- The whole environment is saved with the record (`job.json`, mode 0600 in a 0700
  folder), like `~/.pi/agent/auth.json`.
- The environment keys are user-only: a project's `.pi/roost.json` cannot set
  `inheritEnv`, `workspaceEnv`, `envDenyList` or `envAllowList`.
- The probe runs your own shell rc in folders you dispatch to. It is the same code a
  `cd` there would run.

## Tested

- Unit tests:
  - the never list, the deny list, allowlist mode, and the config coupling (`inheritEnv: false` turns `workspaceEnv` off);
  - parsing the probe output;
  - a real zsh with an isolated `ZDOTDIR` and a precmd hook (it loads the workspace's file, unsets the hub's variable, the deny list holds);
  - the direnv fallback, with a fake direnv;
  - a hanging rc, which is cut off;
  - tcsh and csh with a `.cshrc` (cwdcmd and precmd aliases).
- End to end, with the user's own zsh and direnv:
  - a hub opened in folder A, whose `.envrc` sets `HUB_VAR`, started `!env` in folder B, whose `.envrc` sets `WS_VAR`;
  - the job saw `WS_VAR`, no `HUB_VAR`, `DIRENV_DIR` pointing at B, `PWD` B, the shell's own `MY_SHELL_VAR`, and no `TMUX`;
  - the same with tcsh and the real `direnv hook tcsh` in its `.cshrc`.

## Not done

- nushell, xonsh, ksh hooks (direnv fallback only).
- Re-reading the launching shell's environment on respawn: a session keeps the base it
  was launched with; only the workspace part is evaluated again.
