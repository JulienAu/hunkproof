// Normalized transcript events for Claude Code session files (JSONL).
//
// Field names below were checked against real transcripts written by
// Claude Code 2.1.267 .. 2.1.299:
//   - every line is a JSON object with a `type`; the interesting ones are
//     'assistant', 'user' and 'pr-link'. Everything else ('attachment',
//     'system', 'mode', 'ai-title', 'queue-operation', ...) is counted in
//     stats.skipped[type].
//   - assistant/user lines carry: uuid, timestamp, sessionId, cwd, gitBranch,
//     version, isSidechain, message. Assistant lines also carry requestId
//     (top level) and message.id, message.model, message.usage.
//   - one API message is split over several assistant lines (one per content
//     block, same message.id and requestId, identical usage): usage events
//     are therefore deduped later by (messageId, requestId).
//   - tool results live in a later 'user' line: message.content is a list with
//     exactly one {type:'tool_result', tool_use_id, content, is_error} block,
//     and the structured result sits at top level in `toolUseResult`.
//   - Bash toolUseResult: {stdout, stderr, interrupted, isImage, ...}; since
//     2.1.270 it may carry bashEditDiff {files:[{filePath, hunks:[{oldStart,
//     oldLines, newStart, newLines, lines}], created?, deleted?}], moreFiles,
//     unavailable?}; gitOperation {pr:{number, url?, action}} appears when a PR
//     was created. A string toolUseResult means an error ("Error: Exit code 1...").
//     bashEditDiff.files is every working-tree change seen while the call ran
//     (concurrent agents, merges), hence the corroboration in bashEditDiffSource().
//     A call moved to the background carries backgroundTaskId (and timedOutAfterMs
//     when the move followed a timeout) with stdout '' and a tool_result text
//     "Command running in background with ID: ..." / "Command did not complete
//     within its 600s timeout and was moved to the background (ID: ...)".
//   - Edit toolUseResult: {filePath, oldString, newString, originalFile,
//     structuredPatch, userModified, replaceAll}; Write: {type:'create'|'update',
//     filePath, content, structuredPatch, originalFile, userModified}.
//   - 'pr-link' lines: {sessionId, prNumber, prUrl, prRepository, timestamp}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function splitLines(text) {
  if (text === null || text === undefined) return [];
  const s = String(text);
  if (s === '') return [];
  const lines = s.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function absolutize(file, cwd) {
  if (!file || typeof file !== 'string') return null;
  if (path.isAbsolute(file)) return path.resolve(file);
  return path.resolve(cwd || process.cwd(), file);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function baseEvent(entry, type, extra = {}) {
  const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;
  return {
    type,
    ts: typeof entry.timestamp === 'string' ? entry.timestamp : (extra.ts || ''),
    sessionId: entry.sessionId || extra.sessionId || null,
    cwd: entry.cwd || null,
    gitBranch: entry.gitBranch || null,
    version: entry.version || null,
    messageId: (msg && typeof msg.id === 'string') ? msg.id : null,
    requestId: typeof entry.requestId === 'string' ? entry.requestId : null,
    toolUseId: extra.toolUseId || null,
    uuid: typeof entry.uuid === 'string' ? entry.uuid : null,
    isSidechain: entry.isSidechain === true,
  };
}

// ---------------------------------------------------------------- git commit

// Find the `git [global opts] commit ...` simple command among the shell
// tokens (heredoc bodies and quoted strings never count). Returns the words
// of that simple command (starting at 'commit') or null.
function gitCommitWords(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) continue;
    const prev = tokens[i - 1];
    const isCmdStart = i === 0 || (prev && prev.op && ['|', ';', '&&', '||', '\n', '&', '|&'].includes(prev.text));
    if (!isCmdStart) continue;
    const words = segmentAfter(tokens, i);
    // skip env assignments / sudo / time prefixes
    let k = 0;
    while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text) || ['sudo', 'time', 'env', 'nohup'].includes(words[k].text))) k++;
    if (!words[k] || path.basename(words[k].text) !== 'git' || words[k].quoted) continue;
    k++;
    // global options: -C dir, -c k=v, --git-dir=x, --no-pager, ...
    while (words[k] && words[k].text.startsWith('-') && !words[k].quoted) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[k].text)) k += 2;
      else k++;
    }
    if (words[k] && words[k].text === 'commit' && !words[k].quoted) return words.slice(k);
  }
  return null;
}

export function isGitCommit(command) {
  if (typeof command !== 'string' || !/\bgit\b/.test(command) || !/\bcommit\b/.test(command)) return false;
  return gitCommitWords(shellTokens(command)) !== null;
}

