// fixtures/unrun-example is hunkproof run on the two docs commits of the
// release pull request (559fee6..7fbda28) on 2026-10-14, right after those
// commits and before the test suite ran again:
//   node bin/hunkproof.js --base 559fee6 --head 7fbda28 --no-note
// It is the receipt the README shows for what an unrun hunk looks like: the
// lines written after the last `npm test` of that session are unrun, the rest
// of the two commits had that run after them. The next run in the session
// would stamp them, so this is a snapshot; it rebuilds byte for byte from the
// saved evidence like fixtures/self-pr. Three deviations from the raw run:
// diff.patch went through the home-path rules; the project names quoted in
// two privacy-sweep commands of an earlier session were replaced; and the
// commit ids in repo.{base,head,headSha,mergeBase} were updated after the
// messages of earlier commits on the branch were reworded before the push
// (same trees, same diff, same committer times; the receipt was taken on the
// commits as they were then named).
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
const dir = path.join(repoRoot, 'fixtures', 'unrun-example');
const files = {
  evidence: path.join(dir, 'evidence.json'),
  html: path.join(dir, 'hunkproof.html'),
  md: path.join(dir, 'hunkproof.md'),
  diff: path.join(dir, 'diff.patch'),
};
const evidence = JSON.parse(fs.readFileSync(files.evidence, 'utf8'));
const FORBIDDEN = /\b(tested|verified|covered)\b|proof that it works/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const HOME_PATH = /\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[A-Za-z0-9._-]+/;

const SUMMARY = {
  hunks: 26,
  attributed: 23,
  matched: 23,
  fileLevel: 3,
  unattributed: 0,
  runAfterLastEdit: 20,
  runPass: 20,
  runFail: 0,
  runUnparsed: 0,
  unrun: 6,
  strictRunAfterLastEdit: 20,
  sessions: 6,
  durationSec: 39748,
  toolCalls: 547,
  llmTokensUsedByHunkproof: 0,
  elapsedMs: 680,
};
// The lines written after the last run: the CHANGELOG line, the demo caption,
// the opening of the README section, and three README hunks at file level.
const UNRUN = ['CHANGELOG.md:18', 'README.md:31', 'README.md:47', 'README.md:61', 'README.md:72', 'README.md:9'];

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

test('unrun fixture: the summary of the receipt taken before the suite ran again', () => {
  assert.equal(evidence.schema, 'hunkproof/evidence@1');
  assert.equal(evidence.repo.prNumber, null, 'the pull request did not exist yet');
  assert.equal(evidence.repo.base, '559fee6');
  assert.equal(evidence.repo.head, '7fbda28');
  assert.equal(evidence.repo.headSha, '7fbda284e76ac3440e1514588698c24a516cea11');
  assert.equal(evidence.repo.mergeBase, '559fee668e67c32dc7d28d6c3e567a34055b6509');
  assert.equal(evidence.repo.root, '~/hunkproof');
  assert.deepEqual(evidence.summary, SUMMARY);
  assert.equal(evidence.hunks.length, SUMMARY.hunks);
  assert.equal(evidence.sessions.length, SUMMARY.sessions);
});

test('unrun fixture: the unrun hunks list no run after their last edit', () => {
  const unrun = evidence.hunks.filter((h) => h.status === 'UNRUN').map((h) => h.id).sort();
  assert.deepEqual(unrun, UNRUN);
  for (const h of evidence.hunks) {
    if (h.status === 'UNRUN') {
      assert.equal(h.runsAfter.length, 0, `${h.id} is unrun yet lists runs`);
      assert.ok(h.lastEdit, `${h.id} has a last edit`);
      assert.ok(evidence.runs.every((r) => r.ts < h.lastEdit), `${h.id}: every run of the document is before its last edit`);
    }
    if (h.status === 'RUN_PASS') {
      assert.ok(h.runsAfter.some((r) => r.outcome === 'pass' && r.ts >= h.lastEdit), `${h.id} cites a passing run after its last edit`);
    }
  }
  assert.deepEqual(evidence.hunks.filter((h) => h.attribution === 'FILE_LEVEL').map((h) => h.id), ['README.md:47', 'README.md:61', 'README.md:72']);
  const terminal = renderTerminal(evidence);
  assert.ok(terminal.includes('CHANGELOG.md                +18,3  unrun               none after edit at 17:53:47'), 'the README quotes this row');
  assert.ok(terminal.includes('README.md                   +9     unrun               none after edit at 17:51:34'));
  assert.ok(terminal.includes('README.md                   +47    unrun (file-level)  none after edit at 17:53:42'));
});

