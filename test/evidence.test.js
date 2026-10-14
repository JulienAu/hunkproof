import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COST_LABEL, summarizeUsage } from '../src/cost.js';
import { DEFINITIONS, EVIDENCE_SCHEMA, REDACTION, buildEvidence, redactEvidence, readGitNote, writeGitNote } from '../src/evidence.js';

const HOME = '/home/alice';

function sampleInput() {
  const run = {
    ts: '2026-10-14T10:05:00.000Z',
    sessionId: 's1',
    toolUseId: 'toolu_1',
    command: 'node --test test/ # by alice@example.com',
    runner: 'node --test',
    outcome: 'pass',
    summary: '12 passing',
    isError: false,
    targets: [],
    targeted: true,
  };
  const hunkBase = {
    file: '/repo/src/a.js',
    relFile: 'src/a.js',
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    added: ['const a = 1;', 'const b = 2;'],
    removed: [],
    addedNormalized: ['const a = 1;', 'const b = 2;'],
    edits: [{ ts: '2026-10-14T10:00:00.000Z', sessionId: 's1', tool: 'Edit', toolUseId: 'toolu_0' }],
    churn: 1,
    lastEdit: '2026-10-14T10:00:00.000Z',
    score: 1,
  };
  return {
    repo: { root: '/repo', remote: 'git@github.com:acme/repo.git', base: 'main', head: 'abc1234', prNumber: 1, prUrl: 'https://github.com/acme/repo/pull/1' },
    sessions: [
      { sessionId: 's1', path: '/home/alice/.claude/projects/-repo/s1.jsonl', firstTs: '2026-10-14T09:00:00.000Z', lastTs: '2026-10-14T10:30:00.000Z', versions: ['2.1.299'], models: ['claude-opus-5-5'], toolCalls: 12, edits: 3, shellEdits: 1, runs: 2 },
      { sessionId: 's2', path: '/home/alice/.claude/projects/-repo/s2.jsonl', firstTs: '2026-10-14T08:00:00.000Z', lastTs: '2026-10-14T08:10:00.000Z', versions: ['2.1.298'], models: [], toolCalls: 3, edits: 0, shellEdits: 0, runs: 0 },
    ],
    hunks: [
      { ...hunkBase, id: 'src/a.js:1', attribution: 'MATCHED', status: 'RUN_PASS', runsAfter: [run], intent: { text: 'wire the key sk-ant-api03-Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Zx9Cv8Bn7Mm6 into /home/alice/app', ts: '2026-10-14T09:59:00.000Z', sessionId: 's1' } },
      { ...hunkBase, id: 'src/a.js:40', newStart: 40, attribution: 'MATCHED', status: 'RUN_FAIL', runsAfter: [{ ...run, outcome: 'fail', targeted: false }], intent: null },
      { ...hunkBase, id: 'src/a.js:80', newStart: 80, attribution: 'FILE_LEVEL', status: 'UNRUN', runsAfter: [], intent: null },
      { ...hunkBase, id: 'src/b.js:1', file: '/repo/src/b.js', relFile: 'src/b.js', attribution: 'MATCHED', status: 'RUN_UNPARSED', runsAfter: [{ ...run, outcome: 'unparsed', targeted: true }], intent: null },
      { ...hunkBase, id: 'src/c.js:1', file: '/repo/src/c.js', relFile: 'src/c.js', attribution: 'UNATTRIBUTED', status: 'UNATTRIBUTED', edits: [], churn: 0, lastEdit: null, score: 0, runsAfter: [], intent: null },
    ],
    runs: [run],
    usage: summarizeUsage([
      { type: 'usage', messageId: 'm1', requestId: 'r1', uuid: 'u1', usage: { model: 'claude-opus-5-5', input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 } },
    ]),
    elapsedMs: 321,
    generatedAt: '2026-10-14T11:00:00.000Z',
    version: '0.1.0',
    home: HOME,
  };
}

