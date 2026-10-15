[← hunkproof README](https://github.com/JulienAu/hunkproof#readme)

# Limitations

What a hunkproof receipt does not say, and the cases where it says less than you might expect.

- A run after an edit says that a command ran and what it printed, nothing about the hunk being correct, exercised or safe: `npm test` passing after a README edit stamps the README hunk `ran, passed`. hunkproof's wording never turns a run into a statement about the code; it says what ran after the last edit, or that nothing did.
- Edits made by shell commands (a heredoc, `sed -i`, a script) are attributed only when Claude Code recorded a `bashEditDiff` for that command; otherwise the hunk is unattributed.
- Claude Code keeps transcripts for [30 days by default](https://code.claude.com/docs/en/data-usage) (`cleanupPeriodDays`), so a PR older than that has no sessions to read. The git note written at run time is what survives; `--from-note` renders it.
- A run made in another checkout than the edit (a git worktree) never decides a hunk's status: it is listed with the `other checkout` tag, and when it is the only run after the last edit the hunk reads `ran, outcome not parsed`, not `ran, passed`.
- Intent is a heuristic: the sentence the agent wrote in the same turn as the edit, or in the turn just before it within 15 minutes, in the session whose edits explain most of the hunk's lines. An agent that thinks between tool calls writes few such sentences, so most hunks carry no intent (16 of the 68 hunks in [hunkproof's own receipt](https://github.com/JulienAu/hunkproof/tree/main/fixtures/self-pr)). When the same lines were written in several sessions, the chain that explains most of them wins.
- It knows what the agent ran, not what you ran outside a Claude Code session. Hunks you wrote by hand, or in another tool, are unattributed.
- Whole-project runs count as targeted for every file. The `strict` count in `hunkproof stats` is the only number that insists on the command naming the file.
- The dollar figure is computed from a dated price table shipped in `src/prices.json` and describes that number, never your plan or what you paid.
- The Stop hook lists only the hunks whose lines the current session wrote: a hunk written in an earlier session is not listed, even in a file this session edited elsewhere. Details in [stop-hook.md](stop-hook.md).
- Only Claude Code transcripts are read today. Parsers for Codex and other agents' session logs, behind the same event schema, are on the roadmap.
