import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeProjectDir, listCandidateSessions, discoverSessionsForPR, scoreSession,
  readHeadLines, forEachHeadLine, readTailTimestamp, probeSession, expandHome,
} from '../src/discover.js';
import { readSession } from '../src/transcript.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'fixtures', 'sessions');

// Synthetic ~/.claude/projects tree built from the fixtures:
//   -home-dev-proj/<267>.jsonl                                   main session
//   -home-dev-proj/<280>.jsonl                                   main session
//   -home-dev-proj/<280>/subagents/agent-a1b2.jsonl              subagent (292 fixture)
//   -home-dev-proj/<280>/subagents/workflows/wf_1/agent-b2c3.jsonl  workflow agent (299 fixture)
//   -home-dev-proj/<280>/subagents/workflows/wf_1/journal.jsonl  no cwd: ignored
//   -home-dev-other/<x>.jsonl                                    cwd outside repoRoot
//   -home-dev-proj/late-cwd.jsonl                                cwd only at line 60: ignored at 50 lines
let tmp;
let projectsDir;
const SID267 = 'aaaaaaaa-0267-4000-8000-000000000267';
const SID280 = 'bbbbbbbb-0280-4000-8000-000000000280';
const P = {};

before(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hunkproof-discover-'));
  projectsDir = path.join(tmp, 'projects');
  const proj = path.join(projectsDir, encodeProjectDir('/home/dev/proj'));
  const wf = path.join(proj, SID280, 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(wf, { recursive: true });
  fs.mkdirSync(path.join(proj, SID280, 'subagents'), { recursive: true });
  P.main267 = path.join(proj, `${SID267}.jsonl`);
  P.main280 = path.join(proj, `${SID280}.jsonl`);
  P.sub292 = path.join(proj, SID280, 'subagents', 'agent-a1b2c3d4e5f60718.jsonl');
  P.wf299 = path.join(wf, 'agent-b2c3d4e5f6071829.jsonl');
  P.journal = path.join(wf, 'journal.jsonl');
  fs.copyFileSync(path.join(FIX, 'v2.1.267-no-bashEditDiff.jsonl'), P.main267);
  fs.copyFileSync(path.join(FIX, 'v2.1.280-bashEditDiff.jsonl'), P.main280);
  fs.copyFileSync(path.join(FIX, 'v2.1.292-unavailable.jsonl'), P.sub292);
  fs.copyFileSync(path.join(FIX, 'v2.1.299-split-usage.jsonl'), P.wf299);
  fs.writeFileSync(P.journal, '{"type":"started","key":"k","agentId":"x","label":"l","phase":"p"}\n{"type":"result","key":"k","agentId":"x","result":"ok"}\n');
  // other project
  const other = path.join(projectsDir, encodeProjectDir('/home/dev/other'));
  fs.mkdirSync(other, { recursive: true });
  P.other = path.join(other, 'eeeeeeee-0000-4000-8000-000000000000.jsonl');
  fs.writeFileSync(P.other, fs.readFileSync(P.main267, 'utf8').replaceAll('/home/dev/proj', '/home/dev/other').replaceAll(SID267, 'eeeeeeee-0000-4000-8000-000000000000'));
  // cwd appears late (line 60)
  P.late = path.join(proj, 'ffffffff-0000-4000-8000-000000000000.jsonl');
  const noise = Array.from({ length: 59 }, () => '{"type":"mode","mode":"normal","sessionId":"ffffffff-0000-4000-8000-000000000000"}').join('\n');
  fs.writeFileSync(P.late, `${noise}\n{"type":"user","cwd":"/home/dev/proj","sessionId":"ffffffff-0000-4000-8000-000000000000","timestamp":"2026-10-05T00:00:00.000Z","message":{"role":"user","content":"x"},"uuid":"u","isSidechain":false,"version":"2.1.299","gitBranch":"main"}\n`);
});

