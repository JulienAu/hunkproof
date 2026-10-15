import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import { stopHook, parseStdin, formatUnrun, formatEditTime, MAX_LINES } from '../src/hook.js';
import { runCli } from '../src/cli.js';
import { readSession } from '../src/transcript.js';
import { encodeProjectDir } from '../src/discover.js';

// Scratch git repositories with uncommitted edits, synthetic transcripts of
// one session (and its subagents), and the Stop hook run in process with
// injected deps, then once through the real bin.
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'hunkproof.js');
const SID = '11111111-2222-4333-8444-555555555555';
const FORBIDDEN = new RegExp(`\\b(${['test', 'verifi', 'cover'].map((s) => s + 'ed').join('|')})\\b|proof that it works`, 'i');
const A_V1 = 'export function add(a, b) {\n  return a + b;\n}\n';
const A_V2 = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n';
const B_V1 = 'import { add } from \'./a.js\';\n\nexport const three = add(1, 2);\n';
const EDIT_OLD = '  return a + b;\n}\n';
const EDIT_NEW = '  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n';
const A_PATCH = [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 6, lines: [' return a + b;', ' }', '+', '+export function sub(a, b) {', '+  return a - b;', '+}'] }];

let tmp;
let n = 0;

before(() => { tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hunkproof-hook-')); });
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function gitIn(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
}

// A repository whose base commit is two hours old (so the session's edits come
// after it), on branch `feat`, with src/a.js edited and src/b.js untracked.
function makeRepo({ branch = 'main', edits = true } = {}) {
  const repo = path.join(tmp, `repo-${++n}`);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (args) => gitIn(repo, args, { GIT_AUTHOR_DATE: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), GIT_COMMITTER_DATE: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
  git(['init', '-q', '-b', branch]);
  git(['config', 'user.email', 'dev@example.com']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'src/a.js'), A_V1);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'feat']);
  if (edits) {
    fs.writeFileSync(path.join(repo, 'src/a.js'), A_V2);
    fs.writeFileSync(path.join(repo, 'src/b.js'), B_V1);
  }
  return repo;
}

function line(obj) { return JSON.stringify(obj) + '\n'; }

// steps: { min, write: file, content } | { min, edit: file, old, new, originalFile, patch } | { min, run: command, stdout }
function synth(cwd, steps, { sid = SID, agentId = null, base = Date.now() - 30 * 60000 } = {}) {
  const ts = (min) => new Date(base + min * 60000).toISOString();
  const common = (extra) => ({ isSidechain: false, cwd, sessionId: sid, version: '2.1.300', gitBranch: 'feat', ...(agentId ? { agentId } : {}), ...extra });
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
  const L = [line(common({ type: 'user', uuid: 'u0', timestamp: ts(0), message: { role: 'user', content: '[synthetic] work on the repo' } }))];
  let k = 0;
  for (const s of steps) {
    k++;
    const id = `toolu_${k}`;
    const call = (name, input) => line(common({ type: 'assistant', uuid: `a${k}`, timestamp: ts(s.min), requestId: `req${k}`, message: { id: `msg${k}`, model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id, name, input }] } }));
    const result = (content, toolUseResult) => line(common({ type: 'user', uuid: `r${k}`, timestamp: ts(s.min + 0.5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult }));
    if (s.write) {
      const file = path.join(cwd, s.write);
      L.push(call('Write', { file_path: file, content: s.content }));
      L.push(result('ok', { type: 'create', filePath: file, content: s.content, structuredPatch: [], originalFile: null, userModified: false }));
    } else if (s.edit) {
      const file = path.join(cwd, s.edit);
      L.push(call('Edit', { file_path: file, old_string: s.old, new_string: s.new }));
      L.push(result('ok', { filePath: file, oldString: s.old, newString: s.new, originalFile: s.originalFile, structuredPatch: s.patch, userModified: false }));
    } else if (s.run) {
      L.push(call('Bash', { command: s.run }));
      L.push(result(s.stdout, { stdout: s.stdout, stderr: '', interrupted: false, isImage: false }));
    }
  }
  return L.join('');
}

