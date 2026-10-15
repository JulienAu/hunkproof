// Command-line flow for hunkproof. Everything here is glue over the modules
// described in CONTRACT.md; runCli() is exported so tests can drive it with a
// scratch repo and a synthetic ~/.claude/projects tree.
//
// Only `gh` talks to the network (PR metadata, PR comments). Transcripts are
// read from disk; nothing else leaves the machine.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { readSession, repositoryFromPrUrl } from './transcript.js';
import { expandHome, listCandidateSessions, scoreSession } from './discover.js';
import { gitDiffHunks, parseUnifiedDiff } from './diff.js';
import { attributeHunks } from './attribute.js';
import { extractRuns, runsForHunk, hunkStatus } from './runs.js';
import { summarizeUsage } from './cost.js';
import { redact, redactHomePaths } from './redact.js';
import { buildEvidence, redactEvidence, readGitNote, writeGitNote, NOTES_REF } from './evidence.js';
import { renderHtml } from './render-html.js';
import { renderMarkdown } from './render-md.js';
import { renderTerminal } from './render-terminal.js';
import { anonymizeStats, corpusStats, renderStats } from './stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const USAGE = `hunkproof: stamps every hunk of a PR with what the agent ran after writing it.

Usage:
  hunkproof [--pr N] [--base REF] [--head REF] [--repo PATH] [--sessions a.jsonl,b.jsonl]
            [--out DIR] [--open] [--json] [--post [--quotes] [--yes]]
            [--evidence FILE] [--diff FILE] [--from-note] [--no-note] [--theme auto|light|dark]
  hunkproof stats [--since DAYS] [--anonymize] [--json]
  hunkproof note show [--head REF] [--json]

Options:
  --pr N            pull request number (metadata via gh); merged PRs are diffed from their merge commit
                    and transcript events after the merge are left out
  --base REF        base ref (default: the PR base, else origin/HEAD, main or master)
  --head REF        head ref (default: the PR head, else HEAD)
  --repo PATH       repository path (default: the current directory)
  --sessions LIST   comma-separated transcript paths; skips discovery
  --out DIR         output directory (default: <repo>/.hunkproof)
  --open            open the HTML report
  --json            print the evidence document instead of the table
  --post            preview the Markdown comment, ask, then post it to the PR with gh
  --quotes          include the agent's intent quotes in the comment (off by default)
  --yes             skip the confirmation prompt of --post
  --evidence FILE   render and post from a saved evidence.json (no transcript reading)
  --diff FILE       read hunks from a unified diff file instead of git
  --from-note       render from the evidence stored in the git note of the head commit
  --no-note         do not write the git note (refs/notes/hunkproof)
  --since DAYS      stats: only transcripts modified in the last DAYS days (default 90)
  --anonymize       stats: name projects project-01..project-NN (by sessions, descending) instead of their directories
  --projects-dir D  transcript root (default ~/.claude/projects)
  -h, --help        this text
  --version         print the version

Exit codes: 0 ok, 2 no session matched (diff-only report written), 1 error.
`;

const OPTIONS = {
  pr: { type: 'string' },
  base: { type: 'string' },
  head: { type: 'string' },
  repo: { type: 'string' },
  sessions: { type: 'string' },
  out: { type: 'string' },
  evidence: { type: 'string' },
  diff: { type: 'string' },
  since: { type: 'string' },
  theme: { type: 'string' },
  'projects-dir': { type: 'string' },
  'window-hours': { type: 'string' },
  open: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  post: { type: 'boolean', default: false },
  quotes: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  'from-note': { type: 'boolean', default: false },
  'no-note': { type: 'boolean', default: false },
  anonymize: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
};

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ------------------------------------------------------------------ helpers

function git(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).replace(/\n$/, '');
}

function tryGit(root, args) {
  try { return git(root, args); } catch { return null; }
}

function gh(args, { cwd }) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

// Paths printed on the terminal go through the same home-path rules as the
// documents (home -> ~, its encoded transcript-directory form, other homes).
function tildify(p) {
  if (typeof p !== 'string') return p;
  return redactHomePaths(p);
}

export function resolveRepoRoot(repoOpt) {
  const start = path.resolve(expandHome(repoOpt || process.cwd()));
  const root = tryGit(start, ['rev-parse', '--show-toplevel']);
  if (!root) throw new CliError(`not a git repository: ${start}`);
  return path.resolve(root);
}

export function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` } : null;
}

