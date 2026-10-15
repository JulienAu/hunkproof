[← hunkproof README](https://github.com/JulienAu/hunkproof#readme)

# Stop hook

The plugin installs a Claude Code `Stop` hook ([`hooks/hooks.json`](../hooks/hooks.json), exec form `node ${CLAUDE_PLUGIN_ROOT}/bin/hunkproof.js hook stop`, 10 s timeout). When the agent is about to hand back, the hook diffs the working tree against the base branch (untracked files included when this session wrote them), reads this session's transcripts only (the main one and its subagents) and shows you the hunks whose lines this session wrote and that have no run after their last edit:

```
hunkproof: 2 hunks edited in this session have no run after their last edit
  src/x.js:4        edited 10:31:07 UTC  no run after
  docs/readme.md:1  edited 10:33:50 UTC  no run after (file-level)
```

One `file:line` per hunk, 10 at most, then `+N more` (the lines above are the ones `test/hook.test.js` expects). Hunks written in an earlier session are not listed, even in a file this session edited elsewhere: a line-matched hunk has to carry lines this session's own edits added.

## When it is silent

When there is nothing to say (no git repository, no diff, no transcript, every hunk run) it prints nothing; `HUNKPROOF_DEBUG=1` names the reason on stderr. It writes nothing (no `.hunkproof/`, no git note), never runs transcript discovery, and always exits 0, also when it crashes (`HUNKPROOF_DEBUG=1` prints the stack on stderr).

## Timing

On the hunkproof repository, with a 26 MB session transcript and 108 subagent transcripts (73 MB, 23 of them mentioning the repository), five runs on an idle machine took 1.4 to 1.7 s (1.37, 1.37, 1.54, 1.73 and 1.49 s, 147 to 187 MB of memory at peak). A loaded machine takes longer, and the hook's 10 s timeout bounds it. Untracked files are diffed only when an edit of this session names them, 50 at most and none over 1 MiB, so a stray dump in the working tree costs nothing: a 30 MB untracked log next to one session edit took 6444 ms before this rule and 32 ms after it.

## Without the plugin

Add the hook to `.claude/settings.json`. The `hook` subcommand exists from hunkproof 0.2.0 (0.1.0 prints its usage and exits 1 at every stop), so pin the version:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "npx", "args": ["-y", "hunkproof@^0.2.0", "hook", "stop"], "timeout": 30 } ] } ] } }
```

From a clone, point `command` at `node` and `args` at `<checkout>/bin/hunkproof.js hook stop` instead. The subcommand takes JSON on stdin and answers JSON on stdout, as Claude Code's hook protocol expects; `--mode report|block|off` sets the mode when the environment variable below is not set.

## Block mode

`HUNKPROOF_STOP=block` (an environment variable, so it works with the plugin's hook as shipped: `HUNKPROOF_STOP=block claude`, or `env` in your settings) returns the hook's block decision instead, with the same list as the reason and a closing line naming the project's checks (`npm test`, `npm run check`, `npm run lint`, `make test`, `make check`, whichever exist), so the agent runs the unrun hunks before it stops. The hook never blocks when the agent is already continuing because of a stop hook (`stop_hook_active`), so it cannot loop.

Claude Code shows a block as a `Stop hook error occurred` notice (`ctrl+o` shows the reason): that is how it renders any Stop hook that asks the agent to continue, not a failure of the hook.

`HUNKPROOF_STOP=off` turns the hook off. `HUNKPROOF_BASE=<ref>` picks the base (default: origin's HEAD, `main` or `master`); the diff runs against the merge base of that ref and HEAD.

## What the agent is told

[`docs/install/agent.md`](install/agent.md) asks the agent, when the hook reports unrun hunks, to run the project's check for each listed `file:line` (the test file next to it, `npm test`, `pytest <path>`, the linter), or to tell you which hunks have no runnable check and why, and never to describe a run that did not happen.