const EDIT_A = { edit: 'src/a.js', old: EDIT_OLD, new: EDIT_NEW, originalFile: A_V1, patch: A_PATCH };
const WRITE_B = { write: 'src/b.js', content: B_V1 };
const RUN = { run: 'node --test', stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n' };

// Writes the main transcript where Claude Code would put it and returns its path.
function writeTranscript(repo, text, { sid = SID } = {}) {
  const dir = path.join(tmp, `projects-${n}`, encodeProjectDir(repo));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

function stopInput(repo, transcript, extra = {}) {
  return { session_id: SID, transcript_path: transcript, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, ...extra };
}

const NOW = new Date('2026-10-15T12:00:00Z');
function deps(extra = {}) {
  return { env: {}, now: () => NOW, stderr: { write() {} }, ...extra };
}

function parsed(r) {
  assert.equal(r.exitCode, 0);
  assert.ok(!FORBIDDEN.test(r.stdout), `hook output follows the vocabulary rule: ${r.stdout}`);
  if (!r.stdout) return null;
  assert.match(r.stdout, /^\{[\s\S]*\}\n$/, 'one JSON object');
  return JSON.parse(r.stdout);
}

test('parseStdin: empty, not JSON, array, object', () => {
  assert.equal(parseStdin(''), null);
  assert.equal(parseStdin('   \n'), null);
  assert.equal(parseStdin('nope'), null);
  assert.equal(parseStdin('[1]'), null);
  assert.equal(parseStdin(undefined), null);
  assert.deepEqual(parseStdin('{"a":1}'), { a: 1 });
});

test('formatEditTime: today prints the time, another day adds the date', () => {
  assert.equal(formatEditTime('2026-10-15T10:31:07.000Z', NOW), '10:31:07 UTC');
  assert.equal(formatEditTime('2026-10-14T23:59:59.000Z', NOW), '2026-10-14 23:59:59 UTC');
  assert.equal(formatEditTime('garbage', NOW), 'garbage');
});

test('formatUnrun: singular, plural, file-level marker, block closing line, cap', () => {
  const one = formatUnrun([{ id: 'src/x.js:4', lastEdit: '2026-10-15T10:31:07Z', fileLevel: false }], { now: NOW });
  assert.equal(one, 'hunkproof: 1 hunk edited in this session has no run after its last edit\n  src/x.js:4  edited 10:31:07 UTC  no run after');
  const two = formatUnrun([
    { id: 'src/x.js:4', lastEdit: '2026-10-15T10:31:07Z', fileLevel: false },
    { id: 'docs/readme.md:1', lastEdit: '2026-10-15T10:33:50Z', fileLevel: true },
  ], { now: NOW, mode: 'block' });
  const lines = two.split('\n');
  assert.equal(lines[0], 'hunkproof: 2 hunks edited in this session have no run after their last edit');
  assert.equal(lines[1], '  src/x.js:4        edited 10:31:07 UTC  no run after');
  assert.equal(lines[2], '  docs/readme.md:1  edited 10:33:50 UTC  no run after (file-level)');
  assert.equal(lines[3], "Run the project's check for these files, then stop again.");
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `src/f${String(i + 1).padStart(2, '0')}.js:1`, lastEdit: '2026-10-15T10:00:00Z', fileLevel: false }));
  const many = formatUnrun(rows, { now: NOW }).split('\n');
  assert.equal(many.length, 1 + MAX_LINES + 1);
  assert.equal(many[many.length - 1], '  +2 more');
  assert.ok(!FORBIDDEN.test(one + two + many.join('\n')));
});

