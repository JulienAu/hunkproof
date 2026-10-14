// Evidence document (schema hunkproof/evidence@1) plus git notes storage.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_LABEL, summarizeUsage } from './cost.js';
import { redact, redactHomePaths } from './redact.js';

export const EVIDENCE_SCHEMA = 'hunkproof/evidence@1';
export const NOTES_REF = 'hunkproof';

const here = path.dirname(fileURLToPath(import.meta.url));

function toolVersion() {
  try {
    return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Plain-English footers. They follow the vocabulary rule in CLAUDE.md (say
// "run after last edit", "unrun", "ran, failed", "ran, outcome not parsed").
export const DEFINITIONS = {
  hunk: 'A hunk is one contiguous block of added or removed lines in the diff between the base and head commits (git diff -U0). Its id is the file and the first new line number.',
  attribution: 'MATCHED (line-matched): most of the added lines appear in an edit the agent made to this file during a session; only these hunks count as attributed in the headline. FILE_LEVEL: the agent edited this file in a session, but the added lines could not be found in any edit, so the run timing is relative to the file\'s last edit, not to the lines. UNATTRIBUTED: no session edit of this file was found, or the only edits of the file predate the branch base commit. Working-tree changes a shell command cannot have written (a merge, files changed by another agent while the command ran) are not counted as edits.',
  run: 'A run is a shell command that executes code: a test runner, a linter, a type checker, a build, or a direct script invocation. Commands that only write files are not runs, nor are hunkproof\'s own invocations. Outcome is pass, fail, or unparsed when the exit status and output could not be read (including commands moved to the background).',
  status: 'Decided by the last run after the hunk\'s last edit whose outcome was parsed, targeted runs first; a run made in another checkout than the edit (a git worktree) never decides. RUN_PASS: that run passed. RUN_FAIL: it failed ("ran, failed"). RUN_UNPARSED: runs happened after the last edit but none had a parsable outcome ("ran, outcome not parsed"). UNRUN: no run at all after the last edit. UNATTRIBUTED: the hunk could not be tied to a session edit, so nothing is known about runs.',
  targeted: 'A run is targeted when the command names the file, its stem or its parent directory, or when it is a whole-project run with no path arguments. The strict count only accepts targeted runs after the last edit.',
  cost: `Token counts come from the session transcripts, deduplicated per API call. The dollar figure is ${COST_LABEL}; it comes from a dated public price table and is not what was billed. Models without a price entry are listed and left out of the total. Hunkproof itself makes no LLM call (0 tokens).`,
};

// What the document rewrites before it is written anywhere (evidence.json,
// HTML, Markdown, terminal, git note). Printed by the renderers, so a reader
// of a public report knows exactly what was changed and that nothing else was.
export const REDACTION = {
  home: '~',
  rules: [
    'the home directory of the machine that ran hunkproof is rewritten to ~ in every string of this document, file paths and diff lines included',
    'its encoded transcript-directory form (/home/<user> written as -home-<user> under ~/.claude/projects) is rewritten to ~',
    'any other home directory prefix (/home/<user>, /Users/<user>, C:\\Users\\<user>) is rewritten to ~',
    'in the agent text (intent), run commands and run summaries only: API keys, tokens, private keys, JWTs, emails, IPv4 addresses and long high-entropy strings are replaced by [REDACTED:<kind>]',
  ],
  note: 'Home directories are rewritten to ~ in every field, diff lines included; secrets are masked in the agent text, run commands and run summaries only; nothing else is rewritten.',
};

const RUN_KEYS = ['ts', 'sessionId', 'command', 'runner', 'outcome', 'summary', 'targeted', 'otherCheckout'];

// Apply redactHomePaths to every string reachable from `value` (arrays and
// plain objects are walked; keys are left alone). Returns a new structure.
function redactStrings(value, home) {
  if (typeof value === 'string') return redactHomePaths(value, { home });
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, home));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactStrings(v, home);
    return out;
  }
  return value;
}

/**
 * redactEvidence(evidence, { home }) => Evidence
 * The path rules of REDACTION over the whole document (every string field,
 * fields the CLI adds after buildEvidence included). Idempotent, so the CLI
 * can call it again after it attaches `discovery` and the merge-base data.
 */
export function redactEvidence(evidence, { home = os.homedir() } = {}) {
  return redactStrings(evidence, home);
}

function count(arr, pred) {
  let n = 0;
  for (const x of arr) if (pred(x)) n++;
  return n;
}

