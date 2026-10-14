import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSession, readSessionEvents, extractWriteTargets, extractCommitMessage, isGitCommit,
  stripHeredocBodies, shellTokens, repositoryFromPrUrl, newStats,
  commandNamesFile, isGitPlumbing, isBulkFormatter, bashEditDiffSource, isCorroboratedSource,
} from '../src/transcript.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'fixtures', 'sessions');
const fx = (name) => path.join(FIX, name);
const byType = (events, t) => events.filter((e) => e.type === t);

const BASE_KEYS = ['type', 'ts', 'sessionId', 'cwd', 'gitBranch', 'version', 'messageId', 'requestId', 'toolUseId', 'uuid', 'isSidechain'];

// ---------------------------------------------------------------- 2.1.267

test('2.1.267: edits, regex shell_edit, commit, gitOperation pr_link, say, usage, skipped', async () => {
  const s = await readSession(fx('v2.1.267-no-bashEditDiff.jsonl'));
  assert.equal(s.sessionId, 'aaaaaaaa-0267-4000-8000-000000000267');
  assert.equal(s.path, fx('v2.1.267-no-bashEditDiff.jsonl'));
  assert.deepEqual(s.meta, {
    firstTs: '2026-10-01T10:00:00.000Z', lastTs: '2026-10-01T10:01:10.000Z', cwd: '/home/dev/proj',
    versions: ['2.1.267'], gitBranches: ['feat/retry'], models: ['claude-opus-5-5'],
  });
  assert.equal(s.stats.badLines, 0);
  assert.equal(s.stats.lines, 20);
  assert.deepEqual(s.stats.byType, { usage: 8, say: 2, edit: 2, tool: 3, shell_edit: 1, commit: 1, pr_link: 1 });
  assert.equal(s.stats.skipped.mode, 1);
  assert.equal(s.stats.skipped['permission-mode'], 1);
  assert.equal(s.stats.skipped['atis-latch'], 1);
  assert.equal(s.stats.skipped['ai-title'], 1);
  assert.equal(s.stats.skipped['last-prompt'], 1);
  assert.equal(s.stats.skipped.attachment, 1);
  assert.equal(s.stats.skipped.thinking, 1);
  assert.equal(s.stats.skipped['user:prompt'], 1);

  for (const e of s.events) for (const k of BASE_KEYS) assert.ok(k in e, `${e.type} missing ${k}`);
  // sorted by ts
  const ts = s.events.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort());

  const edits = byType(s.events, 'edit');
  assert.equal(edits[0].edit.tool, 'Edit');
  assert.equal(edits[0].edit.file, '/home/dev/proj/src/fetch.py');
  assert.equal(edits[0].edit.newContent, null);
  assert.equal(edits[0].edit.addedLines.length, 6);
  assert.equal(edits[0].edit.addedLines[0], '    for attempt in range(3):');
  assert.equal(edits[0].edit.oldString, '    return get(url)');
  assert.equal(edits[0].edit.structuredPatch.length, 1);
  assert.equal(edits[0].edit.originalFile, 'def fetch_page(url):\n    return get(url)\n');
  assert.equal(edits[0].edit.userModified, false);
  assert.equal(edits[0].toolUseId, 'toolu_267_edit1');
  assert.equal(edits[0].ts, '2026-10-01T10:00:07.000Z', 'edit event keeps the tool_use timestamp');
  assert.equal(edits[0].tool.result.isError, false);
  assert.equal(edits[1].edit.tool, 'Write');
  assert.equal(edits[1].edit.file, '/home/dev/proj/tests/test_fetch.py');
  assert.equal(edits[1].edit.newContent, "from src.fetch import fetch_page\n\n\ndef test_retry():\n    assert fetch_page('x')\n");
  assert.deepEqual(edits[1].edit.addedLines, ['from src.fetch import fetch_page', '', '', 'def test_retry():', "    assert fetch_page('x')"]);

  const se = byType(s.events, 'shell_edit');
  assert.equal(se.length, 1);
  assert.equal(se[0].edit.source, 'regex');
  assert.equal(se[0].edit.tool, 'Bash');
  assert.equal(se[0].edit.file, '/home/dev/proj/src/fetch.py');
  assert.equal(se[0].edit.newContent, null);
  assert.deepEqual(se[0].edit.addedLines, []);
  assert.match(se[0].edit.command, /^cd \/home\/dev\/proj && sed -i/);
  assert.equal(se[0].edit.hunks, undefined);

  const tools = byType(s.events, 'tool');
  assert.deepEqual(tools.map((t) => t.tool.name), ['Bash', 'Bash', 'Bash']);
  assert.equal(tools[1].tool.result.stdout, '1 passed in 0.02s');
  assert.equal(tools[1].tool.result.stderr, '');
  assert.equal(tools[1].tool.result.isError, false);
  assert.equal(tools[1].tool.result.interrupted, false);
  assert.equal(tools[1].tool.input.command, 'cd /home/dev/proj && python -m pytest tests/test_fetch.py -q 2>&1 | tail -5');

  const commits = byType(s.events, 'commit');
  assert.equal(commits[0].commit.message, 'Retry fetch_page three times on timeout\n\nFlaky upstream.');
  assert.equal(commits[0].toolUseId, 'toolu_267_bash3');

  const pr = byType(s.events, 'pr_link');
  assert.deepEqual(pr[0].pr_link, { prNumber: 42, prUrl: 'https://github.com/devorg/proj/pull/42', prRepository: 'devorg/proj', source: 'gitOperation' });
  assert.equal(pr[0].toolUseId, 'toolu_267_bash3');

  const says = byType(s.events, 'say');
  assert.deepEqual(says.map((e) => e.say.text), ['I will add a retry loop around fetch_page.', 'Opened PR #42 with the retry loop and its test.']);
  assert.ok(!JSON.stringify(s.events).includes('private reasoning'), 'thinking never leaks into events');

  const usage = byType(s.events, 'usage');
  assert.equal(usage.length, 8);
  // cache_creation.ephemeral_1h_input_tokens surfaces as cacheWrite1h (billed 2x input by cost.js)
  assert.deepEqual(usage[0].usage, { model: 'claude-opus-5-5', input: 12, output: 50, cacheWrite: 300, cacheRead: 4000, cacheWrite1h: 300 });
  assert.equal(usage[0].messageId, 'msg_267_a');
  assert.equal(usage[0].requestId, 'req_267_a');
  assert.equal(usage[2].messageId, 'msg_267_a', 'three lines of the same API message share messageId');
  assert.equal(new Set(usage.map((u) => `${u.messageId}|${u.requestId}`)).size, 6);
  for (const e of s.events) { assert.equal(e.cwd, '/home/dev/proj'); assert.equal(e.gitBranch, 'feat/retry'); assert.equal(e.version, '2.1.267'); assert.equal(e.isSidechain, false); }
});

