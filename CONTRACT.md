# CONTRACT.md: module boundaries and schemas (v0.1)

All modules are ESM under `src/`, pure where possible, no runtime deps. All timestamps are ISO strings; all paths are absolute, normalized (`path.resolve`) inside the pipeline and tildified in the Evidence (see Redaction), with `~` never expanded in output.

## Normalized transcript events: `src/transcript.js`
```js
export async function* readSessionEvents(jsonlPath, opts = {}) // yields Event, fail-soft: bad lines skipped and counted in opts.stats
export async function readSession(jsonlPath, opts = {})       // => { sessionId, path, events: Event[], stats, meta: {firstTs, lastTs, cwd, versions:[], gitBranches:[], models:[]} }
```
`Event` =
```ts
{ type: 'edit'|'shell_edit'|'run'|'commit'|'say'|'usage'|'pr_link'|'tool'|'other',
  ts: string, sessionId: string, cwd: string|null, gitBranch: string|null, version: string|null,
  messageId: string|null, requestId: string|null, toolUseId: string|null, uuid: string|null, isSidechain: boolean,
  // type edit (tools Edit, Write, MultiEdit, NotebookEdit): file is absolute, resolved against cwd when relative
  edit?: { tool: string, file: string, newContent: string|null, addedLines: string[], oldString?: string|null, structuredPatch?: any, originalFile?: string|null, userModified?: boolean },
  // type shell_edit (Bash that modified files): one event PER FILE, derived from toolUseResult.bashEditDiff when present, else from regex write-target extraction of the command (sed -i, >, >>, tee, cat <<EOF > path, python/node heredocs that open(path,'w'), git apply, mv/cp into the repo).
  // bashEditDiff lists every working-tree change seen while the call ran (concurrent agents, merges), so each entry is tagged by bashEditDiffSource(command, file, cwd):
  //   'bashEditDiff'                 the command names the file (path, basename or a parent dir as a path), lists it as a write target, or is a whole-tree formatter (prettier --write ., ruff format, black ., eslint --fix dir/)
  //   'bashEditDiff-git'             git merge/pull/checkout/switch/rebase/cherry-pick/revert/reset/restore/stash pop|apply, gh pr merge: a working-tree change, not authorship
  //   'bashEditDiff-uncorroborated'  anything else (a polling loop, a scratch-dir command). attribute.js, runs.js and discover.js ignore the last two (isCorroboratedSource)
  edit?: { tool: 'Bash', file: string, newContent: null, addedLines: string[], command: string, source: 'bashEditDiff'|'bashEditDiff-git'|'bashEditDiff-uncorroborated'|'regex', hunks?: Array<{oldStart:number, oldLines:number, newStart:number, newLines:number, lines:string[]}> },
  // type run (Bash classified as a runner by src/runs.js: transcript.js emits type 'tool' with tool:'Bash'; runs.js upgrades it)
  // result.bashEditDiff is passed through when present so runs.js can drop a "run" whose command names a file it changed in the repo.
  // result.backgroundTaskId (and timedOutAfterMs when the move followed a timeout) are copied from toolUseResult: the call returned before the command finished and stdout '' says nothing.
  tool?: { name: string, input: any, result: { stdout?: string, stderr?: string, isError: boolean, interrupted?: boolean, bashEditDiff?: any, backgroundTaskId?: string, timedOutAfterMs?: number } | null },
  // type commit: Bash containing `git commit`
  commit?: { command: string, message: string|null },
  // type say: assistant text block (never thinking)
  say?: { text: string },
  // type usage: deduped later by (messageId, requestId) in src/cost.js; cacheWrite1h (from usage.cache_creation.ephemeral_1h_input_tokens) only when > 0
  usage?: { model: string|null, input: number, output: number, cacheWrite: number, cacheRead: number, cacheWrite1h?: number },
  pr_link?: { prNumber: number, prUrl: string|null, prRepository: string|null, source: 'pr-link'|'gitOperation' } }
```
Extra fields beyond the above are allowed and present: `edit.created`/`edit.deleted` (bashEditDiff flags), `commit.isError`, a `tool` field on edit events, `edit.checkout` and `ev.checkout` (set by the CLI, see below). `readSession` also returns `agentId` (subagent transcripts carry the PARENT sessionId plus an agentId). Helpers exported for the other modules: `commandNamesFile(command, file, cwd)`, `isGitPlumbing(command)`, `isBulkFormatter(command)`, `bashEditDiffSource(command, file, cwd, writeTargets?)`, `isCorroboratedSource(source)`.
Tool results live in a later `user` line whose `message.content[].tool_use_id` matches; `readSession` joins them (toolUseId → result, toolUseResult). Unknown entry types are counted in `stats.skipped[type]`.