after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('encodeProjectDir', () => {
  assert.equal(encodeProjectDir('/home/dev/foo'), '-home-dev-foo');
  assert.equal(encodeProjectDir('/home/dev/My_App'), '-home-dev-My-App');
  assert.equal(encodeProjectDir('/home/dev/other-app/.claude/worktrees/agent-a45'), '-home-dev-other-app--claude-worktrees-agent-a45');
  assert.equal(encodeProjectDir('/tmp/claude-1000/-home-dev/x y.z'), '-tmp-claude-1000--home-dev-x-y-z');
  assert.equal(encodeProjectDir('/'), '-');
});

test('expandHome', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/.claude/projects'), path.join(os.homedir(), '.claude/projects'));
  assert.equal(expandHome('/abs'), '/abs');
});

test('forEachHeadLine streams complete lines across chunk boundaries and stops early', async () => {
  const f = path.join(tmp, 'long.jsonl');
  const long = JSON.stringify({ type: 'x', pad: 'a'.repeat(200000) });
  fs.writeFileSync(f, `${long}\n{"type":"y"}\n\n{"type":"z"}\n{"type":"w"}`);
  const seen = [];
  await forEachHeadLine(f, (l) => { seen.push(JSON.parse(l).type); return false; }, { chunkSize: 4096 });
  assert.deepEqual(seen, ['x', 'y', 'z', 'w'], 'last line without trailing newline is included');
  const stopped = [];
  await forEachHeadLine(f, (l) => { stopped.push(JSON.parse(l).type); return stopped.length === 2; }, { chunkSize: 4096 });
  assert.deepEqual(stopped, ['x', 'y']);
  assert.deepEqual((await readHeadLines(f, 2, { chunkSize: 4096 })).map((l) => JSON.parse(l).type), ['x', 'y']);
  const capped = [];
  await forEachHeadLine(f, (l) => { capped.push(JSON.parse(l).type); return false; }, { chunkSize: 4096, maxBytes: 8192 });
  assert.deepEqual(capped, [], 'a first line longer than maxBytes is never completed');
});

test('readTailTimestamp finds the last timestamp cheaply', async () => {
  assert.equal(await readTailTimestamp(P.main267), '2026-10-01T10:01:10.000Z');
  assert.equal(await readTailTimestamp(P.journal), null);
  const f = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(f, '');
  assert.equal(await readTailTimestamp(f), null);
});

test('probeSession reads cwd/firstTs/sessionId/agentId from the head', async () => {
  const p = await probeSession(P.sub292);
  assert.equal(p.cwd, '/home/dev/proj');
  assert.equal(p.firstTs, '2026-10-03T14:00:00.000Z');
  assert.equal(p.sessionId, 'cccccccc-0292-4000-8000-000000000292');
  assert.equal(p.agentId, 'a1b2c3d4e5f60718');
  assert.equal(p.gitBranch, 'docs/readme');
  const j = await probeSession(P.journal);
  assert.equal(j.cwd, null);
  assert.equal(j.sessionId, 'journal');
});

test('listCandidateSessions recurses into subagents/ and workflows/, filters by cwd, reads only the head', async () => {
  const list = await listCandidateSessions({ repoRoot: '/home/dev/proj', projectsDir });
  const paths = list.map((c) => c.path).sort();
  assert.deepEqual(paths, [P.main267, P.main280, P.sub292, P.wf299].sort());
  const m267 = list.find((c) => c.path === P.main267);
  assert.deepEqual(m267, { path: P.main267, cwd: '/home/dev/proj', firstTs: '2026-10-01T10:00:00.000Z', sessionId: SID267, gitBranch: 'feat/retry', lastTs: '2026-10-01T10:01:10.000Z' });
  const sub = list.find((c) => c.path === P.sub292);
  assert.equal(sub.agentId, 'a1b2c3d4e5f60718');
  assert.equal(sub.sessionId, 'cccccccc-0292-4000-8000-000000000292');
  // sorted by firstTs
  assert.deepEqual(list.map((c) => c.firstTs), [...list.map((c) => c.firstTs)].sort());
  // the late-cwd file is found once the head window is wide enough
  const wide = await listCandidateSessions({ repoRoot: '/home/dev/proj', projectsDir, headLines: 80, withLastTs: false });
  assert.ok(wide.some((c) => c.path === P.late));
  assert.ok(wide.every((c) => c.lastTs === undefined));
});

