import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseUnifiedDiff, normalizeLine, gitDiffHunks } from '../src/diff.js';

const ROOT = '/repo';

// Synthetic -U0 diff: counts present, counts omitted (single line), new file, deletion, rename, binary,
// no-newline marker, path with a space (git appends a tab after such paths).
const U0 = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -2 +2 @@ import x',
  '-const a = 1;',
  '+const a = 2;',
  '@@ -10,0 +11,3 @@ function f() {',
  '+  if (a) {',
  '+    return  a;',
  '+  }',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+fresh',
  '+file',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-del1',
  '-del2',
  'diff --git a/img.bin b/img.bin',
  'index 5555555..6666666 100644',
  'Binary files a/img.bin and b/img.bin differ',
  'diff --git a/old.txt b/lib/renamed.txt',
  'similarity index 66%',
  'rename from old.txt',
  'rename to lib/renamed.txt',
  'index 7777777..8888888 100644',
  '--- a/old.txt',
  '+++ b/lib/renamed.txt',
  '@@ -2,0 +3 @@ y',
  '+z',
  'diff --git a/noeol.txt b/noeol.txt',
  'new file mode 100644',
  'index 0000000..9999999',
  '--- /dev/null',
  '+++ b/noeol.txt',
  '@@ -0,0 +1 @@',
  '+noeol',
  '\\ No newline at end of file',
  'diff --git a/sp ace.txt b/sp ace.txt',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/sp ace.txt\t',
  '+++ b/sp ace.txt\t',
  '@@ -1,0 +2 @@ same',
  '+more',
  'diff --git a/pure-rename.txt b/moved/pure-rename.txt',
  'similarity index 100%',
  'rename from pure-rename.txt',
  'rename to moved/pure-rename.txt',
  '',
].join('\n');

test('normalizeLine trims and collapses whitespace', () => {
  assert.equal(normalizeLine('  a \t b\t\tc  '), 'a b c');
  assert.equal(normalizeLine(''), '');
  assert.equal(normalizeLine('   '), '');
  assert.equal(normalizeLine(null), '');
  assert.equal(normalizeLine('x'), 'x');
});

test('parseUnifiedDiff requires repoRoot', () => {
  assert.throws(() => parseUnifiedDiff(U0, {}), /repoRoot/);
});

test('parseUnifiedDiff: -U0 headers with and without counts', () => {
  const hunks = parseUnifiedDiff(U0, { repoRoot: ROOT });
  const app = hunks.filter((h) => h.relFile === 'src/app.js');
  assert.equal(app.length, 2);

  const [h1, h2] = app;
  assert.deepEqual(
    { oldStart: h1.oldStart, oldLines: h1.oldLines, newStart: h1.newStart, newLines: h1.newLines },
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
  );
  assert.equal(h1.id, 'src/app.js:2');
  assert.equal(h1.file, path.resolve(ROOT, 'src/app.js'));
  assert.deepEqual(h1.added, ['const a = 2;']);
  assert.deepEqual(h1.removed, ['const a = 1;']);
  assert.equal(h1.kind, 'modify');

  assert.deepEqual(
    { oldStart: h2.oldStart, oldLines: h2.oldLines, newStart: h2.newStart, newLines: h2.newLines },
    { oldStart: 10, oldLines: 0, newStart: 11, newLines: 3 },
  );
  assert.equal(h2.id, 'src/app.js:11');
  assert.deepEqual(h2.added, ['  if (a) {', '    return  a;', '  }']);
  assert.deepEqual(h2.addedNormalized, ['if (a) {', 'return a;', '}']);
  assert.deepEqual(h2.removed, []);
  assert.equal(h2.added.length, h2.addedNormalized.length);
});