test('buildEvidence produces the exact top-level schema', () => {
  const ev = buildEvidence(sampleInput());
  assert.deepEqual(Object.keys(ev), ['schema', 'generatedAt', 'tool', 'repo', 'sessions', 'hunks', 'runs', 'usage', 'summary', 'definitions', 'redaction']);
  assert.equal(ev.schema, 'hunkproof/evidence@1');
  assert.equal(ev.schema, EVIDENCE_SCHEMA);
  assert.equal(ev.generatedAt, '2026-10-14T11:00:00.000Z');
  assert.deepEqual(ev.tool, { name: 'hunkproof', version: '0.1.0' });
  assert.deepEqual(Object.keys(ev.repo), ['root', 'remote', 'base', 'head', 'prNumber', 'prUrl']);
  assert.deepEqual(Object.keys(ev.sessions[0]), ['sessionId', 'path', 'firstTs', 'lastTs', 'versions', 'models', 'toolCalls', 'edits', 'shellEdits', 'runs']);
  assert.deepEqual(Object.keys(ev.summary), [
    'hunks', 'attributed', 'matched', 'fileLevel', 'unattributed', 'runAfterLastEdit', 'runPass', 'runFail', 'runUnparsed', 'unrun',
    'strictRunAfterLastEdit', 'sessions', 'durationSec', 'toolCalls', 'llmTokensUsedByHunkproof', 'elapsedMs',
  ]);
  assert.deepEqual(Object.keys(ev.definitions), ['hunk', 'attribution', 'run', 'status', 'targeted', 'cost']);
  assert.deepEqual(ev.redaction, REDACTION);
  assert.deepEqual(Object.keys(ev.redaction), ['home', 'rules', 'note']);
  assert.equal(ev.redaction.rules.length, 4);
  assert.match(ev.redaction.note, /nothing else is rewritten/);
});

test('buildEvidence rewrites home paths in every string field: repo root, files, checkouts, diff lines, session paths', () => {
  const input = sampleInput();
  input.repo.root = '/home/alice/repo';
  input.sessions[0].path = '/home/alice/.claude/projects/-home-alice-repo/s1.jsonl';
  input.hunks[0].file = '/home/alice/repo/src/a.js';
  input.hunks[0].checkout = '/home/alice/repo';
  input.hunks[0].edits = [{ ts: '2026-10-14T10:00:00.000Z', sessionId: 's1', tool: 'Edit', toolUseId: 'toolu_0', checkout: '/home/alice/repo/.claude/worktrees/w1', chain: true }];
  input.hunks[0].added = ["const HOME = '/home/alice/repo';", "const OTHER = '/home/bob/x';", "const MAC = '/Users/carol/y';", "const WIN = 'C:\\\\Users\\\\dave\\\\z';"];
  input.hunks[0].addedNormalized = input.hunks[0].added.slice();
  input.hunks[0].removed = ['// see -home-alice-repo in ~/.claude/projects'];
  input.runs[0].checkout = '/home/alice/repo';
  const ev = buildEvidence(input);
  const text = JSON.stringify(ev);
  for (const raw of ['/home/alice', '-home-alice', '/home/bob', '/Users/carol', 'C:\\\\Users\\\\dave']) {
    assert.equal(text.includes(raw), false, `${raw} survives in the evidence`);
  }
  assert.equal(ev.repo.root, '~/repo');
  assert.equal(ev.sessions[0].path, '~/.claude/projects/~-repo/s1.jsonl');
  assert.equal(ev.hunks[0].file, '~/repo/src/a.js');
  assert.equal(ev.hunks[0].checkout, '~/repo');
  assert.equal(ev.hunks[0].edits[0].checkout, '~/repo/.claude/worktrees/w1');
  assert.deepEqual(ev.hunks[0].added, ["const HOME = '~/repo';", "const OTHER = '~/x';", "const MAC = '~/y';", "const WIN = '~\\\\z';"]);
  assert.deepEqual(ev.hunks[0].removed, ['// see ~-repo in ~/.claude/projects']);
  assert.equal(ev.runs[0].checkout, '~/repo');
  // a sha, a number and the ids are not strings the path rules touch
  assert.equal(ev.repo.head, 'abc1234');
  assert.equal(ev.hunks[0].newLines, 2);
  assert.equal(ev.hunks[0].id, 'src/a.js:1');
});

