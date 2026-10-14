import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  runCli, USAGE, parseRemote, remapWorktreePaths, timeWindowFor, effectiveRunDir, isRepoScopedBash, resolveRefs, ask, checkoutOf,
  dropEventsAfter, mergedAt, stripRemoteUserinfo,
} from '../src/cli.js';
import { encodeProjectDir } from '../src/discover.js';
import { extractRuns, runsForHunk, hunkStatus } from '../src/runs.js';

// Scratch git repo + synthetic ~/.claude/projects tree. The session edits the
// two files of the branch (one Write, one Edit) and then runs node --test.
let tmp;
let repo;
let projectsDir;
let emptyProjects;
let sessionFile;
const SID = '11111111-2222-4333-8444-555555555555';
const FORBIDDEN = new RegExp(`\\b(${['test', 'verifi', 'cover'].map((s) => s + 'ed').join('|')})\\b|proof that it works`, 'i');

const git = (args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

function io(stdinText = '') {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => { out += d; });
  stderr.on('data', (d) => { err += d; });
  stdin.end(stdinText);
  return { streams: { stdout, stderr, stdin }, out: () => out, err: () => err };
}

const A_V1 = 'export function add(a, b) {\n  return a + b;\n}\n';
const A_V2 = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n';
const B_V1 = 'import { add } from \'./a.js\';\n\nexport const three = add(1, 2);\n';

function line(obj) { return JSON.stringify(obj) + '\n'; }

function synthSession(cwd, { base }) {
  const ts = (min) => new Date(base + min * 60000).toISOString();
  const common = (extra) => ({ isSidechain: false, cwd, sessionId: SID, version: '2.1.299', gitBranch: 'feat', ...extra });
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
  const L = [];
  L.push(line({ type: 'mode', mode: 'normal', sessionId: SID }));
  L.push(line(common({ type: 'user', uuid: 'u1', timestamp: ts(0), message: { role: 'user', content: '[synthetic] add a subtraction helper and a module that uses add' } })));
  L.push(line(common({ type: 'assistant', uuid: 'a1', timestamp: ts(1), requestId: 'req1', message: { id: 'msg1', model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'text', text: 'I will add sub() next to add() and a small module using add().' }] } })));
  L.push(line(common({ type: 'assistant', uuid: 'a2', timestamp: ts(2), requestId: 'req1', message: { id: 'msg1', model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: path.join(cwd, 'src/b.js'), content: B_V1 } }] } })));
  L.push(line(common({ type: 'user', uuid: 'u2', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'ok' }] }, toolUseResult: { type: 'create', filePath: path.join(cwd, 'src/b.js'), content: B_V1, structuredPatch: [], originalFile: null, userModified: false } })));
  L.push(line(common({ type: 'assistant', uuid: 'a3', timestamp: ts(4), requestId: 'req2', message: { id: 'msg2', model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: path.join(cwd, 'src/a.js'), old_string: '  return a + b;\n}\n', new_string: '  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n' } }] } })));
  L.push(line(common({ type: 'user', uuid: 'u3', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: 'ok' }] }, toolUseResult: { filePath: path.join(cwd, 'src/a.js'), oldString: '  return a + b;\n}\n', newString: '  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n', originalFile: A_V1, structuredPatch: [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 6, lines: [' return a + b;', ' }', '+', '+export function sub(a, b) {', '+  return a - b;', '+}'] }], userModified: false } })));
  L.push(line(common({ type: 'assistant', uuid: 'a4', timestamp: ts(6), requestId: 'req3', message: { id: 'msg3', model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'node --test' } }] } })));
  L.push(line(common({ type: 'user', uuid: 'u4', timestamp: ts(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '# pass 3\n# fail 0' }] }, toolUseResult: { stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n', stderr: '', interrupted: false, isImage: false } })));
  // a scratch run elsewhere must not count for this repo
  L.push(line(common({ type: 'assistant', uuid: 'a5', timestamp: ts(8), requestId: 'req4', message: { id: 'msg4', model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: 'toolu_s', name: 'Bash', input: { command: 'cd /tmp/scratch && python3 probe.py' } }] } })));
  L.push(line(common({ type: 'user', uuid: 'u5', timestamp: ts(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'Traceback (most recent call last)\nError: boom' }] }, toolUseResult: { stdout: 'Traceback (most recent call last)\nError: boom', stderr: '', interrupted: false, isImage: false } })));
  return L.join('');
}

before(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hunkproof-cli-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'dev@example.com']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'src/a.js'), A_V1);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'feat']);
  fs.writeFileSync(path.join(repo, 'src/a.js'), A_V2);
  fs.writeFileSync(path.join(repo, 'src/b.js'), B_V1);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n\nhand-written line, no agent edit\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: sub() and b.js']);
  // session 30 minutes ago, well inside the window (first commit - 2h .. now)
  projectsDir = path.join(tmp, 'projects');
  const dir = path.join(projectsDir, encodeProjectDir(repo));
  fs.mkdirSync(dir, { recursive: true });
  sessionFile = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(sessionFile, synthSession(repo, { base: Date.now() - 30 * 60000 }));
  emptyProjects = path.join(tmp, 'empty-projects');
  fs.mkdirSync(emptyProjects);
});

