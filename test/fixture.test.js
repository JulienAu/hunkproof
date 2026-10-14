// fixtures/self-pr is hunkproof run on its own merged PR #2 (branch build/v0.1)
// on 2026-10-14:
//   node bin/hunkproof.js --pr 2 --base 1af692a4 --head 102eae0 --no-note
// The range stops at the last code commit of the PR, before the commit that
// added this fixture itself (a receipt of a diff that contains a 2 MB
// evidence.json quotes itself); as for every merged PR, transcript events after
// the merge commit are left out. evidence.json, hunkproof.html and hunkproof.md
// are as the CLI wrote them, diff.patch is the unified diff of that range
// (git diff -U0 -M, the command src/diff.js runs), with two deviations:
//   1. diff.patch went through the home-path rules of src/redact.js, as the
//      diff lines inside evidence.json already had;
//   2. the private project names quoted in agent commands and in test data
//      were replaced in evidence.json and diff.patch before the HTML and
//      Markdown were re-rendered from them (other-app, My_App / My-App,
//      ~/My_App/app, JulienAu/third-app). Numbers, ids, line numbers and
//      statuses are untouched. The names themselves stay out of this tree,
//      so the check that none is left is a release-checklist grep, not a test.
//
// The numbers below are the ones printed in the README receipt card, so a
// change here means the README card changes too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { runCli, parseRemote } from '../src/cli.js';
import { parseUnifiedDiff } from '../src/diff.js';
import { encodeProjectDir } from '../src/discover.js';
import { renderHtml } from '../src/render-html.js';
import { renderMarkdown } from '../src/render-md.js';
import { renderTerminal, summarySentence } from '../src/render-terminal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const dir = path.join(repoRoot, 'fixtures', 'self-pr');
const files = {
  evidence: path.join(dir, 'evidence.json'),
  html: path.join(dir, 'hunkproof.html'),
  md: path.join(dir, 'hunkproof.md'),
  diff: path.join(dir, 'diff.patch'),
};
const evidence = JSON.parse(fs.readFileSync(files.evidence, 'utf8'));
const FORBIDDEN = /\b(tested|verified|covered)\b|proof that it works/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

const SUMMARY = {
  hunks: 68,
  attributed: 64,
  matched: 64,
  fileLevel: 3,
  unattributed: 1,
  runAfterLastEdit: 64,
  runPass: 64,
  runFail: 0,
  runUnparsed: 0,
  unrun: 0,
  strictRunAfterLastEdit: 64,
  sessions: 9,
  durationSec: 34232,
  toolCalls: 642,
  llmTokensUsedByHunkproof: 0,
  elapsedMs: 3513,
};

// Every attributed hunk had a passing run after its last edit in this range.
const UNRUN = [];
const HOME_PATH = /\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[A-Za-z0-9._-]+/;

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => { out += d; });
  stderr.on('data', (d) => { err += d; });
  stdin.end('');
  return { streams: { stdout, stderr, stdin }, out: () => out, err: () => err };
}

test('self-pr fixture: the summary of hunkproof run on its own PR #2', () => {
  assert.equal(evidence.schema, 'hunkproof/evidence@1');
  assert.equal(evidence.tool.name, 'hunkproof');
  assert.equal(evidence.repo.prNumber, 2);
  assert.equal(evidence.repo.prUrl, 'https://github.com/JulienAu/hunkproof/pull/2');
  assert.equal(evidence.repo.base, '1af692a4');
  assert.equal(evidence.repo.head, '102eae0');
  assert.equal(evidence.repo.headSha, '102eae0549c99f0dc4ba212569243500fa757116');
  assert.equal(evidence.repo.mergeBase, '1af692a49406b71fb35fe99d44b407b6cd3d1bd1');
  assert.equal(evidence.repo.root, '~/hunkproof');
  assert.equal(evidence.discovery.timeWindow.end, '2026-10-14T16:23:26.000Z', 'the window ends at the merge commit');
  assert.deepEqual(evidence.summary, SUMMARY);
  assert.equal(evidence.hunks.length, SUMMARY.hunks);
  assert.equal(evidence.sessions.length, SUMMARY.sessions);
  assert.equal(evidence.usage.totals.input + evidence.usage.totals.output > 0, true, 'agent tokens are counted');
});

test('self-pr fixture: statuses are consistent with the runs they cite', () => {
  const unrun = evidence.hunks.filter((h) => h.status === 'UNRUN').map((h) => h.id).sort();
  assert.deepEqual(unrun, UNRUN);
  for (const h of evidence.hunks) {
    if (h.status === 'UNRUN') {
      assert.equal(h.runsAfter.length, 0, `${h.id} is unrun yet lists runs`);
      assert.ok(h.lastEdit, `${h.id} has a last edit`);
    }
    if (h.status === 'RUN_PASS') {
      assert.ok(h.runsAfter.some((r) => r.outcome === 'pass' && r.ts >= h.lastEdit), `${h.id} cites a passing run after its last edit`);
    }
    if (h.attribution === 'UNATTRIBUTED') {
      assert.equal(h.status, 'UNATTRIBUTED');
      assert.deepEqual(h.edits, []);
      assert.equal(h.reason, 'only edits before the branch base');
    }
  }
  const fileLevel = evidence.hunks.filter((h) => h.attribution === 'FILE_LEVEL').map((h) => h.id);
  assert.deepEqual(fileLevel, ['CONTRACT.md:46', 'CONTRACT.md:123', 'CONTRACT.md:136']);
  assert.equal(evidence.hunks.filter((h) => h.attribution === 'UNATTRIBUTED').map((h) => h.id).join(), '.gitignore:6');
});

