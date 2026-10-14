---
name: hunkproof
description: Stamps every hunk of a pull request with what the agent ran after writing it and lists the hunks that were never run. Use before opening or reviewing a PR written with Claude Code, when someone asks "what did you actually run", "which changes are unrun", "give me a receipt for this PR", or wants a run report posted on a PR. Reads the Claude Code transcripts already on disk; no LLM call, nothing leaves the machine except, on explicit request, a redacted PR comment.
allowed-tools: Bash(node *) Bash(npx hunkproof *) Bash(gh pr view *) Bash(git *) Read
---

# hunkproof

`git diff` shows what changed. hunkproof adds, for every hunk of the diff, the shell command the agent ran after writing it (test runner, linter, type checker, build or script) and its outcome, and marks the hunks with no run at all after their last edit.

## Run it

From the repository you want to report on:

- The branch has a PR: `npx hunkproof --pr <n> --open` (`--open` opens the HTML report; drop it when no browser is available).
- No PR yet: `npx hunkproof --base main` (or whatever the base branch is).
- Installed as a plugin, with no npm: `node "${CLAUDE_PLUGIN_ROOT}/bin/hunkproof.js" --pr <n>` runs the same CLI; it has no dependencies.
- Find the PR number of the current branch with `gh pr view --json number -q .number`.

Outputs land in `<repo>/.hunkproof/`: `evidence.json` (the data), `hunkproof.html` (the report), `hunkproof.md` (the PR comment, not posted). The terminal prints the headline and a table with one row per hunk. If hunkproof prints `hint: add .hunkproof/ to .gitignore`, tell the human; hunkproof never edits the repository itself.

Exit code 2 means no Claude Code session matched the diff; the report is written with every hunk UNATTRIBUTED. Exit code 1 is an error (not a git repository, `gh` not logged in, unknown PR).

## Read the statuses

| Status | Meaning |
| :- | :- |
| `RUN_PASS` | the last parsed run after the hunk's last edit passed |
| `RUN_FAIL` | that run failed ("ran, failed") |
| `RUN_UNPARSED` | runs happened after the last edit but none had a readable outcome (moved to background, output piped away) |
| `UNRUN` | no run at all after the last edit |
| `UNATTRIBUTED` | no session edit of this file was found, so nothing is known about runs |

Attribution qualifies the row: `MATCHED` (line-matched: the added lines appear in an edit the agent made), `FILE_LEVEL` (the file was edited in a session but these exact lines were not found in any edit; the run timing is the file's, not the lines'). A run is `targeted` when its command names the file, its stem or its directory, or is a whole-project run with no path argument. The headline counts MATCHED hunks only.

A run "passing" means the command exited 0 with a parsable pass summary. It says nothing about whether the hunk is correct or exercised by that run. Use the tool's words: "run after last edit", "unrun", "ran, failed", "ran, outcome not parsed".

## What to do with UNRUN hunks

1. For each `UNRUN` hunk, run the project's own check for that file, inside the repository checkout that holds the edit: the test file next to it, `npm test`, `pytest <path>`, `go test ./...`, the linter or the type checker. Then run hunkproof again: the run has to come after the hunk's last edit, so run checks last, after the final edit of the file.
2. When no runnable check exists for a hunk (documentation, configuration, a migration that needs a database), say so to the human explicitly: list those hunks by `file:line` and why they stay unrun. Do not edit a file to change its status and do not describe a run that did not happen.
3. `RUN_FAIL` hunks: fix the failure or tell the human which run failed and why.
4. `FILE_LEVEL` hunks: mention that the lines were not matched to an edit, so their status is weaker.
5. `UNATTRIBUTED` hunks were not written in a Claude Code session on this machine, or were written before the branch base; say so instead of guessing who wrote them.

## Posting to the PR

Never run `--post` without asking the human first, and never pass `--yes` on their behalf. The sequence is: run hunkproof, show the human `.hunkproof/hunkproof.md`, ask whether to post, and only then run `npx hunkproof --pr <n> --post`, which previews the comment and asks `Post this comment to PR #N? [y/N]` for the human to answer. The comment is public: it quotes the agent's commands verbatim (after redaction) and, with `--quotes`, the agent's own words.

## Privacy

- Transcripts are read from `~/.claude/projects` on this machine and never uploaded. hunkproof makes no LLM call and no network call except `gh` for PR metadata and, after confirmation, the comment.
- Everything written to the PR goes through redaction (API keys, tokens, private keys, emails, IP addresses, home paths). The HTML and JSON outputs stay local and are more detailed; do not paste `evidence.json` or `hunkproof.html` into a PR or an issue.
- `--quotes` is off by default; leave it off unless the human asks for intent quotes in the comment.
