# hunkproof

**git diff tells you what the agent changed. hunkproof stamps every hunk with what the agent ran after writing it, and marks the hunks it never ran.**
0 LLM tokens. Your transcripts never leave your machine.

![hunkproof HTML report, 9 seconds: 26 hunks, the Unrun chip is pressed and 6 remain, then the page scrolls from the CHANGELOG hunk to the README hunks, each with its diff lines, its edit time, a red unrun badge and no run after the last edit](https://raw.githubusercontent.com/JulienAu/hunkproof/main/docs/demo.gif)

*The HTML report of [`fixtures/unrun-example`](https://github.com/JulienAu/hunkproof/tree/main/fixtures/unrun-example), 9 seconds: the Unrun chip pressed, 26 hunks down to the 6 unrun ones, then a scroll from `CHANGELOG.md +18,3` to `README.md +47` ([still image](https://raw.githubusercontent.com/JulienAu/hunkproof/main/docs/demo.png)).*

On the laptop that built it, 69% of the agent's commits included a file edited after the last run (270 of 392, 380 transcripts, 18 projects). `npx hunkproof stats` prints yours. [Snapshot](https://github.com/JulienAu/hunkproof/blob/main/docs/stats-2026-10-14.md).

## Install

Paste into Claude Code: *"Install github.com/JulienAu/hunkproof and run it on this branch"*. Or, from the repository, with Node 22 or later:

```
npx hunkproof --pr <n>
```

Plugin, with the skill, the `/hunkproof:receipt` command and the Stop hook: `claude plugin marketplace add JulienAu/hunkproof && claude plugin install hunkproof@hunkproof`

[![test](https://github.com/JulienAu/hunkproof/actions/workflows/test.yml/badge.svg)](https://github.com/JulienAu/hunkproof/actions/workflows/test.yml)

## What you get

- One status per hunk: `ran, passed`, `ran, failed`, `ran, outcome not parsed`, `unrun` or `unattributed`, decided by the last run after the hunk's last edit.
- Terminal: one row per hunk with the file, the line range, the status and that run's timestamp, runner and outcome.
- HTML (`--open`): the diff lines, the sentence the agent wrote with the edit when there is one, the rewrites, the timeline of runs.
- Markdown (`--post`): the unrun hunks with links and the run that decided each hunk, sent to the PR with `gh` after you type `y`.
- Written to `<repo>/.hunkproof/` (add it to `.gitignore`) and to a git note on the head commit. `npx hunkproof --base main` when there is no PR yet.

## Receipt: hunkproof on its own PR

`npx hunkproof --pr 2 --base 1af692a4 --head 102eae0` on the private repository where v0.1 was built, 2026-10-14, output kept in [`fixtures/self-pr`](https://github.com/JulienAu/hunkproof/tree/main/fixtures/self-pr); `test/fixture.test.js` holds these numbers and rebuilds the HTML and Markdown from the saved evidence byte for byte.

```
hunkproof · PR #2 · 64 of 64 line-matched hunks had a run after their last edit (64 passed, 0 failed, 0 outcome not parsed) · 3 file-level (lines not matched to an edit) · 0 unrun · 1 unattributed · 9 sessions · hunkproof used 0 LLM tokens
```

| hunks | attributed | run after last edit | unrun | unattributed | sessions | elapsed | LLM tokens used by hunkproof |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 68 | 64 | 64 | 0 | 1 | 9 | 3.5 s | 0 |

## What an unrun hunk looks like

`npx hunkproof --base 559fee6 --head 7fbda28` on the pull request that prepared v0.1, taken before anything else ran: its docs commits edited the README and the CHANGELOG after the last `npm test`. Output kept in [`fixtures/unrun-example`](https://github.com/JulienAu/hunkproof/tree/main/fixtures/unrun-example).

```
hunkproof · 559fee6...7fbda28 · 20 of 23 line-matched hunks had a run after their last edit (20 passed, 0 failed, 0 outcome not parsed) · 3 file-level (lines not matched to an edit) · 6 unrun · 0 unattributed · 6 sessions · hunkproof used 0 LLM tokens
```

```
CHANGELOG.md                +18,3  unrun               none after edit at 17:53:47
README.md                   +9     unrun               none after edit at 17:51:34
README.md                   +47    unrun (file-level)  none after edit at 17:53:42
```

The 20 other hunks had `npm test` run after them at 17:45:10; the 6 unrun ones are the lines written after it. The next `npm test` in that session stamps them `ran, passed`: a receipt says what had run when it was written, so take it before the review, not after.

## Stop hook

- Installed with the plugin ([`hooks/hooks.json`](https://github.com/JulienAu/hunkproof/blob/main/hooks/hooks.json)). When the agent is about to hand back, it prints `hunkproof: 2 hunks edited in this session have no run after their last edit`, then one `file:line` per hunk, 10 at most.
- It reads this session's transcripts only and lists the hunks whose lines this session wrote. Nothing to say (no git repository, no diff, no transcript, every hunk run) prints nothing; `HUNKPROOF_DEBUG=1` names the reason on stderr. It writes nothing.
- `HUNKPROOF_STOP=block` returns the hook's block decision instead, with the same list and the project's checks (`npm test`, `make check`, whichever exist), so the agent runs the unrun hunks before it stops. `HUNKPROOF_STOP=off` turns it off.
- `HUNKPROOF_BASE=<ref>` picks the base (default: origin's HEAD, `main` or `master`).
- Without the plugin, add it to `.claude/settings.json`: the snippet, the version to pin, the timing (1.4 to 1.7 s on this repository) and how Claude Code shows a block are in [docs/stop-hook.md](https://github.com/JulienAu/hunkproof/blob/main/docs/stop-hook.md).

## Compared with

| | shows what changed | shows what ran after the change | per hunk | LLM tokens | leaves your machine |
| --- | --- | --- | --- | --- | --- |
| hunkproof | yes | the last run after each hunk's last edit, with its outcome | yes | 0 | no (transcripts); `gh` fetches the PR metadata, `--post` sends the comment after you type y |
| git diff | yes | no | yes | 0 | no |
| GitHub PR review | yes | CI status on the head commit, not per hunk | comments per line | 0 | the PR is already there |
| Entire CLI | yes: transcript, prompts, files touched, tool calls per checkpoint | ? | per commit; per line with `entire blame` | optional, for summaries written by an agent at commit time | yes: transcripts live in git refs with the repository; anonymous usage stats unless `--telemetry=false` |
| git-ai | yes: agent, model and prompt per line | ? | per line (`git ai blame`) | none mentioned | no: offline, no login |
| claude-replay | the whole session, with a diff view per edit | the commands in session order, not tied to a change | no | none mentioned | no, but the HTML embeds the full transcript |
| mindwalk | files touched, on a 3D map | one session-level signal, "edits after the last verify" | no, per file | 0 to view; the optional evaluation calls your `claude` or `codex` CLI | nothing while viewing; a session summary when you run the evaluation |

Filled from each project's README on 2026-10-14: [Entire CLI](https://github.com/entireio/cli#readme), [git-ai](https://github.com/git-ai-project/git-ai#readme), [claude-replay](https://github.com/es617/claude-replay#readme), [mindwalk](https://github.com/cosmtrek/mindwalk#readme). A "?" means the README does not say. The git diff and GitHub rows describe them as used, there is no README to cite. Also nearby: Anthropic's [receipts](https://claude.com/plugins/receipts) plugin (a personal usage report from the same transcripts) and [pr-provenance-stamp](https://claudepluginhub.com/plugins/karanb192-pr-provenance-stamp-plugins-pr-provenance-stamp) (a provenance note in the PR body at creation time).

## How it works

- `git diff -U0 base...head` gives the hunks: one contiguous block of added or removed lines each, identified by file and first new line.
- Sessions are found in `~/.claude/projects`: transcripts that mention the PR, edited the diff's files in the branch's time window, or ran on its branch or in its directory, subagents included.
- Each hunk's added lines are looked up in those sessions' edits (Edit, Write, MultiEdit, NotebookEdit, shell commands with a recorded diff); the chain explaining most lines wins, and the sentence written in the same turn is kept as the intent.
- Shell commands are classified as runs (test runners, linters, type checkers, builds, direct script calls) and their outcome is parsed from the output: pass, fail, or unparsed.
- A hunk's status is decided by the last run after its last edit whose outcome was parsed, targeted runs first; a run in another checkout never decides. No run after the last edit means unrun.
- The result is one evidence document, rendered three ways (terminal, HTML, Markdown) with no network call; `--post` sends the redacted Markdown to the PR only after you type `y`.

## More

- [Definitions](https://github.com/JulienAu/hunkproof/blob/main/docs/definitions.md): hunk, attribution, run, status, targeted, cost, as printed in every report footer.
- [Privacy](https://github.com/JulienAu/hunkproof/blob/main/docs/privacy.md): what is read, written and sent, and the redaction rules.
- [Limitations](https://github.com/JulienAu/hunkproof/blob/main/docs/limitations.md): what a run after an edit says and does not say, shell edits, the 30-day transcript window, worktrees, intent.
- [Two-minute film](https://github.com/JulienAu/hunkproof/blob/main/docs/hunkproof_film.mp4) with sound: why reviewing agent code is slow, what the transcript already knows, what the stamps look like.
- [CHANGELOG](https://github.com/JulienAu/hunkproof/blob/main/CHANGELOG.md) and [CONTRIBUTING](https://github.com/JulienAu/hunkproof/blob/main/CONTRIBUTING.md), which has the ground rules.
- Roadmap: parsers for Codex and other agents' session logs, behind the same event schema; a GitHub Action that replays a committed evidence document (or the git note) into a check run.
- License: MIT.