test('redactEvidence covers fields added after buildEvidence and is idempotent', () => {
  const ev = buildEvidence(sampleInput());
  ev.repo.headSha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
  ev.discovery = { candidates: 3, considered: 2, selected: [{ sessionId: 's1', path: '/home/alice/.claude/projects/-home-alice-repo/s1.jsonl', score: 20, reasons: ['cwd /home/alice/repo'] }], timeWindow: { start: null, end: 'x', firstCommit: null } };
  const once = redactEvidence(ev, { home: HOME });
  assert.equal(once.discovery.selected[0].path, '~/.claude/projects/~-repo/s1.jsonl');
  assert.deepEqual(once.discovery.selected[0].reasons, ['cwd ~/repo']);
  assert.equal(once.repo.headSha, 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', 'the path rules leave a commit sha alone');
  assert.equal(once.discovery.candidates, 3);
  assert.deepEqual(redactEvidence(once, { home: HOME }), once);
  assert.equal(JSON.stringify(ev).includes('/home/alice'), true, 'the input object is not mutated');
});

test('buildEvidence computes the summary counts', () => {
  const ev = buildEvidence(sampleInput());
  assert.deepEqual(ev.summary, {
    hunks: 5,
    attributed: 3, // line-matched only: the FILE_LEVEL hunk is not in the headline
    matched: 3,
    fileLevel: 1,
    unattributed: 1,
    runAfterLastEdit: 3,
    runPass: 1,
    runFail: 1,
    runUnparsed: 1,
    unrun: 1,
    strictRunAfterLastEdit: 2,
    sessions: 2,
    durationSec: 2.5 * 3600,
    toolCalls: 15,
    llmTokensUsedByHunkproof: 0,
    elapsedMs: 321,
  });
});

test('buildEvidence redacts intent text and run commands and rewrites home paths', () => {
  const ev = buildEvidence(sampleInput());
  assert.equal(ev.hunks[0].intent.text, 'wire the key [REDACTED:key] into ~/app');
  assert.equal(ev.hunks[0].intent.ts, '2026-10-14T09:59:00.000Z');
  assert.equal(ev.sessions[0].path, '~/.claude/projects/-repo/s1.jsonl');
  assert.equal(ev.runs[0].command, 'node --test test/ # by [REDACTED:email]');
  assert.deepEqual(Object.keys(ev.hunks[0].runsAfter[0]), ['ts', 'sessionId', 'command', 'runner', 'outcome', 'summary', 'targeted']);
  assert.equal(ev.hunks[0].runsAfter[0].sessionId, 's1');
  assert.equal(ev.hunks[0].runsAfter[0].command, 'node --test test/ # by [REDACTED:email]');
  assert.equal(JSON.stringify(ev).includes('sk-ant-'), false);
  assert.equal(JSON.stringify(ev).includes('/home/alice'), false);
});

test('buildEvidence attaches the cost label and keeps usage numbers', () => {
  const ev = buildEvidence(sampleInput());
  assert.equal(ev.usage.label, COST_LABEL);
  assert.equal(ev.usage.totals.messages, 1);
  assert.equal(ev.usage.byModel['claude-opus-5-5'].input, 1000);
  assert.equal(typeof ev.usage.costListUSD, 'number');
  assert.equal(ev.usage.priceListDate, '2026-10-14');
  const empty = buildEvidence({ generatedAt: 'x', version: '0', home: HOME });
  assert.equal(empty.usage.label, COST_LABEL);
  assert.equal(empty.usage.totals.messages, 0);
  assert.equal(empty.summary.hunks, 0);
  assert.equal(empty.summary.durationSec, 0);
});

test('buildEvidence: FILE_LEVEL hunks with runs are not counted in the line-matched headline numbers', () => {
  const input = sampleInput();
  // turn the FILE_LEVEL hunk into one with a passing run after its (file) edit
  const fl = input.hunks.find((h) => h.attribution === 'FILE_LEVEL');
  fl.status = 'RUN_PASS';
  fl.runsAfter = [input.runs[0]];
  const ev = buildEvidence(input);
  assert.equal(ev.summary.attributed, 3);
  assert.equal(ev.summary.fileLevel, 1);
  assert.equal(ev.summary.runAfterLastEdit, 3, 'the file-level RUN_PASS does not count');
  assert.equal(ev.summary.runPass, 1);
  assert.equal(ev.summary.unrun, 0);
  assert.equal(ev.summary.runPass + ev.summary.runFail + ev.summary.runUnparsed, ev.summary.runAfterLastEdit);
});

test('buildEvidence keeps otherCheckout on runs and reason on hunks', () => {
  const input = sampleInput();
  input.hunks[0].runsAfter = [{ ...input.runs[0], targeted: false, otherCheckout: true }];
  input.hunks[4].reason = 'only edits before the branch base';
  const ev = buildEvidence(input);
  assert.deepEqual(Object.keys(ev.hunks[0].runsAfter[0]), ['ts', 'sessionId', 'command', 'runner', 'outcome', 'summary', 'targeted', 'otherCheckout']);
  assert.equal(ev.hunks[0].runsAfter[0].otherCheckout, true);
  assert.equal(ev.hunks[4].reason, 'only edits before the branch base');
});

test('buildEvidence fills missing attribution and status, and is deterministic', () => {
  const input = sampleInput();
  input.hunks = [{ id: 'x:1', file: '/repo/x', relFile: 'x', added: [], removed: [], addedNormalized: [] }];
  const ev = buildEvidence(input);
  assert.equal(ev.hunks[0].attribution, 'UNATTRIBUTED');
  assert.equal(ev.hunks[0].status, 'UNATTRIBUTED');
  assert.deepEqual(ev.hunks[0].runsAfter, []);
  assert.equal(ev.hunks[0].intent, null);
  assert.equal(JSON.stringify(buildEvidence(sampleInput())), JSON.stringify(buildEvidence(sampleInput())));
});

test('definitions are plain English and follow the vocabulary rule', () => {
  const ev = buildEvidence(sampleInput());
  const text = Object.values(ev.definitions).join('\n') + Object.values(DEFINITIONS).join('\n');
  assert.doesNotMatch(text, /\b(tested|verified|covered)\b/i);
  assert.doesNotMatch(text, /proof that it works/i);
  for (const k of ['hunk', 'attribution', 'run', 'status', 'targeted', 'cost']) {
    assert.equal(typeof ev.definitions[k], 'string');
    assert.ok(ev.definitions[k].length > 40, k);
  }
  assert.match(ev.definitions.status, /ran, failed/);
  assert.match(ev.definitions.status, /ran, outcome not parsed/);
  assert.match(ev.definitions.status, /UNRUN/);
  assert.match(ev.definitions.cost, /list prices/);
  assert.match(ev.definitions.cost, /not a bill/);
  assert.match(ev.definitions.attribution, /predate the branch base/);
  const custom = buildEvidence({ ...sampleInput(), definitions: { cost: 'custom cost text' } });
  assert.equal(custom.definitions.cost, 'custom cost text');
  assert.equal(custom.definitions.hunk, DEFINITIONS.hunk);
});

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hunkproof-evidence-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' },
  }).trim();
  g('init', '-q', '.');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'first');
  const first = g('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  g('commit', '-q', '-am', 'second');
  const second = g('rev-parse', 'HEAD');
  return { dir, g, first, second };
}