// ---------------------------------------------------------------- 2.1.280

test('2.1.280: bashEditDiff wins over regex, relative Edit path, empty diff, string toolUseResult', async () => {
  const s = await readSession(fx('v2.1.280-bashEditDiff.jsonl'));
  const se = byType(s.events, 'shell_edit');
  assert.equal(se.length, 3);
  assert.ok(se.every((e) => e.edit.source === 'bashEditDiff'));
  assert.equal(se[0].edit.file, '/home/dev/proj/src/config.py');
  assert.deepEqual(se[0].edit.addedLines, ['def load_config(path):']);
  assert.deepEqual(se[0].edit.hunks, [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' import json', ' ', '-def load_cfg(path):', '+def load_config(path):', '     with open(path) as f:', '         return json.load(f)'] }]);
  assert.match(se[0].edit.command, /^python3 - <<'EOF'/);
  // the heredoc + redirects command: bashEditDiff lists 2 files (regex alone would also find notes.txt)
  const bash2 = se.filter((e) => e.toolUseId === 'toolu_280_bash2');
  assert.deepEqual(bash2.map((e) => e.edit.file), ['/home/dev/proj/docs/CHANGES.md', '/home/dev/proj/scripts/check.sh']);
  assert.ok(bash2.every((e) => e.edit.created === true));
  assert.deepEqual(bash2[1].edit.addedLines, ['#!/bin/sh', "python -c 'import src.config'"]);
  // bashEditDiff with files: [] => no shell_edit at all for a read-only command
  assert.equal(se.filter((e) => e.toolUseId === 'toolu_280_bash3').length, 0);

  const edits = byType(s.events, 'edit');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].edit.file, '/home/dev/proj/src/app.py', 'relative file_path resolved against entry cwd');
  assert.deepEqual(edits[0].edit.addedLines, ['from .config import load_config']);

  const tools = byType(s.events, 'tool');
  const failed = tools.find((t) => t.toolUseId === 'toolu_280_bash4');
  assert.equal(failed.tool.result.isError, true);
  assert.equal(failed.tool.result.stderr, 'Error: Exit code 1\nFAIL 1 test');
  assert.equal(failed.tool.result.stdout, '');

  const commits = byType(s.events, 'commit');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].commit.message, 'Rename load_cfg to load_config');
  assert.equal(commits[0].commit.isError, false);
  assert.equal(byType(s.events, 'pr_link').length, 0, 'gitOperation.commit is not a pr_link');
  assert.deepEqual(s.meta.models, ['claude-fable-5-1']);
});