/**
 * stripRemoteUserinfo(url) => string|null
 * The remote URL is stored in the evidence (and in the git note, which can be
 * pushed). A URL that carries credentials (`https://user:ghp_...@host/...`)
 * loses its userinfo; scp-style `git@host:path` and local paths are returned
 * unchanged.
 */
export function stripRemoteUserinfo(url) {
  if (typeof url !== 'string') return url === undefined ? null : url;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@(.*)$/i.exec(url.trim());
  return m ? `${m[1]}${m[3]}` : url;
}

function refExists(root, ref) {
  return tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

function firstExisting(root, refs) {
  for (const r of refs) if (r && refExists(root, r)) return r;
  return null;
}

export function defaultBaseRef(root) {
  const sym = tryGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym) return sym.replace(/^refs\/remotes\//, '');
  return firstExisting(root, ['origin/main', 'main', 'origin/master', 'master']);
}

// ------------------------------------------------------------------ PR data

function normalizePrView(v) {
  const headOwner = v.headRepositoryOwner && v.headRepositoryOwner.login;
  const headName = v.headRepository && v.headRepository.name;
  return {
    number: Number(v.number),
    url: typeof v.url === 'string' ? v.url : null,
    baseRefName: v.baseRefName || null,
    headRefName: v.headRefName || null,
    headRepository: headOwner && headName ? `${headOwner}/${headName}` : null,
    repository: repositoryFromPrUrl(v.url),
    merged: v.state === 'MERGED',
    mergeCommit: v.mergeCommit && v.mergeCommit.oid ? v.mergeCommit.oid : null,
  };
}

function normalizePrApi(a) {
  return {
    number: Number(a.number),
    url: typeof a.html_url === 'string' ? a.html_url : null,
    baseRefName: a.base && a.base.ref ? a.base.ref : null,
    headRefName: a.head && a.head.ref ? a.head.ref : null,
    headRepository: a.head && a.head.repo && a.head.repo.full_name ? a.head.repo.full_name : null,
    repository: repositoryFromPrUrl(a.html_url),
    merged: a.merged === true,
    mergeCommit: a.merged === true && typeof a.merge_commit_sha === 'string' ? a.merge_commit_sha : null,
  };
}

export function resolvePr(root, prNumber, remote, { warn = () => {} } = {}) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`--pr expects a positive integer, got "${prNumber}"`);
  const fields = 'baseRefName,headRefName,url,number,headRepository,headRepositoryOwner,state,mergeCommit';
  try {
    return normalizePrView(JSON.parse(gh(['pr', 'view', String(n), '--json', fields], { cwd: root })));
  } catch (e) {
    warn(`gh pr view failed (${firstLine(e)}); trying gh api`);
  }
  if (!remote) throw new CliError(`cannot resolve PR #${n}: gh pr view failed and origin is not a GitHub remote`);
  try {
    return normalizePrApi(JSON.parse(gh(['api', `repos/${remote.full}/pulls/${n}`], { cwd: root })));
  } catch (e) {
    throw new CliError(`cannot resolve PR #${n} with gh: ${firstLine(e)}`);
  }
}

function firstLine(e) {
  const s = (e && (e.stderr || e.message)) ? String(e.stderr || e.message) : String(e);
  return s.split('\n').find((l) => l.trim()) || 'unknown error';
}

// Pick base and head refs from the PR metadata and the flags.
export function resolveRefs(root, { pr, base, head, currentBranch }) {
  let baseRef = base || null;
  let headRef = head || null;
  if (pr && pr.merged && pr.mergeCommit && !baseRef && !headRef && refExists(root, pr.mergeCommit)) {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', pr.mergeCommit]).split(/\s+/).slice(1);
    if (parents.length >= 2) { baseRef = `${pr.mergeCommit}^1`; headRef = `${pr.mergeCommit}^2`; }
    else { baseRef = `${pr.mergeCommit}^1`; headRef = pr.mergeCommit; } // squash or rebase merge
  }
  if (pr && !baseRef) baseRef = firstExisting(root, [`origin/${pr.baseRefName}`, pr.baseRefName]);
  if (pr && !headRef) {
    if (pr.headRefName && currentBranch === pr.headRefName) headRef = 'HEAD';
    else headRef = firstExisting(root, [pr.headRefName, `origin/${pr.headRefName}`]);
    if (!headRef && pr.headRefName) throw new CliError(`head branch ${pr.headRefName} of PR #${pr.number} is not available locally; fetch it or pass --head`);
  }
  if (!baseRef) baseRef = defaultBaseRef(root);
  if (!headRef) headRef = 'HEAD';
  if (!baseRef) throw new CliError('cannot determine the base ref; pass --base');
  if (!refExists(root, baseRef)) throw new CliError(`unknown base ref: ${baseRef}`);
  if (!refExists(root, headRef)) throw new CliError(`unknown head ref: ${headRef}`);
  const mergeBase = tryGit(root, ['merge-base', baseRef, headRef]);
  if (!mergeBase) throw new CliError(`no merge base between ${baseRef} and ${headRef}`);
  const headSha = git(root, ['rev-parse', `${headRef}^{commit}`]);
  return { baseRef, headRef, mergeBase, headSha };
}

