// src/runs.js: classify Bash commands as runs, parse runner output, attach runs to hunks.
//
// Facts checked against local Claude Code transcripts (versions 2.1.228-2.1.299):
// - one tool_use per JSONL line, each with its own timestamp, so "run after edit" is a strict ts comparison;
// - a failed Bash call stores toolUseResult as the string "Error: Exit code N\n<merged output>" and the
//   tool_result block carries is_error: true; a successful call stores { stdout, stderr, interrupted, ... };
// - runner output keeps ANSI escapes (vitest colours its summary) and Claude Code appends
//   "Shell cwd was reset to ..." to stdout, so parsers strip both;
// - commands routinely carry heredoc bodies (python3 - <<'EOF' ...) that mention runner names, so heredoc
//   bodies are cut out before any segment is classified.

import path from 'node:path';
import { commandNamesFile } from './transcript.js';

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// hunkproof's own invocations (node bin/hunkproof.js, npx hunkproof, ./bin/hunkproof.js) are never runs of the project.
const SELF_RE = /(^|\/)hunkproof(\.m?js)?$/;
const CWD_RESET_RE = /\n*Shell cwd was reset to [^\n]*\n*$/;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// Command normalisation
// ---------------------------------------------------------------------------

// Inline programs (python3 -c "...", node -e '...') and wrapped shells (bash -c "...") may span lines and
// contain shell-looking text; replace the quoted body by a marker and keep it aside. A program body is only
// scanned for file writes; a shell body is classified recursively as a command of its own.
const INLINE_CODE_RE = /(\b(?:python[\d.]*|node|nodejs|ruby|perl|bash|sh|zsh)\s+(?:-[A-Za-z]+\s+)*(?:-c|-e|--eval))\s+("(?:[^"\\]|\\[\s\S])*"|'[^']*')/g;

// Replace every heredoc body (and inline -c/-e body) by a marker; return the stripped text and the bodies
// as { kind: 'program'|'shell', code }.
function stripHeredocs(command) {
  const bodies = [];
  const inlineStripped = String(command).replace(INLINE_CODE_RE, (m, head, code) => {
    const kind = /^(?:bash|sh|zsh)\b/.test(head) ? 'shell' : 'program';
    bodies.push({ kind, code: code.slice(1, -1) });
    return `${head} <<INLINE`;
  });
  const lines = inlineStripped.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/<<-?\s*(?:'([A-Za-z_][\w]*)'|"([A-Za-z_][\w]*)"|([A-Za-z_][\w]*))/);
    if (!m || m[3] === 'INLINE') { out.push(line); i++; continue; }
    const tag = m[1] ?? m[2] ?? m[3];
    out.push(line.slice(0, m.index) + '<<HEREDOC' + line.slice(m.index + m[0].length));
    const body = [];
    i++;
    while (i < lines.length && lines[i].trim() !== tag) { body.push(lines[i]); i++; }
    bodies.push({ kind: 'program', code: body.join('\n') });
    i++; // skip terminator
  }
  return { text: out.join('\n'), bodies };
}

const SEGMENT_PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', '!', '{', '}', 'fi', 'done', 'exec', 'command', 'builtin']);

// Split on &&, ||, |, |&, ;, newline and " & " (background), honouring quotes:
// an operator inside '...', "..." or `...` is data (a grep alternation such as
// '^== (vitest|make)$' or an ssh payload 'cd x && ./deploy.sh' stays one
// segment). "2>&1" has no spaces around "&" so it survives.
export function splitSegments(text) {
  const src = String(text ?? '');
  const out = [];
  let cur = '';
  let quote = null; // "'" | '"' | '`' | null
  const n = src.length;
  const push = () => { out.push(cur); cur = ''; };
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote !== "'" && i + 1 < n) { cur += src[i + 1]; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < n) { cur += ch + src[i + 1]; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '\n' || ch === ';') { push(); continue; }
    if (ch === '|') {
      if (src[i + 1] === '|' || src[i + 1] === '&') i++;
      push();
      continue;
    }
    if (ch === '&') {
      if (src[i + 1] === '&') { i++; push(); continue; }
      const prev = src[i - 1];
      const next = src[i + 1];
      // "2>&1", ">&2", "&>file" are redirections, not a background operator
      if (prev === '>' || next === '>') { cur += ch; continue; }
      if ((i === 0 || /\s/.test(prev)) && (next === undefined || /\s/.test(next))) { push(); continue; }
      cur += ch;
      continue;
    }
    cur += ch;
  }
  push();
  return out
    .map((s) => s.trim())
    .map((s) => s.replace(/^(?:[A-Za-z_]\w*=\$\(|\$\(|\()+/, '').replace(/\)+$/, '').trim())
    .filter(Boolean);
}

// Tokenise respecting simple quotes (good enough for shell commands as written by agents).
function tokenize(segment) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) {
    if (m[1] !== undefined) tokens.push({ raw: m[0], value: m[1], quoted: true });
    else if (m[2] !== undefined) tokens.push({ raw: m[0], value: m[2], quoted: true });
    else tokens.push({ raw: m[0], value: m[3], quoted: false });
  }
  return tokens;
}

const ENV_ASSIGN_RE = /^[A-Za-z_]\w*=/;
const WRAPPERS_SIMPLE = new Set(['time', 'env', 'nice', 'nohup', 'sudo', 'stdbuf', 'unbuffer', 'script']);
const RUNNER_BINS = new Set([
  'pytest', 'py.test', 'jest', 'vitest', 'mocha', 'tsc', 'ruff', 'eslint', 'mypy', 'pyright',
  'go', 'cargo', 'make', 'npm', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'tsx', 'ts-node', 'bash', 'sh', 'zsh',
  'unittest', 'tox', 'nox', 'coverage', 'flake8', 'pylint', 'black', 'biome', 'prettier',
]);