// ---------------------------------------------------------------- 2.1.292

test('2.1.292: unavailable bashEditDiff falls back to regex, pr-link lines, sidechain, missing result', async () => {
  const s = await readSession(fx('v2.1.292-unavailable.jsonl'));
  assert.equal(s.agentId, 'a1b2c3d4e5f60718');
  assert.ok(s.events.every((e) => e.type === 'pr_link' || e.isSidechain === true));
  const se = byType(s.events, 'shell_edit');
  assert.equal(se.length, 1);
  assert.equal(se[0].edit.source, 'regex');
  assert.equal(se[0].edit.file, '/home/dev/proj/docs/usage.md');
  // the denied node -e writeFileSync command is an error: no regex shell_edit for it
  assert.equal(se.filter((e) => e.toolUseId === 'toolu_292_bash2').length, 0);
  const pr = byType(s.events, 'pr_link');
  assert.equal(pr.length, 2);
  assert.deepEqual(pr[0].pr_link, { prNumber: 77, prUrl: 'https://github.com/devorg/proj/pull/77', prRepository: 'devorg/proj', source: 'pr-link' });
  assert.equal(pr[0].ts, '2026-10-03T14:00:20.000Z');
  assert.equal(pr[0].sessionId, 'cccccccc-0292-4000-8000-000000000292');
  const tools = byType(s.events, 'tool');
  const last = tools.find((t) => t.toolUseId === 'toolu_292_bash3');
  assert.equal(last.tool.result, null, 'tool_use without a result line gets result null');
  assert.equal(s.stats.toolUsesWithoutResult, 1);
  const denied = tools.find((t) => t.toolUseId === 'toolu_292_bash2');
  assert.equal(denied.tool.result.isError, true);
});

// ---------------------------------------------------------------- 2.1.299

test('2.1.299: bad line counted, split message usage, created/deleted flags, Write update, image result', async () => {
  const s = await readSession(fx('v2.1.299-split-usage.jsonl'));
  assert.equal(s.stats.badLines, 1);
  assert.equal(s.stats.parsed, 20);
  assert.equal(s.stats.skipped['file-history-snapshot'], 1);
  assert.equal(s.stats.skipped['queue-operation'], 1);
  assert.equal(s.stats.skipped['bridge-session'], 1);
  const usage = byType(s.events, 'usage');
  const first = usage.filter((u) => u.messageId === 'msg_299_a');
  assert.equal(first.length, 3);
  assert.ok(first.every((u) => u.requestId === 'req_299_a' && u.usage.output === 120));
  const se = byType(s.events, 'shell_edit');
  assert.equal(se.length, 3);
  assert.equal(se[0].edit.deleted, true);
  assert.deepEqual(se[0].edit.addedLines, []);
  assert.equal(se[1].edit.created, true);
  assert.deepEqual(se[1].edit.addedLines, ['def helper():', '    return 1']);
  assert.equal(se[2].edit.file, '/home/dev/proj/docs/CHANGES.md');
  assert.deepEqual(se[2].edit.addedLines, ['- helper moved to util']);
  const edits = byType(s.events, 'edit');
  assert.equal(edits[0].edit.tool, 'Write');
  assert.equal(edits[0].edit.originalFile, '\n');
  assert.equal(edits[0].edit.structuredPatch[0].newLines, 3);
  const read = byType(s.events, 'tool').find((t) => t.tool.name === 'Read');
  assert.deepEqual(read.tool.result, { stdout: '', stderr: '', isError: false });
  const commits = byType(s.events, 'commit');
  assert.equal(commits[0].commit.message, 'Move helper into util');
  assert.equal(byType(s.events, 'pr_link').length, 0, 'gitOperation.push is not a pr_link');
  assert.equal(byType(s.events, 'say').length, 2);
});