test('silent exit 0: bad stdin, other event, mode off, not a git repo, no base ref, empty diff, missing transcript', async () => {
  const repo = makeRepo();
  const transcript = writeTranscript(repo, synth(repo, [WRITE_B, { min: 2, ...EDIT_A }].map((s, i) => ({ min: i * 2 + 1, ...s }))));
  const silent = async (input, d = deps()) => {
    const r = await stopHook(input, d);
    assert.deepEqual(r, { stdout: '', exitCode: 0 });
  };
  await silent(null);
  await silent('not an object');
  await silent(stopInput(repo, transcript, { hook_event_name: 'PreToolUse' }));
  await silent(stopInput(repo, transcript), deps({ env: { HUNKPROOF_STOP: 'off' } }));
  const notRepo = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(notRepo, { recursive: true });
  await silent(stopInput(notRepo, transcript));
  const trunk = makeRepo({ branch: 'trunk' });
  await silent(stopInput(trunk, transcript));
  const clean = makeRepo({ edits: false });
  await silent(stopInput(clean, transcript));
  await silent(stopInput(repo, path.join(tmp, 'missing.jsonl')));
  await silent(stopInput(repo, transcript, { transcript_path: 42 }));
});

test('every hunk has a run after its last edit: silent', async () => {
  const repo = makeRepo();
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...WRITE_B }, { min: 3, ...EDIT_A }, { min: 5, ...RUN }]));
  const r = await stopHook(stopInput(repo, transcript), deps());
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
});

test('two unrun hunks (one in an untracked file): systemMessage names them, no decision', async () => {
  const repo = makeRepo();
  const base = Date.parse('2026-10-15T10:00:00Z');
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...RUN }, { min: 3, ...WRITE_B }, { min: 5, ...EDIT_A }], { base }));
  const r = await stopHook(stopInput(repo, transcript), deps());
  const out = parsed(r);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  const lines = out.systemMessage.split('\n');
  assert.equal(lines[0], 'hunkproof: 2 hunks edited in this session have no run after their last edit');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^  src\/a\.js:4\s+edited 10:05:00 UTC  no run after$/);
  assert.match(lines[2], /^  src\/b\.js:1\s+edited 10:03:00 UTC  no run after$/);
  assert.ok(!fs.existsSync(path.join(repo, '.hunkproof')));
});

test('block mode: decision block with the reason; stop_hook_active true downgrades to a report; off wins over the flag', async () => {
  const repo = makeRepo();
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...RUN }, { min: 3, ...WRITE_B }, { min: 5, ...EDIT_A }]));
  let out = parsed(await stopHook(stopInput(repo, transcript), deps({ env: { HUNKPROOF_STOP: 'block' } })));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^hunkproof: 2 hunks edited in this session have no run after their last edit\n/);
  assert.match(out.reason, /src\/a\.js:4/);
  assert.match(out.reason, /then stop again\.$/);
  assert.equal(out.systemMessage, undefined);
  // the --mode flag works the same way, and the environment wins over it
  out = parsed(await stopHook(stopInput(repo, transcript), deps({ mode: 'block' })));
  assert.equal(out.decision, 'block');
  out = parsed(await stopHook(stopInput(repo, transcript), deps({ mode: 'block', env: { HUNKPROOF_STOP: 'report' } })));
  assert.equal(out.decision, undefined);
  assert.ok(out.systemMessage);
  assert.equal((await stopHook(stopInput(repo, transcript), deps({ mode: 'block', env: { HUNKPROOF_STOP: 'off' } }))).stdout, '');
  // already continuing because of a stop hook: never block again
  out = parsed(await stopHook(stopInput(repo, transcript, { stop_hook_active: true }), deps({ env: { HUNKPROOF_STOP: 'block' } })));
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /^hunkproof: 2 hunks/);
  assert.ok(!/then stop again/.test(out.systemMessage));
});