test('listCandidateSessions: subdirectory repoRoot, trailing slash, ~ in projectsDir, missing dir', async () => {
  const sub = await listCandidateSessions({ repoRoot: '/home/dev/proj/src', projectsDir });
  assert.deepEqual(sub, [], 'cwd /home/dev/proj is not inside /home/dev/proj/src');
  const slash = await listCandidateSessions({ repoRoot: '/home/dev/proj/', projectsDir, withLastTs: false });
  assert.equal(slash.length, 4);
  const parent = await listCandidateSessions({ repoRoot: '/home/dev', projectsDir, withLastTs: false });
  assert.equal(parent.length, 5, 'parent dir matches both projects');
  const none = await listCandidateSessions({ repoRoot: '/home/dev/proj', projectsDir: path.join(tmp, 'nope') });
  assert.deepEqual(none, []);
  await assert.rejects(listCandidateSessions({ projectsDir }));
});

test('scoreSession: pr_link, diff files (capped), branch, cwd, time window, repository mismatch', async () => {
  const s280 = await readSession(P.main280);
  let r = scoreSession(s280, { repoRoot: '/home/dev/proj', diffFiles: ['src/config.py', 'src/app.py'], headRef: 'main' });
  assert.equal(r.score, 20 + 5 + 1);
  assert.equal(r.fileHits, 2);
  assert.ok(r.reasons.some((x) => x.startsWith('2 edits of 2 diff files')));
  assert.ok(r.reasons.includes('gitBranch main'));
  assert.ok(r.reasons.includes('cwd /home/dev/proj'));
  r = scoreSession(s280, { repoRoot: '/home/dev/proj', diffFiles: ['/home/dev/proj/src/config.py'], headRef: 'other' });
  assert.equal(r.score, 11, 'absolute diff file, no branch match');
  r = scoreSession(s280, { repoRoot: '/home/dev/proj', diffFiles: ['src/config.py'], timeWindow: { start: '2026-10-02T09:00:10.000Z', end: '2026-10-02T09:01:00.000Z' } });
  assert.equal(r.score, 1, 'edit before the window does not count');
  r = scoreSession(s280, { repoRoot: '/home/dev/proj', diffFiles: ['src/config.py'], timeWindow: { start: '2026-10-02T09:00:00.000Z' } });
  assert.equal(r.score, 11, 'open-ended window');
  r = scoreSession(s280, { repoRoot: '/home/dev/proj', diffFiles: ['src/config.py', 'src/app.py', 'docs/CHANGES.md', 'scripts/check.sh'] });
  assert.equal(r.fileHits, 4);
  assert.equal(r.score, 41);

  const s292 = await readSession(P.sub292);
  r = scoreSession(s292, { repoRoot: '/home/dev/proj', prNumber: 77, prRepository: 'devorg/proj' });
  assert.equal(r.score, 101);
  assert.equal(r.prHit, true);
  assert.ok(r.reasons[0].startsWith('pr_link #77 (devorg/proj) via pr-link'));
  r = scoreSession(s292, { repoRoot: '/home/dev/proj', prNumber: 77, prRepository: 'someone/else' });
  assert.equal(r.score, 1, 'repository mismatch cancels the PR match');
  r = scoreSession(s292, { repoRoot: '/home/dev/proj', prNumber: '77' });
  assert.equal(r.score, 101, 'string prNumber accepted');
  r = scoreSession(s292, { repoRoot: '/home/dev/proj', prNumber: 78 });
  assert.equal(r.score, 1);

  const s267 = await readSession(P.main267);
  r = scoreSession(s267, { repoRoot: '/home/dev/proj', prNumber: 42, prRepository: 'devorg/proj' });
  assert.equal(r.score, 101, 'gitOperation.pr counts like a pr-link line');

  // cap at 60: a session with many edits of one diff file
  const many = { events: Array.from({ length: 12 }, (_, i) => ({ type: i % 2 ? 'edit' : 'shell_edit', ts: `2026-10-02T09:00:${String(i).padStart(2, '0')}.000Z`, edit: { file: '/home/dev/proj/x.py' } })), meta: { cwd: '/home/dev/proj', gitBranches: [] } };
  r = scoreSession(many, { repoRoot: '/home/dev/proj', diffFiles: ['x.py'] });
  assert.equal(r.score, 61);
});

