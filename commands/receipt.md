---
description: Run hunkproof on the current branch's PR and summarize the unrun hunks
argument-hint: [pr-number]
allowed-tools: Bash(node *) Bash(npx hunkproof *) Bash(gh pr view *) Bash(git *) Read
---

Run hunkproof on the current repository and report what it found. Do not post anything to the PR.

1. Pick the PR: use `$ARGUMENTS` when it is a number, otherwise `gh pr view --json number -q .number`. If the branch has no PR, use `--base <default branch>` (`git symbolic-ref refs/remotes/origin/HEAD` names it) instead of `--pr`.
2. Run `npx hunkproof --pr <n>` from the repository root. If `npx` is unavailable, run `node "${CLAUDE_PLUGIN_ROOT}/bin/hunkproof.js" --pr <n>`. Exit code 2 means no Claude Code session matched the diff; say so.
3. Read the terminal table and `.hunkproof/hunkproof.md`.
4. Report, in this order:
   - the headline sentence as hunkproof printed it;
   - every `UNRUN` hunk as `file:line`, with the check you would run for it (the test file next to it, `npm test`, `pytest <path>`, the linter), or the reason none exists;
   - every `RUN_FAIL` hunk with the failing command;
   - the number of `FILE_LEVEL` hunks (lines not matched to an edit) and of `UNATTRIBUTED` hunks;
   - the path of the HTML report.
5. If the human wants the comment on the PR, they run `npx hunkproof --pr <n> --post` themselves or ask you explicitly; never run `--post` or `--yes` on your own.

Use hunkproof's words: "run after last edit", "unrun", "ran, failed", "ran, outcome not parsed". A passing run after an edit is not a statement that the hunk is correct.
