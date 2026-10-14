# hunkproof

**git diff tells you what the agent changed. hunkproof stamps every hunk with what the agent ran after writing it, and marks the hunks it never ran.** 0 LLM tokens, your transcripts never leave your machine.

[![test](https://github.com/JulienAu/hunkproof/actions/workflows/test.yml/badge.svg)](https://github.com/JulienAu/hunkproof/actions/workflows/test.yml)

![hunkproof HTML report on the pull request that built v0.1: the headline, then the hunks with their diff lines and the runs after each edit](https://raw.githubusercontent.com/JulienAu/hunkproof/main/docs/demo.gif)

*The HTML report on the pull request that built v0.1, about 8 seconds: the headline, then the first hunks with their diff lines, the agent's sentence for the edit when there is one, and the runs after it. [Still image](https://raw.githubusercontent.com/JulienAu/hunkproof/main/docs/demo.png).*

One row per hunk of the pull request: the file and line range, the status (`ran, passed`, `ran, failed`, `ran, outcome not parsed`, `unrun`, `unattributed`), and the last run after the hunk's last edit with its timestamp, runner and outcome.

The HTML report adds the diff lines, the sentence the agent wrote in the same turn as the edit (its intent, when there is one), how many times the lines were rewritten, and the timeline of runs after the edit. The Markdown comment lists the unrun hunks with links and names the run that decided each hunk.

Everything comes from the Claude Code transcripts already in `~/.claude/projects`; hunkproof reads them, it never asks a model.

[![Two-minute film: the problem, the transcript, the stamps, the numbers](https://raw.githubusercontent.com/JulienAu/hunkproof/main/docs/film-poster.png)](https://github.com/JulienAu/hunkproof/blob/main/docs/hunkproof_film.mp4)

*A two-minute film with sound: why reviewing agent code is slow, what the transcript already knows, and what the stamps look like. Click the image to play it on GitHub.*

## Receipt: hunkproof on its own PR

`npx hunkproof --pr 2 --base 1af692a4 --head 102eae0` on the private repository where v0.1 was built, 2026-10-14, output kept in [`fixtures/self-pr`](https://github.com/JulienAu/hunkproof/tree/main/fixtures/self-pr). The range is the code commits of its pull request 2, the v0.1 build branch, up to the last one before the receipt itself was added (a receipt of a diff that contains its own 2 MB evidence file would quote itself). Events after the merge are left out, as for every merged PR. *line-matched* means the hunk's added lines were found in an edit the agent made; *file-level* means only the file was:

```
hunkproof · PR #2 · 64 of 64 line-matched hunks had a run after their last edit (64 passed, 0 failed, 0 outcome not parsed) · 3 file-level (lines not matched to an edit) · 0 unrun · 1 unattributed · 9 sessions · hunkproof used 0 LLM tokens
```

| hunks | attributed | run after last edit | unrun | unattributed | sessions | elapsed | LLM tokens used by hunkproof |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 68 | 64 | 64 | 0 | 1 | 9 | 3.5 s | 0 |

No hunk is unrun in this range: the plugin manifests, the skill and the install page, written last, got a passing `node --test` run eight minutes later from the same session. The 3 file-level hunks are `CONTRACT.md` edits whose exact lines were not found in any edit; the unattributed hunk is a `.gitignore` line edited before the branch existed. `test/fixture.test.js` holds these numbers and rebuilds the HTML and Markdown from the saved evidence byte for byte.

### What an unrun hunk looks like

The receipt above is clean, so here is one that is not, from the pull request that prepared this release: its docs commits edited this README and the CHANGELOG after the test suite had last run. `npx hunkproof --base 559fee6 --head 7fbda28` at that moment, before anything else ran, output kept in [`fixtures/unrun-example`](https://github.com/JulienAu/hunkproof/tree/main/fixtures/unrun-example):

```
hunkproof · 559fee6...7fbda28 · 20 of 23 line-matched hunks had a run after their last edit (20 passed, 0 failed, 0 outcome not parsed) · 3 file-level (lines not matched to an edit) · 6 unrun · 0 unattributed · 6 sessions · hunkproof used 0 LLM tokens
```

```
CHANGELOG.md                +18,3  unrun               none after edit at 17:53:47
README.md                   +9     unrun               none after edit at 17:51:34
README.md                   +47    unrun (file-level)  none after edit at 17:53:42
```

![The HTML report with the Unrun chip pressed: 6 unrun hunks, the CHANGELOG hunk first with its diff lines and no run after its edit](https://raw.githubusercontent.com/JulienAu/hunkproof/main/docs/unrun.png)

The 20 other hunks of those two commits had `npm test` run after them at 17:45:10. The 6 unrun ones are the lines written after it: the CHANGELOG line, the demo caption, the opening of this section, and 3 README hunks at file level, whose exact lines were not found in an edit, so their timing is the file's. The next `npm test` in that session stamps them `ran, passed`: a receipt says what had run when it was written, which is why it is taken before the review, not after. The command has no `--pr` because the pull request did not exist yet.

## Install

Paste this into Claude Code: *"Install github.com/JulienAu/hunkproof and run it on this branch"*. The agent reads [`docs/install/agent.md`](https://github.com/JulienAu/hunkproof/blob/main/docs/install/agent.md) and runs one of:

```
claude plugin marketplace add JulienAu/hunkproof && claude plugin install hunkproof@hunkproof
```

```
npx hunkproof --pr <n>
```

One step, from a terminal: `claude plugin install hunkproof --marketplace JulienAu/hunkproof` (adds the marketplace first). Inside a session, after `claude plugin marketplace add JulienAu/hunkproof`, it is `/plugin install hunkproof@hunkproof`. `npx github:JulienAu/hunkproof --pr <n>` runs the CLI straight from the repository. The plugin adds a skill (Claude runs hunkproof when a PR needs a receipt) and the `/hunkproof:receipt` command (runs it on the current branch's PR and summarizes the unrun hunks). Node 22 or later, no dependencies.

Then, from the repository:

```
npx hunkproof --pr <n> --open     # a branch with a PR; --open shows the HTML report
npx hunkproof --base main         # no PR yet
npx hunkproof --pr <n> --post     # preview the Markdown comment, ask, post with gh
npx hunkproof stats               # what fraction of edits across your transcripts had no run after them
```

Outputs go to `<repo>/.hunkproof/` (`evidence.json`, `hunkproof.html`, `hunkproof.md`); add that directory to `.gitignore`, hunkproof will not do it for you. The evidence is also stored as a git note (`refs/notes/hunkproof`) on the head commit, so `--from-note` can rebuild the receipt later without the transcripts. A snapshot of `hunkproof stats --anonymize` over the author's transcripts is kept in [`docs/stats-2026-10-14.md`](https://github.com/JulienAu/hunkproof/blob/main/docs/stats-2026-10-14.md).

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
- Sessions are found in `~/.claude/projects`: transcripts that mention the PR, edited the diff's files inside the branch's time window, ran on its branch or in its directory, including subagent transcripts started from another directory.
- Each hunk's added lines are looked up in the edits of those sessions (Edit, Write, MultiEdit, NotebookEdit, and shell commands whose working-tree diff Claude Code recorded). The chain of edits that explains most of the lines wins; the sentence the agent wrote in the same turn as that edit is kept as the intent (at most 15 minutes earlier, and only when no other tool call separates them); hunks whose edit came in a thinking-only turn have no intent.
- Shell commands are classified as runs (test runners, linters, type checkers, builds, direct script calls) and their outcome is parsed from the output: pass, fail, or unparsed when nothing readable came back, including commands moved to the background.
- A hunk's status is decided by the last run after its last edit whose outcome was parsed, targeted runs first; a run made in another checkout than the edit never decides. No run at all after the last edit means unrun.
- The result is one evidence document, rendered three ways (terminal, HTML, Markdown) with no network call; `--post` sends the redacted Markdown to the PR only after you type `y`.

## Definitions

These are the strings printed in every report footer (`evidence.definitions`):

- **hunk**: A hunk is one contiguous block of added or removed lines in the diff between the base and head commits (git diff -U0). Its id is the file and the first new line number.
- **attribution**: MATCHED (line-matched): most of the added lines appear in an edit the agent made to this file during a session; only these hunks count as attributed in the headline. FILE_LEVEL: the agent edited this file in a session, but the added lines could not be found in any edit, so the run timing is relative to the file's last edit, not to the lines. UNATTRIBUTED: no session edit of this file was found, or the only edits of the file predate the branch base commit. Working-tree changes a shell command cannot have written (a merge, files changed by another agent while the command ran) are not counted as edits.
- **run**: A run is a shell command that executes code: a test runner, a linter, a type checker, a build, or a direct script invocation. Commands that only write files are not runs, nor are hunkproof's own invocations. Outcome is pass, fail, or unparsed when the exit status and output could not be read (including commands moved to the background).
- **status**: Decided by the last run after the hunk's last edit whose outcome was parsed, targeted runs first; a run made in another checkout than the edit (a git worktree) never decides. RUN_PASS: that run passed. RUN_FAIL: it failed ("ran, failed"). RUN_UNPARSED: runs happened after the last edit but none had a parsable outcome ("ran, outcome not parsed"). UNRUN: no run at all after the last edit. UNATTRIBUTED: the hunk could not be tied to a session edit, so nothing is known about runs.
- **targeted**: A run is targeted when the command names the file, its stem or its parent directory, or when it is a whole-project run with no path arguments. The strict count only accepts targeted runs after the last edit.
- **cost**: Token counts come from the session transcripts, deduplicated per API call. The dollar figure is what these tokens would cost at Anthropic API list prices; not a bill (subscription plans have no per-token charge); it comes from a dated public price table and is not what was billed. Models without a price entry are listed and left out of the total. Hunkproof itself makes no LLM call (0 tokens).

## Privacy

- Read: the Claude Code transcripts under `~/.claude/projects` (JSONL files Claude Code already writes), the repository's git objects, and with `--pr` the PR metadata through `gh`. No LLM call, no telemetry, no upload of transcripts.
- Written: `<repo>/.hunkproof/evidence.json`, `hunkproof.html`, `hunkproof.md`, and a git note on the head commit (`refs/notes/hunkproof`, skipped with `--no-note`). Nothing else on disk is touched.
- Sent: only with `--post`, only the Markdown comment shown in the preview, only after you type `y`, through `gh pr comment`. The comment carries counts, `file:line` links and the deciding run of each hunk; the agent's intent quotes are left out unless you pass `--quotes`. The deciding run commands are quoted verbatim and may name other directories on your machine; read the preview.
- The evidence document and the HTML contain the agent's own sentences (the intent of each edit), the command lines it ran, the parsed run summaries and the diff lines, taken from your transcripts and your repository. They are meant to stay local; read them before sharing them.
- Three fields (intent, command, summary) pass through the secret rules of `src/redact.js` when the evidence is built, and the whole comment passes through them again before posting. They replace private key blocks, JWTs, `Bearer`/`Basic`/`Token` values, keys with a known prefix (`sk-`, `sk-ant-`, `ghp_` and other GitHub tokens, `github_pat_`, `AKIA`/`ASIA`, `xox`, `glpat-`, `AIza`, `npm_`), email addresses, runs of 32 or more hex characters, long high-entropy tokens and IPv4 addresses (loopback and bind-all kept) with `[REDACTED:...]` placeholders.
- Every string of the document goes through the home-path rules, diff lines and file paths included: your home directory, its encoded form in transcript directory names (`-home-you`), and any `/home/<name>`, `/Users/<name>` or `C:\Users\<name>` prefix are rewritten to `~`. The `origin` URL is stored without its user name and password (`https://user:token@github.com/...` becomes `https://github.com/...`). Nothing else is rewritten, and the document says so in its `redaction` field, which the HTML and Markdown footers print.
- `hunkproof stats` prints the names of your project directories; it is a local report. `--anonymize` names them `project-01` to `project-NN` instead, with the same numbers, for a snapshot you can share.

## Limitations

- A run after an edit says that a command ran and what it printed, nothing about the hunk being correct, exercised or safe: `npm test` passing after a README edit stamps the README hunk `ran, passed`. hunkproof's wording never turns a run into a statement about the code; it says what ran after the last edit, or that nothing did.
- Edits made by shell commands (a heredoc, `sed -i`, a script) are attributed only when Claude Code recorded a `bashEditDiff` for that command; otherwise the hunk is unattributed.
- Claude Code keeps transcripts for [30 days by default](https://code.claude.com/docs/en/data-usage) (`cleanupPeriodDays`), so a PR older than that has no sessions to read. The git note written at run time is what survives; `--from-note` renders it.
- A run made in another checkout than the edit (a git worktree) never decides a hunk's status: it is listed with the `other checkout` tag, and when it is the only run after the last edit the hunk reads `ran, outcome not parsed`, not `ran, passed`.
- Intent is a heuristic: the sentence the agent wrote in the same turn as the edit, or in the turn just before it within 15 minutes, in the session whose edits explain most of the hunk's lines. An agent that thinks between tool calls writes few such sentences, so most hunks carry no intent (16 of the 68 hunks in this repository's own receipt). When the same lines were written in several sessions, the chain that explains most of them wins.
- It knows what the agent ran, not what you ran outside a Claude Code session. Hunks you wrote by hand, or in another tool, are unattributed.
- Whole-project runs count as targeted for every file. The `strict` count in `hunkproof stats` is the only number that insists on the command naming the file.
- The dollar figure is computed from a dated price table shipped in `src/prices.json` and describes that number, never your plan or what you paid.

## Roadmap

- Parsers for Codex and other agents' session logs, behind the same event schema.
- A Claude Code `Stop` hook that prints the unrun hunks before the agent hands back.
- A GitHub Action that replays a committed evidence document (or the git note) into a check run.

## License

MIT. Changes are listed in [CHANGELOG.md](https://github.com/JulienAu/hunkproof/blob/main/CHANGELOG.md); [CONTRIBUTING.md](https://github.com/JulienAu/hunkproof/blob/main/CONTRIBUTING.md) has the ground rules.