test('unrun fixture: diff.patch holds the same hunks as the evidence', () => {
  const stats = {};
  const hunks = parseUnifiedDiff(fs.readFileSync(files.diff, 'utf8'), { repoRoot: evidence.repo.root, stats });
  assert.equal(stats.hunks, SUMMARY.hunks);
  assert.deepEqual(hunks.map((h) => h.id).sort(), evidence.hunks.map((h) => h.id).sort());
});

test('unrun fixture: no file carries a home path, an email or a forbidden word', () => {
  for (const s of evidence.sessions) assert.ok(s.path.startsWith('~/'), `${s.sessionId} path starts with ~`);
  for (const h of evidence.hunks) assert.ok(h.file.startsWith('~/'), `${h.id} file path starts with ~`);
  const md = fs.readFileSync(files.md, 'utf8');
  const html = fs.readFileSync(files.html, 'utf8');
  const diff = fs.readFileSync(files.diff, 'utf8');
  const encodedHome = encodeProjectDir(os.homedir());
  for (const [name, text] of [['evidence.json', fs.readFileSync(files.evidence, 'utf8')], ['hunkproof.html', html], ['hunkproof.md', md], ['diff.patch', diff], ['terminal', renderTerminal(evidence)]]) {
    assert.ok(!HOME_PATH.test(text), `${name} has no home path`);
    assert.ok(!text.includes(encodedHome), `${name} has no encoded home path`);
  }
  assert.ok(!FORBIDDEN.test(md), 'markdown has no forbidden word');
  assert.ok(!FORBIDDEN.test(renderTerminal(evidence)), 'terminal output has no forbidden word');
  assert.ok(!EMAIL.test(md), 'markdown has no email');
  // the HTML quotes the diff lines of the two docs commits: the noreply
  // identity of CLAUDE.md and the `user:token@github.com` placeholder of the
  // README Privacy section are the only email-shaped strings
  for (const m of html.match(new RegExp(EMAIL.source, 'g')) || []) {
    assert.ok(m === 'git@github.com' || m === 'token@github.com' || /@users\.noreply(?:\.github\.com)?$/.test(m), `html quotes a real-looking email: ${m}`);
  }
  assert.ok(md.length < 60000, 'markdown fits a GitHub comment');
});

test('unrun fixture: the renderers rebuild the HTML and Markdown byte for byte', () => {
  const blobBase = `https://github.com/${parseRemote(evidence.repo.remote).full}/blob/${evidence.repo.headSha}`;
  assert.equal(renderHtml(evidence), fs.readFileSync(files.html, 'utf8'));
  assert.equal(renderMarkdown(evidence, { blobBase }), fs.readFileSync(files.md, 'utf8'));
});

test('unrun fixture: --evidence --diff replay rebuilds byte-identical files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkproof-unrun-fixture-'));
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
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('README quotes the unrun fixture headline verbatim', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.ok(readme.includes(`hunkproof · ${evidence.repo.base}...${evidence.repo.head} · ${summarySentence(evidence)}`), 'README carries the headline of the unrun fixture');
  assert.ok(readme.includes(`npx hunkproof --base ${evidence.repo.base} --head ${evidence.repo.head}`), 'README carries the command of the unrun fixture');
});
