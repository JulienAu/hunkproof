# Installing hunkproof (for the agent)

You are an agent asked to install hunkproof. Pick the first line that applies and run it; nothing else is needed.

- You run inside Claude Code and the human wants the skill and the `/hunkproof:receipt` command:
  `claude plugin marketplace add JulienAu/hunkproof && claude plugin install hunkproof@hunkproof`
- You only need the CLI once, in a repository with Node 22 or later:
  `npx hunkproof --pr <n>` (no install step; nothing to add to the project), or `npx github:JulienAu/hunkproof --pr <n>` straight from the repository.

Both resolve to the same CLI: `bin/hunkproof.js`, zero runtime dependencies, Node 22 ESM. After the plugin install, `node "${CLAUDE_PLUGIN_ROOT}/bin/hunkproof.js"` runs it without npm. The plugin install copies the whole repository into the plugin cache (about 9 MB, most of it the fixtures and the demo images; the CLI itself is under 300 KB).

The plugin also installs a `Stop` hook (`hooks/hooks.json`): each time you are about to hand back, it names the hunks you edited in this session that have no run after their last edit, as a message to the human; it prints nothing when every hunk had a run, and it writes no file. With `npx` only, the human adds the hook to `.claude/settings.json` themselves; the snippet is in [`docs/stop-hook.md`](../stop-hook.md) (it needs hunkproof 0.2.0 or later: 0.1.0 has no `hook` subcommand and exits 1 at every stop). `HUNKPROOF_STOP=block` makes the hook return a block decision instead, which Claude Code shows the human as a `Stop hook error occurred` notice holding the reason; that is how it renders a Stop hook asking you to continue, not a failure. `HUNKPROOF_STOP=off` turns it off.

## After installing

- Run it from the repository root: `npx hunkproof --pr <n>` for a branch with a PR, `npx hunkproof --base main` otherwise. Outputs go to `<repo>/.hunkproof/` (`evidence.json`, `hunkproof.html`, `hunkproof.md`). If it prints `hint: add .hunkproof/ to .gitignore`, pass that hint on; hunkproof does not edit the repository.
- Read the terminal table: one row per hunk with its status (`RUN_PASS`, `RUN_FAIL`, `RUN_UNPARSED`, `UNRUN`, `UNATTRIBUTED`) and the last run after its last edit.
- Never run `--post` without asking the human first; never pass `--yes` for them. The PR comment is public.
- When the Stop hook reports `hunkproof: N hunks edited in this session have no run after their last edit`, run the project's check for each listed `file:line` (the test file next to it, `npm test`, `pytest <path>`, the linter), or tell the human which hunks have no runnable check and why. Do not describe a run that did not happen.

## What it needs

- Node 22 or later.
- `git` and, for `--pr`, `gh` logged in to the repository's host.
- Claude Code transcripts under `~/.claude/projects` (they are written automatically by Claude Code; hunkproof only reads them).

## What it does not do

- No LLM call, no telemetry, no upload of transcripts. The only network calls are `gh` for PR metadata and, after the human confirms, the redacted comment.
- It does not judge whether code is correct. It reports which shell commands ran after each hunk's last edit and what they printed.

## Uninstall

`claude plugin uninstall hunkproof@hunkproof && claude plugin marketplace remove hunkproof`
