// Session discovery: find the Claude Code transcripts that worked in a repo
// and score them against a PR.
//
// Layout checked on disk (Claude Code 2.1.267 .. 2.1.299):
//   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
//   ~/.claude/projects/<encoded cwd>/<sessionId>/subagents/agent-<id>.jsonl
//   ~/.claude/projects/<encoded cwd>/<sessionId>/subagents/workflows/wf_<id>/agent-<id>.jsonl
//   ~/.claude/projects/<encoded cwd>/<sessionId>/subagents/workflows/wf_<id>/journal.jsonl (no cwd: ignored)
//   ~/.claude/projects/<encoded cwd>/<sessionId>/workflows/...
// The first line carrying a cwd is within the first 6 lines of every real
// file seen (lines before it are 'mode', 'permission-mode', 'atis-latch' ...).
// Subagent lines carry the PARENT sessionId (and an agentId).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSession } from './transcript.js';

export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

async function* walkJsonl(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

// Stream the first `maxLines` complete lines of a file in chunks, calling
// onLine(line) for each; onLine returning true stops early. Reads at most
// maxBytes (transcript lines can be hundreds of KB each).
export async function forEachHeadLine(file, onLine, { maxLines = 50, chunkSize = 64 * 1024, maxBytes = 2 * 1024 * 1024 } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    let rest = '';
    let pos = 0;
    let count = 0;
    const chunk = Buffer.alloc(chunkSize);
    while (pos < maxBytes) {
      const { bytesRead } = await fh.read(chunk, 0, chunkSize, pos);
      if (bytesRead === 0) {
        if (rest.trim() && count < maxLines && onLine(rest)) return;
        return;
      }
      pos += bytesRead;
      rest += chunk.toString('utf8', 0, bytesRead);
      let nl;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (!line.trim()) continue;
        count++;
        if (onLine(line)) return;
        if (count >= maxLines) return;
      }
    }
  } finally {
    await fh.close();
  }
}

// Read the first `maxLines` complete non-empty lines of a file.
export async function readHeadLines(file, maxLines = 50, opts = {}) {
  const lines = [];
  await forEachHeadLine(file, (l) => { lines.push(l); return false; }, { ...opts, maxLines });
  return lines;
}

// Last "timestamp" value found in the tail of the file (cheap lastTs).
export async function readTailTimestamp(file, tailBytes = 64 * 1024) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, tailBytes);
    if (len === 0) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const re = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/g;
    let m; let last = null;
    while ((m = re.exec(text))) last = m[1];
    return last;
  } finally {
    await fh.close();
  }
}

export async function probeSession(file, { headLines = 50 } = {}) {
  let cwd = null; let firstTs = null; let sessionId = null; let agentId = null; let gitBranch = null;
  await forEachHeadLine(file, (line) => {
    let d;
    try { d = JSON.parse(line); } catch { return false; }
    if (!d || typeof d !== 'object') return false;
    if (!sessionId && typeof d.sessionId === 'string') sessionId = d.sessionId;
    if (!agentId && typeof d.agentId === 'string') agentId = d.agentId;
    if (!firstTs && typeof d.timestamp === 'string') firstTs = d.timestamp;
    if (!gitBranch && typeof d.gitBranch === 'string' && d.gitBranch) gitBranch = d.gitBranch;
    if (!cwd && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
    return Boolean(cwd && firstTs && sessionId);
  }, { maxLines: headLines });
  return { path: file, cwd, firstTs, sessionId: sessionId || path.basename(file).replace(/\.jsonl$/, ''), agentId, gitBranch };
}

// Byte-level search of a whole transcript for the repo path: a `cwd` inside the
// repo (sessions that `cd` into it, subagents started elsewhere) or an absolute
// `file_path` edited inside it. Needles are JSON-escaped so they match the raw
// line text without parsing. Reads the file once in 4 MB chunks.
export async function fileMentionsRepo(file, repoRoot, { chunkSize = 4 * 1024 * 1024 } = {}) {
  const root = path.resolve(repoRoot).replace(/\/+$/, '');
  const esc = JSON.stringify(root).slice(1, -1);
  const needles = [Buffer.from(`"cwd":"${esc}`), Buffer.from(`"file_path":"${esc}/`)];
  const maxNeedle = Math.max(...needles.map((n) => n.length)) + 1;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(chunkSize);
    let carry = Buffer.alloc(0);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, pos);
      if (bytesRead === 0) return false;
      pos += bytesRead;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      // cwd needle: the path must end right there ("...") or continue with a '/'
      let i = -1;
      while ((i = chunk.indexOf(needles[0], i + 1)) >= 0) {
        const next = chunk[i + needles[0].length];
        if (next === undefined) break; // decided on the next chunk via carry
        if (next === 0x22 || next === 0x2f) return true;
      }
      if (chunk.indexOf(needles[1]) >= 0) return true;
      carry = Buffer.from(chunk.subarray(Math.max(0, chunk.length - maxNeedle)));
    }
  } finally {
    await fh.close();
  }
}

