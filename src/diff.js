// Diff extraction: run `git diff -U0` and parse unified diffs into Hunk objects.
// Pure parser (parseUnifiedDiff) + a thin git wrapper (gitDiffHunks). Zero deps.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** trim + collapse internal whitespace runs to one space */
export function normalizeLine(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Unquote a git-quoted path ("a/b\tc.txt" style, C escapes incl. octal). Plain paths pass through.
 */
function unquoteGitPath(p) {
  if (!p || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const inner = p.slice(1, -1);
  const bytes = []; // octal escapes are raw UTF-8 bytes; decode them together at the end
  const pushStr = (s) => { for (const b of Buffer.from(s, 'utf8')) bytes.push(b); };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') { pushStr(ch); continue; }
    const nx = inner[i + 1];
    if (nx === undefined) break;
    if (/[0-7]/.test(nx)) {
      const oct = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
      continue;
    }
    const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };
    pushStr(map[nx] !== undefined ? map[nx] : nx);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** strip the `a/` or `b/` prefix git puts in front of paths, and the trailing tab after paths with spaces */
function stripPrefix(p) {
  let s = p.replace(/\t$/, '');
  s = unquoteGitPath(s);
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

/**
 * Split the `diff --git a/X b/Y` remainder into [X, Y]. When X === Y (the common case) the string is
 * `a/P b/P`; we look for a split point where both halves agree. Otherwise we fall back to the last ` b/`.
 */
function splitDiffGitLine(rest) {
  if (rest.startsWith('"')) {
    // quoted form: "a/..." "b/..."
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
    if (m) return [stripPrefix(m[1]), stripPrefix(m[2])];
  }
  let idx = rest.indexOf(' b/');
  while (idx !== -1) {
    const left = rest.slice(0, idx);
    const right = rest.slice(idx + 1);
    if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return [left.slice(2), right.slice(2)];
    }
    idx = rest.indexOf(' b/', idx + 1);
  }
  const last = rest.lastIndexOf(' b/');
  if (last !== -1) return [stripPrefix(rest.slice(0, last)), stripPrefix(rest.slice(last + 1))];
  return [stripPrefix(rest), stripPrefix(rest)];
}

function makeStats(stats) {
  const s = stats || {};
  s.files = s.files || 0;
  s.hunks = s.hunks || 0;
  s.binary = s.binary || 0;
  s.binaryFiles = s.binaryFiles || [];
  s.renames = s.renames || 0;
  s.newFiles = s.newFiles || 0;
  s.deletedFiles = s.deletedFiles || 0;
  s.filesWithoutHunks = s.filesWithoutHunks || 0;
  return s;
}

/**
 * Parse a unified diff (as produced by `git diff`, any -U value) into Hunk[].
 * Binary files are skipped and counted in opts.stats.binary / opts.stats.binaryFiles.
 * Renames keep the NEW path as `file`/`relFile` and expose `oldFile`/`oldRelFile`.
 */
export function parseUnifiedDiff(text, { repoRoot, stats } = {}) {
  if (!repoRoot) throw new Error('parseUnifiedDiff: repoRoot is required');
  const root = path.resolve(repoRoot);
  const st = makeStats(stats);
  const hunks = [];
  const lines = String(text ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let file = null; // current file state
  let hunk = null; // current hunk being filled
  let fileHunkCount = 0;

  const closeFile = () => {
    if (!file) return;
    if (file.binary) { st.binary += 1; st.binaryFiles.push(file.newRel ?? file.oldRel); }
    else if (fileHunkCount === 0) st.filesWithoutHunks += 1;
    file = null;
    fileHunkCount = 0;
  };

  const pushHunk = () => { if (hunk) { hunks.push(hunk); hunk = null; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');

    if (raw.startsWith('diff --git ')) {
      pushHunk();
      closeFile();
      const [oldRel, newRel] = splitDiffGitLine(raw.slice('diff --git '.length));
      file = { oldRel, newRel, kind: 'modify', binary: false, sawHeaders: false };
      st.files += 1;
      continue;
    }

    if (!file) continue; // preamble or non-git diff text before first header

    if (hunk) {
      const exhausted = hunk.remainOld <= 0 && hunk.remainNew <= 0;
      if (raw.startsWith('\\')) { continue; } // "\ No newline at end of file"
      if (exhausted || raw.startsWith('@@')) {
        pushHunk(); // counts consumed (or a new header): hand the line to the file-level parser
      } else if (raw.startsWith('+')) { hunk.added.push(raw.slice(1)); hunk.remainNew -= 1; continue; }
      else if (raw.startsWith('-')) { hunk.removed.push(raw.slice(1)); hunk.remainOld -= 1; continue; }
      else if (raw.startsWith(' ')) { hunk.context.push(raw.slice(1)); hunk.remainOld -= 1; hunk.remainNew -= 1; continue; }
      else if (raw === '') { hunk.context.push(''); hunk.remainOld -= 1; hunk.remainNew -= 1; continue; } // bare empty context line (some tools strip the space)
      else { pushHunk(); /* unknown line: let the file-level parser look at it */ }
    }

    const hm = raw.match(HUNK_HEADER);
    if (hm) {
      if (file.binary) continue;
      const oldStart = Number(hm[1]);
      const oldLines = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newLines = hm[4] === undefined ? 1 : Number(hm[4]);
      const relFile = file.newRel ?? file.oldRel;
      hunk = {
        id: `${relFile}:${newStart}`,
        file: path.resolve(root, relFile),
        relFile,
        oldStart, oldLines, newStart, newLines,
        added: [], removed: [], context: [],
        remainOld: oldLines, remainNew: newLines,
        kind: file.kind,
      };
      if (file.kind === 'rename' && file.oldRel) {
        hunk.oldRelFile = file.oldRel;
        hunk.oldFile = path.resolve(root, file.oldRel);
      }
      fileHunkCount += 1;
      st.hunks += 1;
      continue;
    }

    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) { file.binary = true; continue; }
    if (raw.startsWith('new file mode')) { file.kind = 'add'; st.newFiles += 1; continue; }
    if (raw.startsWith('deleted file mode')) { file.kind = 'delete'; st.deletedFiles += 1; continue; }
    if (raw.startsWith('rename from ')) { file.oldRel = unquoteGitPath(raw.slice('rename from '.length)); file.kind = 'rename'; st.renames += 1; continue; }
    if (raw.startsWith('rename to ')) { file.newRel = unquoteGitPath(raw.slice('rename to '.length)); file.kind = 'rename'; continue; }
    if (raw.startsWith('copy from ') || raw.startsWith('copy to ')) { if (raw.startsWith('copy to ')) file.newRel = unquoteGitPath(raw.slice('copy to '.length)); continue; }
    if (raw.startsWith('--- ')) {
      const p = stripPrefix(raw.slice(4));
      if (p !== null) file.oldRel = p;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripPrefix(raw.slice(4));
      if (p !== null) file.newRel = p;
      else if (file.kind !== 'delete') file.kind = 'delete';
      continue;
    }
    // index, old mode, new mode, similarity index, dissimilarity index: ignored
  }
  pushHunk();
  closeFile();

  // Fill derived fields; drop internal context once normalized data is attached.
  for (const h of hunks) {
    h.addedNormalized = h.added.map(normalizeLine);
    delete h.context;
    delete h.remainOld;
    delete h.remainNew;
  }
  return hunks;
}

/**
 * Run `git diff -U0 --no-color --no-ext-diff <base>...<head>` in repoRoot and parse it.
 * opts.stats (optional object) receives file/hunk/binary counters.
 */
export function gitDiffHunks({ repoRoot, base, head = 'HEAD', stats } = {}) {
  if (!repoRoot) throw new Error('gitDiffHunks: repoRoot is required');
  if (!base) throw new Error('gitDiffHunks: base is required');
  const root = path.resolve(repoRoot);
  const range = head ? `${base}...${head}` : base;
  const text = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', range],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return parseUnifiedDiff(text, { repoRoot: root, stats });
}