test('twelve unrun hunks: ten lines then +2 more', async () => {
  const repo = makeRepo({ edits: false });
  const steps = [{ min: 1, ...RUN }];
  for (let i = 1; i <= 12; i++) {
    const rel = `src/f${String(i).padStart(2, '0')}.js`;
    const content = `export const v${i} = ${i};\n`;
    fs.writeFileSync(path.join(repo, rel), content);
    steps.push({ min: 1 + i, write: rel, content });
  }
  const transcript = writeTranscript(repo, synth(repo, steps));
  const out = parsed(await stopHook(stopInput(repo, transcript), deps()));
  const lines = out.systemMessage.split('\n');
  assert.equal(lines[0], 'hunkproof: 12 hunks edited in this session have no run after their last edit');
  assert.equal(lines.length, 1 + MAX_LINES + 1);
  assert.equal(lines[lines.length - 1], '  +2 more');
  assert.match(lines[1], /^  src\/f01\.js:1\s/);
  assert.match(lines[10], /^  src\/f10\.js:1\s/);
});

test('subagent edit with no run is reported; a subagent that never mentions the repo is not read; the byte cap skips them all', async () => {
  const repo = makeRepo();
  // the main transcript only runs the suite, before the agents edit
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...RUN }]));
  const agents = path.join(path.dirname(transcript), SID, 'subagents', 'workflows', 'w1');
  fs.mkdirSync(agents, { recursive: true });
  const inRepo = path.join(agents, 'agent-x.jsonl');
  fs.writeFileSync(inRepo, synth(repo, [{ min: 3, ...WRITE_B }, { min: 5, ...EDIT_A }], { agentId: 'agent-x' }));
  const elsewhere = path.join(tmp, `elsewhere-${n}`);
  const outside = path.join(agents, 'agent-y.jsonl');
  fs.writeFileSync(outside, synth(elsewhere, [{ min: 4, write: 'x.js', content: 'export const x = 1;\n' }], { agentId: 'agent-y' }));
  const readPaths = [];
  const counting = async (p, o) => { readPaths.push(p); return readSession(p, o); };
  const out = parsed(await stopHook(stopInput(repo, transcript), deps({ readSession: counting })));
  assert.match(out.systemMessage, /^hunkproof: 2 hunks/);
  assert.match(out.systemMessage, /src\/a\.js:4/);
  assert.deepEqual(readPaths.sort(), [inRepo, transcript].sort(), 'the subagent transcript that never mentions the repo is not read');
  // with the cap at one byte, no subagent file fits: nothing left to report
  readPaths.length = 0;
  const r = await stopHook(stopInput(repo, transcript), deps({ readSession: counting, subagentBytesCap: 1 }));
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
  assert.deepEqual(readPaths, [transcript]);
});

test('an exception is silent exit 0; HUNKPROOF_DEBUG=1 writes the stack to stderr; git failing is silent', async () => {
  const repo = makeRepo();
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...RUN }, { min: 3, ...EDIT_A }]));
  const boom = () => { throw new Error('boom'); };
  let r = await stopHook(stopInput(repo, transcript), deps({ diffHunks: boom }));
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
  let err = '';
  r = await stopHook(stopInput(repo, transcript), deps({ diffHunks: boom, env: { HUNKPROOF_DEBUG: '1' }, stderr: { write(s) { err += s; } } }));
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
  assert.match(err, /hunkproof hook: Error: boom/);
  r = await stopHook(stopInput(repo, transcript), deps({ git: boom }));
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
  r = await stopHook(stopInput(repo, transcript), deps({ readSession: boom }));
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
});

test('cli: hook stop through runCli, unknown hook command, bad stdin', async () => {
  const repo = makeRepo();
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...RUN }, { min: 3, ...EDIT_A }]));
  const io = (text) => {
    const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough();
    let out = ''; let err = '';
    stdout.on('data', (d) => { out += d; }); stderr.on('data', (d) => { err += d; });
    stdin.end(text);
    return { streams: { stdout, stderr, stdin }, out: () => out, err: () => err };
  };
  let r = io(JSON.stringify(stopInput(repo, transcript)));
  const saved = process.env.HUNKPROOF_STOP;
  delete process.env.HUNKPROOF_STOP;
  try {
    assert.equal(await runCli(['hook', 'stop'], r.streams), 0);
    assert.match(JSON.parse(r.out()).systemMessage, /^hunkproof: 1 hunk edited in this session has no run after its last edit\n  src\/a\.js:4/);
    r = io(JSON.stringify(stopInput(repo, transcript)));
    assert.equal(await runCli(['hook', 'stop', '--mode', 'block'], r.streams), 0);
    assert.equal(JSON.parse(r.out()).decision, 'block');
  } finally {
    if (saved !== undefined) process.env.HUNKPROOF_STOP = saved;
  }
  r = io('not json');
  assert.equal(await runCli(['hook', 'stop'], r.streams), 0);
  assert.equal(r.out(), '');
  r = io('');
  assert.equal(await runCli(['hook', 'frob'], r.streams), 1);
  assert.match(r.err(), /unknown hook command/);
});