## Session discovery: `src/discover.js`
```js
export function encodeProjectDir(cwd)                 // '/home/alice/foo' -> '-home-alice-foo' (every path separator and '.' and other non [A-Za-z0-9-] become '-')
export async function listCandidateSessions({ repoRoot, projectsDir = '~/.claude/projects', deep = false, since = null }) // recursive scan of *.jsonl (incl. subagents/** and workflows/**) whose FIRST entries' cwd is inside repoRoot, cheap: reads the first ~50 lines of each file. With deep: true, files whose head cwd is elsewhere are kept when the whole file mentions the repo (a `"cwd":"<repoRoot>..."` or `"file_path":"<repoRoot>/..."` byte match; ~1.5 s per 500 MB); `since` (ISO) skips the deep scan for files not modified since then. => [{ path, cwd, firstTs, lastTs?, sessionId, agentId?, gitBranch?, match?: 'deep' }]
export async function fileMentionsRepo(file, repoRoot)  // the byte scan used by deep discovery
export function scoreSession(session, { repoRoot, prNumber, prRepository, headRef, diffFiles, timeWindow }) // => { score, reasons, fileHits, prHit }
export async function discoverSessionsForPR({ repoRoot, prNumber, prRepository, baseRef, headRef, diffFiles, timeWindow: {start,end}, projectsDir, minScore = 10, candidates, onSession }) // => { sessions: [{ path, sessionId, score, reasons: string[] }], considered: number }
```
Scoring: +100 pr_link/gitOperation.pr match on prNumber (+repository), +10 per edit/shell_edit of a file in diffFiles inside timeWindow (cap 60; shell_edits with source `bashEditDiff-git` or `bashEditDiff-uncorroborated` do not count), +5 gitBranch === headRef, +1 cwd match. Sessions with score >= 10 are selected unless `--sessions` overrides. The CLI runs listCandidateSessions with `deep: true` (subagents started from another directory edit the repo by absolute path) and scores with `scoreSession` after remapping worktree paths (see CLI).

## Diff: `src/diff.js`
```js
export function gitDiffHunks({ repoRoot, base, head = 'HEAD', stats })   // runs `git -c core.quotePath=false diff -U0 --no-color --no-ext-diff -M <base>...<head>` ; => Hunk[]
export function parseUnifiedDiff(text, { repoRoot, stats })              // pure parser used by tests and --diff FILE
export function normalizeLine(s)                                         // trim, collapse whitespace
```
`Hunk` = `{ id: 'file.ext:newStart', file: absolute, relFile, oldStart, oldLines, newStart, newLines, added: string[], removed: string[], addedNormalized: string[], kind: 'modify'|'add'|'delete'|'rename', oldRelFile?, oldFile? }` (the two old* fields only for renames). Binary files produce no hunks; the optional `stats` object receives `{ files, hunks, binary, binaryFiles[], renames, newFiles, deletedFiles, filesWithoutHunks }`. Deletion-only hunks have `newStart === 0`.

