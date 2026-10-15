// Claude Code Stop hook: when the agent is about to hand back, name the hunks
// edited in this session that have no run after their last edit.
//
// Runs the same pipeline as the CLI (diff, transcript, runs, attribution) in
// process, against the working tree, restricted to the transcripts of the
// current session: the main transcript named by the hook input plus the
// session's subagent transcripts that mention the repository. Nothing is
// written anywhere (no .hunkproof/, no git note, no index change), the hook
// never runs transcript discovery, and it always exits 0: a crash here must
// never keep the agent from stopping.
//
// stdin  (from Claude Code): { session_id, transcript_path, cwd, hook_event_name: 'Stop', stop_hook_active }
// stdout: nothing when there is nothing to say, else one JSON object:
//   report mode: { systemMessage }                 shown to the user, the agent stops
//   block mode:  { decision: 'block', reason }      the agent continues and runs the hunks
// Mode: HUNKPROOF_STOP=report|block|off (default report), else --mode of `hunkproof hook stop`.
// Block is downgraded to report when stop_hook_active is true, so the hook never loops.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readSession } from './transcript.js';
import { fileMentionsRepo } from './discover.js';
import { gitDiffHunks, parseUnifiedDiff } from './diff.js';
import { attributeHunks } from './attribute.js';
import { extractRuns, runsForHunk, hunkStatus } from './runs.js';
import {
  commitTime, defaultBaseRef, isRepoScopedBash, readMakeTargets, readPackageScripts, remapWorktreePaths, worktreeRoots,
} from './cli.js';

export const MAX_LINES = 10;             // hunk lines in the message, then "+N more"
export const MAX_UNTRACKED = 50;         // untracked files diffed against /dev/null
export const SUBAGENT_BYTES_CAP = 64 * 1024 * 1024; // subagent transcript bytes read at most
const MODES = new Set(['report', 'block', 'off']);

function defaultGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\n$/, '');
}

const DEFAULT_DEPS = {
  git: defaultGit,
  diffHunks: gitDiffHunks,
  readSession,
  fileMentionsRepo,
  fs,
  env: process.env,
  now: () => new Date(),
  stderr: process.stderr,
  mode: null,
  subagentBytesCap: SUBAGENT_BYTES_CAP,
};