test('integration: the real bin with the Stop JSON on stdin writes one JSON object, no .hunkproof/, no git note', () => {
  const repo = makeRepo();
  const transcript = writeTranscript(repo, synth(repo, [{ min: 1, ...RUN }, { min: 3, ...WRITE_B }, { min: 5, ...EDIT_A }]));
  const env = { ...process.env };
  delete env.HUNKPROOF_STOP;
  delete env.HUNKPROOF_BASE;
  const run = (extraEnv = {}) => spawnSync(process.execPath, [BIN, 'hook', 'stop'], {
    cwd: repo, input: JSON.stringify(stopInput(repo, transcript)), encoding: 'utf8', env: { ...env, ...extraEnv },
  });
  let p = run();
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stderr, '');
  assert.match(p.stdout, /^\{[\s\S]*\}\n$/);
  const out = JSON.parse(p.stdout);
  assert.match(out.systemMessage, /^hunkproof: 2 hunks edited in this session have no run after their last edit\n  src\/a\.js:4 .*\n  src\/b\.js:1 /);
  assert.ok(!FORBIDDEN.test(p.stdout));
  p = run({ HUNKPROOF_STOP: 'block' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).decision, 'block');
  p = run({ HUNKPROOF_STOP: 'off' });
  assert.equal(p.status, 0);
  assert.equal(p.stdout, '');
  assert.ok(!fs.existsSync(path.join(repo, '.hunkproof')), 'the hook writes no .hunkproof/');
  assert.equal(gitIn(repo, ['notes', '--ref=hunkproof', 'list']), '', 'the hook writes no git note');
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  assert.deepEqual(status.split('\0').filter(Boolean).sort(), [' M src/a.js', '?? src/b.js'], 'the working tree and the index are untouched');
});

test('hooks/hooks.json: wrapped in "hooks", one Stop command hook calling bin/hunkproof.js hook stop; plugin manifest leaves it at the default location', () => {
  const root = path.join(here, '..');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg), ['hooks']);
  assert.deepEqual(Object.keys(cfg.hooks), ['Stop']);
  assert.equal(cfg.hooks.Stop.length, 1);
  const [matcher] = cfg.hooks.Stop;
  assert.equal(matcher.hooks.length, 1);
  const hook = matcher.hooks[0];
  assert.equal(hook.type, 'command');
  assert.equal(hook.command, 'node');
  assert.equal(hook.args[0], '${CLAUDE_PLUGIN_ROOT}/bin/hunkproof.js');
  assert.deepEqual(hook.args.slice(1), ['hook', 'stop']);
  assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0 && hook.timeout <= 60);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks, undefined, 'hooks/hooks.json is loaded by default; declaring it again would merge it with itself');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('hooks'), 'npm users get hooks/hooks.json to copy from');
  assert.ok(!FORBIDDEN.test(fs.readFileSync(path.join(root, 'src', 'hook.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/[.\w-]+\.test\.js/g, '')));
});

test('claude plugin validate passes when the claude binary is available', (t) => {
  const which = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (which.error || which.status !== 0) { t.skip('claude not on PATH'); return; }
  const p = spawnSync('claude', ['plugin', 'validate', path.join(here, '..')], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stdout + p.stderr);
});