## Attribution: `src/attribute.js`
```js
export function attributeHunks(hunks, events, { threshold = 0.6, since = null } = {}) // => AttributedHunk[]
```
`AttributedHunk` = Hunk + `{ attribution: 'MATCHED'|'FILE_LEVEL'|'UNATTRIBUTED', score: number (0..1), edits: Array<{ts, sessionId, tool, toolUseId, source?, checkout?, chain: boolean}>, churn: number (edit events on this file whose new content overlaps the hunk), lastEdit: string|null, intent: { text: string, ts: string, sessionId: string }|null, reason?: string, checkout?: string }`
Matching: share of `addedNormalized` lines (non-empty) found in an edit event's new content (edit.newContent, edit.addedLines, shell hunks '+' lines) for the same file. Also accept matches against the post-edit file reconstructed from originalFile+structuredPatch when provided. Chains = edits of the file grouped by session; the chain with the best share wins, ties go to a chain containing an Edit/Write/MultiEdit/NotebookEdit over shell-only chains, then to the later chain. `edits` lists EVERY overlapping edit across sessions (MATCHED) or every edit of the file (FILE_LEVEL), sorted by ts, `chain: true` on the winning chain's entries, so `lastEdit` is always the ts of a listed edit (it may belong to another session than the chain). shell_edits with source `bashEditDiff-git`/`bashEditDiff-uncorroborated` are not edits here. `since` (ISO, the merge-base commit time passed by the CLI): a FILE_LEVEL hunk whose every candidate edit predates it becomes UNATTRIBUTED with `reason: 'only edits before the branch base'` (edits: [], lastEdit: null); MATCHED hunks are never downgraded. `checkout` = `edit.checkout` of the edit that defines lastEdit, when present. `intent` = the agent's text for the last edit of the winning chain (MATCHED) or the last edit of the file (FILE_LEVEL): a `say` of the same session in the same assistant message (messageId) as the edit always qualifies; otherwise the last preceding `say` of the same session qualifies when it is at most 15 minutes before the edit and no tool call of that session (edit, shell_edit, tool, run, commit) lies between them in a third message (calls in the say's or the edit's own message are fine); else null. Events without messageId fall back to the time cap alone. Text <= 200 chars after trimming, more cut with "…".

## Runs: `src/runs.js`
```js
export function classifyRun(command, { repoRoot, packageScripts = {}, makeTargets = [] } = {}) // => { isRun: boolean, runner: string|null, writes: boolean, targets: string[] (paths or stems named in the command), silentOk: boolean (the runner is the last segment and its stdout is not redirected to a file: an empty stdout with exit 0 may mean pass) }
export function splitSegments(text)                                 // quote-aware split on && || | |& ; newline and " & ": operators inside '...', "..." or `...` are data
export function parseOutcome(runner, stdout, stderr, isError, { silentPass = true } = {}) // => { outcome: 'pass'|'fail'|'unparsed', summary: string|null }; silentPass:false turns the "no output, exit ok => pass" rule off
export function extractRuns(events, ctx)                           // => Run[] sorted by ts; a result with backgroundTaskId => outcome 'unparsed', summary 'moved to background, output not captured'; silentPass = classifyRun().silentOk; ev.checkout is copied to run.checkout
export function runsForHunk(hunk, runs)                            // runs after hunk.lastEdit; each gets targeted: boolean (command names file stem/relFile/parent dir, or is a whole-project run with no path args); when hunk.checkout and run.checkout both exist and differ: targeted=false, otherCheckout=true
export function hunkStatus(hunk, runsAfter)                        // => 'RUN_PASS'|'RUN_FAIL'|'RUN_UNPARSED'|'UNRUN'|'UNATTRIBUTED' (UNATTRIBUTED when hunk.attribution==='UNATTRIBUTED'; else decided by decidingRun(runsAfter): the LAST run after lastEdit with a parsed outcome, targeted ones first, other-checkout runs never; an unparsed run never hides a parsed one; only unparsed (or other-checkout) runs => RUN_UNPARSED; any run => not UNRUN)
export function decidingRun(runsAfter)                             // the run hunkStatus looks at, or null; with nothing parsed, the last same-checkout run, else the last run
export function isTargeted(hunk, run), stripAnsi(text)             // helpers
```
`Run` = `{ ts, sessionId, toolUseId, command, runner, outcome, summary, isError, targets: string[], checkout?: string }`
Runners: pytest, python -m pytest, unittest, jest, vitest, mocha, go test|build|vet, cargo test|check|clippy|build, tsc, ruff, eslint, mypy, pyright, make <target>, npm|pnpm|yarn|bun (run) test|build|lint|typecheck|check, package.json scripts, Makefile targets, direct `python x.py` / `node x.js` / `./x.sh` / `bash x.sh`. Commands that write files (sed -i, >, tee, git commit) are NOT runs, nor are hunkproof's own invocations (`node bin/hunkproof.js`, `npx hunkproof`). A Bash call whose bashEditDiff lists a repo file that the command names (commandNamesFile) is an edit, not a run; unrelated files in bashEditDiff (another agent's edit landing meanwhile) do not disqualify the run.

