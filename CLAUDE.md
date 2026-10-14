# hunkproof: build rules

- Node 22 ESM, ZERO runtime dependencies (node:fs, node:path, node:child_process, node:crypto, node:readline, node:os only). Dev tooling: node:test only.
- Use the Edit and Write tools for every file change. Never edit files via heredocs, `sed -i`, `tee` or shell redirection.
- Run `npm test` after every change. Keep tests in test/*.test.js (node:test).
- Follow CONTRACT.md exactly for module boundaries, event and evidence schemas. If the contract must change, change CONTRACT.md in the same commit and say so.
- Vocabulary rule enforced by test: output strings never contain "tested", "verified", "covered", "proof that it works". Use "run after last edit", "unrun", "ran, failed", "ran, outcome not parsed".
- No LLM call anywhere. No network call except `gh` for PR metadata/comments.
- Never read or print secrets; everything that leaves the machine (the PR comment) goes through src/redact.js and requires explicit confirmation.
- Commits: small, imperative subject, body explains why. Trailer: `Signed-off-by: JulienAu <16043912+JulienAu@users.noreply.github.com>`, no other trailers. Subject and body describe the change, not the tooling.