// Extract the commit message from a `git commit` command: handles -m "x",
// -m 'x', -m=x, --message x, --message=x, combined short flags (-qm, -am,
// -sm), several -m (joined by a blank line), -m "$(cat <<'EOF' ... EOF)" and
// -F - / --file=- fed by a heredoc. Returns null when no message is on the
// command line (editor, -F file, --amend --no-edit, --fixup, ...).
export function extractCommitMessage(command) {
  if (typeof command !== 'string') return null;
  const { bodies } = stripHeredocBodies(command);
  // -m "$(cat <<'EOF' ... EOF)" : the body is the message
  const catForm = /-[a-zA-Z]*m\s+"\$\(\s*cat\s*<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\n([\s\S]*?)\n\s*\1\2\3\s*\n?\s*\)"/.exec(command);
  if (catForm) return catForm[4].replace(/\s+$/, '');
  const tokens = shellTokens(command);
  const words = gitCommitWords(tokens);
  if (!words) return null;
  const parts = [];
  for (let i = 1; i < words.length; i++) {
    const t = words[i];
    if (t.quoted) continue;
    let mm;
    if ((mm = /^--message=(.*)$/s.exec(t.text))) { parts.push(mm[1]); continue; }
    if (t.text === '--message' && words[i + 1]) { parts.push(words[++i].text); continue; }
    if ((t.text === '--file=-' || ((t.text === '-F' || t.text === '--file' || /^-[a-zA-Z]*F$/.test(t.text)) && words[i + 1] && words[i + 1].text === '-')) && bodies.length) {
      parts.push(bodies[0].replace(/\s+$/, ''));
      if (t.text !== '--file=-') i++;
      continue;
    }
    if (t.text.startsWith('--')) continue;
    if ((mm = /^-[a-zA-Z]*m=(.*)$/s.exec(t.text))) { parts.push(mm[1]); continue; }
    if (/^-[a-zA-Z]*m$/.test(t.text)) { if (words[i + 1]) parts.push(words[++i].text); continue; }
    if ((mm = /^-[a-zA-Z]*m(.+)$/s.exec(t.text)) && t.text.startsWith('-')) { parts.push(mm[1]); continue; }
  }
  if (!parts.length) return null;
  return parts.join('\n\n');
}

// ------------------------------------------------------------ shell lexing

// Minimal shell lexer: words (quotes removed, `quoted` set when the whole
// word came from quotes) and operators (> >> &> N> >& | ; && || & newline).
// Heredoc bodies are removed from the token stream (they are scanned
// separately for script-level writes).
export function shellTokens(command) {
  const src = stripHeredocBodies(command).text;
  const tokens = [];
  let i = 0;
  const n = src.length;
  let word = null; // { text, quoted, allQuoted }
  const flush = () => {
    if (word !== null) {
      tokens.push({ text: word.text, quoted: word.allQuoted && word.text.length > 0, op: false });
      word = null;
    }
  };
  const addChar = (ch, quoted) => {
    if (word === null) word = { text: '', allQuoted: quoted };
    else if (!quoted) word.allQuoted = false;
    word.text += ch;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === "'") {
      let j = src.indexOf("'", i + 1);
      if (j < 0) j = n;
      const inner = src.slice(i + 1, j);
      if (word === null) word = { text: '', allQuoted: true };
      word.text += inner;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let inner = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { inner += src[j + 1]; j += 2; continue; }
        inner += src[j];
        j++;
      }
      if (word === null) word = { text: '', allQuoted: true };
      word.text += inner;
      i = j + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      if (src[i + 1] === '\n') { i += 2; continue; }
      addChar(src[i + 1], false);
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t') { flush(); i++; continue; }
    if (ch === '\n') { flush(); tokens.push({ text: '\n', op: true }); i++; continue; }
    if (ch === '>' || ch === '<' || ch === '|' || ch === ';' || ch === '&') {
      // digit glued to a redirect: 2> 1>> 2>&1
      let fd = null;
      if ((ch === '>' || ch === '<') && word && /^\d$/.test(word.text) && !word.allQuoted) {
        fd = word.text;
        word = null;
      } else {
        flush();
      }
      let op = ch;
      let j = i + 1;
      if (ch === '&' && src[j] === '>') { op = '&>'; j++; if (src[j] === '>') { op = '&>>'; j++; } }
      else if (ch === '>' && src[j] === '>') { op = '>>'; j++; }
      else if (ch === '>' && src[j] === '&') { op = '>&'; j++; }
      else if (ch === '>' && src[j] === '|') { op = '>|'; j++; }
      else if (ch === '>' && src[j] === '(') { op = '>('; j++; }
      else if (ch === '<' && src[j] === '<') { op = '<<'; j++; if (src[j] === '<') { op = '<<<'; j++; } }
      else if (ch === '<' && src[j] === '(') { op = '<('; j++; }
      else if (ch === '&' && src[j] === '&') { op = '&&'; j++; }
      else if (ch === '|' && src[j] === '|') { op = '||'; j++; }
      else if (ch === '|' && src[j] === '&') { op = '|&'; j++; }
      tokens.push({ text: op, op: true, fd });
      i = j;
      continue;
    }
    addChar(ch, false);
    i++;
  }
  flush();
  return tokens;
}

// Remove heredoc bodies (`<<EOF ... EOF`) from a command; returns the text
// without bodies and the list of bodies.
export function stripHeredocBodies(command) {
  const bodies = [];
  if (typeof command !== 'string' || !command.includes('<<')) return { text: command || '', bodies };
  const lines = command.split('\n');
  const out = [];
  const hdRe = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    const delims = [];
    let m;
    hdRe.lastIndex = 0;
    while ((m = hdRe.exec(line))) {
      // `<<<` is a here-string, not a heredoc
      if (m.index > 0 && line[m.index - 1] === '<') continue;
      delims.push(m[1] || m[2] || m[3]);
    }
    i++;
    for (const d of delims) {
      const body = [];
      while (i < lines.length && lines[i].replace(/^\t+/, '') !== d) { body.push(lines[i]); i++; }
      bodies.push(body.join('\n'));
      if (i < lines.length) { out.push(lines[i]); i++; }
    }
  }
  return { text: out.join('\n'), bodies };
}