after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('help, version, bad flags, unknown command', async () => {
  let r = io();
  assert.equal(await runCli(['--help'], r.streams), 0);
  assert.match(r.out(), /Usage:/);
  assert.ok(!FORBIDDEN.test(USAGE));
  r = io();
  assert.equal(await runCli(['--version'], r.streams), 0);
  assert.match(r.out(), /^hunkproof \d+\.\d+\.\d+/);
  r = io();
  assert.equal(await runCli(['--nope'], r.streams), 1);
  assert.match(r.err(), /Unknown option/);
  r = io();
  assert.equal(await runCli(['frobnicate'], r.streams), 1);
  assert.match(r.err(), /unknown command/);
  r = io();
  assert.equal(await runCli(['--repo', tmp], r.streams), 1);
  assert.match(r.err(), /not a git repository/);
});

test('full run: discovery by cwd, attribution, runs, outputs, git note, exit 0', async () => {
  const r = io();
  const code = await runCli(['--base', 'main', '--head', 'feat', '--repo', repo, '--projects-dir', projectsDir], r.streams);
  assert.equal(code, 0, r.err());
  const out = r.out();
  assert.match(out, /^hunkproof · main\.\.\.feat · 2 of 2 line-matched hunks had a run after their last edit \(2 passed, 0 failed, 0 outcome not parsed\) · 0 file-level \(lines not matched to an edit\) · 0 unrun · 1 unattributed · 1 session · hunkproof used 0 LLM tokens/m);
  assert.match(out, /src\/a\.js .*ran, passed .*node:test pass \(targeted\)/);
  assert.match(out, /src\/b\.js .*ran, passed/);
  assert.match(out, /README\.md .*unattributed/);
  assert.match(out, /wrote .*evidence\.json, hunkproof\.html, hunkproof\.md · note refs\/notes\/hunkproof on [0-9a-f]{7}/);
  assert.ok(!FORBIDDEN.test(out + r.err()), 'cli output follows the vocabulary rule');

  const outDir = path.join(repo, '.hunkproof');
  const evidence = JSON.parse(fs.readFileSync(path.join(outDir, 'evidence.json'), 'utf8'));
  assert.equal(evidence.schema, 'hunkproof/evidence@1');
  assert.deepEqual(
    [evidence.summary.hunks, evidence.summary.matched, evidence.summary.fileLevel, evidence.summary.unattributed, evidence.summary.runPass, evidence.summary.strictRunAfterLastEdit],
    [3, 2, 0, 1, 2, 2],
  );
  assert.equal(evidence.runs.length, 1, 'the scratch run in /tmp does not count');
  assert.equal(evidence.sessions.length, 1);
  assert.equal(evidence.sessions[0].sessionId, SID);
  assert.equal(evidence.sessions[0].edits, 2);
  assert.equal(evidence.sessions[0].runs, 1);
  assert.equal(evidence.usage.totals.messages, 4);
  assert.equal(evidence.repo.base, 'main');
  assert.equal(evidence.repo.headSha, git(['rev-parse', 'feat']));
  assert.equal(evidence.discovery.selected.length, 1);
  assert.match(evidence.discovery.selected[0].reasons.join(' '), /2 edits of 2 diff files/);
  const a = evidence.hunks.find((h) => h.relFile === 'src/a.js');
  assert.equal(a.attribution, 'MATCHED');
  assert.equal(a.status, 'RUN_PASS');
  assert.equal(a.runsAfter.length, 1);
  assert.equal(a.runsAfter[0].targeted, true);
  assert.match(a.intent.text, /I will add sub\(\)/);
  assert.ok(fs.existsSync(path.join(outDir, 'hunkproof.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'hunkproof.md')));
  // hunkproof never edits the repository it reports on: it points out the missing ignore line
  assert.ok(!fs.existsSync(path.join(repo, '.gitignore')), 'no .gitignore was created');
  assert.match(r.err(), /^hint: add \.hunkproof\/ to \.gitignore/m);
  assert.equal(git(['status', '--porcelain']).split('\n').filter((l) => l.trim()).join(','), '?? .hunkproof/', 'only the untracked output dir shows up');
  // once the line is there, no hint
  fs.writeFileSync(path.join(repo, '.gitignore'), '.hunkproof/\n');
  const r2 = io();
  await runCli(['--base', 'main', '--head', 'feat', '--repo', repo, '--projects-dir', projectsDir, '--no-note'], r2.streams);
  assert.doesNotMatch(r2.err(), /hint: add/);
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), '.hunkproof/\n');
});

test('note show reads the note back; --from-note renders it', async () => {
  let r = io();
  assert.equal(await runCli(['note', 'show', '--repo', repo, '--head', 'feat'], r.streams), 0);
  assert.match(r.out(), /^hunkproof · main\.\.\.feat/m);
  assert.match(r.out(), /note written \d{4}-/);
  r = io();
  assert.equal(await runCli(['note', 'show', '--repo', repo, '--head', 'feat', '--json'], r.streams), 0);
  assert.equal(JSON.parse(r.out()).schema, 'hunkproof/evidence@1');
  r = io();
  assert.equal(await runCli(['note', 'show', '--repo', repo, '--head', 'main'], r.streams), 1);
  assert.match(r.out(), /no hunkproof note/);
  r = io();
  assert.equal(await runCli(['--from-note', '--repo', repo, '--head', 'feat', '--out', path.join(tmp, 'replay')], r.streams), 0);
  assert.ok(fs.existsSync(path.join(tmp, 'replay', 'hunkproof.html')));
  r = io();
  assert.equal(await runCli(['note', 'list'], r.streams), 1);
});

test('--sessions overrides discovery; --json prints the evidence', async () => {
  const r = io();
  const code = await runCli(['--base', 'main', '--head', 'feat', '--repo', repo, '--sessions', sessionFile, '--json', '--no-note', '--out', path.join(tmp, 'json-out')], r.streams);
  assert.equal(code, 0, r.err());
  const ev = JSON.parse(r.out());
  assert.equal(ev.summary.matched, 2);
  assert.deepEqual(ev.discovery.selected[0].reasons, ['given with --sessions']);
});

test('no session found: diff-only report, exit 2', async () => {
  const r = io();
  const code = await runCli(['--base', 'main', '--head', 'feat', '--repo', repo, '--projects-dir', emptyProjects, '--no-note', '--out', path.join(tmp, 'none-out')], r.streams);
  assert.equal(code, 2);
  assert.match(r.out(), /0 of 0 line-matched hunks .* 3 unattributed · 0 sessions/);
  assert.match(r.out(), /no Claude Code session matched/);
  const ev = JSON.parse(fs.readFileSync(path.join(tmp, 'none-out', 'evidence.json'), 'utf8'));
  assert.ok(ev.hunks.every((h) => h.status === 'UNATTRIBUTED'));
});

test('--diff FILE replaces git diff; --evidence FILE replays without transcripts', async () => {
  const diffFile = path.join(tmp, 'change.diff');
  fs.writeFileSync(diffFile, git(['diff', '-U0', 'main...feat']) + '\n');
  let r = io();
  let code = await runCli(['--diff', diffFile, '--repo', repo, '--projects-dir', projectsDir, '--no-note', '--out', path.join(tmp, 'diff-out')], r.streams);
  assert.equal(code, 0, r.err());
  let ev = JSON.parse(fs.readFileSync(path.join(tmp, 'diff-out', 'evidence.json'), 'utf8'));
  assert.equal(ev.summary.hunks, 3);
  assert.equal(ev.summary.matched, 2);
  assert.equal(ev.repo.base, 'diff-file');

  const evFile = path.join(tmp, 'saved.json');
  ev.repo.prNumber = 7;
  fs.writeFileSync(evFile, JSON.stringify(ev));
  r = io();
  code = await runCli(['--evidence', evFile, '--out', path.join(tmp, 'replay2')], r.streams);
  assert.equal(code, 0, r.err());
  assert.match(r.out(), /^hunkproof · PR #7/m);
  assert.ok(fs.existsSync(path.join(tmp, 'replay2', 'hunkproof.md')));
  r = io();
  fs.writeFileSync(path.join(tmp, 'bad.json'), '{"schema":"other"}');
  assert.equal(await runCli(['--evidence', path.join(tmp, 'bad.json')], r.streams), 1);
});

test('--post previews, asks, and stops on anything but yes; needs a PR number', async () => {
  const evFile = path.join(tmp, 'saved.json');
  let r = io('n\n');
  let code = await runCli(['--evidence', evFile, '--post', '--out', path.join(tmp, 'post-out')], r.streams);
  assert.equal(code, 0, r.err());
  assert.match(r.out(), /comment preview \(PR #7\)/);
  assert.match(r.out(), /Post this comment to PR #7\? \[y\/N\]/);
  assert.match(r.out(), /not posted/);
  assert.ok(!/I will add sub\(\)/.test(r.out()), 'intent text stays out of the comment without --quotes');
  r = io('n\n');
  await runCli(['--evidence', evFile, '--post', '--quotes', '--out', path.join(tmp, 'post-out')], r.streams);
  assert.match(r.out(), /agent: I will add sub\(\)/);
  // evidence without a PR number
  const ev = JSON.parse(fs.readFileSync(evFile, 'utf8'));
  ev.repo.prNumber = null;
  const noPr = path.join(tmp, 'nopr.json');
  fs.writeFileSync(noPr, JSON.stringify(ev));
  r = io('y\n');
  code = await runCli(['--evidence', noPr, '--post', '--out', path.join(tmp, 'post-out')], r.streams);
  assert.equal(code, 1);
  assert.match(r.err(), /needs a PR number/);
});

// A fake `gh` first in PATH records its arguments; the answer typed at the
// prompt must reach postComment (rl.close() used to resolve '' first).
function withFakeGh(fn) {
  const bin = path.join(tmp, 'fakebin');
  const logFile = path.join(tmp, 'gh.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nif [ "$1" = "pr" ] && [ "$2" = "comment" ]; then echo "https://github.com/acme/repo/pull/7#issuecomment-1"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(logFile, '');
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return Promise.resolve()
    .then(() => fn(() => fs.readFileSync(logFile, 'utf8')))
    .finally(() => { process.env.PATH = prev; });
}

test('--post: "y" and "yes" at the prompt post the comment through gh', async () => {
  const evFile = path.join(tmp, 'saved.json');
  await withFakeGh(async (ghLog) => {
    for (const answer of ['y\n', 'yes\n', 'Y\n', '  Yes \n']) {
      fs.writeFileSync(path.join(tmp, 'gh.log'), '');
      const r = io(answer);
      const code = await runCli(['--evidence', evFile, '--post', '--out', path.join(tmp, 'post-out')], r.streams);
      assert.equal(code, 0, r.err());
      assert.match(r.out(), /Post this comment to PR #7\? \[y\/N\]/);
      assert.match(r.out(), /\[y\/N\] posted: https:\/\/github\.com\/acme\/repo\/pull\/7#issuecomment-1\n/, `answer ${JSON.stringify(answer)}`);
      assert.ok(!/not posted/.test(r.out()));
      const calls = ghLog().trim().split('\n');
      assert.equal(calls.length, 1);
      assert.match(calls[0], /^pr comment 7 --body-file .*comment\.md$/);
    }
    // anything else, or a closed stdin, does not post
    for (const answer of ['n\n', '\n', '', 'yolo\n']) {
      fs.writeFileSync(path.join(tmp, 'gh.log'), '');
      const r = io(answer);
      await runCli(['--evidence', evFile, '--post', '--out', path.join(tmp, 'post-out')], r.streams);
      assert.match(r.out(), /not posted/, `answer ${JSON.stringify(answer)}`);
      assert.equal(ghLog(), '');
    }
    // --yes skips the prompt
    fs.writeFileSync(path.join(tmp, 'gh.log'), '');
    const r = io('');
    await runCli(['--evidence', evFile, '--post', '--yes', '--out', path.join(tmp, 'post-out')], r.streams);
    assert.match(r.out(), /^posted:/m);
    assert.doesNotMatch(r.out(), /Post this comment/);
  });
});

test('privacy: no home path survives in the terminal, evidence.json, HTML, Markdown or the git note', async () => {
  // A second scratch repo whose branch adds a file quoting several home
  // directories (the real one included), edited by a session whose text and
  // run command quote them too.
  const home = os.homedir();
  const encodedHome = encodeProjectDir(home);
  const repo2 = path.join(tmp, 'repo-home');
  const g = (args) => execFileSync('git', ['-C', repo2, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(path.join(repo2, 'src'), { recursive: true });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'dev@example.com']);
  g(['config', 'user.name', 'Dev']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo2, 'README.md'), '# paths\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'base']);
  g(['checkout', '-q', '-b', 'feat']);
  const content = [
    `export const OWN = '${home}/private/notes.txt';`,
    "export const OTHER = '/home/dev/.npmrc';",
    "export const MAC = '/Users/bob/Library/Keychains';",
    "export const WIN = 'C:\\\\Users\\\\carol\\\\secrets.txt';",
    `export const TRANSCRIPTS = '~/.claude/projects/${encodedHome}-repo/';`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repo2, 'src/paths.js'), content);
  g(['add', '.']);
  g(['commit', '-q', '-m', 'feat: path constants']);

  const sid = '22222222-3333-4444-8555-666666666666';
  const base = Date.now() - 20 * 60000;
  const ts = (min) => new Date(base + min * 60000).toISOString();
  const common = (extra) => ({ isSidechain: false, cwd: repo2, sessionId: sid, version: '2.1.299', gitBranch: 'feat', ...extra });
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const L = [
    line(common({ type: 'user', uuid: 'h-u1', timestamp: ts(0), message: { role: 'user', content: '[synthetic] add the path constants' } })),
    line(common({ type: 'assistant', uuid: 'h-a1', timestamp: ts(1), requestId: 'h-req1', message: { id: 'h-msg1', model: 'claude-opus-5-5', role: 'assistant', usage, content: [
      { type: 'text', text: `Writing the constants: ${home}/private, /home/dev/.npmrc, /Users/bob and C:\\Users\\carol, plus the transcript dir ${encodedHome}-repo.` },
      { type: 'tool_use', id: 'h-toolu_w', name: 'Write', input: { file_path: path.join(repo2, 'src/paths.js'), content } },
    ] } })),
    line(common({ type: 'user', uuid: 'h-u2', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h-toolu_w', content: 'ok' }] }, toolUseResult: { type: 'create', filePath: path.join(repo2, 'src/paths.js'), content, structuredPatch: [], originalFile: null, userModified: false } })),
    line(common({ type: 'assistant', uuid: 'h-a2', timestamp: ts(3), requestId: 'h-req2', message: { id: 'h-msg2', model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: 'h-toolu_b', name: 'Bash', input: { command: `cat /home/dev/.npmrc ${home}/.npmrc >/dev/null; node --test` } }] } })),
    line(common({ type: 'user', uuid: 'h-u3', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h-toolu_b', content: '# pass 1' }] }, toolUseResult: { stdout: `ℹ tests 1\nℹ pass 1\nℹ fail 0\n# ran from ${home}/repo-home`, stderr: '', interrupted: false, isImage: false } })),
  ].join('');
  const dir2 = path.join(projectsDir, encodeProjectDir(repo2));
  fs.mkdirSync(dir2, { recursive: true });
  const session2 = path.join(dir2, `${sid}.jsonl`);
  fs.writeFileSync(session2, L);

  const outDir = path.join(tmp, 'home-out');
  const r = io();
  const code = await runCli(['--base', 'main', '--head', 'feat', '--repo', repo2, '--sessions', session2, '--out', outDir], r.streams);
  assert.equal(code, 0, r.err());

  const outputs = {
    terminal: r.out(),
    'evidence.json': fs.readFileSync(path.join(outDir, 'evidence.json'), 'utf8'),
    'hunkproof.html': fs.readFileSync(path.join(outDir, 'hunkproof.html'), 'utf8'),
    'hunkproof.md': fs.readFileSync(path.join(outDir, 'hunkproof.md'), 'utf8'),
    'git note': g(['notes', '--ref=hunkproof', 'show', 'feat']),
  };
  // a home directory followed by a user name, in any of its forms; the
  // redaction rules themselves spell "<user>", which no rule matches
  const RAW = [
    [home, 'own home directory'],
    [encodedHome, 'encoded own home directory'],
    [/\/home\/[A-Za-z0-9._-]+/, '/home/<user>'],
    [/\/Users\/[A-Za-z0-9._-]+/, '/Users/<user>'],
    [/[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[A-Za-z0-9._-]+/, 'C:\\Users\\<user>'],
  ];
  for (const [name, text] of Object.entries(outputs)) {
    assert.ok(text.length > 0, `${name} is not empty`);
    for (const [pat, label] of RAW) {
      const hit = typeof pat === 'string' ? text.includes(pat) : pat.test(text);
      assert.equal(hit, false, `${label} survives in ${name}`);
    }
    assert.ok(!FORBIDDEN.test(text), `${name} follows the vocabulary rule`);
  }
  const ev = JSON.parse(outputs['evidence.json']);
  assert.equal(ev.summary.matched, 1);
  assert.equal(ev.hunks[0].status, 'RUN_PASS');
  assert.equal(ev.repo.root, redactPrefix(repo2, home), 'repo root goes through the path rules');
  assert.ok(ev.hunks[0].added.includes("export const OWN = '~/private/notes.txt';"), 'own home in a diff line');
  assert.ok(ev.hunks[0].added.includes("export const OTHER = '~/.npmrc';"), 'other home in a diff line');
  assert.ok(ev.hunks[0].added.includes("export const MAC = '~/Library/Keychains';"), 'macOS home in a diff line');
  assert.ok(ev.hunks[0].added.includes("export const WIN = '~\\\\secrets.txt';"), 'Windows home in a diff line');
  assert.ok(ev.hunks[0].added.includes("export const TRANSCRIPTS = '~/.claude/projects/~-repo/';"), 'encoded home in a diff line');
  assert.match(ev.hunks[0].intent.text, /^Writing the constants: ~\/private, ~\/\.npmrc, ~ and ~, plus the transcript dir ~-repo\.$/);
  assert.equal(ev.runs[0].command, 'cat ~/.npmrc ~/.npmrc >/dev/null; node --test');
  assert.match(ev.runs[0].summary, /ran from ~\/repo-home|pass/);
  assert.equal(ev.redaction.home, '~');
  assert.ok(outputs['hunkproof.html'].includes('nothing else is rewritten'), 'the HTML footer states the redaction rule');
  assert.ok(outputs['hunkproof.md'].includes('nothing else is rewritten'), 'the Markdown footer states the redaction rule');
  assert.deepEqual(JSON.parse(outputs['git note']).redaction, ev.redaction, 'the note holds the same redacted document');
});

// The scratch repo lives under os.tmpdir(); when that is itself under the home
// directory the redacted root starts with ~, otherwise it is unchanged.
function redactPrefix(p, home) {
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

test('merged PR: transcript events after the merge commit are left out, later sessions dropped', async () => {
  // A clone where feat was merged into main 10 minutes ago; a fake gh reports
  // the PR as MERGED with that merge commit. One session worked before the
  // merge (runs pass), a second one ran a failing test after it.
  const clone = path.join(tmp, 'repo-merged');
  execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'ignore' });
  const g = (args, env = {}) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
  g(['config', 'user.email', 'dev@example.com']);
  g(['config', 'user.name', 'Dev']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['checkout', '-q', 'main']);
  const mergeDate = new Date(Date.now() - 10 * 60000);
  g(['merge', '--no-ff', '-q', '-m', 'Merge pull request #9 from acme/feat', 'origin/feat'], { GIT_COMMITTER_DATE: mergeDate.toISOString(), GIT_AUTHOR_DATE: mergeDate.toISOString() });
  const mergeSha = g(['rev-parse', 'HEAD']);
  assert.equal(mergedAt(clone, { merged: true, mergeCommit: mergeSha }), new Date(Math.floor(mergeDate.getTime() / 1000) * 1000).toISOString());
  assert.equal(mergedAt(clone, { merged: false, mergeCommit: mergeSha }), null);
  assert.equal(mergedAt(clone, null), null);

  const projDir = path.join(projectsDir, encodeProjectDir(clone));
  fs.mkdirSync(projDir, { recursive: true });
  const early = path.join(projDir, '33333333-4444-4555-8666-777777777777.jsonl');
  const afterMerge = new Date(Date.now() - 5 * 60000).toISOString();
  fs.writeFileSync(early, synthSession(clone, { base: Date.now() - 30 * 60000 }) + line({
    isSidechain: false, cwd: clone, sessionId: SID, version: '2.1.299', gitBranch: 'feat',
    type: 'assistant', uuid: 'a9', timestamp: afterMerge, requestId: 'req9',
    message: { id: 'msg9', model: 'claude-opus-5-5', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_after', name: 'Bash', input: { command: 'node --test' } }] },
  }));
  const lateSid = '44444444-5555-4666-8777-888888888888';
  const lateBase = Date.now() - 8 * 60000;
  const lts = (min) => new Date(lateBase + min * 60000).toISOString();
  const lc = (extra) => ({ isSidechain: false, cwd: clone, sessionId: lateSid, version: '2.1.299', gitBranch: 'main', ...extra });
  const late = path.join(projDir, `${lateSid}.jsonl`);
  fs.writeFileSync(late, [
    line(lc({ type: 'user', uuid: 'l-u1', timestamp: lts(0), message: { role: 'user', content: '[synthetic] rerun the tests' } })),
    line(lc({ type: 'assistant', uuid: 'l-a1', timestamp: lts(1), requestId: 'l-req1', message: { id: 'l-msg1', model: 'claude-opus-5-5', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'l-toolu_b', name: 'Bash', input: { command: 'node --test' } }] } })),
    line(lc({ type: 'user', uuid: 'l-u2', timestamp: lts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'l-toolu_b', content: '# fail 1' }] }, toolUseResult: { stdout: 'ℹ tests 3\nℹ pass 2\nℹ fail 1\n', stderr: '', interrupted: false, isImage: true } })),
  ].join(''));

  const bin = path.join(tmp, 'fakebin-merged');
  fs.mkdirSync(bin, { recursive: true });
  const prJson = JSON.stringify({ number: 9, url: 'https://github.com/acme/repo/pull/9', baseRefName: 'main', headRefName: 'feat', state: 'MERGED', mergeCommit: { oid: mergeSha }, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'acme' } });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat <<'EOF'\n${prJson}\nEOF\nexit 0; fi\nexit 1\n`, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    // explicit sessions: the late one is read, then emptied by the cutoff
    let r = io();
    let code = await runCli(['--pr', '9', '--repo', clone, '--sessions', `${early},${late}`, '--no-note', '--out', path.join(tmp, 'merged-out')], r.streams);
    assert.equal(code, 0, r.err());
    assert.match(r.err(), /merged PR: \d+ transcript events after the merge \(\S+\) left out, 1 transcript entirely/);
    let ev = JSON.parse(fs.readFileSync(path.join(tmp, 'merged-out', 'evidence.json'), 'utf8'));
    assert.equal(ev.repo.prNumber, 9);
    assert.equal(ev.repo.base, `${mergeSha}^1`);
    assert.equal(ev.repo.head, `${mergeSha}^2`);
    assert.equal(ev.sessions.length, 1, 'the session that only worked after the merge is not listed');
    assert.equal(ev.runs.length, 1, 'the failing run after the merge is not a run of this PR');
    assert.equal(ev.runs[0].outcome, 'pass');
    assert.equal(ev.summary.runPass, 2);
    assert.equal(ev.summary.runFail, 0);
    assert.equal(ev.discovery.timeWindow.end, mergedAt(clone, { merged: true, mergeCommit: mergeSha }));
    // the session row stops at the cutoff too: the early transcript goes on
    // after the merge (the appended Bash call), but its row and durationSec
    // end with the last event kept, so the document does not change each time
    // that transcript grows
    assert.ok(ev.sessions[0].lastTs <= ev.discovery.timeWindow.end, `${ev.sessions[0].lastTs} <= ${ev.discovery.timeWindow.end}`);
    assert.ok(ev.sessions[0].lastTs >= ev.runs[0].ts, 'lastTs is not before the last run kept');
    const durationSec = ev.summary.durationSec;
    // discovery: the late transcript starts after the merge and is not even read
    r = io();
    code = await runCli(['--pr', '9', '--repo', clone, '--projects-dir', projectsDir, '--no-note', '--out', path.join(tmp, 'merged-out2')], r.streams);
    assert.equal(code, 0, r.err());
    ev = JSON.parse(fs.readFileSync(path.join(tmp, 'merged-out2', 'evidence.json'), 'utf8'));
    assert.equal(ev.sessions.length, 1);
    assert.equal(ev.summary.runPass, 2);
    assert.ok(!ev.discovery.selected.some((s) => s.sessionId === lateSid));
    assert.equal(ev.summary.durationSec, durationSec, 'same rows, same duration');
    assert.ok(ev.sessions[0].lastTs <= ev.discovery.timeWindow.end);
  } finally {
    process.env.PATH = prevPath;
  }
  // the helper itself
  const evs = [{ ts: '2026-10-14T10:00:00.000Z' }, { ts: '2026-10-14T10:00:01.000Z' }, { ts: null }];
  assert.deepEqual(dropEventsAfter(evs, '2026-10-14T10:00:00.000Z'), [evs[0], evs[2]]);
  assert.equal(dropEventsAfter(evs, null), evs);
});

test('a remote URL that carries credentials loses them before the evidence is written', async () => {
  const token = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD';
  git(['remote', 'add', 'origin', `https://alice:${token}@github.com/acme/repo.git`]);
  const outDir = path.join(tmp, 'cred-out');
  try {
    const r = io();
    const code = await runCli(['--base', 'main', '--head', 'feat', '--repo', repo, '--projects-dir', projectsDir, '--no-note', '--out', outDir], r.streams);
    assert.equal(code, 0, r.err());
    const raw = fs.readFileSync(path.join(outDir, 'evidence.json'), 'utf8');
    assert.ok(!raw.includes(token), 'the token is not in evidence.json');
    assert.ok(!raw.includes('alice:'), 'the user name is not in evidence.json');
    assert.equal(JSON.parse(raw).repo.remote, 'https://github.com/acme/repo.git');
    for (const f of ['hunkproof.html', 'hunkproof.md']) assert.ok(!fs.readFileSync(path.join(outDir, f), 'utf8').includes(token), `${f} has no token`);
    assert.ok(!(r.out() + r.err()).includes(token), 'the terminal has no token');
  } finally {
    git(['remote', 'remove', 'origin']);
  }
  assert.equal(stripRemoteUserinfo('https://alice:ghp_x@github.com/acme/repo.git'), 'https://github.com/acme/repo.git');
  assert.equal(stripRemoteUserinfo('https://JulienAu@github.com/JulienAu/hunkproof.git'), 'https://github.com/JulienAu/hunkproof.git');
  assert.equal(stripRemoteUserinfo('ssh://git@github.com/acme/repo.git'), 'ssh://github.com/acme/repo.git');
  assert.equal(stripRemoteUserinfo('git@github.com:acme/repo.git'), 'git@github.com:acme/repo.git');
  assert.equal(stripRemoteUserinfo('/home/alice/repo'), '/home/alice/repo');
  assert.equal(stripRemoteUserinfo(null), null);
  assert.equal(stripRemoteUserinfo(undefined), null);
});

test('ask() resolves the typed answer, or "" when stdin ends first', async () => {
  let r = io('y\n');
  assert.equal(await ask('q? ', r.streams), 'y');
  r = io('');
  assert.equal(await ask('q? ', r.streams), '');
});

test('a run in another checkout than the edit never stamps the hunk ran, passed', async () => {
  const root = '/repo';
  const wt = '/repo/.claude/worktrees/feat';
  const ev = [
    { type: 'edit', ts: '2026-10-14T10:00:00Z', sessionId: 'A', cwd: wt, edit: { tool: 'Edit', file: wt + '/src/a.js', newContent: 'x', addedLines: ['x'] } },
    { type: 'tool', ts: '2026-10-14T10:05:00Z', sessionId: 'B', cwd: root, tool: { name: 'Bash', input: { command: 'npm test' }, result: { stdout: '# tests 3\n# pass 3\n# fail 0', stderr: '', isError: false } } },
    { type: 'tool', ts: '2026-10-14T10:06:00Z', sessionId: 'A', cwd: wt, tool: { name: 'Bash', input: { command: 'npm test' }, result: { stdout: '# tests 3\n# pass 2\n# fail 1', stderr: '', isError: false } } },
  ];
  remapWorktreePaths(ev, root, [wt]);
  assert.equal(ev[0].edit.file, '/repo/src/a.js');
  assert.equal(ev[0].edit.checkout, wt);
  assert.equal(ev[1].checkout, root);
  assert.equal(ev[2].checkout, wt);
  const runs = extractRuns(ev.filter((e) => e.type === 'tool'), { repoRoot: root, packageScripts: { test: 'node --test' } });
  assert.deepEqual(runs.map((r) => r.checkout), [root, wt]);
  const h = { file: root + '/src/a.js', relFile: 'src/a.js', attribution: 'MATCHED', lastEdit: '2026-10-14T10:00:00Z', checkout: wt };
  const after = runsForHunk(h, runs);
  assert.deepEqual(after.map((r) => [r.outcome, r.targeted, r.otherCheckout === true]), [['pass', false, true], ['fail', true, false]]);
  assert.equal(hunkStatus(h, after), 'RUN_FAIL', 'the worktree run decides, the main-checkout pass does not');
  assert.equal(hunkStatus(h, runsForHunk(h, [runs[0]])), 'RUN_UNPARSED', 'only a run elsewhere: no pass/fail');
  assert.equal(checkoutOf('/repo/.claude/worktrees/feat/x/y.js', root, []), wt);
  assert.equal(checkoutOf('/wt2/x.js', root, ['/wt2']), '/wt2');
  assert.equal(checkoutOf('/repo/x.js', root, ['/wt2']), root);
  assert.equal(checkoutOf('/elsewhere/x.js', root, ['/wt2']), null);
});

test('helpers: parseRemote, remapWorktreePaths, effectiveRunDir, isRepoScopedBash, timeWindowFor, resolveRefs', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/billing.git'), { owner: 'acme', name: 'billing', full: 'acme/billing' });
  assert.deepEqual(parseRemote('https://github.com/acme/billing'), { owner: 'acme', name: 'billing', full: 'acme/billing' });
  assert.equal(parseRemote('https://gitlab.com/acme/billing.git'), null);

  const events = [
    { type: 'edit', edit: { file: '/r/.claude/worktrees/agent-1/src/x.js' } },
    { type: 'shell_edit', edit: { file: '/wt/src/y.js' } },
    { type: 'edit', edit: { file: '/r/src/z.js' } },
    { type: 'say', say: { text: 'hi' } },
  ];
  assert.equal(remapWorktreePaths(events, '/r', ['/wt']), 2);
  assert.equal(events[0].edit.file, '/r/src/x.js');
  assert.equal(events[1].edit.file, '/r/src/y.js');
  assert.equal(events[2].edit.file, '/r/src/z.js');
  assert.deepEqual(events.slice(0, 3).map((e) => e.edit.checkout), ['/r/.claude/worktrees/agent-1', '/wt', '/r']);

  assert.equal(effectiveRunDir('node --test', '/r'), '/r');
  assert.equal(effectiveRunDir('cd /tmp/x && pytest', '/r'), '/tmp/x');
  assert.equal(effectiveRunDir('cd sub; make', '/r'), '/r/sub');
  assert.equal(effectiveRunDir('cd "$DIR" && make', '/r'), null);
  assert.equal(effectiveRunDir('FOO=1 cd lib && npm test', '/r'), '/r/lib');
  const bash = (command, cwd) => ({ type: 'tool', cwd, tool: { name: 'Bash', input: { command } } });
  assert.equal(isRepoScopedBash(bash('npm test', '/r'), '/r'), true);
  assert.equal(isRepoScopedBash(bash('npm test', '/elsewhere'), '/r'), false);
  assert.equal(isRepoScopedBash(bash('cd /r && npm test', '/elsewhere'), '/r'), true);
  assert.equal(isRepoScopedBash(bash('node /r/test/x.test.js', '/elsewhere'), '/r'), true);
  assert.equal(isRepoScopedBash(bash('cd /tmp/s && python3 p.py', '/r'), '/r'), false);
  assert.equal(isRepoScopedBash(bash('npm test', '/wt/a'), '/r', ['/wt/a']), true);

  const mb = git(['merge-base', 'main', 'feat']);
  const w = timeWindowFor(repo, mb, 'feat', { hours: 2, now: new Date('2030-01-01T00:00:00Z') });
  assert.equal(w.end, '2030-01-01T00:00:00.000Z');
  assert.equal(Date.parse(w.firstCommit) - Date.parse(w.start), 2 * 3600 * 1000);
  const none = timeWindowFor(repo, mb, 'main', {});
  assert.equal(none.start, null);

  const refs = resolveRefs(repo, { pr: null, base: 'main', head: 'feat', currentBranch: 'feat' });
  assert.equal(refs.mergeBase, mb);
  assert.equal(refs.headSha, git(['rev-parse', 'feat']));
  assert.throws(() => resolveRefs(repo, { pr: null, base: 'nope', head: 'feat' }), /unknown base ref/);
  // a "merged PR" whose merge commit has two parents diffs parent 1 against parent 2
  const fakePr = { number: 9, merged: true, mergeCommit: git(['rev-parse', 'feat']), baseRefName: 'main', headRefName: 'feat' };
  const r2 = resolveRefs(repo, { pr: fakePr, base: null, head: null, currentBranch: 'main' });
  assert.equal(r2.baseRef, `${fakePr.mergeCommit}^1`);
  assert.equal(r2.headRef, fakePr.mergeCommit, 'single-parent merge: head is the commit itself');
});