test('discoverSessionsForPR: PR number match, diff files, minScore, considered, ordering', async () => {
  let d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', projectsDir, prNumber: 77, prRepository: 'devorg/proj', diffFiles: ['docs/usage.md'] });
  assert.equal(d.considered, 4);
  assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].path, P.sub292);
  assert.equal(d.sessions[0].sessionId, 'cccccccc-0292-4000-8000-000000000292');
  assert.equal(d.sessions[0].agentId, 'a1b2c3d4e5f60718');
  assert.equal(d.sessions[0].score, 111);
  assert.ok(Array.isArray(d.sessions[0].reasons) && d.sessions[0].reasons.length >= 2);

  d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', projectsDir, prNumber: 9999, headRef: 'chore/move', diffFiles: ['docs/CHANGES.md', 'src/util/helper.py', 'src/util/__init__.py'] });
  // 299: 3 edit events on diff files (+30) + branch (+5) + cwd (+1) = 36; 280: CHANGES.md (+10) + cwd = 11
  assert.deepEqual(d.sessions.map((s) => [path.basename(s.path), s.score]), [['agent-b2c3d4e5f6071829.jsonl', 36], [`${SID280}.jsonl`, 11]]);

  d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', projectsDir, prNumber: 9999, diffFiles: ['nothing.py'] });
  assert.deepEqual(d.sessions, [], 'cwd alone (score 1) does not select');
  d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', projectsDir, prNumber: 9999, diffFiles: ['nothing.py'], minScore: 1 });
  assert.equal(d.sessions.length, 4);
  assert.ok(d.sessions.every((s) => s.score === 1));

  // time window prefilter skips sessions entirely outside the window when no PR number is given
  d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', projectsDir, diffFiles: ['src/config.py'], timeWindow: { start: '2026-10-02T00:00:00.000Z', end: '2026-10-02T23:59:59.000Z' } });
  assert.equal(d.considered, 1);
  assert.equal(d.sessions[0].path, P.main280);
  assert.equal(d.sessions[0].score, 11);

  // candidates passthrough and onSession hook
  const seen = [];
  d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', candidates: [{ path: P.main267, sessionId: SID267 }], prNumber: 42, onSession: (row) => seen.push(row.score) });
  assert.deepEqual(seen, [101]);
  assert.equal(d.sessions[0].firstTs, '2026-10-01T10:00:00.000Z');
  assert.equal(d.sessions[0].lastTs, '2026-10-01T10:01:10.000Z');
  await assert.rejects(discoverSessionsForPR({ projectsDir }));
});

test('discoverSessionsForPR: unreadable candidate is skipped, output strings avoid forbidden vocabulary', async () => {
  const d = await discoverSessionsForPR({ repoRoot: '/home/dev/proj', candidates: [{ path: path.join(tmp, 'missing.jsonl') }, { path: P.main280 }], diffFiles: ['src/app.py'] });
  assert.equal(d.considered, 2);
  assert.equal(d.sessions.length, 1);
  const text = JSON.stringify(d);
  const forbidden = new RegExp(`\\b(${['test', 'verifi', 'cover'].map((s) => s + 'ed').join('|')})\\b`, 'i');
  assert.ok(!forbidden.test(text));
});
