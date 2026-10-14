import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anonymizeStats, corpusStats, renderStats, sessionRecord, foldRecord } from '../src/stats.js';
import { runCli } from '../src/cli.js';
import { PassThrough } from 'node:stream';
import { encodeProjectDir } from '../src/discover.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'fixtures', 'sessions');
const FORBIDDEN = new RegExp(`\\b(${['test', 'verifi', 'cover'].map((s) => s + 'ed').join('|')})\\b|proof that it works`, 'i');

let tmp;
let projectsDir;

before(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hunkproof-stats-'));
  projectsDir = path.join(tmp, 'projects');
  const proj = path.join(projectsDir, encodeProjectDir('/home/dev/proj'));
  const sub = path.join(proj, 'bbbbbbbb-0280-4000-8000-000000000280', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'v2.1.267-no-bashEditDiff.jsonl'), path.join(proj, 'aaaaaaaa-0267-4000-8000-000000000267.jsonl'));
  fs.copyFileSync(path.join(FIX, 'v2.1.280-bashEditDiff.jsonl'), path.join(proj, 'bbbbbbbb-0280-4000-8000-000000000280.jsonl'));
  fs.copyFileSync(path.join(FIX, 'v2.1.292-unavailable.jsonl'), path.join(sub, 'agent-a1b2c3d4e5f60718.jsonl'));
  const other = path.join(projectsDir, encodeProjectDir('/home/dev/other'));
  fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'v2.1.299-split-usage.jsonl'), path.join(other, 'dddddddd-0299-4000-8000-000000000299.jsonl'));
  fs.writeFileSync(path.join(other, 'empty.jsonl'), '');
  fs.writeFileSync(path.join(other, 'garbage.jsonl'), 'not json\n');
});

after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('sessionRecord keeps only compact facts per transcript', async () => {
  const rec = await sessionRecord(path.join(FIX, 'v2.1.280-bashEditDiff.jsonl'), { projectsDir: FIX });
  assert.equal(rec.cwd, '/home/dev/proj');
  assert.equal(rec.project, 'v2.1.280-bashEditDiff.jsonl');
  assert.ok(rec.edits.length >= 1);
  assert.ok(rec.edits.every((e) => typeof e.file === 'string' && typeof e.ts === 'string' && Object.keys(e).length === 2));
  assert.ok(rec.runs.every((r) => ['pass', 'fail', 'unparsed'].includes(r.outcome) && Array.isArray(r.targets)));
  assert.ok(Array.isArray(rec.commits));
  const none = await sessionRecord(path.join(tmp, 'projects', encodeProjectDir('/home/dev/other'), 'garbage.jsonl'), {});
  assert.equal(none, null);
});

test('foldRecord: unrun files, strict/pass variants, commits with edits after the last run', () => {
  const b = {
    project: 'p', cwd: null, sessions: 0, toolCalls: 0, editEvents: 0, toolEdits: 0, shellEdits: 0, runs: 0, commits: 0,
    files: new Set(), fileEdits: 0, looseUnrun: 0, strictUnrun: 0, passUnrun: 0,
    commitsEditAfterLastRun: 0, commitsEditAfterLastPass: 0, commitsWithEdits: 0,
  };
  foldRecord(b, {
    cwd: '/p', toolCalls: 6, toolEdits: 3, shellEdits: 1,
    edits: [
      { file: '/p/src/alpha.py', ts: '2026-10-14T10:00:00Z' },
      { file: '/p/src/beta.py', ts: '2026-10-14T10:01:00Z' },
      { file: '/p/src/alpha.py', ts: '2026-10-14T10:06:00Z' }, // after the last run: unrun
      { file: '/p/src/gamma.py', ts: '2026-10-14T10:02:00Z' },
    ],
    runs: [
      { ts: '2026-10-14T10:03:00Z', outcome: 'fail', targets: ['tests/test_beta.py'] }, // targets beta only
      { ts: '2026-10-14T10:04:00Z', outcome: 'pass', targets: ['tests/test_gamma.py'] },
    ],
    commits: ['2026-10-14T10:05:00Z', '2026-10-14T10:07:00Z'],
  });
  assert.equal(b.sessions, 1);
  assert.equal(b.editEvents, 4);
  assert.equal(b.files.size, 3);
  assert.equal(b.fileEdits, 3);
  assert.equal(b.looseUnrun, 1, 'alpha.py: last edit after every run');
  assert.equal(b.strictUnrun, 1, 'beta and gamma each have a targeted run after their last edit');
  assert.equal(b.passUnrun, 1, 'beta and gamma both see the 10:04 passing run after their last edit; alpha does not');
  assert.equal(b.commitsWithEdits, 2);
  assert.equal(b.commitsEditAfterLastRun, 1, 'second commit follows the 10:06 edit made after the 10:04 run');
  assert.equal(b.commitsEditAfterLastPass, 1);
});

test('corpusStats merges per project, skips empty/garbage files, honours since', async () => {
  const s = await corpusStats({ projectsDir, workers: 1 });
  assert.equal(s.transcriptsRead, 4);
  assert.equal(s.projects, 2);
  const proj = s.byProject.find((p) => p.project === encodeProjectDir('/home/dev/proj'));
  assert.equal(proj.sessions, 3, 'subagent transcript counts under its project');
  assert.ok(proj.editEvents > 0);
  assert.ok(s.loose.pct >= 0 && s.loose.pct <= 100);
  assert.equal(s.sessions, 4);
  const future = await corpusStats({ projectsDir, workers: 1, since: '2999-01-01T00:00:00Z' });
  assert.equal(future.transcriptsRead, 0);
  assert.equal(future.projects, 0);
});