test('parseUnifiedDiff: new file, deletion, no-newline marker, spaces in path', () => {
  const hunks = parseUnifiedDiff(U0, { repoRoot: ROOT });
  const byId = Object.fromEntries(hunks.map((h) => [h.id, h]));

  assert.ok(byId['new.txt:1']);
  assert.equal(byId['new.txt:1'].kind, 'add');
  assert.equal(byId['new.txt:1'].oldStart, 0);
  assert.deepEqual(byId['new.txt:1'].added, ['fresh', 'file']);

  assert.ok(byId['gone.txt:0']);
  assert.equal(byId['gone.txt:0'].kind, 'delete');
  assert.equal(byId['gone.txt:0'].newLines, 0);
  assert.deepEqual(byId['gone.txt:0'].added, []);
  assert.deepEqual(byId['gone.txt:0'].addedNormalized, []);
  assert.deepEqual(byId['gone.txt:0'].removed, ['del1', 'del2']);

  assert.deepEqual(byId['noeol.txt:1'].added, ['noeol']); // marker line is not content

  assert.ok(byId['sp ace.txt:2'], 'trailing tab after the path is stripped');
  assert.equal(byId['sp ace.txt:2'].file, path.resolve(ROOT, 'sp ace.txt'));
  assert.deepEqual(byId['sp ace.txt:2'].added, ['more']);
});

test('parseUnifiedDiff: rename keeps new path and exposes old path', () => {
  const hunks = parseUnifiedDiff(U0, { repoRoot: ROOT });
  const r = hunks.find((h) => h.relFile === 'lib/renamed.txt');
  assert.ok(r);
  assert.equal(r.kind, 'rename');
  assert.equal(r.id, 'lib/renamed.txt:3');
  assert.equal(r.file, path.resolve(ROOT, 'lib/renamed.txt'));
  assert.equal(r.oldRelFile, 'old.txt');
  assert.equal(r.oldFile, path.resolve(ROOT, 'old.txt'));
  assert.deepEqual(r.added, ['z']);
  assert.equal(hunks.some((h) => h.relFile === 'old.txt'), false);
  assert.equal(hunks.some((h) => h.relFile.includes('pure-rename')), false, 'pure rename yields no hunk');
});

test('parseUnifiedDiff: binary files are skipped and counted', () => {
  const stats = {};
  const hunks = parseUnifiedDiff(U0, { repoRoot: ROOT, stats });
  assert.equal(hunks.some((h) => h.relFile === 'img.bin'), false);
  assert.equal(stats.binary, 1);
  assert.deepEqual(stats.binaryFiles, ['img.bin']);
  assert.equal(stats.files, 8);
  assert.equal(stats.hunks, hunks.length);
  assert.equal(stats.renames, 2);
  assert.equal(stats.newFiles, 2);
  assert.equal(stats.deletedFiles, 1);
  assert.equal(stats.filesWithoutHunks, 1); // the pure rename
});

test('parseUnifiedDiff: GIT binary patch form is binary too', () => {
  const stats = {};
  const text = [
    'diff --git a/x.png b/x.png',
    'index 1111111..2222222 100644',
    'GIT binary patch',
    'literal 10',
    'zcmZ?wbhEHbWMp7uXkcJa',
    '',
    'literal 0',
    'HcmV?d00001',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(text, { repoRoot: ROOT, stats }), []);
  assert.equal(stats.binary, 1);
});

test('parseUnifiedDiff: context lines (-U3) are neither added nor removed, hunk ends on counts', () => {
  const text = [
    'diff --git a/a.py b/a.py',
    'index 1..2 100644',
    '--- a/a.py',
    '+++ b/a.py',
    '@@ -1,5 +1,6 @@',
    ' import os',
    ' ',
    '-def f():',
    '+def f(x):',
    '+    """doc"""',
    '     return 1',
    ' ',
    '@@ -20,3 +21,3 @@ class C:',
    '     pass',
    '-    old = 1',
    '+    new = 1',
    '     done',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(text, { repoRoot: ROOT });
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].added, ['def f(x):', '    """doc"""']);
  assert.deepEqual(hunks[0].removed, ['def f():']);
  assert.equal(hunks[0].newStart, 1);
  assert.equal(hunks[0].newLines, 6);
  assert.deepEqual(hunks[1].added, ['    new = 1']);
  assert.deepEqual(hunks[1].removed, ['    old = 1']);
  assert.equal(hunks[1].id, 'a.py:21');
});