test('writeGitNote and readGitNote round-trip through refs/notes/hunkproof', (t) => {
  const { dir, g, first, second } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(readGitNote({ repoRoot: dir, head: 'HEAD' }), null);

  const evidence = buildEvidence({ ...sampleInput(), repo: { root: dir, base: first, head: second } });
  const res = writeGitNote({ repoRoot: dir, head: 'HEAD', evidence });
  assert.deepEqual(res, { ref: 'refs/notes/hunkproof', head: second });

  assert.deepEqual(readGitNote({ repoRoot: dir, head: 'HEAD' }), evidence);
  assert.deepEqual(readGitNote({ repoRoot: dir, head: second }), evidence);
  assert.equal(readGitNote({ repoRoot: dir, head: first }), null);
  assert.equal(readGitNote({ repoRoot: dir, head: 'no-such-ref' }), null);

  // The default notes ref is untouched and the raw note is pretty JSON.
  assert.throws(() => g('notes', 'show', 'HEAD'));
  const raw = g('notes', '--ref=hunkproof', 'show', 'HEAD');
  assert.equal(raw, JSON.stringify(evidence, null, 2));
  assert.equal(g('notes', '--ref=hunkproof', 'list').split('\n').length, 1);

  // -f overwrites on a second write instead of failing.
  const evidence2 = { ...evidence, generatedAt: '2026-10-14T12:00:00.000Z' };
  writeGitNote({ repoRoot: dir, head: second, evidence: evidence2 });
  assert.equal(readGitNote({ repoRoot: dir }).generatedAt, '2026-10-14T12:00:00.000Z');
  assert.equal(g('notes', '--ref=hunkproof', 'list').split('\n').length, 1);
});

test('a note larger than the 1 MB child-process default reads back whole', (t) => {
  // a diff-only run on a medium PR writes a note of 1 to 3 MB; execFileSync's
  // default maxBuffer made `git notes show` throw and the note read as missing
  const { dir, second, first } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidence = buildEvidence({ ...sampleInput(), repo: { root: dir, base: first, head: second } });
  evidence.hunks[0].intent.text = 'x'.repeat(2 * 1024 * 1024);
  writeGitNote({ repoRoot: dir, head: second, evidence });
  const back = readGitNote({ repoRoot: dir, head: second });
  assert.ok(back, 'the note reads back');
  assert.equal(back.hunks[0].intent.text.length, 2 * 1024 * 1024);
  assert.deepEqual(back, evidence);
});

test('readGitNote returns null for a note that is not an evidence document', (t) => {
  const { dir, g } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  g('notes', '--ref=hunkproof', 'add', '-f', '-m', 'not json', 'HEAD');
  assert.equal(readGitNote({ repoRoot: dir }), null);
  g('notes', '--ref=hunkproof', 'add', '-f', '-m', '{"schema":"other"}', 'HEAD');
  assert.equal(readGitNote({ repoRoot: dir }), null);
});

test('writeGitNote rejects missing arguments and a head that does not resolve', (t) => {
  const { dir } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => writeGitNote({ head: 'HEAD', evidence: {} }), /repoRoot/);
  assert.throws(() => writeGitNote({ repoRoot: dir, head: 'HEAD' }), /evidence/);
  assert.throws(() => writeGitNote({ repoRoot: dir, head: 'does-not-exist', evidence: { schema: EVIDENCE_SCHEMA } }));
});