// `deep: true` also keeps files whose head cwd is outside repoRoot when the
// whole file mentions the repo (see fileMentionsRepo); `since` (ISO string or
// ms) skips the deep scan for files not modified since then. Deep matches carry
// `match: 'deep'`; head matches have no `match` field.
export async function listCandidateSessions({ repoRoot, projectsDir = '~/.claude/projects', headLines = 50, withLastTs = true, deep = false, since = null } = {}) {
  if (!repoRoot) throw new Error('listCandidateSessions: repoRoot is required');
  const root = path.resolve(expandHome(repoRoot));
  const base = path.resolve(expandHome(projectsDir));
  const out = [];
  if (!fs.existsSync(base)) return out;
  const sinceMs = since == null ? null : (typeof since === 'number' ? since : Date.parse(since));
  for await (const file of walkJsonl(base)) {
    let probe;
    try { probe = await probeSession(file, { headLines }); } catch { continue; }
    let match = null;
    if (probe.cwd && isInside(probe.cwd, root)) match = 'cwd';
    else if (deep && probe.firstTs) {
      if (sinceMs != null && Number.isFinite(sinceMs)) {
        let mtime;
        try { mtime = (await fsp.stat(file)).mtimeMs; } catch { continue; }
        if (mtime < sinceMs) continue;
      }
      let hit = false;
      try { hit = await fileMentionsRepo(file, root); } catch { hit = false; }
      if (hit) match = 'deep';
    }
    if (!match) continue;
    const item = { path: file, cwd: probe.cwd, firstTs: probe.firstTs, sessionId: probe.sessionId };
    if (match === 'deep') item.match = 'deep';
    if (probe.agentId) item.agentId = probe.agentId;
    if (probe.gitBranch) item.gitBranch = probe.gitBranch;
    if (withLastTs) {
      try { item.lastTs = await readTailTimestamp(file); } catch { item.lastTs = null; }
    }
    out.push(item);
  }
  out.sort((a, b) => String(a.firstTs || '').localeCompare(String(b.firstTs || '')) || a.path.localeCompare(b.path));
  return out;
}

function normalizeDiffFiles(diffFiles, repoRoot) {
  const set = new Set();
  for (const f of diffFiles || []) {
    if (typeof f !== 'string' || !f) continue;
    set.add(path.isAbsolute(f) ? path.resolve(f) : path.resolve(repoRoot, f));
  }
  return set;
}

function inWindow(ts, win) {
  if (!win) return true;
  if (!ts) return false;
  if (win.start && ts < win.start) return false;
  if (win.end && ts > win.end) return false;
  return true;
}

export function scoreSession(session, { repoRoot, prNumber, prRepository, headRef, diffFiles, timeWindow } = {}) {
  const root = path.resolve(expandHome(repoRoot || session.meta.cwd || '/'));
  const files = normalizeDiffFiles(diffFiles, root);
  const reasons = [];
  let score = 0;
  let prHit = false;
  let fileHits = 0;
  const hitFiles = new Set();
  for (const ev of session.events) {
    if (ev.type === 'pr_link' && !prHit && prNumber != null && ev.pr_link.prNumber === Number(prNumber)) {
      if (prRepository && ev.pr_link.prRepository && ev.pr_link.prRepository.toLowerCase() !== String(prRepository).toLowerCase()) continue;
      prHit = true;
      score += 100;
      reasons.push(`pr_link #${ev.pr_link.prNumber}${ev.pr_link.prRepository ? ` (${ev.pr_link.prRepository})` : ''} via ${ev.pr_link.source || 'transcript'}`);
    } else if ((ev.type === 'edit' || ev.type === 'shell_edit') && ev.edit && ev.edit.file && files.has(ev.edit.file) && inWindow(ev.ts, timeWindow)
      && ev.edit.source !== 'bashEditDiff-git' && ev.edit.source !== 'bashEditDiff-uncorroborated') {
      fileHits++;
      hitFiles.add(path.relative(root, ev.edit.file));
    }
  }
  if (fileHits) {
    const pts = Math.min(60, fileHits * 10);
    score += pts;
    const list = [...hitFiles].slice(0, 5).join(', ');
    reasons.push(`${fileHits} edit${fileHits > 1 ? 's' : ''} of ${hitFiles.size} diff file${hitFiles.size > 1 ? 's' : ''}${timeWindow ? ' in window' : ''} (+${pts}): ${list}${hitFiles.size > 5 ? ', ...' : ''}`);
  }
  if (headRef && session.meta.gitBranches.includes(headRef)) {
    score += 5;
    reasons.push(`gitBranch ${headRef}`);
  }
  if (session.meta.cwd && isInside(session.meta.cwd, root)) {
    score += 1;
    reasons.push(`cwd ${session.meta.cwd}`);
  }
  return { score, reasons, fileHits, prHit };
}

export async function discoverSessionsForPR({ repoRoot, prNumber, prRepository, baseRef, headRef, diffFiles, timeWindow, projectsDir, minScore = 10, candidates, onSession } = {}) {
  if (!repoRoot) throw new Error('discoverSessionsForPR: repoRoot is required');
  const root = path.resolve(expandHome(repoRoot));
  const list = candidates || await listCandidateSessions({ repoRoot: root, projectsDir: projectsDir || '~/.claude/projects' });
  const sessions = [];
  let considered = 0;
  for (const cand of list) {
    // cheap prefilter: a session fully outside the window cannot score on edits;
    // keep it only if a PR number could still match (we cannot know without reading),
    // so skip only when no prNumber is given.
    if (timeWindow && prNumber == null && cand.firstTs && cand.lastTs) {
      if ((timeWindow.end && cand.firstTs > timeWindow.end) || (timeWindow.start && cand.lastTs < timeWindow.start)) continue;
    }
    considered++;
    let session;
    try { session = await readSession(cand.path); } catch { continue; }
    const { score, reasons } = scoreSession(session, { repoRoot: root, prNumber, prRepository, headRef, baseRef, diffFiles, timeWindow });
    const row = { path: cand.path, sessionId: session.sessionId, score, reasons, firstTs: session.meta.firstTs, lastTs: session.meta.lastTs };
    if (session.agentId) row.agentId = session.agentId;
    if (typeof onSession === 'function') onSession(row, session);
    if (score >= minScore) sessions.push(row);
  }
  sessions.sort((a, b) => b.score - a.score || String(a.firstTs || '').localeCompare(String(b.firstTs || '')));
  return { sessions, considered };
}