// ------------------------------------------------- 2.1.299 background + sources

test('2.1.299: backgroundTaskId/timedOutAfterMs pass through; bashEditDiff entries are tagged by corroboration', async () => {
  const s = await readSession(fx('v2.1.299-background.jsonl'));
  const tools = byType(s.events, 'tool');
  const bg = tools.find((t) => t.toolUseId === 'toolu_bg1');
  assert.equal(bg.tool.result.stdout, '');
  assert.equal(bg.tool.result.isError, false);
  assert.equal(bg.tool.result.backgroundTaskId, 'bvgza2pu9');
  assert.equal('timedOutAfterMs' in bg.tool.result, false);
  const timedOut = tools.find((t) => t.toolUseId === 'toolu_bg2');
  assert.equal(timedOut.tool.result.backgroundTaskId, 'bdby3u41x');
  assert.equal(timedOut.tool.result.timedOutAfterMs, 600000);
  // a plain result carries neither field
  const plain = tools.find((t) => t.toolUseId === 'toolu_bg3');
  assert.equal('backgroundTaskId' in plain.tool.result, false);

  const all = byType(s.events, 'shell_edit');
  // the backgrounded verify.sh has no bashEditDiff: its `> /tmp/scratch/verify.log` is a regex shell_edit outside the repo
  assert.deepEqual(all.filter((e) => !e.edit.file.startsWith('/home/dev/proj/')).map((e) => [e.edit.file, e.edit.source]), [['/tmp/scratch/verify.log', 'regex']]);
  const se = all.filter((e) => e.edit.file.startsWith('/home/dev/proj/'));
  const bySrc = Object.fromEntries(se.map((e) => [path.relative('/home/dev/proj', e.edit.file), e.edit.source]));
  assert.deepEqual(bySrc, {
    'src/other.py': 'bashEditDiff-uncorroborated', // cat > /tmp/.../assemble.py cannot have written it
    'README.md': 'bashEditDiff-git', // git checkout + pull
    'docs/usage.md': 'bashEditDiff-git',
    'docs/notes.md': 'bashEditDiff', // named by the printf >> redirect
    'src/app.py': 'bashEditDiff', // prettier --write . formats the whole tree
  });
  assert.ok(se.every((e) => e.edit.tool === 'Bash' && Array.isArray(e.edit.hunks)));
  assert.deepEqual(se.find((e) => e.edit.file.endsWith('src/other.py')).edit.addedLines, ['def other():', '    return 2']);
  assert.equal(byType(s.events, 'say')[0].say.text, 'The frames are rendered, assembling the clip.');
});