// The hook's stdin as an object, or null when it is empty or not JSON.
export function parseStdin(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function pickMode(env, flagMode) {
  const fromEnv = typeof env.HUNKPROOF_STOP === 'string' ? env.HUNKPROOF_STOP.trim().toLowerCase() : '';
  if (MODES.has(fromEnv)) return fromEnv;
  const fromFlag = typeof flagMode === 'string' ? flagMode.trim().toLowerCase() : '';
  if (MODES.has(fromFlag)) return fromFlag;
  return 'report';
}

// `HH:MM:SS UTC`, with the date in front when the edit is not from today.
export function formatEditTime(iso, now = new Date()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  const time = d.toISOString().slice(11, 19);
  const day = d.toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  return day === today ? `${time} UTC` : `${day} ${time} UTC`;
}

// rows: [{ id, lastEdit, fileLevel }] -> the message. Header, one line per hunk
// (at most MAX_LINES), then "+N more". In block mode a closing line tells the
// agent what to do. The words come from the renderers' vocabulary.
export function formatUnrun(rows, { mode = 'report', now = new Date(), maxLines = MAX_LINES } = {}) {
  const n = rows.length;
  const head = n === 1
    ? 'hunkproof: 1 hunk edited in this session has no run after its last edit'
    : `hunkproof: ${n} hunks edited in this session have no run after their last edit`;
  const shown = rows.slice(0, maxLines);
  const width = Math.min(48, Math.max(...shown.map((r) => r.id.length), 0));
  const lines = shown.map((r) => `  ${r.id.padEnd(width)}  edited ${formatEditTime(r.lastEdit, now)}  no run after${r.fileLevel ? ' (file-level)' : ''}`);
  if (n > shown.length) lines.push(`  +${n - shown.length} more`);
  const out = [head, ...lines];
  if (mode === 'block') out.push("Run the project's check for these files, then stop again.");
  return out.join('\n');
}

async function* walkJsonl(fsMod, dir) {
  let entries;
  try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(fsMod, p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// Hunks of the untracked files (git diff never lists them): each diffed against
// /dev/null, at most MAX_UNTRACKED files. `git diff --no-index` exits 1 when the
// files differ, which is the expected case here.
function untrackedHunks(d, root) {
  let list;
  try { list = d.git(root, ['ls-files', '--others', '--exclude-standard', '-z']); } catch { return []; }
  const files = list.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED);
  const out = [];
  for (const rel of files) {
    let text = null;
    try {
      text = d.git(root, ['-c', 'core.quotePath=false', 'diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '/dev/null', rel]);
    } catch (e) {
      if (e && e.status === 1 && typeof e.stdout === 'string') text = e.stdout;
    }
    if (!text) continue;
    try { out.push(...parseUnifiedDiff(text, { repoRoot: root })); } catch { /* an unreadable file is not a hunk */ }
  }
  return out;
}

// Subagent transcripts of this session: <dirname(transcript)>/<session_id>/subagents/**/*.jsonl,
// kept when they mention the repository (byte scan) and while the cap holds.
async function subagentFiles(d, transcriptPath, sessionId, root) {
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  const out = [];
  let queued = 0;
  for await (const file of walkJsonl(d.fs, dir)) {
    let size;
    try { size = d.fs.statSync(file).size; } catch { continue; }
    if (queued + size > d.subagentBytesCap) continue;
    let hit = false;
    try { hit = await d.fileMentionsRepo(file, root); } catch { hit = false; }
    if (!hit) continue;
    queued += size;
    out.push(file);
  }
  return out;
}

async function run(input, d) {
  if (!input || typeof input !== 'object') return null;
  if (input.hook_event_name !== 'Stop') return null;
  let mode = pickMode(d.env, d.mode);
  if (mode === 'off') return null;
  if (mode === 'block' && input.stop_hook_active === true) mode = 'report';

  const transcriptPath = typeof input.transcript_path === 'string' ? path.resolve(input.transcript_path) : null;
  if (!transcriptPath || !d.fs.existsSync(transcriptPath)) return null;

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let root;
  try { root = path.resolve(d.git(cwd, ['rev-parse', '--show-toplevel'])); } catch { return null; }

  const base = (typeof d.env.HUNKPROOF_BASE === 'string' && d.env.HUNKPROOF_BASE.trim()) || defaultBaseRef(root);
  if (!base) return null;
  let mergeBase;
  try { mergeBase = d.git(root, ['merge-base', base, 'HEAD']); } catch { return null; }
  if (!mergeBase) return null;

  // merge base .. working tree, plus the untracked files
  const hunks = d.diffHunks({ repoRoot: root, base: mergeBase, head: null });
  hunks.push(...untrackedHunks(d, root));
  if (!hunks.length) return null;

  // this session's transcripts only: the main one, then its subagents
  const main = await d.readSession(transcriptPath);
  const ids = new Set([main.sessionId]);
  if (typeof input.session_id === 'string' && input.session_id) ids.add(input.session_id);
  const sessions = [main];
  for (const file of await subagentFiles(d, transcriptPath, input.session_id, root)) {
    let s;
    try { s = await d.readSession(file); } catch { continue; }
    if (s.agentId) { for (const ev of s.events) ev.sessionId = s.agentId; ids.add(s.agentId); } else ids.add(s.sessionId);
    sessions.push(s);
  }

  const worktrees = worktreeRoots(root);
  const events = [];
  for (const s of sessions) {
    remapWorktreePaths(s.events, root, worktrees);
    for (const ev of s.events) events.push(ev);
  }
  events.forEach((e, i) => { e._i = i; });
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a._i - b._i));
  for (const e of events) delete e._i;

  const runEvents = events.filter((ev) => ev.type !== 'tool' || ev.tool?.name !== 'Bash' || isRepoScopedBash(ev, root, worktrees));
  const runs = extractRuns(runEvents, { repoRoot: root, packageScripts: readPackageScripts(root), makeTargets: readMakeTargets(root) });
  const attributed = attributeHunks(hunks, events, { since: commitTime(root, mergeBase) });

  const rows = [];
  for (const h of attributed) {
    if (hunkStatus(h, runsForHunk(h, runs)) !== 'UNRUN') continue;
    // the edit that defines lastEdit has to be this session's (or one of its agents')
    const own = (h.edits || []).some((e) => e.ts === h.lastEdit && ids.has(e.sessionId));
    if (!own) continue;
    rows.push({ id: h.id, lastEdit: h.lastEdit, fileLevel: h.attribution === 'FILE_LEVEL' });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const text = formatUnrun(rows, { mode, now: d.now() });
  if (mode === 'block') return { decision: 'block', reason: text };
  return { systemMessage: text };
}

// The hook: `input` is the parsed stdin object (or null), `deps` overrides git,
// the diff, the transcript reader, the byte scan, fs, env, the clock, stderr,
// the --mode flag and the subagent byte cap. Returns { stdout, exitCode: 0 }
// where stdout is '' or one JSON object; any exception gives '' (the stack goes
// to stderr only with HUNKPROOF_DEBUG=1).
export async function stopHook(input, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  try {
    const out = await run(input, d);
    return { stdout: out ? JSON.stringify(out) + '\n' : '', exitCode: 0 };
  } catch (e) {
    if (d.env && d.env.HUNKPROOF_DEBUG === '1') {
      try { d.stderr.write(`hunkproof hook: ${e && e.stack ? e.stack : e}\n`); } catch { /* stderr closed */ }
    }
    return { stdout: '', exitCode: 0 };
  }
}