test('corpusStats with child-process workers gives the same numbers', async () => {
  const one = await corpusStats({ projectsDir, workers: 1 });
  const two = await corpusStats({ projectsDir, workers: 2 });
  const strip = (s) => { const { elapsedMs, workers, ...rest } = s; return rest; };
  assert.deepEqual(strip(two), strip(one));
  assert.equal(two.workers, 2);
});

test('anonymizeStats: project-01..NN by sessions desc, numbers and order unchanged, all projects row kept', async () => {
  const s = await corpusStats({ projectsDir, workers: 1 });
  const a = anonymizeStats(s);
  assert.equal(a.anonymized, true);
  assert.equal(a.byProject.length, s.byProject.length);
  // the same rows, only the label and cwd differ; rows follow the label order
  const strip1 = ({ project, cwd, ...rest }) => rest;
  const key = (p) => JSON.stringify(strip1(p));
  assert.deepEqual(a.byProject.map(key).sort(), s.byProject.map(key).sort());
  assert.deepEqual(a.byProject.map((p) => p.project), ['project-01', 'project-02']);
  assert.deepEqual(a.byProject.map((p) => p.cwd), [null, null]);
  assert.equal(a.byProject[0].sessions, 3, 'the project with the most sessions is project-01');
  assert.equal(a.byProject[1].sessions, 1);
  assert.ok(s.byProject.every((p) => p.cwd === null || typeof p.cwd === 'string'));
  assert.ok(!JSON.stringify(a.byProject).includes('home-dev'), 'no project directory survives');
  assert.ok(!a.projectsDir.includes(os.homedir()), 'the transcript root is tildified');
  // the totals are untouched
  const strip = ({ byProject, projectsDir, anonymized, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(s));
  // the table shows the labels and keeps the all projects row
  const text = renderStats(a);
  assert.match(text, /^project-01\s+3\s/m);
  assert.match(text, /^project-02\s+1\s/m);
  assert.match(text, /^all projects\s+4\s/m);
  assert.ok(!text.includes('home-dev'));
  assert.deepEqual(anonymizeStats(a).byProject.map((p) => p.project), a.byProject.map((p) => p.project), 'stable on a second pass');
});

test('cli: stats --anonymize prints labels, plain stats prints directories', async () => {
  const run = async (args) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let out = '';
    stdout.on('data', (d) => { out += d; });
    stderr.on('data', () => {});
    stdin.end('');
    const code = await runCli(args, { stdout, stderr, stdin });
    return { code, out };
  };
  const plain = await run(['stats', '--projects-dir', projectsDir, '--since', '0']);
  assert.equal(plain.code, 0);
  assert.ok(plain.out.includes('-home-dev-proj'), 'without the flag the directory is shown');
  const anon = await run(['stats', '--projects-dir', projectsDir, '--since', '0', '--anonymize']);
  assert.equal(anon.code, 0);
  assert.ok(!anon.out.includes('home-dev'), anon.out);
  assert.match(anon.out, /^project-01\s+3\s/m);
  assert.match(anon.out, /^all projects\s+4\s/m);
  const json = await run(['stats', '--projects-dir', projectsDir, '--since', '0', '--anonymize', '--json']);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.anonymized, true);
  assert.deepEqual(parsed.byProject.map((p) => p.cwd), [null, null]);
  assert.ok(!json.out.includes('home-dev'));
});

test('renderStats: table with a total row, vocabulary rule', async () => {
  const s = await corpusStats({ projectsDir, workers: 1 });
  const text = renderStats(s);
  assert.match(text, /^hunkproof stats · 4 transcripts/);
  assert.match(text, /project\s+sessions\s+files\s+file edits\s+edits\s+runs\s+commits\s+unrun\s+strict\s+no pass\s+commit after edit/);
  assert.match(text, /^all projects\s+4\s/m);
  // every ratio carries its denominator: "n/d (p%)", the three unrun columns over file edits
  const total = text.split('\n').find((l) => l.startsWith('all projects'));
  const ratios = total.match(/\d+\/\d+ \(\d+(?:\.\d+)?%\)/g) || [];
  assert.equal(ratios.length, 4, total);
  const fileEdits = Number(total.trim().split(/\s{2,}/)[3]);
  assert.equal(fileEdits, s.fileEdits);
  assert.equal(ratios[0], `${s.loose.noRunAfterLastEdit}/${s.fileEdits} (${s.loose.pct}%)`);
  assert.match(text, /^file edits = \(transcript, file\) pairs with at least one edit: \d+/m);
  assert.ok(!FORBIDDEN.test(text), 'stats output follows the vocabulary rule');
  // a project directory that only contains the encoded home (a scratch tree
  // under /tmp) is rewritten like the ones that start with it
  const encodedHome = encodeProjectDir(os.homedir());
  const rows = [...s.byProject];
  rows.push({ ...s.byProject[0], project: `-tmp-scratch-${encodedHome}-x` });
  rows.push({ ...s.byProject[0], project: `${encodedHome}-y` });
  const text2 = renderStats({ ...s, byProject: rows });
  assert.ok(!text2.includes(encodedHome), 'no row prints the encoded home');
  assert.match(text2, /^-tmp-scratch-~-x\s/m);
  assert.match(text2, /^~-y\s/m);
  assert.ok(!FORBIDDEN.test(fs.readFileSync(path.join(here, '..', 'src', 'stats.js'), 'utf8')));
  assert.ok(!FORBIDDEN.test(fs.readFileSync(path.join(here, '..', 'src', 'cli.js'), 'utf8')));
});