// Committer time of a commit as ISO UTC, or null.
export function commitTime(root, ref) {
  const raw = tryGit(root, ['log', '-1', '--format=%cI', ref]);
  const t = raw ? Date.parse(raw.trim()) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Window = first commit of the branch minus `hours` .. now. Null start when the
// range has no commit (e.g. head == merge base). `end` (ISO) replaces now: a
// merged PR ends at its merge commit, see mergedAt().
export function timeWindowFor(root, mergeBase, headRef, { hours = 2, now = new Date(), end = null } = {}) {
  const log = tryGit(root, ['log', '--format=%aI%n%cI', '--reverse', `${mergeBase}..${headRef}`]) || '';
  let min = null;
  for (const line of log.split('\n')) {
    const t = Date.parse(line.trim());
    if (Number.isFinite(t) && (min === null || t < min)) min = t;
  }
  return {
    start: min === null ? null : new Date(min - hours * 3600 * 1000).toISOString(),
    end: end || now.toISOString(),
    firstCommit: min === null ? null : new Date(min).toISOString(),
  };
}

// Committer time of a merged PR's merge commit, or null (open PR, no PR, or
// the merge commit is not available locally). Transcript events after it are
// about the repository as it moved on, not about the PR: a run made on a tree
// that later sessions kept editing says nothing about these hunks.
export function mergedAt(root, pr) {
  if (!pr || !pr.merged || !pr.mergeCommit || !refExists(root, pr.mergeCommit)) return null;
  return commitTime(root, pr.mergeCommit);
}

// Events at or before `end` (ISO); events without a timestamp are kept.
export function dropEventsAfter(events, end) {
  if (!end) return events;
  return events.filter((ev) => !ev.ts || ev.ts <= end);
}

// ------------------------------------------------------------- sessions

// Agents working in a git worktree (Claude Code uses <repo>/.claude/worktrees/<name>)
// edit files under the worktree path; map them back onto the main checkout so
// hunks and edits compare by the same absolute path.
export function worktreeRoots(root) {
  const out = [];
  const porcelain = tryGit(root, ['worktree', 'list', '--porcelain']) || '';
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = path.resolve(line.slice('worktree '.length).trim());
    if (p !== root) out.push(p);
  }
  return out;
}

// The checkout (worktree root or the main checkout) a path falls in, or null.
export function checkoutOf(p, root, worktrees = []) {
  if (typeof p !== 'string' || !p) return null;
  const abs = path.resolve(p);
  for (const w of worktrees.map((x) => path.resolve(x))) {
    if (w !== root && isInside(abs, w)) return w;
  }
  const claudeWt = path.join(root, '.claude', 'worktrees') + '/';
  if (abs.startsWith(claudeWt)) {
    const rest = abs.slice(claudeWt.length);
    const slash = rest.indexOf('/');
    return path.join(root, '.claude', 'worktrees', slash > 0 ? rest.slice(0, slash) : rest);
  }
  if (isInside(abs, root)) return root;
  return null;
}