function basenameNoVersion(word) {
  let b = word;
  if (b.includes('/')) b = path.posix.basename(b);
  b = b.replace(/@[^@]*$/, ''); // ruff@0.14.3 -> ruff
  return b;
}

function isPythonBin(b) { return /^python(\d+(\.\d+)?)?$/.test(b) || b === 'py'; }
function isNodeBin(b) { return b === 'node' || b === 'nodejs'; }

// Drop wrapper prefixes (env assignments, timeout 60, npx, uv run, poetry run, pnpm exec ...) until a real program.
function stripPrefixes(tokens) {
  let t = tokens.slice();
  for (let guard = 0; guard < 20 && t.length; guard++) {
    const v = t[0].value;
    if (!t[0].quoted && (SEGMENT_PREFIX_WORDS.has(v))) { t.shift(); continue; }
    if (!t[0].quoted && ENV_ASSIGN_RE.test(v)) { t.shift(); continue; }
    const b = basenameNoVersion(v);
    if (b === 'timeout') {
      t.shift();
      while (t.length && (t[0].value.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(t[0].value))) t.shift();
      continue;
    }
    if (WRAPPERS_SIMPLE.has(b)) {
      t.shift();
      while (t.length && (t[0].value.startsWith('-') || ENV_ASSIGN_RE.test(t[0].value))) t.shift();
      continue;
    }
    if (b === 'npx' || b === 'bunx' || b === 'pnpx' || b === 'uvx') {
      t.shift();
      while (t.length && t[0].value.startsWith('-')) {
        const flag = t.shift().value;
        if ((flag === '-p' || flag === '--package') && t.length) t.shift();
      }
      continue;
    }
    if ((b === 'pnpm' || b === 'yarn' || b === 'bun') && t[1] && (t[1].value === 'exec' || t[1].value === 'dlx' || t[1].value === 'x')) { t.splice(0, 2); continue; }
    if (b === 'yarn' && t[1] && RUNNER_BINS.has(basenameNoVersion(t[1].value)) && !['run', 'test', 'build', 'lint'].includes(t[1].value)) { t.shift(); continue; }
    if ((b === 'uv' || b === 'poetry' || b === 'pipenv' || b === 'hatch' || b === 'pdm' || b === 'rye') && t[1] && t[1].value === 'run') { t.splice(0, 2); continue; }
    if (b === 'conda' && t[1] && t[1].value === 'run') {
      t.splice(0, 2);
      while (t.length && t[0].value.startsWith('-')) { const f = t.shift().value; if ((f === '-n' || f === '-p' || f === '--name' || f === '--prefix') && t.length) t.shift(); }
      continue;
    }
    if (b === 'coverage' && t[1] && t[1].value === 'run') { t.splice(0, 2); if (t[0] && t[0].value === '-m') t.shift(); continue; }
    break;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Runner detection per segment
// ---------------------------------------------------------------------------

const PY_MODULE_RUNNERS = { pytest: 'pytest', unittest: 'unittest', mypy: 'mypy', ruff: 'ruff', pyright: 'pyright', flake8: 'flake8', pylint: 'pylint', tox: 'tox', nox: 'nox', doctest: 'python', black: 'black' };
const NPM_SCRIPT_WORDS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'test:unit', 'test:e2e', 'test:ci', 'lint:fix', 'type-check', 'tsc', 'ci', 'verify', 'validate', 'coverage']);
const GO_SUBCOMMANDS = new Set(['test', 'build', 'vet', 'run']);
const CARGO_SUBCOMMANDS = new Set(['test', 'check', 'clippy', 'build', 'run', 'nextest']);
const PATHLIKE_RE = /^(\.{1,2}\/|\/|~\/|[\w@().-]+\/|[\w@()-]+\.[A-Za-z]{1,6}($|:))/;

function looksLikePath(v) {
  if (!v || v.startsWith('-') || v.includes('=')) return false;
  if (v === './...' || v === '...' || v === '.' || v === '2>&1') return false;
  return PATHLIKE_RE.test(v);
}

// Flags whose next token is a value (config files, reporters...), never a target.
const VALUE_FLAGS = new Set(['--config', '-c', '--rootdir', '-p', '--project', '--reporter', '--test-reporter', '--test-reporter-destination', '-o', '--out', '--outDir', '--output', '--env-file', '--timeout', '--maxWorkers', '--pool', '-n', '--dist', '-W', '--ignore', '--exclude', '--ext', '--parser', '--format', '-f', '--run', '--bench', '--testTimeout', '--retry', '--shard', '--coverage-dir', '--cache-location', '--resolve-plugins-relative-to', '--rulesdir', '--target-version', '--line-length', '--python-version', '--pythonpath', '--import', '--require', '-r', '--loader', '--conditions', '--tags', '--run', '-run', '-bench', '-count', '-timeout', '-cpu', '--features', '--target', '--package', '--bin', '--example', '--manifest-path', '-j', '--jobs']);
const STEM_FLAGS = new Set(['-k', '-t', '--testNamePattern', '-g', '--grep', '--test-name-pattern', '-run']);

function cleanToken(v) {
  return v.replace(/^\(+/, '').replace(/\)+$/, '');
}

// Collect path/stem-like arguments after the runner word (stop at redirections).
function collectTargets(tokens, { allowStems = false } = {}) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = cleanToken(tokens[i].value);
    if (/^\d?>{1,2}/.test(v) || v === '<' || v === '<<HEREDOC' || v === '<<INLINE') break;
    if (v === '--') continue;
    if (allowStems && STEM_FLAGS.has(v) && tokens[i + 1]) { targets.push(cleanToken(tokens[i + 1].value)); i++; continue; }
    if (VALUE_FLAGS.has(v) && tokens[i + 1] && !tokens[i + 1].value.startsWith('-')) { i++; continue; }
    if (v.startsWith('-')) continue;
    if (looksLikePath(v)) targets.push(v.replace(/::.*$/, '').replace(/:\d+(:\d+)?$/, ''));
  }
  return [...new Set(targets)];
}