test('commandNamesFile, isGitPlumbing, isBulkFormatter, bashEditDiffSource', () => {
  const R = '/home/dev/proj';
  assert.equal(commandNamesFile('sed -i s/a/b/ src/a.js', `${R}/src/a.js`, R), true);
  assert.equal(commandNamesFile('cat > a.js <<EOF\nx\nEOF', `${R}/src/a.js`, `${R}/src`), true, 'basename');
  assert.equal(commandNamesFile(`echo x > ${R}/src/a.js`, `${R}/src/a.js`, '/elsewhere'), true, 'absolute path');
  assert.equal(commandNamesFile('cd src && printf x > a.js', `${R}/src/a.js`, R), true, 'relative to a leading cd');
  assert.equal(commandNamesFile('npx tsc --build && node --test dist-test/', `${R}/dist-test/a.js`, R), true, 'parent directory as a path');
  assert.equal(commandNamesFile('cat > /tmp/x/assemble.py <<EOF\nEOF', `${R}/test/cost.test.js`, '/home/dev'), false);
  assert.equal(commandNamesFile('grep -rn test src', `${R}/test/cost.test.js`, R), false, 'a bare word is not a path mention');
  assert.equal(commandNamesFile('ls', `${R}/xa.js`, R), false);
  assert.equal(commandNamesFile('cat xa.js', `${R}/a.js`, R), false, 'basename must stand alone');

  assert.equal(isGitPlumbing('git status && git diff --stat'), false);
  assert.equal(isGitPlumbing('git checkout -q main && npm test'), true);
  assert.equal(isGitPlumbing('git -C /x merge origin/main'), true);
  assert.equal(isGitPlumbing('git stash pop'), true);
  assert.equal(isGitPlumbing('git stash list'), false);
  assert.equal(isGitPlumbing('gh pr merge 12 --squash --delete-branch'), true);
  assert.equal(isGitPlumbing('gh pr view 12'), false);
  assert.equal(isGitPlumbing('echo "git pull"'), false, 'quoted words do not count');

  assert.equal(isBulkFormatter('npx prettier --write .'), true);
  assert.equal(isBulkFormatter('npx prettier --write "src/**/*.ts"'), true);
  assert.equal(isBulkFormatter('npx prettier --write evals/maintainer/run.ts'), false, 'explicit files only corroborate themselves');
  assert.equal(isBulkFormatter('npx prettier --check .'), false);
  assert.equal(isBulkFormatter('ruff format && pytest'), true);
  assert.equal(isBulkFormatter('ruff format --check'), false);
  assert.equal(isBulkFormatter('uv run ruff check --fix src/'), true);
  assert.equal(isBulkFormatter('black .'), true);
  assert.equal(isBulkFormatter('cargo fmt'), true);
  assert.equal(isBulkFormatter('npx eslint --fix src/'), true);
  assert.equal(isBulkFormatter('npx eslint src/'), false);

  assert.equal(bashEditDiffSource('cd /tmp/scratch/video && cat > assemble.py <<EOF\nEOF', `${R}/test/cost.test.js`, '/home/dev'), 'bashEditDiff-uncorroborated');
  assert.equal(bashEditDiffSource('until gh pr view 457 --json state -q .state | grep -q MERGED; do sleep 30; done', `${R}/README.md`, R), 'bashEditDiff-uncorroborated');
  assert.equal(bashEditDiffSource('cd .claude/worktrees/agent-a7 && npx prettier --write evals/maintainer/run.ts && bash scripts/verify.sh | tail -3', `${R}/README.md`, R), 'bashEditDiff-uncorroborated');
  assert.equal(bashEditDiffSource('git checkout main && git pull -q && npm test', `${R}/src/a.js`, R), 'bashEditDiff-git');
  assert.equal(bashEditDiffSource("python3 - <<'EOF'\np='src/config.py'\nopen(p,'w').write('x')\nEOF", `${R}/src/config.py`, R), 'bashEditDiff');
  assert.equal(bashEditDiffSource('npx prettier --write . && npm test', `${R}/src/a.js`, R), 'bashEditDiff');
  assert.equal(isCorroboratedSource('bashEditDiff'), true);
  assert.equal(isCorroboratedSource('regex'), true);
  assert.equal(isCorroboratedSource('bashEditDiff-git'), false);
  assert.equal(isCorroboratedSource('bashEditDiff-uncorroborated'), false);
});

// ------------------------------------------------------------ generator