// Before an edit path is folded onto the repo root, the checkout it was made in
// is kept on edit.checkout; Bash events get ev.checkout from the directory they
// ran in. runs.js compares the two: a run in another checkout never saw the edit.
export function remapWorktreePaths(events, root, worktrees = []) {
  const prefixes = worktrees.map((w) => path.resolve(w)).filter((w) => w !== root);
  const claudeWt = path.join(root, '.claude', 'worktrees') + '/';
  let n = 0;
  const remap = (file) => {
    if (typeof file !== 'string') return file;
    for (const w of prefixes) {
      if (isInside(file, w)) return path.join(root, path.relative(w, file));
    }
    if (file.startsWith(claudeWt)) {
      const rest = file.slice(claudeWt.length);
      const slash = rest.indexOf('/');
      if (slash > 0) return path.join(root, rest.slice(slash + 1));
    }
    return file;
  };
  for (const ev of events) {
    if ((ev.type === 'edit' || ev.type === 'shell_edit') && ev.edit && typeof ev.edit.file === 'string') {
      const co = checkoutOf(ev.edit.file, root, prefixes);
      if (co) ev.edit.checkout = co;
      const f = remap(ev.edit.file);
      if (f !== ev.edit.file) { ev.edit.file = f; n++; }
    } else if (ev.type === 'tool' && ev.tool && ev.tool.name === 'Bash' && ev.tool.input) {
      const co = checkoutOf(effectiveRunDir(ev.tool.input.command, ev.cwd), root, prefixes);
      if (co) ev.checkout = co;
    }
  }
  return n;
}

// Subagent transcripts carry the parent's sessionId; give their events the
// agentId as identity so chains and intents never cross agent boundaries.
function identifySession(session) {
  if (!session.agentId) return session.sessionId;
  const id = session.agentId;
  for (const ev of session.events) ev.sessionId = id;
  return id;
}

function sessionRow(session, id, runs) {
  const toolUseIds = new Set();
  let edits = 0;
  let shellEdits = 0;
  for (const ev of session.events) {
    if (ev.toolUseId && (ev.type === 'tool' || ev.type === 'edit')) toolUseIds.add(ev.toolUseId);
    if (ev.type === 'edit') edits++;
    else if (ev.type === 'shell_edit') shellEdits++;
  }
  const row = {
    sessionId: id,
    path: session.path,
    firstTs: session.meta.firstTs,
    lastTs: session.meta.lastTs,
    versions: session.meta.versions,
    models: session.meta.models,
    toolCalls: toolUseIds.size,
    edits,
    shellEdits,
    runs: runs.filter((r) => r.sessionId === id).length,
  };
  if (session.agentId) row.parentSessionId = session.sessionId;
  return row;
}

async function collectSessions({ root, projectsDir, sessionsOpt, pr, headRefName, diffFiles, timeWindow, cutoff = null, worktrees, log }) {
  const picked = []; // { session, id, score, reasons, path }
  let considered = 0;
  if (sessionsOpt) {
    for (const raw of sessionsOpt.split(',').map((s) => s.trim()).filter(Boolean)) {
      const p = path.resolve(expandHome(raw));
      let session;
      try { session = await readSession(p); } catch (e) { throw new CliError(`cannot read session ${raw}: ${firstLine(e)}`); }
      considered++;
      remapWorktreePaths(session.events, root, worktrees);
      const id = identifySession(session);
      picked.push({ session, id, score: null, reasons: ['given with --sessions'], path: p });
    }
    return { picked, considered, candidates: considered };
  }
  const candidates = await listCandidateSessions({ repoRoot: root, projectsDir, deep: true, since: timeWindow.start });
  for (const cand of candidates) {
    // A transcript that ended before the branch's first commit (minus the
    // margin) cannot have edited the diff in the window nor seen the PR exist;
    // one that started after the merge of the PR is about later work.
    if (timeWindow.start && cand.lastTs && cand.lastTs < timeWindow.start) continue;
    if (cutoff && cand.firstTs && cand.firstTs > cutoff) continue;
    considered++;
    let session;
    try { session = await readSession(cand.path); } catch (e) { log(`skipping unreadable ${tildify(cand.path)}: ${firstLine(e)}`); continue; }
    remapWorktreePaths(session.events, root, worktrees);
    const { score, reasons } = scoreSession(session, {
      repoRoot: root,
      prNumber: pr ? pr.number : null,
      prRepository: pr ? pr.repository : null,
      headRef: headRefName,
      diffFiles,
      timeWindow,
    });
    if (score < 10) continue;
    const id = identifySession(session);
    picked.push({ session, id, score, reasons, path: cand.path, deep: cand.match === 'deep' });
  }
  picked.sort((a, b) => (b.score - a.score) || String(a.session.meta.firstTs || '').localeCompare(String(b.session.meta.firstTs || '')));
  return { picked, considered, candidates: candidates.length };
}