## Cost: `src/cost.js` + `src/prices.json`
```js
export function summarizeUsage(events)   // dedupe by `${messageId}|${requestId}` (fallback uuid), keeping the MAX of each field per call (repeated lines are cumulative snapshots) => { byModel: {model:{input,output,cacheWrite,cacheRead,messages,cacheWrite1h?}}, totals, costListUSD, priceListDate, costByModel: {model: number|null}, unpricedModels: string[] }
export function priceFor(model), costOf(model, usage)  // helpers; 1h cache writes are billed 2x input
```
Label constant: `export const COST_LABEL = 'what these tokens would cost at Anthropic API list prices; not a bill (subscription plans have no per-token charge)'`. It describes the number, never the reader's plan or what they paid. Renderers print `unpricedModels` next to every dollar figure ("N models without a price entry excluded from the total (...)").

## Redaction: `src/redact.js`
```js
export function redact(text, { home = os.homedir() } = {})  // replaces: sk-..., sk-ant-..., ghp_/gho_/ghu_/github_pat_, AKIA..., xox[abp]-, Bearer <tok>, -----BEGIN ... PRIVATE KEY-----, JWT-looking eyJ..., high-entropy >=32 char base64/hex tokens, emails, IPv4, then the home-path rules of redactHomePaths. Returns string.
export function redactHomePaths(text, { home = os.homedir() } = {})  // the path rules only: home dir -> '~', its encoded transcript-directory form ('-home-alice' -> '~'), any other /home/<user>, /Users/<user>, C:\Users\<user> (also C:/Users/<user> and the doubled-backslash form inside string literals) -> '~'. Nothing else is touched; idempotent.
```
Secrets are masked in the agent text (intent), run commands and run summaries only; `repo.remote` is the `origin` URL with its userinfo removed by the CLI (`stripRemoteUserinfo`: `https://user:token@host/...` -> `https://host/...`, scp-style and local remotes unchanged). The home-path rules run over EVERY string of the Evidence document (`repo.root`, `hunks[].file`, `checkout` fields, diff lines `added`/`removed`, `sessions[].path`, `discovery`), and the CLI passes every output (evidence.json, HTML, Markdown, terminal, git note) through them once more.