// Returns { runner, targets, writes } for one segment, or null when it is not a runner.
function classifySegment(segment, ctx) {
  const tokens = stripPrefixes(tokenize(segment));
  if (!tokens.length) return null;
  const first = tokens[0].value;
  const b = basenameNoVersion(first);
  const rest = tokens.slice(1);
  const sub = rest[0]?.value;

  if (b === 'pytest' || b === 'py.test') return { runner: 'pytest', targets: collectTargets(rest, { allowStems: true }) };
  if (b === 'jest') return { runner: 'jest', targets: collectTargets(rest, { allowStems: true }) };
  if (b === 'vitest') return { runner: 'vitest', targets: collectTargets(sub === 'run' || sub === 'watch' || sub === 'related' ? rest.slice(1) : rest, { allowStems: true }) };
  if (b === 'mocha') return { runner: 'mocha', targets: collectTargets(rest, { allowStems: true }) };
  if (b === 'tsc') return { runner: 'tsc', targets: collectTargets(rest) };
  if (b === 'ruff') {
    const writes = sub === 'format' && !rest.some((t) => t.value === '--check' || t.value === '--diff');
    const fix = rest.some((t) => t.value === '--fix' || t.value === '--unsafe-fixes');
    return { runner: 'ruff', targets: collectTargets(rest.slice(sub === 'check' || sub === 'format' ? 1 : 0)), writes: writes || fix };
  }
  if (b === 'eslint') return { runner: 'eslint', targets: collectTargets(rest), writes: rest.some((t) => t.value === '--fix') };
  if (b === 'biome') return { runner: 'biome', targets: collectTargets(rest.slice(1)), writes: rest.some((t) => t.value === '--write' || t.value === '--apply') };
  if (b === 'prettier') {
    if (rest.some((t) => t.value === '--write' || t.value === '-w')) return { runner: 'prettier', targets: collectTargets(rest), writes: true };
    return rest.some((t) => t.value === '--check' || t.value === '-c' || t.value === '--list-different' || t.value === '-l') ? { runner: 'prettier', targets: collectTargets(rest) } : null;
  }
  if (b === 'mypy') return { runner: 'mypy', targets: collectTargets(rest) };
  if (b === 'pyright') return { runner: 'pyright', targets: collectTargets(rest) };
  if (b === 'flake8' || b === 'pylint') return { runner: b, targets: collectTargets(rest) };
  if (b === 'black') return rest.some((t) => t.value === '--check' || t.value === '--diff') ? { runner: 'black', targets: collectTargets(rest) } : { runner: 'black', targets: collectTargets(rest), writes: true };
  if (b === 'tox' || b === 'nox') return { runner: b, targets: [] };
  if (b === 'go' && GO_SUBCOMMANDS.has(sub)) return { runner: 'go', targets: collectTargets(rest.slice(1), { allowStems: sub === 'test' }) };
  if (b === 'cargo' && CARGO_SUBCOMMANDS.has(sub)) return { runner: 'cargo', targets: collectTargets(rest.slice(1)) };
  if (b === 'make' || b === 'gmake') {
    const targets = rest.map((t) => t.value).filter((v) => !v.startsWith('-') && !v.includes('=') && !/^\d?>{1,2}/.test(v));
    return { runner: 'make', targets: [], makeTargets: targets };
  }
  if (b === 'npm' || b === 'pnpm' || b === 'yarn' || b === 'bun') {
    let script = null; let argsStart = 1;
    if (sub === 'run' || sub === 'run-script') { script = rest[1]?.value ?? null; argsStart = 2; }
    else if (sub === 't' || sub === 'tst') { script = 'test'; }
    else if (sub && (NPM_SCRIPT_WORDS.has(sub) || Object.hasOwn(ctx.packageScripts, sub))) { script = sub; }
    if (!script) return null;
    if (b === 'bun' && script === 'test' && !Object.hasOwn(ctx.packageScripts, 'test')) return { runner: 'bun', targets: collectTargets(rest.slice(argsStart), { allowStems: true }) };
    const body = ctx.packageScripts[script];
    const knownWord = /^(test|build|lint|typecheck|check|type-check|ci|verify|validate|coverage|tsc)(\W|$)/.test(script);
    let runner = null;
    if (typeof body === 'string' && body.trim()) {
      const inner = classifyRun(body, { ...ctx, packageScripts: {} });
      if (inner.runner) runner = inner.runner;
      else if (knownWord) runner = 'npm'; // script exists but runs something we do not parse (e.g. next build)
    } else if (knownWord) {
      runner = 'npm';
    }
    if (!runner) return null;
    return { runner, targets: collectTargets(rest.slice(argsStart), { allowStems: true }), script };
  }
  if (isPythonBin(b)) {
    const args = rest.slice();
    while (args.length && args[0].value.startsWith('-') && args[0].value !== '-m' && args[0].value !== '-c' && args[0].value !== '-') {
      const f = args.shift().value;
      if ((f === '-W' || f === '-X') && args.length) args.shift();
    }
    if (!args.length) return null;
    if (args[0].value === '-m') {
      const mod = args[1]?.value;
      if (mod && Object.hasOwn(PY_MODULE_RUNNERS, mod)) return { runner: PY_MODULE_RUNNERS[mod], targets: collectTargets(args.slice(2), { allowStems: mod === 'pytest' }) };
      return null;
    }
    if (args[0].value === '-c' || args[0].value === '-') return null; // inline code or stdin: not a run of a project file
    const script = args[0].value;
    if (/\.py$/.test(script)) return { runner: 'python', targets: [script, ...collectTargets(args.slice(1))] };
    const sb = basenameNoVersion(script);
    if (Object.hasOwn(PY_MODULE_RUNNERS, sb)) return { runner: PY_MODULE_RUNNERS[sb], targets: collectTargets(args.slice(1), { allowStems: true }) };
    return null;
  }
  if (isNodeBin(b) || b === 'tsx' || b === 'ts-node' || b === 'deno' || b === 'bun-run') {
    const args = rest.slice();
    if (args.some((t) => t.value === '--test')) {
      return { runner: 'node:test', targets: collectTargets(args.filter((t) => t.value !== '--test'), { allowStems: true }) };
    }
    while (args.length && args[0].value.startsWith('-')) {
      const f = args.shift().value;
      if (f === '-e' || f === '-p' || f === '--eval' || f === '--print') return null; // inline code
      if ((f === '-r' || f === '--require' || f === '--import' || f === '--loader') && args.length) args.shift();
    }
    if (!args.length) return null;
    const script = args[0].value;
    if (SELF_RE.test(script)) return null;
    const sb = basenameNoVersion(script).replace(/\.(m?js|cjs|ts)$/, '');
    if (/node_modules\/(\.bin\/)?(vitest|jest|mocha|tsc|eslint|typescript)/.test(script) || RUNNER_BINS.has(sb)) {
      return classifySegment([script, ...args.slice(1).map((t) => t.raw)].join(' '), ctx);
    }
    if (/\.(m?js|cjs|ts|mts|cts|tsx|jsx)$/.test(script)) return { runner: 'node', targets: [script, ...collectTargets(args.slice(1))] };
    return null;
  }
  if (b === 'bash' || b === 'sh' || b === 'zsh') {
    const args = rest.filter((t) => !t.value.startsWith('-'));
    const script = args[0]?.value;
    if (script && /\.(sh|bash)$/.test(script)) return { runner: 'script', targets: [script, ...collectTargets(args.slice(1))] };
    return null;
  }
  if (SELF_RE.test(first)) return null;
  if (/^\.{1,2}\/.*\.(sh|bash|py|js|mjs)$/.test(first) || /^\.{1,2}\/[\w./-]+$/.test(first) && !first.includes('node_modules')) {
    if (/\.py$/.test(first)) return { runner: 'python', targets: [first, ...collectTargets(rest)] };
    if (/\.(m?js|cjs)$/.test(first)) return { runner: 'node', targets: [first, ...collectTargets(rest)] };
    return { runner: 'script', targets: [first, ...collectTargets(rest)] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write detection
// ---------------------------------------------------------------------------

const GIT_WRITE_SUBCOMMANDS = new Set(['commit', 'apply', 'am', 'cherry-pick', 'revert', 'merge', 'rebase', 'pull', 'stash', 'checkout', 'switch', 'reset', 'restore', 'mv', 'rm', 'clean']);
const INLINE_WRITE_RE = /open\([^)]*,\s*['"](?:w|a|r\+|wb|ab|x)['"]|\.write_text\(|\.write_bytes\(|writeFile(?:Sync)?\(|appendFile(?:Sync)?\(|\.unlink\(|os\.remove\(|shutil\.(?:move|copy)|rename\(/;

function segmentWrites(segment, runnerInfo) {
  const tokens = stripPrefixes(tokenize(segment));
  if (!tokens.length) return false;
  const b = basenameNoVersion(tokens[0].value);
  const vals = tokens.map((t) => t.value);
  if (b === 'sed' && vals.some((v) => /^-[a-zA-Z]*i/.test(v) || v === '--in-place' || v.startsWith('--in-place='))) return true;
  if (b === 'perl' && vals.some((v) => /^-[a-zA-Z]*i/.test(v))) return true;
  if (b === 'tee') return !vals.slice(1).every((v) => v.startsWith('-') || v === '/dev/null');
  if (b === 'git' && vals[1] && GIT_WRITE_SUBCOMMANDS.has(vals[1])) {
    if (vals[1] === 'stash' && (vals[2] === 'list' || vals[2] === 'show')) return false;
    if (vals[1] === 'checkout' && vals.includes('--') === false && vals[2] === undefined) return false;
    return true;
  }
  if (b === 'mv' || b === 'cp' || b === 'install' || b === 'rsync' || b === 'truncate' || b === 'patch') return true;
  if (b === 'touch' || b === 'ln') return true;
  if ((b === 'python' || b === 'python3' || isPythonBin(b)) && (vals.includes('-c'))) {
    return INLINE_WRITE_RE.test(segment);
  }
  if ((isNodeBin(b)) && (vals.includes('-e') || vals.includes('--eval'))) return INLINE_WRITE_RE.test(segment);
  if (runnerInfo?.writes) return true;
  // Redirection to a real file. A runner's own log capture (pytest > out.log 2>&1) is not an edit.
  const redirect = segment.match(/(?:^|[^0-9&>])(?:\d?>{1,2}|&>)\s*([^\s&|;)]+)/g);
  if (redirect && !runnerInfo) {
    for (const r of redirect) {
      const target = r.replace(/^.*?(?:\d?>{1,2}|&>)\s*/, '');
      if (target === '/dev/null' || target.startsWith('&') || target.startsWith('(') || target === '') continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public: classifyRun
// ---------------------------------------------------------------------------

export function classifyRun(command, { repoRoot = null, packageScripts = {}, makeTargets = [] } = {}) {
  const ctx = { repoRoot, packageScripts: packageScripts || {}, makeTargets: makeTargets || [] };
  const { text, bodies } = stripHeredocs(String(command ?? ''));
  const segments = splitSegments(text);
  let runner = null;
  let targets = [];
  let writes = false;
  // silentOk: an empty stdout with a zero exit may be read as a pass only when
  // the runner is the LAST segment and its stdout is not redirected to a file
  // (`verify.sh > log; echo exit $?` has the exit code and output of `echo`).
  let silentOk = false;
  let lastRunnerIndex = -1;
  let runnerRedirected = false;
  const merge = (info) => {
    if (!info || !info.runner) return;
    if (!runner) runner = info.runner;
    else if (runner !== info.runner) runner = [...new Set(`${runner}+${info.runner}`.split('+'))].join('+');
    targets = [...new Set([...targets, ...(info.targets ?? [])])];
  };
  segments.forEach((segment, i) => {
    const info = classifySegment(segment, ctx);
    merge(info);
    if (info && info.runner) {
      lastRunnerIndex = i;
      if (STDOUT_TO_FILE_RE.test(segment)) runnerRedirected = true;
    }
    if (segmentWrites(segment, info)) writes = true;
  });
  for (const body of bodies) {
    if (body.kind === 'shell') {
      // bash -c "...": the wrapped command is a command of its own
      const inner = classifyRun(body.code, ctx);
      merge(inner);
      if (inner.writes) writes = true;
      if (inner.runner && inner.silentOk) {
        const at = segments.findIndex((s) => s.includes('<<INLINE'));
        if (at > lastRunnerIndex) lastRunnerIndex = at;
      }
    } else if (INLINE_WRITE_RE.test(body.code)) {
      // python/node program bodies that open a file for writing; `cat > path <<EOF` is caught by the header's redirect
      writes = true;
    }
  }
  silentOk = Boolean(runner) && lastRunnerIndex === segments.length - 1 && !runnerRedirected;
  return { isRun: Boolean(runner) && !writes, runner, writes, targets, silentOk };
}

// stdout redirected to a real file (not /dev/null, not to another fd)
const STDOUT_TO_FILE_RE = /(?:^|[^0-9&>])(?:1?>{1,2}|&>{1,2})\s*(?!\/dev\/null\b|&|\(|\s|$)[^\s&|;)]+/;

// ---------------------------------------------------------------------------
// Outcome parsers
// ---------------------------------------------------------------------------

function lastMatch(re, text) {
  let m; let last = null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(text))) { last = m; if (m[0] === '') g.lastIndex++; }
  return last;
}

const PARSERS = {
  pytest(t) {
    const m = lastMatch(/^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?|rerun|subtests? passed)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?/m, t);
    if (m) {
      const s = m[1];
      const fail = /\b\d+ (?:failed|errors?)\b/.test(s) && !/^(?:0 failed|0 errors?)$/.test(s);
      return { outcome: fail ? 'fail' : 'pass', summary: `pytest: ${s}` };
    }
    if (/^no tests ran in [\d.]+s/m.test(t) || /=+ no tests ran/.test(t)) return { outcome: 'unparsed', summary: 'pytest: no tests ran' };
    if (/^ImportError while loading conftest|^ERROR: (?:usage|file or directory not found|not found)/m.test(t) || /^E\s+\w*Error\b/m.test(t)) return { outcome: 'fail', summary: 'pytest: collection error' };
    return null;
  },
  unittest(t) {
    const m = lastMatch(/^Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK|FAILED)([^\n]*)/m, t);
    if (!m) return null;
    return { outcome: m[2] === 'OK' ? 'pass' : 'fail', summary: `unittest: ran ${m[1]}, ${m[2]}${m[3].trim()}` };
  },
  jest(t) {
    const m = lastMatch(/^Tests:\s+([^\n]*\d+ total)/m, t);
    const suites = lastMatch(/^Test Suites:\s+([^\n]*\d+ total)/m, t);
    if (!m && !suites) return null;
    const line = m ? m[1] : suites[1];
    const fail = /\b[1-9]\d* failed\b/.test(line) || (suites && /\b[1-9]\d* failed\b/.test(suites[1]));
    return { outcome: fail ? 'fail' : 'pass', summary: `jest: ${line.trim()}` };
  },
  vitest(t) {
    const tests = lastMatch(/^\s*Tests\s+([^\n]*?)\s*$/m, t);
    const files = lastMatch(/^\s*Test Files\s+([^\n]*?)\s*$/m, t);
    if (!tests && !files) return null;
    const testsLine = tests ? tests[1] : '';
    const filesLine = files ? files[1] : '';
    const fail = /\b[1-9]\d* failed\b/.test(testsLine) || /\b[1-9]\d* failed\b/.test(filesLine);
    if (!fail && !/\b\d+ passed\b/.test(testsLine) && !/\b\d+ passed\b/.test(filesLine)) return { outcome: 'unparsed', summary: `vitest: ${testsLine || filesLine}` };
    return { outcome: fail ? 'fail' : 'pass', summary: `vitest: ${[testsLine && `Tests ${testsLine}`, filesLine && `Test Files ${filesLine}`].filter(Boolean).join('; ')}` };
  },
  mocha(t) {
    const p = lastMatch(/^\s*(\d+) passing(?: \([^)]*\))?/m, t);
    const f = lastMatch(/^\s*(\d+) failing/m, t);
    if (!p && !f) return null;
    const failing = f ? Number(f[1]) : 0;
    return { outcome: failing > 0 ? 'fail' : 'pass', summary: `mocha: ${p ? p[1] : 0} passing, ${failing} failing` };
  },
  'node:test'(t) {
    const p = lastMatch(/^(?:#|ℹ) pass (\d+)/m, t);
    const f = lastMatch(/^(?:#|ℹ) fail (\d+)/m, t);
    const c = lastMatch(/^(?:#|ℹ) cancelled (\d+)/m, t);
    if (!p && !f) {
      if (/^not ok \d+/m.test(t)) return { outcome: 'fail', summary: 'node --test: not ok' };
      return null;
    }
    const failed = (f ? Number(f[1]) : 0) + (c ? Number(c[1]) : 0);
    const cancelled = c && Number(c[1]) ? `, cancelled ${c[1]}` : '';
    // `| tail -5` cuts the `# pass N` line but keeps `# fail 0`: say that the
    // count is missing instead of printing a pass count of 0
    const pass = p ? `pass ${p[1]}` : 'pass count not in output';
    return { outcome: failed > 0 ? 'fail' : 'pass', summary: `node --test: ${pass}, fail ${f ? f[1] : 0}${cancelled}` };
  },
  go(t) {
    const fail = /^(?:--- FAIL:|FAIL\s+\S+(?:\s+[\d.]+s|\s+\[build failed\])?$|FAIL$)/m.test(t) || /^# [\w./-]+\n(?:[\w./-]+\.go:\d+:\d+: )/m.test(t) || /^[\w./-]+\.go:\d+:\d+: /m.test(t);
    const ok = lastMatch(/^(?:ok\s+(\S+)\s+(?:[\d.]+s|\(cached\))|PASS)$/m, t);
    if (!fail && !ok) return null;
    if (fail) {
      const f = lastMatch(/^--- FAIL: (\S+)/m, t) || lastMatch(/^FAIL\s+(\S+)/m, t);
      return { outcome: 'fail', summary: `go: FAIL${f ? ` ${f[1]}` : ''}` };
    }
    const n = (t.match(/^ok\s+\S+/mg) || []).length;
    return { outcome: 'pass', summary: `go: ok${n ? ` (${n} package${n === 1 ? '' : 's'})` : ''}` };
  },
  cargo(t) {
    const results = t.match(/^test result: (ok|FAILED)\. [^\n]*/mg);
    if (/^error\[E\d+\]|^error: could not compile|^error: aborting/m.test(t)) {
      const m = t.match(/^error\[E\d+\][^\n]*/m);
      return { outcome: 'fail', summary: `cargo: ${m ? m[0].slice(0, 120) : 'build error'}` };
    }
    if (results) {
      const fail = results.some((r) => r.startsWith('test result: FAILED'));
      return { outcome: fail ? 'fail' : 'pass', summary: `cargo: ${results[results.length - 1]}` };
    }
    if (/^\s*Finished [^\n]*/m.test(t)) return { outcome: 'pass', summary: 'cargo: Finished' };
    return null;
  },
  tsc(t) {
    const errs = t.match(/error TS\d+:/g);
    if (!errs) return null;
    const found = t.match(/^Found (\d+) errors?( in \d+ files?)?\.?$/m);
    const n = found ? Number(found[1]) : errs.length;
    return { outcome: 'fail', summary: `tsc: ${n} error${n === 1 ? '' : 's'} (error TS)` };
  },
  prettier(t) {
    if (/^All matched files use Prettier code style!/m.test(t)) return { outcome: 'pass', summary: 'prettier: all matched files use Prettier code style' };
    const m = t.match(/^\[warn\] Code style issues found in ([^\n]*)/m);
    if (m) return { outcome: 'fail', summary: `prettier: code style issues found in ${m[1].trim()}` };
    return null;
  },
  ruff(t) {
    // ruff: "Found 1 error." / "Found 3 errors (1 fixed, 2 remaining)."; tsc and mypy continue with " in ..."
    const found = t.match(/^Found (\d+) errors?(?: \([^)]*\))?\.$/m);
    if (found) return { outcome: 'fail', summary: `ruff: Found ${found[1]} error${found[1] === '1' ? '' : 's'}` };
    if (/^(\d+) files? would be reformatted/m.test(t)) { const m = t.match(/^(\d+) files? would be reformatted/m); return { outcome: 'fail', summary: `ruff format: ${m[0]}` }; }
    if (/^All checks passed!/m.test(t)) return { outcome: 'pass', summary: 'ruff: All checks passed!' };
    if (/^(\d+) files? already formatted/m.test(t)) return { outcome: 'pass', summary: `ruff format: ${t.match(/^(\d+) files? already formatted/m)[0]}` };
    return null;
  },
  eslint(t) {
    const m = lastMatch(/^✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m, t) || lastMatch(/^(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m, t);
    if (m) return { outcome: Number(m[2]) > 0 ? 'fail' : 'pass', summary: `eslint: ${m[1]} problem${m[1] === '1' ? '' : 's'} (${m[2]} error${m[2] === '1' ? '' : 's'}, ${m[3]} warning${m[3] === '1' ? '' : 's'})` };
    if (/^✔ No ESLint warnings or errors/m.test(t)) return { outcome: 'pass', summary: 'eslint: no warnings or errors' };
    return null;
  },
  mypy(t) {
    if (/^Success: no issues found/m.test(t)) return { outcome: 'pass', summary: `mypy: ${t.match(/^Success: no issues found[^\n]*/m)[0]}` };
    const m = t.match(/^Found (\d+) errors? in (\d+) files? \(checked \d+ source files?\)/m);
    if (m) return { outcome: 'fail', summary: `mypy: ${m[0]}` };
    return null;
  },
  pyright(t) {
    const m = lastMatch(/^(\d+) errors?, (\d+) warnings?(?:, (\d+) informations?)?\s*$/m, t);
    if (!m) return null;
    return { outcome: Number(m[1]) > 0 ? 'fail' : 'pass', summary: `pyright: ${m[0].trim()}` };
  },
  nextBuild(t) {
    if (/^\s*(?:⨯ )?Failed to compile|^Type error:|^\s*> Build error occurred|^Error: Build failed/m.test(t)) return { outcome: 'fail', summary: 'next build: failed to compile' };
    if (/^\s*✓ Compiled successfully|^Compiled successfully/m.test(t) && !/^\s*(?:⨯|✗|Error:) /m.test(t.slice(t.search(/Compiled successfully/)))) return { outcome: 'pass', summary: 'next build: compiled successfully' };
    if (/^\s*✓ Compiled successfully|^Compiled successfully/m.test(t)) return { outcome: 'pass', summary: 'next build: compiled successfully (errors logged after build)' };
    return null;
  },
  bun(t) {
    const p = lastMatch(/^\s*(\d+) pass\s*$/m, t);
    const f = lastMatch(/^\s*(\d+) fail\s*$/m, t);
    if (!p && !f) return null;
    const failed = f ? Number(f[1]) : 0;
    return { outcome: failed > 0 ? 'fail' : 'pass', summary: `bun test: ${p ? p[1] : 0} pass, ${failed} fail` };
  },
};

// Runners whose success is silence: empty output and a zero exit code means pass.
const SILENT_PASS_RUNNERS = new Set(['tsc', 'eslint', 'ruff', 'mypy', 'pyright', 'flake8', 'pylint', 'black', 'biome', 'prettier', 'go', 'script', 'python', 'node']);

const GENERIC_FAIL_RE = /^Traceback \(most recent call last\)|^(?:\S+)?Error: |^FAILED\b|^error:|^error\[|^FAIL\b|^\s*✖|^\s*✗|^(?:npm|pnpm|yarn) ERR!|^ELIFECYCLE|^Error: Exit code \d+|Segmentation fault|command not found|No such file or directory|^AssertionError|^Exception\b|^panic:/m;

function firstLineMatching(re, text) {
  const m = text.match(re);
  if (!m) return null;
  const start = text.lastIndexOf('\n', m.index) + 1;
  const end = text.indexOf('\n', m.index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 160);
}

export function parseOutcome(runner, stdout, stderr, isError, { silentPass = true } = {}) {
  let text = `${stripAnsi(stdout)}\n${stripAnsi(stderr)}`.replace(CWD_RESET_RE, '').replace(/\r\n?/g, '\n');
  const exitMatch = text.match(/^Error: Exit code (\d+)\n?/m);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  if (exitMatch) text = text.replace(exitMatch[0], '');
  const trimmed = text.trim();
  const runners = String(runner ?? '').split('+').filter(Boolean);

  const results = [];
  const tried = new Set();
  const tryParser = (name) => {
    if (tried.has(name) || !PARSERS[name]) return;
    tried.add(name);
    const r = PARSERS[name](text);
    if (r) results.push(r);
  };
  for (const r of runners) tryParser(r);
  // The runner's own summary wins. Nested or generic runners (npm scripts, make, shell scripts, direct
  // scripts) and runners whose summary was filtered out fall back to every known summary format.
  if (!results.some((r) => r.outcome !== 'unparsed')) {
    for (const name of Object.keys(PARSERS)) tryParser(name);
  }

  const parsed = results.filter((r) => r.outcome !== 'unparsed');
  if (parsed.length) {
    const fail = parsed.filter((r) => r.outcome === 'fail');
    const chosen = fail.length ? fail : parsed;
    let summary = chosen.map((r) => r.summary).join('; ');
    if (!fail.length && isError) summary += exitCode !== null ? `; command exited with code ${exitCode}` : '; command exited with an error';
    return { outcome: fail.length ? 'fail' : 'pass', summary };
  }

  if (isError) {
    const line = exitCode !== null ? `exit code ${exitCode}` : null;
    const detail = firstLineMatching(GENERIC_FAIL_RE, text) || firstLineMatching(/\S/, text);
    return { outcome: 'fail', summary: [line, detail].filter(Boolean).join(': ') || 'command exited with an error' };
  }
  if (GENERIC_FAIL_RE.test(text)) return { outcome: 'fail', summary: firstLineMatching(GENERIC_FAIL_RE, text) };
  if (!trimmed && silentPass && runners.some((r) => SILENT_PASS_RUNNERS.has(r))) return { outcome: 'pass', summary: `${runners.join('+')}: no output, exit ok` };
  if (results.length) return results[0]; // e.g. "no tests ran"
  if (!trimmed && !silentPass && runners.some((r) => SILENT_PASS_RUNNERS.has(r))) return { outcome: 'unparsed', summary: 'no runner output captured (redirected, or exit code of a later command)' };
  return { outcome: 'unparsed', summary: trimmed ? null : 'no output' };
}

// ---------------------------------------------------------------------------
// Public: extractRuns / runsForHunk / hunkStatus
// ---------------------------------------------------------------------------

// bashEditDiff lists every working-tree change seen while the call ran, not what
// the command wrote (a concurrent agent's edit, a merge in another checkout).
// A run is only dropped as an edit when the command names a changed file inside
// the repo (its path, basename or a parent directory such as `dist-test/`).
function bashEditDiffTouches(diff, repoRoot, command, cwd) {
  if (!diff || typeof diff !== 'object' || !Array.isArray(diff.files)) return false;
  const paths = diff.files.map((f) => (f && typeof f === 'object' ? f.filePath : null)).filter((p) => typeof p === 'string' && p);
  if (!paths.length) return false;
  const root = repoRoot ? path.resolve(repoRoot) : null;
  return paths.some((p) => {
    const r = path.resolve(p);
    if (root && r !== root && !r.startsWith(root + path.sep)) return false;
    return commandNamesFile(command, r, cwd || root);
  });
}

function normalizeResult(result) {
  if (result == null) return null;
  if (typeof result === 'string') return { stdout: result, stderr: '', isError: /^Error: Exit code \d+/.test(result), interrupted: false };
  return {
    stdout: result.stdout ?? '', stderr: result.stderr ?? '', isError: Boolean(result.isError), interrupted: Boolean(result.interrupted),
    backgroundTaskId: typeof result.backgroundTaskId === 'string' && result.backgroundTaskId ? result.backgroundTaskId : null,
  };
}

export function extractRuns(events, ctx = {}) {
  const runs = [];
  for (const ev of events ?? []) {
    if (!ev || (ev.type !== 'tool' && ev.type !== 'run') || !ev.tool || ev.tool.name !== 'Bash') continue;
    const command = ev.tool.input?.command;
    if (typeof command !== 'string' || !command.trim()) continue;
    const cls = classifyRun(command, ctx);
    if (!cls.isRun) continue;
    // Claude Code >= 2.1.270 records the files a Bash call modified in toolUseResult.bashEditDiff
    // ({ files: [{ filePath, hunks }], ... }; `files` is [] for log captures outside the project).
    // A command that names a changed file (inside repoRoot when known) edited files and is not a run.
    if (bashEditDiffTouches(ev.tool.result?.bashEditDiff ?? ev.tool.bashEditDiff, ctx.repoRoot, command, ev.cwd)) continue;
    const result = normalizeResult(ev.tool.result);
    let outcome; let summary;
    if (!result) { outcome = 'unparsed'; summary = 'no result recorded'; }
    else if (result.backgroundTaskId) {
      // the tool call returned before the command finished; its output lives in a file hunkproof does not read
      outcome = 'unparsed'; summary = 'moved to background, output not captured';
    } else {
      ({ outcome, summary } = parseOutcome(cls.runner, result.stdout, result.stderr, result.isError, { silentPass: cls.silentOk }));
      if (outcome === 'unparsed' && result.interrupted) summary = 'interrupted';
    }
    const run = {
      ts: ev.ts, sessionId: ev.sessionId, toolUseId: ev.toolUseId ?? null, command, runner: cls.runner,
      outcome, summary, isError: Boolean(result?.isError), targets: cls.targets,
    };
    // the checkout (main repo or git worktree) the command ran in, when the caller resolved it
    if (typeof ev.checkout === 'string' && ev.checkout) run.checkout = ev.checkout;
    runs.push(run);
  }
  runs.sort((a, b) => tsValue(a.ts) - tsValue(b.ts) || String(a.ts).localeCompare(String(b.ts)));
  return runs;
}

function tsValue(ts) {
  const v = Date.parse(ts);
  return Number.isNaN(v) ? 0 : v;
}

function stemOf(p) {
  let b = path.posix.basename(String(p).replace(/\\/g, '/'));
  b = b.replace(/\.[^.]+$/, '');
  b = b.replace(/\.(test|spec|e2e|integration|unit)$/, '').replace(/^test_/, '').replace(/_test$/, '').replace(/^(test|spec)-/, '');
  return normalizeStem(b);
}

function normalizeStem(s) { return String(s).toLowerCase().replace(/[-_.]/g, ''); }

function trimSlashes(s) { return String(s).replace(/^\.\//, '').replace(/\/+$/, ''); }

export function isTargeted(hunk, run) {
  const targets = run.targets ?? [];
  if (!targets.length) return true; // whole-project run
  const rel = trimSlashes(hunk.relFile ?? (hunk.file ? path.basename(hunk.file) : ''));
  const abs = hunk.file ? path.resolve(hunk.file) : null;
  const stem = stemOf(rel);
  const parent = trimSlashes(path.posix.dirname(rel));
  for (const raw of targets) {
    const t = trimSlashes(raw);
    if (!t) continue;
    if (t.startsWith('/') && abs && (abs === path.resolve(t) || abs.startsWith(path.resolve(t) + '/'))) return true;
    if (rel === t || rel.endsWith('/' + t) || t.endsWith('/' + rel)) return true;
    if (parent && parent !== '.' && (parent === t || parent.startsWith(t + '/') || t.endsWith('/' + parent) || parent.endsWith('/' + t))) return true;
    if (!t.includes('/') && !/\.[A-Za-z]{1,6}$/.test(t)) {
      const s = normalizeStem(t);
      if (s.length >= 3 && stem.length >= 3 && (stem.includes(s) || s.includes(stem))) return true;
    } else if (stemOf(t) === stem && stem.length >= 3) return true;
  }
  return false;
}

// Runs after the hunk's last edit. A run executed in another checkout than the
// edit (a git worktree vs the main checkout) did not contain the edit: it is
// kept for the record with otherCheckout: true, never targeted, and
// decidingRun() treats it like an unparsed run.
export function runsForHunk(hunk, runs) {
  if (!hunk || !hunk.lastEdit) return [];
  const after = tsValue(hunk.lastEdit);
  const editCheckout = typeof hunk.checkout === 'string' && hunk.checkout ? path.resolve(hunk.checkout) : null;
  return (runs ?? [])
    .filter((r) => tsValue(r.ts) > after)
    .sort((a, b) => tsValue(a.ts) - tsValue(b.ts))
    .map((r) => {
      const out = { ...r, targeted: isTargeted(hunk, r) };
      if (editCheckout && typeof r.checkout === 'string' && r.checkout && path.resolve(r.checkout) !== editCheckout) {
        out.targeted = false;
        out.otherCheckout = true;
      }
      return out;
    });
}

// Status = the last run after the hunk's last edit whose outcome was parsed
// (pass/fail), preferring targeted runs among those; an unparsed run (a script
// invocation, a command still in flight, a run in another checkout) never hides
// a parsed outcome. Only when no run parsed does the last run decide, i.e.
// RUN_UNPARSED.
export function decidingRun(runsAfter) {
  if (!runsAfter || !runsAfter.length) return null;
  const parsed = runsAfter.filter((r) => r && (r.outcome === 'pass' || r.outcome === 'fail') && r.otherCheckout !== true);
  if (!parsed.length) {
    // nothing parsed: show the last run made where the edit lives, else the last run at all
    const same = runsAfter.filter((r) => r && r.otherCheckout !== true);
    return (same.length ? same : runsAfter)[(same.length ? same : runsAfter).length - 1];
  }
  const targeted = parsed.filter((r) => r.targeted === true);
  const pool = targeted.length ? targeted : parsed;
  return pool[pool.length - 1];
}

export function hunkStatus(hunk, runsAfter) {
  if (!hunk || hunk.attribution === 'UNATTRIBUTED') return 'UNATTRIBUTED';
  const last = decidingRun(runsAfter);
  if (!last) return 'UNRUN';
  if (last.otherCheckout === true) return 'RUN_UNPARSED'; // ran, but in a checkout without this edit
  if (last.outcome === 'pass') return 'RUN_PASS';
  if (last.outcome === 'fail') return 'RUN_FAIL';
  return 'RUN_UNPARSED';
}