// Directory a Bash command effectively runs in: the entry cwd, or the target
// of a leading `cd DIR` (resolved against it). Null when unknown ($VAR).
export function effectiveRunDir(command, cwd) {
  const first = String(command || '').replace(/^[\s(]+/, '').split(/\n|&&|\|\||;|\|/)[0].trim();
  const m = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:cd|pushd)\s+(?:--\s+)?("([^"]*)"|'([^']*)'|(\S+))/.exec(first);
  if (!m) return cwd || null;
  const dir = m[2] ?? m[3] ?? m[4];
  if (/[$`]/.test(dir)) return null;
  if (dir === '-') return null;
  if (dir === '~' || dir.startsWith('~/')) return path.resolve(os.homedir(), dir.slice(2));
  if (path.isAbsolute(dir)) return path.resolve(dir);
  return cwd ? path.resolve(cwd, dir) : null;
}

// A run counts for this repo when it executes inside the repo (or in one of
// its worktrees) or names a path inside it; scratchpad scripts run from a
// session whose cwd is elsewhere are not runs of this diff.
export function isRepoScopedBash(ev, root, worktrees = []) {
  const command = ev.tool && ev.tool.input ? ev.tool.input.command : null;
  if (typeof command !== 'string') return false;
  const dir = effectiveRunDir(command, ev.cwd);
  if (dir && (isInside(dir, root) || worktrees.some((w) => isInside(dir, w)))) return true;
  if (command.includes(root + '/') || worktrees.some((w) => command.includes(w + '/'))) return true;
  return false;
}

export function readPackageScripts(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  } catch { return {}; }
}

export function readMakeTargets(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
    const out = [];
    for (const m of text.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_./-]*)\s*:(?!=)/gm)) out.push(m[1]);
    return out;
  } catch { return []; }
}

// ------------------------------------------------------------ analysis

export async function analyze(opts, io) {
  const t0 = Date.now();
  const log = (s) => io.stderr.write(`${s}\n`);
  const root = resolveRepoRoot(opts.repo);
  const remoteUrl = tryGit(root, ['remote', 'get-url', 'origin']);
  const remote = parseRemote(remoteUrl);
  const safeRemote = stripRemoteUserinfo(remoteUrl);
  const currentBranch = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const projectsDir = opts['projects-dir'] || '~/.claude/projects';

  let pr = null;
  if (opts.pr != null) pr = resolvePr(root, opts.pr, remote, { warn: log });

  let hunks;
  let refs;
  let timeWindow;
  if (opts.diff) {
    const text = fs.readFileSync(path.resolve(expandHome(opts.diff)), 'utf8');
    const stats = {};
    hunks = parseUnifiedDiff(text, { repoRoot: root, stats });
    const headSha = refExists(root, opts.head || 'HEAD') ? git(root, ['rev-parse', `${opts.head || 'HEAD'}^{commit}`]) : null;
    refs = { baseRef: opts.base || 'diff-file', headRef: opts.head || 'HEAD', mergeBase: null, headSha, diffStats: stats };
    timeWindow = { start: null, end: new Date().toISOString(), firstCommit: null };
  } else {
    refs = resolveRefs(root, { pr, base: opts.base, head: opts.head, currentBranch });
    const stats = {};
    try {
      hunks = gitDiffHunks({ repoRoot: root, base: refs.baseRef, head: refs.headRef, stats });
    } catch (e) {
      throw new CliError(`git diff failed: ${firstLine(e)}`);
    }
    refs.diffStats = stats;
    const hours = Number(opts['window-hours']) > 0 ? Number(opts['window-hours']) : 2;
    timeWindow = timeWindowFor(root, refs.mergeBase, refs.headRef, { hours, end: mergedAt(root, pr) });
  }
  // A merged PR stops at its merge commit: later transcript events are dropped.
  const cutoff = mergedAt(root, pr);

  const diffFiles = [...new Set(hunks.flatMap((h) => [h.file, h.oldFile].filter(Boolean)))];
  const worktrees = worktreeRoots(root);
  const headRefName = pr ? pr.headRefName : (currentBranch && currentBranch !== 'HEAD' ? currentBranch : null);

  const collected = await collectSessions({
    root, projectsDir, sessionsOpt: opts.sessions, pr, headRefName, diffFiles, timeWindow, cutoff, worktrees, log,
  });
  const { considered, candidates } = collected;
  let picked = collected.picked;
  if (cutoff) {
    let dropped = 0;
    for (const p of picked) {
      const before = p.session.events.length;
      p.session.events = dropEventsAfter(p.session.events, cutoff);
      dropped += before - p.session.events.length;
      // the session row (and summary.durationSec, computed from the rows) stops
      // at the cutoff too, or the document changes each time the transcript grows
      const meta = p.session.meta || {};
      if (meta.lastTs && meta.lastTs > cutoff) {
        let last = null;
        for (const ev of p.session.events) if (ev.ts && (!last || ev.ts > last)) last = ev.ts;
        meta.lastTs = last || cutoff;
      }
    }
    const emptied = picked.filter((p) => !p.session.events.length).length;
    picked = picked.filter((p) => p.session.events.length);
    if (dropped) log(`merged PR: ${dropped} transcript event${dropped === 1 ? '' : 's'} after the merge (${cutoff}) left out${emptied ? `, ${emptied} transcript${emptied === 1 ? '' : 's'} entirely` : ''}`);
  }

  const nFiles = new Set(hunks.map((h) => h.relFile)).size;
  log(`repo ${tildify(root)} · ${refs.baseRef}...${refs.headRef} · ${hunks.length} hunk${hunks.length === 1 ? '' : 's'} in ${nFiles} file${nFiles === 1 ? '' : 's'}${refs.diffStats && refs.diffStats.binary ? ` · ${refs.diffStats.binary} binary skipped` : ''}`);
  log(`sessions: ${candidates} candidate transcripts, ${considered} read, ${picked.length} selected${timeWindow.start ? ` · window from ${timeWindow.start}` : ''}`);
  for (const p of picked) {
    log(`  ${String(p.id).slice(0, 8)}  score ${p.score === null ? '-' : p.score}  ${tildify(p.path)}${p.deep ? ' (deep match)' : ''}`);
    if (opts.verbose) for (const r of p.reasons) log(`           ${r}`);
  }

  // merge events of all selected sessions, stable by ts
  const events = [];
  for (const p of picked) for (const ev of p.session.events) events.push(ev);
  events.forEach((e, i) => { e._i = i; });
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a._i - b._i));
  for (const e of events) delete e._i;

  const runEvents = events.filter((ev) => ev.type !== 'tool' || ev.tool?.name !== 'Bash' || isRepoScopedBash(ev, root, worktrees));
  const runs = extractRuns(runEvents, { repoRoot: root, packageScripts: readPackageScripts(root), makeTargets: readMakeTargets(root) });
  // edits that all predate the base commit cannot explain lines the branch added
  const mergeBaseTs = refs.mergeBase ? commitTime(root, refs.mergeBase) : null;
  const attributed = attributeHunks(hunks, events, { since: mergeBaseTs });
  const hunksOut = attributed.map((h) => {
    const runsAfter = runsForHunk(h, runs);
    return { ...h, runsAfter, status: hunkStatus(h, runsAfter) };
  });
  const usage = summarizeUsage(events);
  const sessions = picked.map((p) => sessionRow(p.session, p.id, runs));

  const evidence = buildEvidence({
    repo: { root, remote: safeRemote, base: refs.baseRef, head: refs.headRef, prNumber: pr ? pr.number : null, prUrl: pr ? pr.url : null },
    sessions,
    hunks: hunksOut,
    runs,
    usage,
    elapsedMs: Date.now() - t0,
  });
  evidence.repo.headSha = refs.headSha;
  evidence.repo.mergeBase = refs.mergeBase;
  if (mergeBaseTs) evidence.repo.mergeBaseTs = mergeBaseTs;
  evidence.discovery = {
    candidates,
    considered,
    selected: picked.map((p) => ({ sessionId: p.id, path: p.path, score: p.score, reasons: p.reasons })),
    timeWindow,
  };
  // The fields added here carry paths too; one more (idempotent) pass keeps
  // the whole document under the rules of evidence.redaction.
  return { evidence: redactEvidence(evidence), root, remote, pr, exitCode: picked.length ? 0 : 2 };
}

// ------------------------------------------------------------- outputs

function blobBaseFor(evidence, remote) {
  const r = remote || parseRemote(evidence.repo && evidence.repo.remote);
  if (!r) return null;
  const sha = evidence.repo && evidence.repo.headSha;
  return sha ? `https://github.com/${r.full}/blob/${sha}` : null;
}

// hunkproof never edits the repository it reports on: an unlisted output
// directory is pointed out, not added to .gitignore (a silent append shows up
// in the next diff as a hunk no agent wrote).
export function adviseGitignore(root, outDir, log) {
  if (!isInside(outDir, root)) return false;
  const rel = path.relative(root, outDir).split(path.sep).join('/');
  const line = `${rel}/`;
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { text = ''; }
  const present = text.split('\n').some((l) => {
    const t = l.trim().replace(/^\//, '').replace(/\/$/, '');
    return t === rel || t === rel.split('/')[0];
  });
  if (present) return false;
  log(`hint: add ${line} to .gitignore (hunkproof does not edit the repository)`);
  return true;
}

function writeOutputs(evidence, { root, outDir, theme, quotes, blobBase, log }) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    json: path.join(outDir, 'evidence.json'),
    html: path.join(outDir, 'hunkproof.html'),
    md: path.join(outDir, 'hunkproof.md'),
  };
  // The evidence is already redacted; the renderers only consume it, so the
  // pass below is a no-op unless a renderer prints a path of its own. It is
  // kept so that no output file can carry a home directory.
  fs.writeFileSync(files.json, redactHomePaths(JSON.stringify(evidence, null, 2)) + '\n');
  fs.writeFileSync(files.html, redactHomePaths(renderHtml(evidence, { theme: theme || 'auto' })));
  fs.writeFileSync(files.md, redactHomePaths(renderMarkdown(evidence, { quotes, blobBase })));
  if (root) adviseGitignore(root, outDir, log);
  return files;
}