## Evidence: `src/evidence.js`
```js
export function buildEvidence({ repo, sessions, hunks, runs, usage, elapsedMs, definitions }) // => Evidence
export function writeGitNote({ repoRoot, head, evidence })  // git notes --ref=hunkproof add -f -F <tmpfile> <head> ; => { ref, head: sha }
export function readGitNote({ repoRoot, head })             // => Evidence|null (null for a missing, foreign or corrupt note)
export function redactEvidence(evidence, { home })          // the home-path rules over every string of the document, fields added after buildEvidence included; deep, idempotent, does not mutate
export const REDACTION                                      // { home: '~', rules: string[4], note } copied into evidence.redaction
```
`Evidence` =
```ts
{ schema: 'hunkproof/evidence@1', generatedAt, tool: { name:'hunkproof', version },
  repo: { root, remote: string|null, base, head, prNumber: number|null, prUrl: string|null, headSha?, mergeBase?, mergeBaseTs? },  // headSha/mergeBase/mergeBaseTs added by the CLI
  // one row per transcript FILE. Subagent transcripts share the parent's sessionId, so the CLI uses their agentId as sessionId (events too) and adds parentSessionId
  sessions: [{ sessionId, path (home replaced by ~), firstTs, lastTs, versions: string[], models: string[], toolCalls: number, edits: number, shellEdits: number, runs: number, parentSessionId? }],
  hunks: AttributedHunk & { status, runsAfter: Run[] (ts, sessionId, command, runner, outcome, summary, targeted, otherCheckout? (only when true)) }  // intent.text already redacted
  runs: Run[],
  usage: { ...summarizeUsage(), label: COST_LABEL },
  // attributed = matched: only line-matched hunks are in the headline; runAfterLastEdit/runPass/runFail/runUnparsed/strictRunAfterLastEdit count MATCHED hunks only (a FILE_LEVEL hunk's lastEdit is the file's, not the lines'); unrun counts every hunk with status UNRUN (MATCHED and FILE_LEVEL)
  summary: { hunks, attributed, matched, fileLevel, unattributed, runAfterLastEdit, runPass, runFail, runUnparsed, unrun, strictRunAfterLastEdit, sessions, durationSec, toolCalls, llmTokensUsedByHunkproof: 0, elapsedMs },
  definitions: { hunk, attribution, run, status, targeted, cost }, // plain-English strings printed in footers
  redaction: { home: '~', rules: string[], note: string },  // what was rewritten before the document was written anywhere; the renderers print `note` in their footers
  discovery?: { candidates, considered, selected: [{ sessionId, path, score, reasons }], timeWindow: { start, end, firstCommit } } // added by the CLI
}
```
`buildEvidence` also accepts optional `generatedAt`, `version`, `home` (determinism), redacts `intent.text`, `runs[].command/summary` and `hunks[].runsAfter[]` commands (secrets), then runs the home-path rules over every string of the document (`redactEvidence`).

## Renderers: `src/render-html.js`, `src/render-md.js`
```js
export function renderHtml(evidence, { theme: 'auto' } = {})  // => string, SINGLE self-contained file, no CDN, inline CSS/JS, light+dark via prefers-color-scheme, summary bar, per-file sections with hunks (added/removed lines), margin note (intent), badges, per-hunk run timeline, "show only unrun" toggle, footer with definitions + reproduction command
export function renderMarkdown(evidence, { quotes = false, blobBase = null, maxChars = 60000 } = {}) // => string, text-free by default (no intent quotes), summary line, table of unrun hunks with file:line links (blobBase/<relFile>#L<newStart>), collapsed <details> with one line per hunk naming the run that decided it, a collapsed list of the distinct deciding runs (command cut to 100 chars), definitions, reproduction command. Degrades to stay <= maxChars (GitHub rejects comments over 65,536 chars): first drops the commands, then the per-hunk list
export function reproCommand(evidence)                        // => 'npx hunkproof [--pr N] [--base X] [--head Y]': every ref present in evidence.repo is printed, the PR number alone would diff another range
export function renderTerminal(evidence)                      // => string, the headline + table (header 'last run (UTC)', status cell gets ' (file-level)', last-run cell = decidingRun with ' (targeted)' ' (other checkout)' ' (other session)' markers and the date when it differs from generatedAt) + the agent cost line, printed by the CLI
```
Headline (summarySentence, same words in all three renderers): `N of M line-matched hunks had a run after their last edit (x passed, y failed, z outcome not parsed) · F file-level (lines not matched to an edit) · U unrun · V unattributed · S sessions · hunkproof used 0 LLM tokens`.
Renderers consume ONLY `Evidence`. Byte-identical output for identical evidence (no Date.now()). Agent commands, run summaries and diff lines are quoted verbatim (redacted); the vocabulary rule applies to the tool's own strings and is checked with every data field set to a sentinel.

