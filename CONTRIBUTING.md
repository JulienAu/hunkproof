# Contributing to hunkproof

Thanks for looking. Issues and pull requests are welcome at https://github.com/JulienAu/hunkproof.

## Run the tests

Node 22 or later, nothing to install:

```
npm test
```

That runs `node --test` over `test/*.test.js`. Run it after every change. New behaviour comes with a test in the same pull request.

## Ground rules

- **Zero runtime dependencies.** Only `node:` built-ins (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:readline`, `node:os`). Test tooling is `node:test` only. A pull request that adds a dependency will be asked to remove it.
- **Follow `CONTRACT.md`.** It defines the module boundaries, the event schema and the evidence schema. If a change needs the contract to move, change `CONTRACT.md` in the same pull request and say so in the description.
- **Vocabulary rule, enforced by a test.** hunkproof reports what ran, not what is true about the code. Strings printed by the tool, and the docs, never borrow the vocabulary of test coverage and never call a report proof of anything. Use: "run after last edit", "unrun", "ran, failed", "ran, outcome not parsed".
- **No LLM call anywhere, no network call** except `gh` for PR metadata and the PR comment. Everything that leaves the machine goes through `src/redact.js` and requires explicit confirmation.
- **Renderers are deterministic.** Same evidence document, byte-identical output. No `Date.now()` in a renderer.
- **Plain punctuation** in docs and copy: commas, periods, colons. No em dashes or en dashes.

## Commits

Small commits, imperative subject, a body that explains why. Sign your commits off with your own identity (Developer Certificate of Origin):

```
git commit -s
```

That adds a `Signed-off-by:` trailer with the name and email from your git config. No other trailers are needed.

## Fixtures

`fixtures/self-pr` holds a report hunkproof produced on its own pull request; `test/fixture.test.js` rebuilds the HTML and Markdown from that evidence byte for byte and checks the summary numbers. `fixtures/unrun-example` is a second report, taken on the release pull request before the suite ran again, with 6 unrun hunks; `test/unrun-fixture.test.js` does the same for it. If a renderer change alters the output on purpose, regenerate both with `node bin/hunkproof.js --evidence fixtures/<name>/evidence.json --diff fixtures/<name>/diff.patch --out fixtures/<name> --no-note` and commit the new files with the change. Synthetic transcripts for the parser live in `fixtures/sessions`.
