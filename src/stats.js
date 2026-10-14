// Corpus statistics over every Claude Code transcript on the machine.
//
// Streams one transcript at a time (readSessionEvents) and keeps only a small
// record per transcript: edits as (file, ts), runs as (ts, outcome, targets),
// commits as ts. Records are merged per project (the encoded directory under
// ~/.claude/projects, i.e. the session's working directory). Large corpora are
// split over child processes (src/stats-worker.js) so a 500 MB corpus stays
// within a minute.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from './discover.js';
import { readSessionEvents, newStats } from './transcript.js';
import { extractRuns, isTargeted } from './runs.js';
import { redactHomePaths } from './redact.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'stats-worker.js');

async function* walkJsonl(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

// Files that are not project code: temp dirs, Claude's own memory/plans, the
// transcripts themselves.
function isScratch(file) {
  if (!file) return true;
  if (file.startsWith('/tmp/') || isInside(file, os.tmpdir())) return true;
  if (isInside(file, path.join(os.homedir(), '.claude'))) return true;
  return false;
}

/**
 * sessionRecord(file) => compact per-transcript record (or null when the file
 * has no events). `project` is the first path component under projectsDir.
 */
export async function sessionRecord(file, { projectsDir } = {}) {
  const stats = newStats();
  const meta = { firstTs: null, lastTs: null, cwd: null, versions: [], gitBranches: [], models: [], sessionId: null, agentId: null };
  const edits = []; // { file, ts }
  const commits = []; // ts (successful only)
  const bash = []; // tool events kept for extractRuns
  const toolUseIds = new Set();
  let toolEdits = 0;
  let shellEdits = 0;
  for await (const ev of readSessionEvents(file, { stats, meta })) {
    if (ev.toolUseId && (ev.type === 'tool' || ev.type === 'edit')) toolUseIds.add(ev.toolUseId);
    if (ev.type === 'edit' || ev.type === 'shell_edit') {
      if (ev.type === 'edit') toolEdits++; else shellEdits++;
      if (ev.edit && ev.edit.file && ev.ts && !isScratch(ev.edit.file)) edits.push({ file: ev.edit.file, ts: ev.ts });
    } else if (ev.type === 'tool' && ev.tool && ev.tool.name === 'Bash') {
      bash.push(ev);
    } else if (ev.type === 'commit') {
      if (ev.ts && !(ev.commit && ev.commit.isError)) commits.push(ev.ts);
    }
  }
  if (!stats.events) return null;
  const runs = extractRuns(bash, { repoRoot: meta.cwd }).map((r) => ({ ts: r.ts, outcome: r.outcome, targets: r.targets }));
  let project = null;
  if (projectsDir) {
    const rel = path.relative(path.resolve(expandHome(projectsDir)), file);
    project = rel.split(path.sep)[0] || null;
  }
  return {
    path: file,
    project,
    cwd: meta.cwd,
    sessionId: meta.sessionId,
    agentId: meta.agentId,
    firstTs: meta.firstTs,
    lastTs: meta.lastTs,
    toolCalls: toolUseIds.size,
    toolEdits,
    shellEdits,
    edits,
    runs,
    commits,
  };
}

function newBucket(label) {
  return {
    project: label,
    cwd: null,
    sessions: 0,
    toolCalls: 0,
    editEvents: 0,
    toolEdits: 0,
    shellEdits: 0,
    runs: 0,
    commits: 0,
    files: new Set(),
    fileEdits: 0, // (session, file) pairs
    looseUnrun: 0,
    strictUnrun: 0,
    passUnrun: 0,
    commitsEditAfterLastRun: 0,
    commitsEditAfterLastPass: 0,
    commitsWithEdits: 0,
  };
}

/** Fold one record into a bucket. Exported for tests. */
export function foldRecord(bucket, rec) {
  bucket.sessions++;
  if (!bucket.cwd && rec.cwd) bucket.cwd = rec.cwd;
  bucket.toolCalls += rec.toolCalls || 0;
  bucket.toolEdits += rec.toolEdits || 0;
  bucket.shellEdits += rec.shellEdits || 0;
  bucket.editEvents += (rec.toolEdits || 0) + (rec.shellEdits || 0);
  bucket.runs += rec.runs.length;
  bucket.commits += rec.commits.length;

  const runs = [...rec.runs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const passes = runs.filter((r) => r.outcome === 'pass');
  const lastEdit = new Map();
  for (const e of rec.edits) {
    bucket.files.add(e.file);
    const prev = lastEdit.get(e.file);
    if (!prev || e.ts > prev) lastEdit.set(e.file, e.ts);
  }
  for (const [file, ts] of lastEdit) {
    bucket.fileEdits++;
    const after = runs.filter((r) => r.ts > ts);
    if (!after.length) bucket.looseUnrun++;
    const rel = rec.cwd && isInside(file, rec.cwd) ? path.relative(rec.cwd, file) : path.basename(file);
    const hunkLike = { file, relFile: rel };
    if (!after.some((r) => isTargeted(hunkLike, r))) bucket.strictUnrun++;
    if (!after.some((r) => r.outcome === 'pass')) bucket.passUnrun++;
  }
  const editTs = rec.edits.map((e) => e.ts).sort();
  const lastBefore = (list, ts) => {
    let best = null;
    for (const r of list) { if (r.ts < ts) best = r.ts; else break; }
    return best;
  };
  const editBetween = (from, to) => editTs.some((t) => (from === null || t > from) && t < to);
  for (const c of rec.commits) {
    if (!editTs.some((t) => t < c)) continue; // commit without any prior edit in this session
    bucket.commitsWithEdits++;
    if (editBetween(lastBefore(runs, c), c)) bucket.commitsEditAfterLastRun++;
    if (editBetween(lastBefore(passes, c), c)) bucket.commitsEditAfterLastPass++;
  }
  return bucket;
}

function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function finishBucket(b) {
  return {
    project: b.project,
    cwd: b.cwd,
    sessions: b.sessions,
    toolCalls: b.toolCalls,
    filesEdited: b.files.size,
    editEvents: b.editEvents,
    toolEdits: b.toolEdits,
    shellEdits: b.shellEdits,
    runs: b.runs,
    commits: b.commits,
    fileEdits: b.fileEdits,
    loose: { noRunAfterLastEdit: b.looseUnrun, pct: pct(b.looseUnrun, b.fileEdits) },
    strict: { noTargetedRunAfterLastEdit: b.strictUnrun, pct: pct(b.strictUnrun, b.fileEdits) },
    pass: { noPassingRunAfterLastEdit: b.passUnrun, pct: pct(b.passUnrun, b.fileEdits) },
    commitsWithEdits: b.commitsWithEdits,
    commitsWithEditAfterLastRun: { n: b.commitsEditAfterLastRun, pct: pct(b.commitsEditAfterLastRun, b.commitsWithEdits) },
    commitsWithEditAfterLastPass: { n: b.commitsEditAfterLastPass, pct: pct(b.commitsEditAfterLastPass, b.commitsWithEdits) },
  };
}

async function listFiles(projectsDir, since) {
  const base = path.resolve(expandHome(projectsDir));
  const sinceMs = since ? Date.parse(since) : null;
  const files = [];
  for await (const f of walkJsonl(base)) {
    let st;
    try { st = await fsp.stat(f); } catch { continue; }
    if (!st.size) continue;
    if (sinceMs != null && Number.isFinite(sinceMs) && st.mtimeMs < sinceMs) continue;
    files.push({ path: f, size: st.size });
  }
  files.sort((a, b) => b.size - a.size);
  return files;
}

// Run sessionRecord over `files` in `n` child processes; largest files first,
// each file handed to the least loaded worker.
async function recordsInWorkers(files, n, projectsDir, onProgress) {
  const slots = Array.from({ length: n }, () => ({ files: [], bytes: 0 }));
  for (const f of files) {
    const s = slots.reduce((a, b) => (a.bytes <= b.bytes ? a : b));
    s.files.push(f.path);
    s.bytes += f.size;
  }
  let done = 0;
  const total = files.length;
  const jobs = slots.filter((s) => s.files.length).map((s) => new Promise((resolve, reject) => {
    const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const records = [];
    child.on('message', (m) => {
      if (m && m.type === 'record') {
        done++;
        if (m.record) records.push(m.record);
        if (onProgress) onProgress({ done, total });
      } else if (m && m.type === 'done') {
        child.disconnect();
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(records) : reject(new Error(`stats worker exited with code ${code}`))));
    child.send({ type: 'files', files: s.files, projectsDir });
  }));
  return (await Promise.all(jobs)).flat();
}

/**
 * corpusStats({ projectsDir = '~/.claude/projects', since = null, workers, onProgress })
 * `since`: ISO string; transcripts not modified since then are skipped.
 */
export async function corpusStats({ projectsDir = '~/.claude/projects', since = null, workers, onProgress = null } = {}) {
  const t0 = Date.now();
  const files = await listFiles(projectsDir, since);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const n = workers != null ? Math.max(1, Number(workers)) : Math.max(1, Math.min(6, os.availableParallelism ? os.availableParallelism() - 1 : 3, Math.ceil(totalBytes / (64 * 1024 * 1024))));
  let records;
  if (n <= 1 || files.length < 2) {
    records = [];
    let done = 0;
    for (const f of files) {
      let rec = null;
      try { rec = await sessionRecord(f.path, { projectsDir }); } catch { rec = null; }
      done++;
      if (rec) records.push(rec);
      if (onProgress) onProgress({ done, total: files.length });
    }
  } else {
    records = await recordsInWorkers(files, n, projectsDir, onProgress);
  }

  const buckets = new Map();
  const total = newBucket('all projects');
  for (const rec of records) {
    const key = rec.project || rec.cwd || '(unknown)';
    if (!buckets.has(key)) buckets.set(key, newBucket(key));
    foldRecord(buckets.get(key), rec);
    foldRecord(total, rec);
  }
  const projects = [...buckets.values()].map(finishBucket).sort((a, b) => b.editEvents - a.editEvents || a.project.localeCompare(b.project));
  const all = finishBucket(total);
  return {
    projectsDir: path.resolve(expandHome(projectsDir)),
    since,
    transcripts: files.length,
    transcriptsRead: records.length,
    bytes: totalBytes,
    workers: n,
    elapsedMs: Date.now() - t0,
    projects: projects.length,
    sessions: all.sessions,
    toolCalls: all.toolCalls,
    filesEdited: all.filesEdited,
    editEvents: all.editEvents,
    toolEdits: all.toolEdits,
    shellEdits: all.shellEdits,
    runs: all.runs,
    commits: all.commits,
    fileEdits: all.fileEdits,
    loose: all.loose,
    strict: all.strict,
    pass: all.pass,
    commitsWithEdits: all.commitsWithEdits,
    commitsWithEditAfterLastRun: all.commitsWithEditAfterLastRun,
    commitsWithEditAfterLastPass: all.commitsWithEditAfterLastPass,
    byProject: projects,
  };
}

/**
 * anonymizeStats(stats) => stats with project directories replaced by labels
 * project-01..project-NN, numbered by sessions (descending; ties by edits,
 * then by the original name so the mapping is stable), rows in that order,
 * `cwd` dropped and the transcript root rewritten with the home-path rules.
 * Every number is unchanged; the "all projects" row keeps its name.
 */
export function anonymizeStats(stats) {
  const s = stats || {};
  const byProject = Array.isArray(s.byProject) ? s.byProject : [];
  const order = [...byProject].sort((a, b) => (b.sessions - a.sessions) || (b.editEvents - a.editEvents) || String(a.project).localeCompare(String(b.project)));
  const width = Math.max(2, String(order.length).length);
  return {
    ...s,
    projectsDir: typeof s.projectsDir === 'string' ? redactHomePaths(s.projectsDir) : s.projectsDir,
    anonymized: true,
    byProject: order.map((p, i) => ({ ...p, project: `project-${String(i + 1).padStart(width, '0')}`, cwd: null })),
  };
}

function pad(s, w, right = false) {
  const str = String(s);
  if (str.length >= w) return str;
  return right ? ' '.repeat(w - str.length) + str : str + ' '.repeat(w - str.length);
}

function shortProject(p) {
  const home = os.homedir().replace(/[^A-Za-z0-9-]/g, '-');
  let s = String(p);
  if (s.startsWith(home + '-')) s = '~' + s.slice(home.length);
  else if (s === home) s = '~';
  // a directory under another tree (`-tmp-claude-1000--home-alice-...`) still
  // names the user: the same rule as every other output
  s = redactHomePaths(s);
  return s.length > 34 ? s.slice(0, 33) + '…' : s;
}

function fmtMB(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

/** Terminal table: one row per project (top 20 by edits) plus a total row. */
export function renderStats(stats) {
  const s = stats || {};
  const rows = (s.byProject || []).slice(0, 20);
  // Every ratio prints its numerator and denominator: the three "unrun" columns
  // are over file edits ((transcript, file) pairs), not over distinct files.
  const header = ['project', 'sessions', 'files', 'file edits', 'edits', 'runs', 'commits', 'unrun', 'strict', 'no pass', 'commit after edit'];
  const ratio = (n, d, p) => `${n}/${d} (${p}%)`;
  const line = (b) => [
    shortProject(b.project),
    b.sessions,
    b.filesEdited,
    b.fileEdits,
    b.editEvents,
    b.runs,
    b.commits,
    ratio(b.loose.noRunAfterLastEdit, b.fileEdits, b.loose.pct),
    ratio(b.strict.noTargetedRunAfterLastEdit, b.fileEdits, b.strict.pct),
    ratio(b.pass.noPassingRunAfterLastEdit, b.fileEdits, b.pass.pct),
    ratio(b.commitsWithEditAfterLastRun.n, b.commitsWithEdits, b.commitsWithEditAfterLastRun.pct),
  ].map(String);
  const data = rows.map(line);
  const totalRow = line({ ...s, project: 'all projects' });
  const widths = header.map((h, i) => Math.max(h.length, totalRow[i].length, ...data.map((r) => r[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i === 0 ? pad(c, widths[i]) : pad(c, widths[i], true))).join('  ').trimEnd();
  const out = [];
  out.push(`hunkproof stats · ${s.transcriptsRead ?? 0} transcripts (${fmtMB(s.bytes || 0)}) in ${s.projects ?? 0} projects${s.since ? ` since ${String(s.since).slice(0, 10)}` : ''} · read in ${Math.round((s.elapsedMs || 0) / 100) / 10}s with ${s.workers || 1} worker${s.workers === 1 ? '' : 's'}`);
  out.push('');
  out.push(fmt(header));
  out.push(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of data) out.push(fmt(r));
  if ((s.byProject || []).length > rows.length) out.push(`… ${(s.byProject || []).length - rows.length} more projects`);
  out.push(fmt(widths.map((w) => '-'.repeat(w))));
  out.push(fmt(totalRow));
  out.push('');
  out.push(`file edits = (transcript, file) pairs with at least one edit: ${s.fileEdits ?? 0} · unrun = no run after the file's last edit (${s.loose?.noRunAfterLastEdit ?? 0}) · strict = no targeted run after it (${s.strict?.noTargetedRunAfterLastEdit ?? 0}) · no pass = no passing run after it (${s.pass?.noPassingRunAfterLastEdit ?? 0}) · files = distinct files edited`);
  out.push(`commits: ${s.commits ?? 0}, of which ${s.commitsWithEdits ?? 0} follow edits in the same session; ${s.commitsWithEditAfterLastRun?.n ?? 0} (${s.commitsWithEditAfterLastRun?.pct ?? 0}%) include an edit made after the last run, ${s.commitsWithEditAfterLastPass?.n ?? 0} (${s.commitsWithEditAfterLastPass?.pct ?? 0}%) after the last passing run`);
  out.push(`runs = shell commands classified as test, lint, type-check, build or script invocations; outcome parsed from their output. Nothing here is a judgement of quality, only of what ran after what.`);
  return out.join('\n') + '\n';
}