## Stats: `src/stats.js`
```js
export async function corpusStats({ projectsDir, since, workers, onProgress }) // streams every transcript (one at a time, split over child processes: src/stats-worker.js), merges per project (the encoded cwd directory under projectsDir), => { projects, sessions, filesEdited, editEvents, shellEdits, toolEdits, runs, commits, fileEdits, loose: {noRunAfterLastEdit: n, pct}, strict: {noTargetedRunAfterLastEdit: n, pct}, pass: {noPassingRunAfterLastEdit: n, pct}, commitsWithEdits, commitsWithEditAfterLastRun: {n, pct}, commitsWithEditAfterLastPass: {n, pct}, byProject: [...same per project], transcripts, bytes, elapsedMs }
export function renderStats(stats)  // terminal table: project, sessions, files (distinct), file edits, edits, runs, commits, unrun, strict, no pass, commit after edit; every ratio prints as `n/d (p%)`
export function anonymizeStats(stats)  // project directories replaced by project-01..project-NN (by sessions descending, ties by edits then name), rows in that order, cwd nulled, projectsDir tildified, `anonymized: true`; every number and the "all projects" row unchanged
```
Units: `fileEdits` = (transcript, file) pairs with at least one edit; `loose`/`strict`/`pass` count pairs whose last edit has no run / no targeted run / no passing run after it in the same transcript; `commitsWithEdits` = successful `git commit` calls preceded by an edit in the transcript, of which `commitsWithEditAfterLastRun` include an edit made after the last run (`...LastPass`: after the last passing run). Files under /tmp, the OS temp dir and ~/.claude are not counted as edits. `since` is an ISO timestamp compared with the file mtime (CLI default: 90 days).

## CLI: `bin/hunkproof.js`
```
hunkproof [--pr N] [--base REF] [--head REF] [--repo PATH] [--sessions a.jsonl,b.jsonl] [--out DIR] [--open] [--json] [--post [--quotes] [--yes]] [--evidence FILE --diff FILE] [--from-note] [--no-note]
hunkproof stats [--since DAYS] [--anonymize]
hunkproof note show
```
Default out dir: `<repo>/.hunkproof/`. hunkproof never edits the repository it reports on: when the directory is not gitignored it prints `hint: add .hunkproof/ to .gitignore` on stderr. Writes evidence.json, hunkproof.html, hunkproof.md. Prints renderTerminal. `--post` previews the markdown (passed through redact once more), asks `Post this comment to PR #N? [y/N]` (y/yes, any case, posts; anything else or a closed stdin does not), then `gh pr comment N --body-file` with fallback `gh api repos/{owner}/{repo}/issues/{N}/comments -F body=@file`.
Exit codes: 0 ok, 2 no sessions found (still writes the diff-only report with all hunks UNATTRIBUTED), 1 error.

Flow (src/cli.js, `runCli(argv, io)`): repo root via `git rev-parse --show-toplevel`; PR metadata via `gh pr view N --json ...` (fallback `gh api repos/o/r/pulls/N`); refs: a merged PR is diffed from its merge commit (`sha^1...sha^2`, or `sha^1...sha` for squash/rebase merges), an open PR from `origin/<base>` to the head branch (HEAD when checked out), no PR from `--base`/origin HEAD/main/master to `--head`/HEAD; base for the diff is `base...head` (merge base). Time window = first commit of `mergeBase..head` minus 2 h (`--window-hours`) .. now; a merged PR ends at the committer time of its merge commit (`mergedAt`): transcript candidates that start after it are skipped and events after it are dropped (`dropEventsAfter`) before extractRuns/attributeHunks, sessions left empty are not listed, and a session's `meta.lastTs` is clamped to the last event kept (so `sessions[].lastTs` and `summary.durationSec` do not move when the transcript grows after the merge). Discovery = deep listCandidateSessions + scoreSession >= 10. Edits made in a git worktree of the repo (incl. `<repo>/.claude/worktrees/<name>`) are remapped onto the repo root; before the rewrite `edit.checkout` records the checkout (worktree root or repo root), and Bash tool events get `ev.checkout` from the directory they ran in (`checkoutOf(effectiveRunDir(command, cwd))`), so runs.js can tell a run made in a checkout that did not contain the edit. Bash events count as runs only when they execute inside the repo (entry cwd or a leading `cd`) or name a path inside it. Events of all selected transcripts are merged and stably sorted by ts before extractRuns/attributeHunks; attributeHunks receives `since` = committer time of the merge base (`repo.mergeBaseTs`). After `discovery` and the merge-base fields are attached, `redactEvidence` runs once more over the document, and every output file, the terminal render and `--json` go through `redactHomePaths`. `--evidence FILE` and `--from-note` replay a saved document (render/post only). `--diff FILE` parses a unified diff instead of running git.