test('parseUnifiedDiff: removed line starting with "-- " does not break file detection', () => {
  const text = [
    'diff --git a/q.sql b/q.sql',
    'index 1..2 100644',
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1 +1 @@',
    '--- comment',
    '+-- new comment',
    'diff --git a/z.txt b/z.txt',
    'index 1..2 100644',
    '--- a/z.txt',
    '+++ b/z.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(text, { repoRoot: ROOT });
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].removed, ['-- comment']);
  assert.deepEqual(hunks[0].added, ['-- new comment']);
  assert.equal(hunks[1].relFile, 'z.txt');
});

test('parseUnifiedDiff: quoted paths are unquoted', () => {
  const text = [
    'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
    'index 1..2 100644',
    '--- "a/caf\\303\\251 \\"x\\".txt"',
    '+++ "b/caf\\303\\251 \\"x\\".txt"',
    '@@ -0,0 +1 @@',
    '+hi',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(text, { repoRoot: ROOT });
  assert.equal(hunks.length, 1);
  // \303\251 is the UTF-8 byte pair for "é"
  assert.equal(hunks[0].relFile, 'café "x".txt');
  assert.equal(hunks[0].file, path.resolve(ROOT, 'café "x".txt'));
});

test('parseUnifiedDiff: CRLF input and empty input', () => {
  const text = 'diff --git a/w.txt b/w.txt\r\nindex 1..2 100644\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n';
  const hunks = parseUnifiedDiff(text, { repoRoot: ROOT });
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].added, ['b']);
  assert.deepEqual(parseUnifiedDiff('', { repoRoot: ROOT }), []);
  assert.deepEqual(parseUnifiedDiff(undefined, { repoRoot: ROOT }), []);
});

test('parseUnifiedDiff: file paths are absolute under repoRoot even for relative repoRoot', () => {
  const hunks = parseUnifiedDiff(U0, { repoRoot: '.' });
  assert.ok(path.isAbsolute(hunks[0].file));
  assert.equal(hunks[0].file, path.resolve('.', 'src/app.js'));
});

test('gitDiffHunks: parses real git -U0 output from a scratch repo (rename, binary, new, delete)', (t) => {
  let hasGit = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
  if (!hasGit) { t.skip('git not available'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkproof-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main', '.');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'del1\ndel2\n');
    fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 255, 254]));
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nB\nc\nd\n');
    git('mv', 'old.txt', 'new.txt');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\nz\n');
    git('rm', '-q', 'gone.txt');
    fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 3, 255, 254, 7]));
    fs.writeFileSync(path.join(dir, 'added.txt'), 'fresh\nfile');
    git('add', '-A');
    git('commit', '-qm', 'change');

    const stats = {};
    const hunks = gitDiffHunks({ repoRoot: dir, base: 'main', head: 'HEAD', stats });
    const ids = hunks.map((h) => h.id).sort();
    assert.deepEqual(ids, ['added.txt:1', 'gone.txt:0', 'keep.txt:2', 'keep.txt:4', 'new.txt:3']);
    assert.equal(stats.binary, 1);
    assert.deepEqual(stats.binaryFiles, ['img.bin']);
    const renamed = hunks.find((h) => h.id === 'new.txt:3');
    assert.equal(renamed.kind, 'rename');
    assert.equal(renamed.oldRelFile, 'old.txt');
    assert.equal(renamed.file, path.join(path.resolve(dir), 'new.txt'));
    assert.equal(renamed.oldFile, path.join(path.resolve(dir), 'old.txt'));
    const single = hunks.find((h) => h.id === 'keep.txt:2');
    assert.deepEqual([single.oldLines, single.newLines], [1, 1]); // header without counts: "@@ -2 +2 @@"
    assert.deepEqual(single.added, ['B']);
    assert.deepEqual(single.removed, ['b']);
    assert.deepEqual(hunks.find((h) => h.id === 'added.txt:1').added, ['fresh', 'file']);
    assert.deepEqual(hunks.find((h) => h.id === 'gone.txt:0').removed, ['del1', 'del2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitDiffHunks: argument validation', () => {
  assert.throws(() => gitDiffHunks({ base: 'main' }), /repoRoot/);
  assert.throws(() => gitDiffHunks({ repoRoot: '/tmp' }), /base/);
});