function openFile(file, log) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => log(`could not open ${file}: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`could not open ${file}: ${e.message}`);
  }
}

// Resolve with the typed answer, or '' when stdin closes first. The answer must
// win the race: rl.close() inside the question callback fires 'close'
// synchronously, so a close listener that resolves '' would otherwise turn
// every "y" into a refusal.
export function ask(question, io) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: false });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
      rl.close();
    };
    rl.question(question, finish);
    rl.on('close', () => finish(''));
  });
}

export async function postComment(evidence, { root, remote, quotes, yes, blobBase }, io) {
  const n = evidence.repo && evidence.repo.prNumber;
  if (!Number.isInteger(n)) throw new CliError('--post needs a PR number (run with --pr N or use evidence that carries one)');
  const body = redact(renderMarkdown(evidence, { quotes, blobBase }));
  io.stdout.write(`\n----- comment preview (PR #${n}) -----\n${body}\n----- end of preview -----\n`);
  if (!yes) {
    const answer = (await ask(`Post this comment to PR #${n}? [y/N] `, io)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      io.stdout.write('not posted\n');
      return false;
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkproof-post-'));
  const file = path.join(dir, 'comment.md');
  try {
    fs.writeFileSync(file, body);
    let out;
    try {
      out = gh(['pr', 'comment', String(n), '--body-file', file], { cwd: root });
    } catch (e) {
      const r = remote || parseRemote(evidence.repo.remote);
      if (!r) throw new CliError(`gh pr comment failed (${firstLine(e)}) and no GitHub remote for the API fallback`);
      io.stderr.write(`gh pr comment failed (${firstLine(e)}); trying gh api\n`);
      try {
        const res = JSON.parse(gh(['api', `repos/${r.full}/issues/${n}/comments`, '-F', `body=@${file}`], { cwd: root }));
        out = res && res.html_url ? res.html_url : '';
      } catch (e2) {
        throw new CliError(`posting the comment failed: ${firstLine(e2)}`);
      }
    }
    io.stdout.write(`posted${out && out.trim() ? `: ${out.trim().split('\n').pop()}` : ''}\n`);
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

function loadEvidenceFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.resolve(expandHome(file)), 'utf8')); } catch (e) { throw new CliError(`cannot read evidence ${file}: ${firstLine(e)}`); }
  if (!parsed || parsed.schema !== 'hunkproof/evidence@1') throw new CliError(`${file} is not a hunkproof evidence document`);
  return parsed;
}

function toolVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

async function mainReport(opts, io) {
  const log = (s) => io.stderr.write(`${s}\n`);
  let evidence;
  let root = null;
  let remote = null;
  let exitCode = 0;
  let replay = false;
  if (opts.evidence) {
    evidence = loadEvidenceFile(opts.evidence);
    replay = true;
    try { root = resolveRepoRoot(opts.repo || (evidence.repo && evidence.repo.root)); } catch { root = null; }
  } else if (opts['from-note']) {
    root = resolveRepoRoot(opts.repo);
    evidence = readGitNote({ repoRoot: root, head: opts.head || 'HEAD' });
    if (!evidence) throw new CliError(`no hunkproof note on ${opts.head || 'HEAD'} (refs/notes/${NOTES_REF})`);
    replay = true;
  } else {
    const r = await analyze(opts, io);
    ({ evidence, root, remote, exitCode } = r);
  }
  if (!remote && root) remote = parseRemote(tryGit(root, ['remote', 'get-url', 'origin']));
  const blobBase = blobBaseFor(evidence, remote);
  const outDir = path.resolve(expandHome(opts.out || path.join(root || process.cwd(), '.hunkproof')));
  const files = writeOutputs(evidence, { root, outDir, theme: opts.theme, quotes: opts.quotes, blobBase, log });

  let noteInfo = '';
  if (!replay && !opts['no-note'] && root && evidence.repo && evidence.repo.headSha) {
    try {
      const n = writeGitNote({ repoRoot: root, head: evidence.repo.headSha, evidence });
      noteInfo = ` · note ${n.ref} on ${n.head.slice(0, 7)}`;
    } catch (e) {
      log(`git note not written: ${firstLine(e)}`);
    }
  }

  if (opts.json) io.stdout.write(redactHomePaths(JSON.stringify(evidence, null, 2)) + '\n');
  else {
    io.stdout.write(redactHomePaths(renderTerminal(evidence)));
    io.stdout.write(`wrote ${tildify(files.json)}, hunkproof.html, hunkproof.md${noteInfo}\n`);
    if (exitCode === 2) io.stdout.write('no Claude Code session matched this diff; the report is diff-only (every hunk unattributed)\n');
  }
  if (opts.open) openFile(files.html, log);
  if (opts.post) {
    const posted = await postComment(evidence, { root, remote, quotes: opts.quotes, yes: opts.yes, blobBase }, io);
    if (!posted && exitCode === 0) exitCode = 0;
  }
  return exitCode;
}

async function statsCommand(opts, io) {
  const days = opts.since != null ? Number(opts.since) : 90;
  if (!Number.isFinite(days) || days < 0) throw new CliError(`--since expects a number of days, got "${opts.since}"`);
  const since = days > 0 ? new Date(Date.now() - days * 86400 * 1000).toISOString() : null;
  let stats = await corpusStats({
    projectsDir: opts['projects-dir'] || '~/.claude/projects',
    since,
    onProgress: opts.verbose ? (p) => io.stderr.write(`${p.done}/${p.total} transcripts\n`) : null,
  });
  if (opts.anonymize) stats = anonymizeStats(stats);
  if (opts.json) io.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  else io.stdout.write(renderStats(stats));
  return 0;
}

async function noteCommand(positionals, opts, io) {
  const sub = positionals[1];
  if (sub !== 'show') throw new CliError(`unknown note command "${sub || ''}"; try: hunkproof note show`);
  const root = resolveRepoRoot(opts.repo);
  const head = opts.head || 'HEAD';
  const evidence = readGitNote({ repoRoot: root, head });
  if (!evidence) {
    io.stdout.write(`no hunkproof note on ${head} (refs/notes/${NOTES_REF})\n`);
    return 1;
  }
  if (opts.json) io.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  else {
    io.stdout.write(renderTerminal(evidence));
    io.stdout.write(`note written ${evidence.generatedAt} by ${evidence.tool && evidence.tool.name} ${evidence.tool && evidence.tool.version}\n`);
  }
  return 0;
}

export async function runCli(argv, io = {}) {
  const out = { stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr, stdin: io.stdin || process.stdin };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    out.stderr.write(`hunkproof: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  const { values: opts, positionals } = parsed;
  if (opts.help) { out.stdout.write(USAGE); return 0; }
  if (opts.version) { out.stdout.write(`hunkproof ${toolVersion()}\n`); return 0; }
  try {
    if (positionals[0] === 'stats') return await statsCommand(opts, out);
    if (positionals[0] === 'note') return await noteCommand(positionals, opts, out);
    if (positionals.length) throw new CliError(`unknown command "${positionals[0]}"\n\n${USAGE}`);
    return await mainReport(opts, out);
  } catch (e) {
    if (e instanceof CliError) {
      out.stderr.write(`hunkproof: ${e.message}\n`);
      return e.exitCode;
    }
    out.stderr.write(`hunkproof: ${e && e.stack ? e.stack : e}\n`);
    return 1;
  }
}
