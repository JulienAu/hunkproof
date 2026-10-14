# Installing hunkproof (for the agent)

You are an agent asked to install hunkproof. Pick the first line that applies and run it; nothing else is needed.

- You run inside Claude Code and the human wants the skill and the `/hunkproof:receipt` command:
  `claude plugin marketplace add JulienAu/hunkproof && claude plugin install hunkproof@hunkproof`
- You only need the CLI once, in a repository with Node 22 or later:
  `npx hunkproof --pr <n>` (no install step; nothing to add to the project), or `npx github:JulienAu/hunkproof --pr <n>` straight from the repository.

Both resolve to the same CLI: `bin/hunkproof.js`, zero runtime dependencies, Node 22 ESM. After the plugin install, `node "${CLAUDE_PLUGIN_ROOT}/bin/hunkproof.js"` runs it without npm. The plugin install copies the whole repository into the plugin cache (about 9 MB, most of it the fixtures and the demo images; the CLI itself is under 300 KB).

## After installing

- Run it from the repository root: `npx hunkproof --pr <n>` for a branch with a PR, `npx hunkproof --base main` otherwise. Outputs go to `<repo>/.hunkproof/` (`evidence.json`, `hunkproof.html`, `hunkproof.md`). If it prints `hint: add .hunkproof/ to .gitignore`, pass that hint on; hunkproof does not edit the repository.
- Read the terminal table: one row per hunk with its status (`RUN_PASS`, `RUN_FAIL`, `RUN_UNPARSED`, `UNRUN`, `UNATTRIBUTED`) and the last run after its last edit.
- Never run `--post` without asking the human first; never pass `--yes` for them. The PR comment is public.

## What it needs

- Node 22 or later.
- `git` and, for `--pr`, `gh` logged in to the repository's host.
- Claude Code transcripts under `~/.claude/projects` (they are written automatically by Claude Code; hunkproof only reads them).

## What it does not do

- No LLM call, no telemetry, no upload of transcripts. The only network calls are `gh` for PR metadata and, after the human confirms, the redacted comment.
- It does not judge whether code is correct. It reports which shell commands ran after each hunk's last edit and what they printed.

## Uninstall

`claude plugin uninstall hunkproof@hunkproof && claude plugin marketplace remove hunkproof`