test('readSessionEvents is an async generator and fills opts.stats', async () => {
  const stats = newStats();
  const types = [];
  for await (const ev of readSessionEvents(fx('v2.1.280-bashEditDiff.jsonl'), { stats })) types.push(ev.type);
  assert.equal(types.length, stats.events);
  assert.equal(stats.lines, 16);
  assert.ok(types.includes('shell_edit'));
});

test('readSession rejects on a missing file', async () => {
  await assert.rejects(readSession(fx('does-not-exist.jsonl')));
});

test('readSession on an empty file yields no events and empty meta', async () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'hunkproof-'));
  const f = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(f, '');
  const s = await readSession(f);
  assert.deepEqual(s.events, []);
  assert.equal(s.sessionId, 'empty');
  assert.equal(s.meta.cwd, null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// -------------------------------------------------------- write targets

test('extractWriteTargets: sed -i, redirects, tee, heredoc redirect, cd tracking', () => {
  assert.deepEqual(extractWriteTargets("sed -i 's/a/b/' f.py g.py", '/w'), ['/w/f.py', '/w/g.py']);
  assert.deepEqual(extractWriteTargets("sed -i.bak -e 's/a/b/' f.py", '/w'), ['/w/f.py']);
  assert.deepEqual(extractWriteTargets("sed --in-place 's/a/b/' f.py", '/w'), ['/w/f.py']);
  assert.deepEqual(extractWriteTargets("sed -n 's/a/b/p' f.py", '/w'), [], 'sed without -i does not write');
  assert.deepEqual(extractWriteTargets("sed -Ei 's/a/b/' f.py", '/w'), ['/w/f.py']);
  assert.deepEqual(extractWriteTargets('echo hi > out.txt', '/w'), ['/w/out.txt']);
  assert.deepEqual(extractWriteTargets('echo hi >> out.txt', '/w'), ['/w/out.txt']);
  assert.deepEqual(extractWriteTargets('echo hi >"my file.txt"', '/w'), ['/w/my file.txt']);
  assert.deepEqual(extractWriteTargets('cmd 2> err.log', '/w'), [], 'stderr redirects are not file writes we track');
  assert.deepEqual(extractWriteTargets('cmd > /dev/null 2>&1', '/w'), []);
  assert.deepEqual(extractWriteTargets('cmd >&2', '/w'), []);
  assert.deepEqual(extractWriteTargets('cmd | tee out.log', '/w'), ['/w/out.log']);
  assert.deepEqual(extractWriteTargets('cmd | tee -a a.log b.log', '/w'), ['/w/a.log', '/w/b.log']);
  assert.deepEqual(extractWriteTargets("cat <<'EOF' > made.md\nfoo > bar\nEOF\n", '/w'), ['/w/made.md'], 'redirect inside a heredoc body is ignored');
  assert.deepEqual(extractWriteTargets("cat > notes.md <<'EOF'\nx\nEOF", '/w'), ['/w/notes.md']);
  assert.deepEqual(extractWriteTargets('cd /r && echo 1 > a.txt; cd sub && echo 2 > b.txt', '/w'), ['/r/a.txt', '/r/sub/b.txt']);
  assert.deepEqual(extractWriteTargets('mkdir -p /r && cd /r && gh api x > a.json', '/w'), ['/r/a.json']);
  assert.deepEqual(extractWriteTargets('cd ~/p && echo 1 > a.txt', '/w'), [path.join(process.env.HOME, 'p', 'a.txt')]);
  assert.deepEqual(extractWriteTargets('S=/tmp/x; cd $S && echo 1 > rel.txt && echo 2 > /abs.txt', '/w'), ['/abs.txt'], 'relative targets after cd $VAR are dropped');
  assert.deepEqual(extractWriteTargets('echo $X > $OUT', '/w'), [], 'variable targets are dropped');
  assert.deepEqual(extractWriteTargets('S=/tmp/x; cd $S/wt && cd sub && echo 1 > rel.txt; cd /abs && echo 2 > ok.txt', '/w'), ['/abs/ok.txt'], 'relative cd after an unknown base stays unknown until an absolute cd');
  assert.deepEqual(extractWriteTargets('grep -n "a > b" file.py && [ 1 -gt 0 ]', '/w'), [], 'quoted > is not a redirect');
  assert.deepEqual(extractWriteTargets("awk '{print > \"x\"}' f", '/w'), []);
  assert.deepEqual(extractWriteTargets('node -e "const a = x => x" > o.js', '/w'), ['/w/o.js']);
  assert.deepEqual(extractWriteTargets('', '/w'), []);
  assert.deepEqual(extractWriteTargets(null, '/w'), []);
});

test('extractWriteTargets: mv/cp destinations, git apply, patch, inline scripts', () => {
  assert.deepEqual(extractWriteTargets('mv src/a.py src/b.py', '/w'), ['/w/src/b.py']);
  assert.deepEqual(extractWriteTargets('cp -r a.py b.py dir/', '/w'), ['/w/dir/a.py', '/w/dir/b.py']);
  assert.deepEqual(extractWriteTargets('cp a.py b.py dest', '/w'), ['/w/dest/a.py', '/w/dest/b.py']);
  assert.deepEqual(extractWriteTargets("git apply <<'EOF'\n--- a/src/x.py\n+++ b/src/x.py\n@@ -1 +1 @@\n-a\n+b\nEOF", '/w'), ['/w/src/x.py']);
  assert.deepEqual(extractWriteTargets("git apply - <<'EOF'\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x\nEOF", '/w'), ['/w/new.py']);
  assert.deepEqual(extractWriteTargets("python3 - <<'EOF'\np='a/b.py'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF", '/w'), ['/w/a/b.py']);
  assert.deepEqual(extractWriteTargets("python3 -c \"open('x.txt','w').write('1')\"", '/w'), ['/w/x.txt']);
  assert.deepEqual(extractWriteTargets("python3 - <<'EOF'\nfrom pathlib import Path\nPath('out/r.md').write_text('x')\nEOF", '/w'), ['/w/out/r.md']);
  assert.deepEqual(extractWriteTargets("python3 - <<'EOF'\nopen('r.txt').read()\nEOF", '/w'), [], 'read-mode open is not a write');
  assert.deepEqual(extractWriteTargets("python3 - <<'PY'\nimport json\nwith open('a.json', 'w', encoding='utf-8') as f:\n    json.dump({}, f)\nPY", '/w'), ['/w/a.json']);
  assert.deepEqual(extractWriteTargets("node -e \"const fs=require('fs'); const p='docs/index.json'; fs.writeFileSync(p, '{}')\"", '/w'), ['/w/docs/index.json']);
  assert.deepEqual(extractWriteTargets("node -e \"require('fs').writeFileSync('o.json', '1')\"", '/w'), ['/w/o.json']);
  assert.deepEqual(extractWriteTargets("cd /r && python3 - <<'EOF'\nopen('x.py','w')\nEOF", '/w'), ['/r/x.py'], 'script targets follow the cd');
  assert.deepEqual(extractWriteTargets('echo 1 > a.txt && echo 2 > a.txt', '/w'), ['/w/a.txt'], 'deduped');
});

// -------------------------------------------------------------- commits

test('isGitCommit: real commits only', () => {
  assert.equal(isGitCommit('git commit -m x'), true);
  assert.equal(isGitCommit('cd /r && git add -A && git commit -q -m "x" && git push'), true);
  assert.equal(isGitCommit('git -C /x -c user.name=a commit -q'), true);
  assert.equal(isGitCommit('GIT_AUTHOR_NAME=a git commit -q'), true);
  assert.equal(isGitCommit('git log --oneline | grep commit'), false);
  assert.equal(isGitCommit('echo "git commit"'), false);
  assert.equal(isGitCommit("python3 - <<'EOF'\nprint('git commit here')\nEOF"), false);
  assert.equal(isGitCommit('git status && git diff'), false);
  assert.equal(isGitCommit('gh pr view 1 --json commits'), false);
  assert.equal(isGitCommit(''), false);
  assert.equal(isGitCommit(undefined), false);
});

test('extractCommitMessage: -m forms, --message, combined flags, heredoc forms, none', () => {
  assert.equal(extractCommitMessage('git commit -m "Fix it"'), 'Fix it');
  assert.equal(extractCommitMessage("git commit -m 'Fix it'"), 'Fix it');
  assert.equal(extractCommitMessage('git commit -qm "Fix it" && git push'), 'Fix it');
  assert.equal(extractCommitMessage('git commit -am "Fix it"'), 'Fix it');
  assert.equal(extractCommitMessage('git commit -q -s -m "a" -m "b"'), 'a\n\nb');
  assert.equal(extractCommitMessage('git commit --message="Fix it"'), 'Fix it');
  assert.equal(extractCommitMessage('git commit --message "Fix it"'), 'Fix it');
  assert.equal(extractCommitMessage('git commit -m"glued"'), 'glued');
  assert.equal(extractCommitMessage('git commit -m "$(cat <<\'EOF\'\nSubject\n\nBody.\nEOF\n)"'), 'Subject\n\nBody.');
  assert.equal(extractCommitMessage("git commit -q -F - <<'MSG'\nFix the thing\n\nwhy\nMSG"), 'Fix the thing\n\nwhy');
  assert.equal(extractCommitMessage("git commit --file=- <<'MSG'\nFix\nMSG"), 'Fix');
  assert.equal(extractCommitMessage('git commit -F msg.txt'), null);
  assert.equal(extractCommitMessage('git commit --amend --no-edit'), null);
  assert.equal(extractCommitMessage('git commit -q --fixup=abc'), null);
  assert.equal(extractCommitMessage('git commit -m "x" | cat'), 'x');
  assert.equal(extractCommitMessage('git push'), null);
  assert.equal(extractCommitMessage(null), null);
});

// -------------------------------------------------------------- helpers

test('stripHeredocBodies removes bodies and keeps the delimiters', () => {
  const r = stripHeredocBodies("cat <<'EOF' > f\nline > 1\nline 2\nEOF\necho done");
  assert.equal(r.text, "cat <<'EOF' > f\nEOF\necho done");
  assert.deepEqual(r.bodies, ['line > 1\nline 2']);
  const two = stripHeredocBodies('cat <<A > a\nx\nA\ncat <<"B" > b\ny\nB');
  assert.deepEqual(two.bodies, ['x', 'y']);
  assert.deepEqual(stripHeredocBodies('cat <<< "here string"').bodies, []);
  assert.deepEqual(stripHeredocBodies('plain').bodies, []);
});

test('shellTokens: quotes, fds, operators', () => {
  const t = shellTokens('echo "a b" \'c\' 2>&1 > out && x | y');
  assert.deepEqual(t.map((x) => x.text), ['echo', 'a b', 'c', '>&', '1', '>', 'out', '&&', 'x', '|', 'y']);
  assert.equal(t[1].quoted, true);
  assert.equal(t[3].fd, '2');
  assert.equal(t[5].fd, null);
});

test('repositoryFromPrUrl', () => {
  assert.equal(repositoryFromPrUrl('https://github.com/devorg/proj/pull/42'), 'devorg/proj');
  assert.equal(repositoryFromPrUrl('https://github.com/devorg/proj.js/pull/42#issuecomment-1'), 'devorg/proj.js');
  assert.equal(repositoryFromPrUrl('https://gitlab.com/a/b/-/merge_requests/1'), null);
  assert.equal(repositoryFromPrUrl(null), null);
});

test('fixtures are synthetic and the module avoids forbidden vocabulary', () => {
  // built from pieces so this file itself never spells the forbidden words
  const forbidden = new RegExp(`\\b(${['test', 'verifi', 'cover'].map((s) => s + 'ed').join('|')})\\b|proof that it works`, 'i');
  for (const f of ['transcript.js', 'discover.js']) {
    const src = fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
    assert.ok(!forbidden.test(src), `${f} contains forbidden vocabulary`);
  }
  for (const f of fs.readdirSync(FIX)) {
    const text = fs.readFileSync(path.join(FIX, f), 'utf8');
    assert.ok(text.includes('/home/dev/proj'), `${f} uses the synthetic cwd`);
    assert.ok(!text.includes(os.homedir()), `${f} must not embed a real home path`);
  }
});