function looksLikePath(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.startsWith('-')) return false;
  if (/[$`*?{}[\]]/.test(s)) return false;
  if (s.startsWith('/dev/') || s.startsWith('/proc/') || s === '/dev/null') return false;
  if (s === '.' || s === '..' || s === '/' || s === '~') return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}

function segmentAfter(tokens, start) {
  // words of the current simple command, until a control operator/pipe
  const words = [];
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) {
      if (t.text === '|' || t.text === ';' || t.text === '&&' || t.text === '||' || t.text === '\n' || t.text === '&' || t.text === '|&') break;
      // a redirect: skip its target word
      if (t.text.startsWith('>') || t.text.startsWith('&>') || t.text === '<') { i++; }
      continue;
    }
    words.push(t);
  }
  return words;
}

function sedTargets(words) {
  // words[0] is 'sed'
  let inPlace = false;
  let scriptSeen = false;
  const files = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const t = w.text;
    if (!w.quoted && t.startsWith('-') && t.length > 1) {
      if (t.startsWith('--')) {
        if (t.startsWith('--in-place')) inPlace = true;
        else if (t === '--expression' || t === '--file') { i++; scriptSeen = true; }
        else if (t.startsWith('--expression=') || t.startsWith('--file=')) scriptSeen = true;
        continue;
      }
      const flags = t.slice(1);
      if (/i/.test(flags)) inPlace = true;
      if (/[ef]$/.test(flags)) { i++; scriptSeen = true; continue; }
      if (/[ef]/.test(flags) && /[ef][^ef]*$/.test(flags)) { scriptSeen = true; continue; }
      continue;
    }
    if (!scriptSeen) { scriptSeen = true; continue; }
    files.push(t);
  }
  return inPlace ? files : [];
}

function scriptWriteTargets(text) {
  const targets = [];
  const vars = new Map();
  let m;
  // python: p = 'file'   / const p = "file"  / let p = `file`
  const assignRe = /(?:^|[\s;(,])(?:const|let|var)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:Path\()?\s*(['"`])([^'"`\n]+)\2\s*\)?/g;
  while ((m = assignRe.exec(text))) vars.set(m[1], m[3]);
  const resolveArg = (lit, name) => (lit !== undefined ? lit : (name ? vars.get(name) : undefined));
  // open('file', 'w'|'a'|'wb'...) / open(p, 'w')
  const openRe = /\bopen\(\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*(?:mode\s*=\s*)?(['"])[wax][^'"]*\4/g;
  while ((m = openRe.exec(text))) { const f = resolveArg(m[2], m[3]); if (f) targets.push(f); }
  // Path('file').write_text( / write_bytes(   or  p.write_text(
  const pathWriteRe = /\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g;
  while ((m = pathWriteRe.exec(text))) targets.push(m[2]);
  const varWriteRe = /\b([A-Za-z_][A-Za-z0-9_]*)\.write_(?:text|bytes)\(/g;
  while ((m = varWriteRe.exec(text))) { const f = vars.get(m[1]); if (f) targets.push(f); }
  // writeFileSync('file' / writeFile('file' / fs.promises.writeFile(p
  const wfRe = /\bwriteFile(?:Sync)?\(\s*(?:(['"`])([^'"`\n]+)\1|([A-Za-z_][A-Za-z0-9_]*))\s*,/g;
  while ((m = wfRe.exec(text))) { const f = resolveArg(m[2], m[3]); if (f) targets.push(f); }
  // json.dump(x, open('file','w')) already matches openRe; .to_csv('file') / .savefig('file')
  const pandasRe = /\.(?:to_csv|to_json|to_parquet|savefig|save)\(\s*(['"])([^'"\n]+)\1/g;
  while ((m = pandasRe.exec(text))) targets.push(m[2]);
  return targets;
}

function patchTargets(text) {
  const out = [];
  const re = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const f = m[1].trim();
    if (f && f !== '/dev/null') out.push(f);
  }
  return out;
}

// Regex/lexer based extraction of the files a Bash command writes to.
// Returns absolute paths (resolved against a leading `cd DIR &&` when
// present, else against cwd). Fallback used when bashEditDiff is absent.
export function extractWriteTargets(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const found = []; // [raw, base]
  const { text, bodies } = stripHeredocBodies(command);
  const tokens = shellTokens(command);
  const cwd0 = cwd || process.cwd();
  let base = cwd0;
  const applyCd = (dir) => {
    if (!dir) { base = cwd0; return; }
    if (dir === '-') return;
    if (dir.startsWith('~')) base = path.resolve(expandTilde(dir));
    else if (!looksLikePath(dir)) base = null; // unknown ($VAR): later relative targets cannot be resolved
    else if (path.isAbsolute(dir)) base = path.resolve(dir);
    else if (base) base = path.resolve(base, dir);
    // else: relative cd after an unknown base stays unknown
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) {
      if ((t.text === '>' || t.text === '>>' || t.text === '>|' || t.text === '&>' || t.text === '&>>') && (t.fd === null || t.fd === undefined || t.fd === '1')) {
        const nxt = tokens[i + 1];
        if (nxt && !nxt.op) found.push([nxt.text, base]);
      }
      continue;
    }
    // first word of a simple command?
    const prev = tokens[i - 1];
    const isCmdStart = i === 0 || (prev && prev.op && ['|', ';', '&&', '||', '\n', '&', '|&'].includes(prev.text));
    if (!isCmdStart) continue;
    // skip env assignments and sudo/time/nice prefixes
    let j = i;
    while (tokens[j] && !tokens[j].op && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j].text) || ['sudo', 'time', 'nice', 'env', 'timeout', 'nohup'].includes(tokens[j].text))) {
      j++;
      if (tokens[j] && !tokens[j].op && tokens[j - 1].text === 'nice' && /^-n$/.test(tokens[j].text)) j += 2;
      else if (tokens[j] && !tokens[j].op && tokens[j - 1].text === 'timeout' && /^\d/.test(tokens[j].text)) j++;
      else if (tokens[j] && !tokens[j].op && /^-/.test(tokens[j].text)) j++;
    }
    const words = segmentAfter(tokens, j);
    if (!words.length) continue;
    const cmd = path.basename(words[0].text);
    const push = (raw) => found.push([raw, base]);
    if (cmd === 'cd') {
      applyCd(words[1] ? words[1].text : null);
    } else if (cmd === 'pushd' && words[1]) {
      applyCd(words[1].text);
    } else if (cmd === 'sed') {
      sedTargets(words).forEach(push);
    } else if (cmd === 'tee') {
      for (let k = 1; k < words.length; k++) if (!words[k].text.startsWith('-') || words[k].quoted) push(words[k].text);
    } else if (cmd === 'mv' || cmd === 'cp' || cmd === 'rsync' || cmd === 'install') {
      const args = words.slice(1).filter((w) => w.quoted || !w.text.startsWith('-'));
      if (args.length >= 2) {
        const dest = args[args.length - 1].text;
        const srcs = args.slice(0, -1).map((w) => w.text);
        if (srcs.length > 1 || dest.endsWith('/')) for (const s of srcs) push(path.posix.join(dest, path.basename(s)));
        else push(dest);
      }
    } else if (cmd === 'git' && words[1] && words[1].text === 'apply') {
      patchTargets(command).forEach(push);
    } else if (cmd === 'patch') {
      patchTargets(command).forEach(push);
    } else if (cmd === 'touch' || cmd === 'truncate') {
      for (let k = 1; k < words.length; k++) if (words[k].quoted || !words[k].text.startsWith('-')) push(words[k].text);
    }
  }
  // inline scripts: -c "..." arguments and heredoc bodies, resolved against
  // the directory in effect at the end of the command
  for (const raw of scriptWriteTargets(text)) found.push([raw, base]);
  for (const b of bodies) for (const raw of scriptWriteTargets(b)) found.push([raw, base]);
  const out = [];
  const seen = new Set();
  for (const [raw, dir] of found) {
    const f = raw.trim();
    if (!looksLikePath(f)) continue;
    let abs;
    if (f.startsWith('~')) abs = path.resolve(expandTilde(f));
    else if (path.isAbsolute(f)) abs = path.resolve(f);
    else if (dir) abs = path.resolve(dir, f);
    else continue; // relative path after `cd $UNKNOWN`
    if (abs.startsWith('/dev/') || abs.startsWith('/proc/')) continue;
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ------------------------------------------------- bashEditDiff corroboration
//
// toolUseResult.bashEditDiff lists every working-tree change that appeared
// while the Bash call ran, not the files the command wrote: edits made by a
// concurrent agent, a merge landing in another checkout, a polling loop that
// happened to be open while files changed. An entry is only taken as this
// command's edit when the command can plausibly have written the file.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Directory the first simple command of `command` cds into, or null.
function leadingCdDir(command, cwd) {
  const tokens = shellTokens(command);
  let j = 0;
  while (tokens[j] && !tokens[j].op && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j].text)) j++;
  const w = tokens[j];
  if (!w || w.op || (w.text !== 'cd' && w.text !== 'pushd')) return null;
  const dir = tokens[j + 1];
  if (!dir || dir.op || !looksLikePath(dir.text) || dir.text === '-') return null;
  if (dir.text.startsWith('~')) return path.resolve(expandTilde(dir.text));
  if (path.isAbsolute(dir.text)) return path.resolve(dir.text);
  return cwd ? path.resolve(cwd, dir.text) : null;
}

function mentions(text, needle) {
  if (!needle) return false;
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(needle)}(?=$|[^A-Za-z0-9_.-])`).test(text);
}

// True when the command text names the file: its absolute path, its path
// relative to the cwd (or to a leading `cd`), its basename, or one of its
// parent directories below the cwd as a path (`dist-test/`, `src/lib/`).
export function commandNamesFile(command, file, cwd) {
  if (typeof command !== 'string' || typeof file !== 'string' || !file) return false;
  const abs = path.resolve(file);
  if (command.includes(abs)) return true;
  if (mentions(command, path.basename(abs))) return true;
  const bases = [cwd, leadingCdDir(command, cwd)].filter((b) => typeof b === 'string' && b);
  for (const b of bases) {
    const rel = path.relative(path.resolve(b), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (mentions(command, rel)) return true;
    let dir = path.dirname(rel);
    while (dir && dir !== '.') {
      if (mentions(command, `${dir}/`)) return true;
      dir = path.dirname(dir);
    }
  }
  return false;
}

const GIT_PLUMBING = new Set(['merge', 'pull', 'checkout', 'switch', 'rebase', 'cherry-pick', 'revert', 'am', 'reset', 'restore', 'worktree', 'clone', 'clean']);

// `git merge|pull|checkout|rebase|cherry-pick|stash pop|...` (or `gh pr merge`):
// the working tree changed, but nothing was authored by this command.
export function isGitPlumbing(command) {
  if (typeof command !== 'string' || !/\b(?:git|gh)\b/.test(command)) return false;
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) continue;
    const prev = tokens[i - 1];
    const isCmdStart = i === 0 || (prev && prev.op && ['|', ';', '&&', '||', '\n', '&', '|&'].includes(prev.text));
    if (!isCmdStart) continue;
    const words = segmentAfter(tokens, i).filter((w) => !w.quoted);
    let k = 0;
    while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text) || ['sudo', 'time', 'env', 'nohup', 'timeout'].includes(words[k].text) || (/^\d/.test(words[k].text) && k > 0 && words[k - 1].text === 'timeout'))) k++;
    if (!words[k]) continue;
    const bin = path.basename(words[k].text);
    if (bin === 'gh' && words[k + 1] && words[k + 1].text === 'pr' && words[k + 2] && words[k + 2].text === 'merge') return true;
    if (bin !== 'git') continue;
    k++;
    while (words[k] && words[k].text.startsWith('-')) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[k].text)) k += 2;
      else k++;
    }
    const sub = words[k] && words[k].text;
    if (!sub) continue;
    if (GIT_PLUMBING.has(sub)) return true;
    if (sub === 'stash' && words[k + 1] && (words[k + 1].text === 'pop' || words[k + 1].text === 'apply')) return true;
  }
  return false;
}

const FORMATTERS = new Set(['prettier', 'biome', 'ruff', 'black', 'isort', 'eslint', 'gofmt', 'rustfmt', 'cargo', 'autopep8', 'yapf', 'clang-format', 'dprint', 'standard']);
const PREFIX_BINS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pipenv', 'hatch', 'pdm', 'rye', 'exec', 'dlx', 'x', 'run', 'sudo', 'time', 'env', 'nohup']);

// A formatter run over the whole tree (`prettier --write .`, `ruff format`,
// `black src/`, `eslint --fix "src/**"`) may legitimately touch any file the
// diff reports. A formatter given explicit files only corroborates those
// files, which commandNamesFile() already handles.
export function isBulkFormatter(command) {
  if (typeof command !== 'string') return false;
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) continue;
    const prev = tokens[i - 1];
    const isCmdStart = i === 0 || (prev && prev.op && ['|', ';', '&&', '||', '\n', '&', '|&'].includes(prev.text));
    if (!isCmdStart) continue;
    const words = segmentAfter(tokens, i);
    let k = 0;
    while (words[k] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text) || PREFIX_BINS.has(path.basename(words[k].text)) || (words[k].text.startsWith('-') && k > 0))) k++;
    if (!words[k]) continue;
    const bin = path.basename(words[k].text).replace(/@[^@]*$/, '');
    if (!FORMATTERS.has(bin)) continue;
    const rest = words.slice(k + 1);
    const flags = rest.filter((w) => !w.quoted && w.text.startsWith('-')).map((w) => w.text);
    const args = rest.filter((w) => w.quoted || !w.text.startsWith('-')).map((w) => w.text);
    if (bin === 'cargo') { if (args[0] === 'fmt') return true; continue; }
    if (bin === 'ruff') { if (args[0] !== 'format' && !(args[0] === 'check' && flags.includes('--fix'))) continue; args.shift(); }
    if (bin === 'biome') { if (!['format', 'check', 'lint'].includes(args[0]) || !flags.some((f) => f === '--write' || f === '--apply' || f === '--fix')) continue; args.shift(); }
    if (bin === 'prettier' && !flags.some((f) => f === '--write' || f === '-w')) continue;
    if (bin === 'eslint' && !flags.includes('--fix')) continue;
    if ((bin === 'black' || bin === 'isort' || bin === 'ruff' || bin === 'autopep8' || bin === 'yapf') && flags.some((f) => f === '--check' || f === '--diff')) continue;
    if (bin === 'gofmt' && !flags.some((f) => /w/.test(f))) continue;
    const paths = args.filter((a) => a !== '--');
    if (!paths.length) return true;
    if (paths.some((a) => a === '.' || /[*?{]/.test(a) || a.endsWith('/'))) return true;
  }
  return false;
}

// Source tag of a bashEditDiff entry: 'bashEditDiff' when the command names
// the file, lists it as a write target or is a whole-tree formatter;
// 'bashEditDiff-git' when the command is git plumbing (a merge is not
// authorship); 'bashEditDiff-uncorroborated' otherwise. Attribution and run
// classification only trust the first.
export function bashEditDiffSource(command, file, cwd, writeTargets = null) {
  if (commandNamesFile(command, file, cwd)) return 'bashEditDiff';
  const targets = writeTargets || extractWriteTargets(command, cwd);
  const abs = path.resolve(file);
  if (targets.some((t) => t === abs || abs.startsWith(t + path.sep))) return 'bashEditDiff';
  if (isGitPlumbing(command)) return 'bashEditDiff-git';
  if (isBulkFormatter(command)) return 'bashEditDiff';
  return 'bashEditDiff-uncorroborated';
}

export function isCorroboratedSource(source) {
  return source !== 'bashEditDiff-git' && source !== 'bashEditDiff-uncorroborated';
}

// ------------------------------------------------------------ pr helpers

export function repositoryFromPrUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/\d+/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

// --------------------------------------------------------- event builders

function toolResultFromUserLine(entry, block) {
  const tur = entry.toolUseResult;
  if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
    const r = {
      stdout: typeof tur.stdout === 'string' ? tur.stdout : textOfContent(block.content),
      stderr: typeof tur.stderr === 'string' ? tur.stderr : '',
      isError: block.is_error === true,
    };
    if (typeof tur.interrupted === 'boolean') r.interrupted = tur.interrupted;
    // runs.js drops a "run" whose Bash call also modified files inside the repo
    if (tur.bashEditDiff && typeof tur.bashEditDiff === 'object') r.bashEditDiff = tur.bashEditDiff;
    // A command moved to the background (explicitly, or after its timeout) has
    // an empty stdout that says nothing about the command: {backgroundTaskId,
    // timedOutAfterMs?} ride along so runs.js never reads it as a silent pass.
    if (typeof tur.backgroundTaskId === 'string' && tur.backgroundTaskId) r.backgroundTaskId = tur.backgroundTaskId;
    if (Number.isFinite(Number(tur.timedOutAfterMs)) && tur.timedOutAfterMs !== null && tur.timedOutAfterMs !== undefined) r.timedOutAfterMs = Number(tur.timedOutAfterMs);
    return r;
  }
  if (typeof tur === 'string') {
    return { stdout: '', stderr: tur, isError: block.is_error === true || /^Error\b/.test(tur) };
  }
  return { stdout: textOfContent(block.content), stderr: '', isError: block.is_error === true };
}

function buildEditEvent(pending, resultEntry, block) {
  const { entry, blockUse: use } = pending;
  const input = use.input && typeof use.input === 'object' ? use.input : {};
  const tur = resultEntry && resultEntry.toolUseResult && typeof resultEntry.toolUseResult === 'object' && !Array.isArray(resultEntry.toolUseResult)
    ? resultEntry.toolUseResult : null;
  const tool = use.name;
  const cwd = entry.cwd || null;
  const rawFile = (tur && typeof tur.filePath === 'string' && tur.filePath) || input.file_path || input.notebook_path || null;
  const file = absolutize(rawFile, cwd);
  let newContent = null;
  let addedLines = [];
  let oldString = null;
  if (tool === 'Write') {
    newContent = typeof input.content === 'string' ? input.content : (tur && typeof tur.content === 'string' ? tur.content : null);
    addedLines = splitLines(newContent);
  } else if (tool === 'Edit') {
    oldString = typeof input.old_string === 'string' ? input.old_string : (tur && typeof tur.oldString === 'string' ? tur.oldString : null);
    const ns = typeof input.new_string === 'string' ? input.new_string : (tur && typeof tur.newString === 'string' ? tur.newString : null);
    addedLines = splitLines(ns);
  } else if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    for (const e of edits) if (e && typeof e.new_string === 'string') addedLines.push(...splitLines(e.new_string));
    oldString = edits.length ? edits.map((e) => (e && typeof e.old_string === 'string' ? e.old_string : '')).join('\n') : null;
  } else if (tool === 'NotebookEdit') {
    newContent = typeof input.new_source === 'string' ? input.new_source : null;
    addedLines = splitLines(newContent);
  }
  // structuredPatch '+' lines (post-edit truth) also count as added lines
  const sp = tur && Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null;
  if (sp) {
    const fromPatch = [];
    for (const h of sp) for (const l of (h && Array.isArray(h.lines) ? h.lines : [])) if (typeof l === 'string' && l.startsWith('+')) fromPatch.push(l.slice(1));
    if (!addedLines.length) addedLines = fromPatch;
  }
  const ev = baseEvent(entry, 'edit', { toolUseId: use.id });
  ev.edit = {
    tool,
    file,
    newContent,
    addedLines,
    oldString,
    structuredPatch: sp,
    originalFile: tur && typeof tur.originalFile === 'string' ? tur.originalFile : null,
    userModified: tur && typeof tur.userModified === 'boolean' ? tur.userModified : undefined,
  };
  ev.tool = { name: tool, input, result: resultEntry ? toolResultFromUserLine(resultEntry, block) : null };
  return ev;
}

function buildBashEvents(pending, resultEntry, block) {
  const { entry, blockUse: use } = pending;
  const input = use.input && typeof use.input === 'object' ? use.input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const cwd = entry.cwd || null;
  const events = [];
  const tur = resultEntry && resultEntry.toolUseResult && typeof resultEntry.toolUseResult === 'object' && !Array.isArray(resultEntry.toolUseResult)
    ? resultEntry.toolUseResult : null;
  const toolEv = baseEvent(entry, 'tool', { toolUseId: use.id });
  toolEv.tool = { name: 'Bash', input, result: resultEntry ? toolResultFromUserLine(resultEntry, block) : null };
  events.push(toolEv);

  const bed = tur && tur.bashEditDiff && typeof tur.bashEditDiff === 'object' ? tur.bashEditDiff : null;
  const bedFiles = bed && Array.isArray(bed.files) ? bed.files : null;
  if (bedFiles && !bed.unavailable) {
    const writeTargets = bedFiles.length ? extractWriteTargets(command, cwd) : [];
    for (const f of bedFiles) {
      if (!f || typeof f.filePath !== 'string') continue;
      const hunks = (Array.isArray(f.hunks) ? f.hunks : []).map((h) => ({
        oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines,
        lines: Array.isArray(h.lines) ? h.lines : [],
      }));
      const addedLines = [];
      for (const h of hunks) for (const l of h.lines) if (typeof l === 'string' && l.startsWith('+')) addedLines.push(l.slice(1));
      const file = absolutize(f.filePath, cwd);
      const ev = baseEvent(entry, 'shell_edit', { toolUseId: use.id });
      ev.edit = { tool: 'Bash', file, newContent: null, addedLines, command, source: bashEditDiffSource(command, file, cwd, writeTargets), hunks };
      if (f.created === true) ev.edit.created = true;
      if (f.deleted === true) ev.edit.deleted = true;
      events.push(ev);
    }
  } else {
    const failed = toolEv.tool.result && toolEv.tool.result.isError;
    if (!failed) {
      for (const file of extractWriteTargets(command, cwd)) {
        const ev = baseEvent(entry, 'shell_edit', { toolUseId: use.id });
        ev.edit = { tool: 'Bash', file, newContent: null, addedLines: [], command, source: 'regex' };
        events.push(ev);
      }
    }
  }
  if (isGitCommit(command)) {
    const ev = baseEvent(entry, 'commit', { toolUseId: use.id });
    ev.commit = { command, message: extractCommitMessage(command) };
    if (toolEv.tool.result) ev.commit.isError = toolEv.tool.result.isError;
    events.push(ev);
  }
  const pr = tur && tur.gitOperation && typeof tur.gitOperation === 'object' && tur.gitOperation.pr && typeof tur.gitOperation.pr === 'object'
    ? tur.gitOperation.pr : null;
  if (pr && Number.isFinite(Number(pr.number))) {
    const ev = baseEvent(resultEntry, 'pr_link', { toolUseId: use.id, ts: toolEv.ts });
    ev.pr_link = {
      prNumber: Number(pr.number),
      prUrl: typeof pr.url === 'string' ? pr.url : null,
      prRepository: repositoryFromPrUrl(pr.url),
      source: 'gitOperation',
    };
    events.push(ev);
  }
  return events;
}

function buildGenericToolEvent(pending, resultEntry, block) {
  const { entry, blockUse: use } = pending;
  const ev = baseEvent(entry, 'tool', { toolUseId: use.id });
  ev.tool = {
    name: use.name || null,
    input: use.input && typeof use.input === 'object' ? use.input : {},
    result: resultEntry ? toolResultFromUserLine(resultEntry, block) : null,
  };
  return ev;
}

function finalizeTool(pending, resultEntry, block) {
  const name = pending.blockUse.name;
  if (EDIT_TOOLS.has(name)) return [buildEditEvent(pending, resultEntry, block)];
  if (name === 'Bash') return buildBashEvents(pending, resultEntry, block);
  return [buildGenericToolEvent(pending, resultEntry, block)];
}

export function newStats() {
  return { lines: 0, parsed: 0, badLines: 0, events: 0, byType: {}, skipped: {}, toolUsesWithoutResult: 0, toolResultsWithoutUse: 0 };
}

function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

// Yields Events in completion order: non-tool events as soon as their line is
// read, tool-derived events when the matching tool_result line arrives (or at
// EOF with result null). readSession() sorts by ts.
export async function* readSessionEvents(jsonlPath, opts = {}) {
  const stats = opts.stats || newStats();
  opts.stats = stats;
  const fileSessionId = path.basename(jsonlPath).replace(/\.jsonl$/, '');
  const pendingTools = new Map(); // toolUseId -> { entry, blockUse }
  const meta = opts.meta || null;
  let lastTs = '';
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      stats.lines++;
      const line = rawLine.trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { stats.badLines++; continue; }
      if (!entry || typeof entry !== 'object') { stats.badLines++; continue; }
      stats.parsed++;
      if (!entry.sessionId) entry.sessionId = fileSessionId;
      if (typeof entry.timestamp === 'string') lastTs = entry.timestamp;
      if (meta) noteMeta(meta, entry);
      const t = entry.type;
      if (t === 'pr-link') {
        const n = Number(entry.prNumber);
        if (Number.isFinite(n)) {
          const ev = baseEvent(entry, 'pr_link', { ts: lastTs });
          ev.pr_link = {
            prNumber: n,
            prUrl: typeof entry.prUrl === 'string' ? entry.prUrl : null,
            prRepository: typeof entry.prRepository === 'string' ? entry.prRepository : repositoryFromPrUrl(entry.prUrl),
            source: 'pr-link',
          };
          yield countEvent(stats, ev);
        } else bump(stats.skipped, 'pr-link:invalid');
        continue;
      }
      if (t === 'assistant') {
        const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;
        if (!msg) { bump(stats.skipped, 'assistant:no-message'); continue; }
        if (msg.usage && typeof msg.usage === 'object') {
          const u = msg.usage;
          const ev = baseEvent(entry, 'usage');
          ev.usage = {
            model: typeof msg.model === 'string' ? msg.model : null,
            input: Number(u.input_tokens) || 0,
            output: Number(u.output_tokens) || 0,
            cacheWrite: Number(u.cache_creation_input_tokens) || 0,
            cacheRead: Number(u.cache_read_input_tokens) || 0,
          };
          // 1h cache writes are billed 2x input (cost.js); the 5m share is cacheWrite - cacheWrite1h
          const cc = u.cache_creation;
          if (cc && typeof cc === 'object' && Number(cc.ephemeral_1h_input_tokens) > 0) {
            ev.usage.cacheWrite1h = Number(cc.ephemeral_1h_input_tokens);
          }
          yield countEvent(stats, ev);
        }
        const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') {
            if (typeof b.text === 'string' && b.text.trim()) {
              const ev = baseEvent(entry, 'say');
              ev.say = { text: b.text };
              yield countEvent(stats, ev);
            }
          } else if (b.type === 'tool_use') {
            if (typeof b.id === 'string') pendingTools.set(b.id, { entry, blockUse: b });
            else bump(stats.skipped, 'tool_use:no-id');
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            bump(stats.skipped, 'thinking');
          } else {
            bump(stats.skipped, `assistant:${b.type}`);
          }
        }
        continue;
      }
      if (t === 'user') {
        const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;
        const content = msg && Array.isArray(msg.content) ? msg.content : null;
        let hadResult = false;
        if (content) {
          for (const b of content) {
            if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
            hadResult = true;
            const p = pendingTools.get(b.tool_use_id);
            if (!p) { stats.toolResultsWithoutUse++; continue; }
            pendingTools.delete(b.tool_use_id);
            for (const ev of finalizeTool(p, entry, b)) yield countEvent(stats, ev);
          }
        }
        if (!hadResult) bump(stats.skipped, 'user:prompt');
        continue;
      }
      bump(stats.skipped, t === undefined ? 'undefined' : String(t));
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  // tool uses whose result never arrived (interrupted session, tail cut)
  for (const p of pendingTools.values()) {
    stats.toolUsesWithoutResult++;
    for (const ev of finalizeTool(p, null, null)) yield countEvent(stats, ev);
  }
}

function countEvent(stats, ev) {
  stats.events++;
  bump(stats.byType, ev.type);
  return ev;
}

function noteMeta(meta, entry) {
  if (typeof entry.timestamp === 'string') {
    if (!meta.firstTs || entry.timestamp < meta.firstTs) meta.firstTs = entry.timestamp;
    if (!meta.lastTs || entry.timestamp > meta.lastTs) meta.lastTs = entry.timestamp;
  }
  if (!meta.cwd && typeof entry.cwd === 'string' && entry.cwd) meta.cwd = entry.cwd;
  if (typeof entry.version === 'string' && !meta.versions.includes(entry.version)) meta.versions.push(entry.version);
  if (typeof entry.gitBranch === 'string' && entry.gitBranch && !meta.gitBranches.includes(entry.gitBranch)) meta.gitBranches.push(entry.gitBranch);
  if (!meta.sessionId && typeof entry.sessionId === 'string' && entry.sessionId) meta.sessionId = entry.sessionId;
  if (!meta.agentId && typeof entry.agentId === 'string' && entry.agentId) meta.agentId = entry.agentId;
  if (entry.type === 'assistant' && entry.message && typeof entry.message.model === 'string' && !meta.models.includes(entry.message.model)) meta.models.push(entry.message.model);
}

export async function readSession(jsonlPath, opts = {}) {
  const abs = path.resolve(jsonlPath);
  const stats = opts.stats || newStats();
  const meta = { firstTs: null, lastTs: null, cwd: null, versions: [], gitBranches: [], models: [], sessionId: null, agentId: null };
  const events = [];
  for await (const ev of readSessionEvents(abs, { ...opts, stats, meta })) events.push(ev);
  // stable sort by ts (ISO strings compare lexicographically); events without ts keep position
  events.forEach((e, i) => { e._i = i; });
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a._i - b._i));
  for (const e of events) delete e._i;
  const sessionId = meta.sessionId || path.basename(abs).replace(/\.jsonl$/, '');
  const { sessionId: _s, agentId, ...metaOut } = meta;
  return { sessionId, agentId, path: abs, events, stats, meta: metaOut };
}