function minMaxTs(sessions) {
  let first = null;
  let last = null;
  for (const s of sessions) {
    if (s.firstTs && (first === null || s.firstTs < first)) first = s.firstTs;
    if (s.lastTs && (last === null || s.lastTs > last)) last = s.lastTs;
  }
  if (!first || !last) return 0;
  const ms = Date.parse(last) - Date.parse(first);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

function pickRun(r, home) {
  const out = {};
  for (const k of RUN_KEYS) {
    if (k in r) out[k] = r[k];
  }
  if (typeof out.command === 'string') out.command = redact(out.command, { home });
  if (typeof out.summary === 'string') out.summary = redact(out.summary, { home });
  return out;
}

/**
 * buildEvidence({ repo, sessions, hunks, runs, usage, elapsedMs, definitions,
 *                 generatedAt, version, home }) => Evidence
 * `generatedAt`, `version` and `home` are optional and exist so tests and
 * renderers can produce byte-identical documents.
 */
export function buildEvidence({
  repo = {},
  sessions = [],
  hunks = [],
  runs = [],
  usage = null,
  elapsedMs = 0,
  definitions = {},
  generatedAt = new Date().toISOString(),
  version = toolVersion(),
  home = os.homedir(),
} = {}) {
  const repoOut = {
    root: repo.root ?? null,
    remote: repo.remote ?? null,
    base: repo.base ?? null,
    head: repo.head ?? null,
    prNumber: repo.prNumber ?? null,
    prUrl: repo.prUrl ?? null,
  };

  const sessionsOut = sessions.map((s) => ({
    sessionId: s.sessionId ?? null,
    path: s.path ?? null,
    firstTs: s.firstTs ?? null,
    lastTs: s.lastTs ?? null,
    versions: Array.isArray(s.versions) ? [...s.versions] : [],
    models: Array.isArray(s.models) ? [...s.models] : [],
    toolCalls: s.toolCalls ?? 0,
    edits: s.edits ?? 0,
    shellEdits: s.shellEdits ?? 0,
    runs: s.runs ?? 0,
  }));

  const hunksOut = hunks.map((h) => {
    const runsAfter = Array.isArray(h.runsAfter) ? h.runsAfter.map((r) => pickRun(r, home)) : [];
    const attribution = h.attribution ?? 'UNATTRIBUTED';
    const status = h.status ?? (attribution === 'UNATTRIBUTED' ? 'UNATTRIBUTED' : 'UNRUN');
    const intent = h.intent
      ? { ...h.intent, text: redact(h.intent.text ?? '', { home }) }
      : null;
    return { ...h, attribution, status, intent, runsAfter };
  });

  const runsOut = runs.map((r) => ({
    ...r,
    command: typeof r.command === 'string' ? redact(r.command, { home }) : r.command,
    summary: typeof r.summary === 'string' ? redact(r.summary, { home }) : r.summary ?? null,
  }));

  const usageOut = { ...(usage ?? summarizeUsage([])), label: COST_LABEL };

  // The headline is over line-matched hunks only: a FILE_LEVEL hunk's "last
  // edit" is the file's, not the lines', so its run timing is weaker evidence.
  const matched = count(hunksOut, (h) => h.attribution === 'MATCHED');
  const fileLevel = count(hunksOut, (h) => h.attribution === 'FILE_LEVEL');
  const unattributed = count(hunksOut, (h) => h.attribution === 'UNATTRIBUTED');
  const isMatched = (h) => h.attribution === 'MATCHED';
  const summary = {
    hunks: hunksOut.length,
    attributed: matched,
    matched,
    fileLevel,
    unattributed,
    runAfterLastEdit: count(hunksOut, (h) => isMatched(h) && h.runsAfter.length > 0),
    runPass: count(hunksOut, (h) => isMatched(h) && h.status === 'RUN_PASS'),
    runFail: count(hunksOut, (h) => isMatched(h) && h.status === 'RUN_FAIL'),
    runUnparsed: count(hunksOut, (h) => isMatched(h) && h.status === 'RUN_UNPARSED'),
    unrun: count(hunksOut, (h) => h.status === 'UNRUN'),
    strictRunAfterLastEdit: count(
      hunksOut,
      (h) => isMatched(h) && h.runsAfter.some((r) => r.targeted === true),
    ),
    sessions: sessionsOut.length,
    durationSec: minMaxTs(sessionsOut),
    toolCalls: sessionsOut.reduce((n, s) => n + (s.toolCalls || 0), 0),
    llmTokensUsedByHunkproof: 0,
    elapsedMs,
  };

  // Secrets were masked above in the fields that carry agent text; the path
  // rules then run over every string of the document (repo root, file paths,
  // checkouts, diff lines, session paths).
  return redactEvidence({
    schema: EVIDENCE_SCHEMA,
    generatedAt,
    tool: { name: 'hunkproof', version },
    repo: repoOut,
    sessions: sessionsOut,
    hunks: hunksOut,
    runs: runsOut,
    usage: usageOut,
    summary,
    definitions: { ...DEFINITIONS, ...definitions },
    redaction: { ...REDACTION, rules: [...REDACTION.rules] },
  }, { home });
}

function git(repoRoot, args, input) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    // an evidence document on a medium PR is a few MB; the 1 MB default
    // makes `git notes show` throw ENOBUFS and the note read as missing
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * writeGitNote({ repoRoot, head = 'HEAD', evidence }) => { ref, head: sha }
 * Runs `git notes --ref=hunkproof add -f -F <tmpfile> <head>`; the temp file
 * lives in os.tmpdir() and is removed afterwards.
 */
export function writeGitNote({ repoRoot, head = 'HEAD', evidence }) {
  if (!repoRoot) throw new Error('writeGitNote: repoRoot is required');
  if (!evidence || typeof evidence !== 'object') throw new Error('writeGitNote: evidence is required');
  const sha = git(repoRoot, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hunkproof-note-'));
  const file = path.join(dir, 'evidence.json');
  try {
    writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', file, sha]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ref: `refs/notes/${NOTES_REF}`, head: sha };
}

/**
 * readGitNote({ repoRoot, head = 'HEAD' }) => Evidence|null
 * Runs `git notes --ref=hunkproof show <head>`; null when there is no note,
 * the ref does not resolve, or the note is not a hunkproof evidence document.
 */
export function readGitNote({ repoRoot, head = 'HEAD' }) {
  if (!repoRoot) throw new Error('readGitNote: repoRoot is required');
  let text;
  try {
    text = git(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'show', head]);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== EVIDENCE_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}