test('self-pr fixture: diff.patch holds the same hunks as the evidence', () => {
  const stats = {};
  const hunks = parseUnifiedDiff(fs.readFileSync(files.diff, 'utf8'), { repoRoot: evidence.repo.root, stats });
  assert.equal(stats.hunks, SUMMARY.hunks);
  assert.deepEqual(hunks.map((h) => h.id).sort(), evidence.hunks.map((h) => h.id).sort());
});

test('self-pr fixture: no file carries a home path, an email or a forbidden word', () => {
  for (const h of evidence.hunks) {
    if (!h.intent) continue;
    assert.ok(h.intent.text.length <= 201, `${h.id} intent is cut at 200 chars`);
    assert.ok(!EMAIL.test(h.intent.text), `${h.id} intent has no email`);
  }
  for (const s of evidence.sessions) assert.ok(s.path.startsWith('~/'), `${s.sessionId} path starts with ~`);
  for (const h of evidence.hunks) {
    assert.ok(h.file.startsWith('~/'), `${h.id} file path starts with ~`);
    for (const e of h.edits) if (e.checkout) assert.ok(e.checkout.startsWith('~/'), `${h.id} edit checkout starts with ~`);
  }
  assert.equal(evidence.redaction.home, '~');
  assert.equal(evidence.redaction.rules.length, 4);
  const md = fs.readFileSync(files.md, 'utf8');
  const html = fs.readFileSync(files.html, 'utf8');
  const diff = fs.readFileSync(files.diff, 'utf8');
  const encodedHome = encodeProjectDir(os.homedir());
  for (const [name, text] of [['evidence.json', fs.readFileSync(files.evidence, 'utf8')], ['hunkproof.html', html], ['hunkproof.md', md], ['diff.patch', diff], ['terminal', renderTerminal(evidence)]]) {
    assert.ok(!HOME_PATH.test(text), `${name} has no home path`);
    assert.ok(!text.includes(encodedHome), `${name} has no encoded home path`);
  }
  // the vocabulary rule is about the tool's own strings: the Markdown and the
  // terminal quote no diff line, the evidence and the HTML quote the test files
  // of this repository, which name the forbidden words on purpose
  assert.ok(!FORBIDDEN.test(md), 'markdown has no forbidden word');
  assert.ok(!FORBIDDEN.test(renderTerminal(evidence)), 'terminal output has no forbidden word');
  assert.ok(!md.includes('-home-'), 'markdown has no encoded home path');
  assert.ok(!EMAIL.test(md), 'markdown has no email');
  // the HTML quotes diff lines of this repository's tests, which hold
  // synthetic addresses (example.com, example.invalid); the only other
  // email-shaped string is the git@github.com remote
  for (const m of html.match(new RegExp(EMAIL.source, 'g')) || []) {
    assert.ok(m === 'git@github.com' || /@(?:[a-z.]+\.)?(?:example\.(?:com|invalid)|mail\.sub)$/.test(m), `html quotes a real-looking email: ${m}`);
  }
  assert.ok(md.length < 60000, 'markdown fits a GitHub comment');
});

test('self-pr fixture: the renderers rebuild the HTML and Markdown byte for byte', () => {
  const blobBase = `https://github.com/${parseRemote(evidence.repo.remote).full}/blob/${evidence.repo.headSha}`;
  assert.equal(renderHtml(evidence), fs.readFileSync(files.html, 'utf8'));
  assert.equal(renderMarkdown(evidence, { blobBase }), fs.readFileSync(files.md, 'utf8'));
});

test('self-pr fixture: --evidence --diff replay rebuilds byte-identical files', async () => {
  // a scratch repo whose origin is the evidence remote, so the replay does not
  // depend on where this checkout was cloned from
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkproof-fixture-'));
  try {
    const scratch = path.join(tmp, 'repo');
    fs.mkdirSync(scratch);
    execFileSync('git', ['-C', scratch, 'init', '-q']);
    execFileSync('git', ['-C', scratch, 'remote', 'add', 'origin', evidence.repo.remote]);
    const out = path.join(tmp, 'out');
    const r = io();
    const code = await runCli(['--evidence', files.evidence, '--diff', files.diff, '--repo', scratch, '--out', out, '--no-note'], r.streams);
    assert.equal(code, 0, r.err());
    for (const name of ['hunkproof.html', 'hunkproof.md', 'evidence.json']) {
      const a = fs.readFileSync(path.join(out, name));
      const b = fs.readFileSync(path.join(dir, name));
      assert.ok(a.equals(b), `${name} differs after replay`);
    }
    assert.ok(r.out().includes(summarySentence(evidence)), 'terminal prints the headline');
    assert.ok(r.out().includes('hunkproof used 0 LLM tokens'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('README quotes the fixture headline and the definitions verbatim', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.ok(readme.includes(summarySentence(evidence)), 'README carries the headline sentence of the fixture');
  for (const [key, text] of Object.entries(evidence.definitions)) {
    assert.ok(readme.includes(text), `README quotes the "${key}" definition verbatim`);
  }
  assert.ok(readme.includes(evidence.usage.label), 'README quotes the cost label');
});
