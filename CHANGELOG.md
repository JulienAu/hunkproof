# Changelog

All notable changes to hunkproof are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

First public release.

### What it does

- `hunkproof --pr N` (or `--base REF`) reads the Claude Code transcripts already in `~/.claude/projects`, finds the sessions that belong to the pull request, and stamps every hunk of `git diff -U0 base...head` with the last shell command the agent ran after the hunk's last edit: the runner, its outcome (pass, fail, outcome not parsed) and its timestamp. Hunks with no run at all after their last edit are marked unrun.
- Attribution is textual: a hunk is `MATCHED` when its added lines appear in an edit the agent made (Edit, Write, MultiEdit, NotebookEdit, or a shell command whose working-tree diff Claude Code recorded), `FILE_LEVEL` when only the file was edited, `UNATTRIBUTED` when no session edit of the file was found.
- Edits made in a git worktree of the repository are mapped back onto the repository, and a run made in another checkout than the edit never decides a hunk's status.
- One evidence document (`evidence.json`, schema `hunkproof/evidence@1`) rendered three ways: the terminal table, a self-contained HTML report (`hunkproof.html`, light and dark), and a Markdown comment (`hunkproof.md`) that lists the unrun hunks with `file:line` links. The evidence is also stored as a git note on the head commit (`refs/notes/hunkproof`); `--from-note` and `--evidence FILE --diff FILE` replay a saved document.
- Each hunk carries the agent's intent: the sentence written in the same turn as the hunk's last edit, or in the turn just before it within 15 minutes with no other tool call in between. Hunks edited in a thinking-only turn have no intent (null) rather than a stale sentence from an earlier turn.
- Every output (`evidence.json`, HTML, Markdown, terminal, git note) rewrites home directories to `~`, diff lines and file paths included: the machine's home, its encoded transcript-directory form, and any `/home/<user>`, `/Users/<user>` or `C:\Users\<user>` prefix. Secrets (API keys, tokens, private keys, JWTs, high-entropy strings, emails, IPv4 addresses) are masked in the agent text, run commands and run summaries; the `origin` URL is stored without its user name and password. The document states these rules in its `redaction` field and the footers print them.
- `--post` previews the Markdown comment, asks for confirmation, then posts it with `gh`. The comment is text-free by default; `--quotes` adds the agent's intent sentences.
- A merged PR stops at its merge commit: transcript events after it are left out, so later sessions on the same repository do not stamp its hunks, and the session rows end there too, so the document does not change as the transcripts grow.
- `hunkproof stats` streams every transcript modified in the last 90 days (`--since DAYS`) and prints, per project, how many file edits had no run, no targeted run or no passing run after their last edit, and how many commits included a file edited after the last run. `--anonymize` names the projects `project-01` to `project-NN` for a snapshot that can be shared.
- A receipt of hunkproof on the pull request that built v0.1 (code commits, `1af692a4..102eae0`) ships in `fixtures/self-pr`; the test suite rebuilds the HTML and Markdown from it byte for byte and the README quotes its numbers. A second receipt, `fixtures/unrun-example`, was taken on the release pull request right after its docs commits, before the suite ran again, so the README can show what an unrun hunk looks like.
- A token and cost summary per session, deduplicated per API call and priced from a dated public price table; the figure is what the tokens would cost at Anthropic API list prices, not a bill.
- Ships as an npm package (`npx hunkproof`) and as a Claude Code plugin from the repository (`claude plugin marketplace add JulienAu/hunkproof && claude plugin install hunkproof@hunkproof`) with a skill and the `/hunkproof:receipt` command.
- The reproduction command printed in every report carries the PR number and the `--base`/`--head` refs the receipt was made with.
- Node 22 or later, ESM, zero runtime dependencies. No LLM call, no telemetry; the only network calls are `gh` for PR metadata and, after confirmation, the comment.

### What it does not do

- It does not judge code. A run after an edit says that the command ran and what it printed, nothing about whether the hunk is correct, exercised or safe. hunkproof's own wording never borrows the vocabulary of test coverage; it says what ran after the last edit, or that nothing did.
- It only knows what ran inside Claude Code sessions. Hunks written by hand or in another tool are unattributed, and commands you ran outside a session are not seen.
- It reads Claude Code transcripts only. Other agents' session logs are not parsed yet.
- It does not edit the repository it reports on: outputs go to `<repo>/.hunkproof/` and the tool only prints a hint when that directory is not gitignored.
- The dollar figure is computed from a shipped price table and says nothing about your plan or what you paid.

[0.1.0]: https://github.com/JulienAu/hunkproof/releases/tag/v0.1.0
