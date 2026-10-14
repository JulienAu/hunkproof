// Attribution: link each diff hunk to the transcript edit events that produced it.
// Pure, zero deps. Consumes Hunk[] (src/diff.js) and Event[] (src/transcript.js).
import path from 'node:path';
import { normalizeLine } from './diff.js';

const INTENT_MAX = 200;
// A text older than this before the edit is not about the edit any more, whatever else happened.
const INTENT_MAX_AGE_MS = 15 * 60 * 1000;

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function splitLines(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  return s.split(/\r?\n/);
}

/**
 * Rebuild the post-edit file from originalFile + structuredPatch (diff-style hunks).
 * Returns the new file's lines, or null when the inputs are unusable.
 */
export function applyStructuredPatch(originalFile, structuredPatch) {
  if (typeof originalFile !== 'string' || !Array.isArray(structuredPatch) || structuredPatch.length === 0) return null;
  const orig = splitLines(originalFile);
  const hunks = [...structuredPatch]
    .filter((h) => h && Number.isFinite(h.oldStart) && Array.isArray(h.lines))
    .sort((a, b) => a.oldStart - b.oldStart);
  if (hunks.length === 0) return null;
  const out = [];
  let cursor = 0; // index into orig (0-based)
  for (const h of hunks) {
    const start = Math.max(0, (h.oldStart || 1) - 1);
    if (start < cursor) return null; // overlapping hunks: give up, caller falls back to '+' lines
    for (; cursor < start && cursor < orig.length; cursor++) out.push(orig[cursor]);
    for (const l of h.lines) {
      const tag = l[0];
      const body = l.slice(1);
      if (tag === '+') out.push(body);
      else if (tag === ' ') { out.push(body); cursor += 1; }
      else if (tag === '-') { cursor += 1; }
      else if (tag === '\\') { /* no newline marker */ }
      else out.push(l);
    }
  }
  for (; cursor < orig.length; cursor++) out.push(orig[cursor]);
  return out;
}

/**
 * Normalized, non-empty set of "new content" lines an edit event contributed to its file.
 * Sources: edit.newContent, edit.addedLines, shell hunks ('+' lines), originalFile+structuredPatch.
 */
export function editContentLines(edit) {
  const set = new Set();
  const add = (line) => { const n = normalizeLine(line); if (n) set.add(n); };
  if (!edit) return set;
  for (const l of splitLines(edit.newContent)) add(l);
  if (Array.isArray(edit.addedLines)) for (const l of edit.addedLines) add(l);
  if (Array.isArray(edit.hunks)) {
    for (const h of edit.hunks) {
      if (!h || !Array.isArray(h.lines)) continue;
      for (const l of h.lines) if (typeof l === 'string' && l[0] === '+') add(l.slice(1));
    }
  }
  if (Array.isArray(edit.structuredPatch) && edit.structuredPatch.length) {
    const rebuilt = applyStructuredPatch(edit.originalFile, edit.structuredPatch);
    if (rebuilt) for (const l of rebuilt) add(l);
    else for (const h of edit.structuredPatch) {
      if (!h || !Array.isArray(h.lines)) continue;
      for (const l of h.lines) if (typeof l === 'string' && (l[0] === '+' || l[0] === ' ')) add(l.slice(1));
    }
  }
  return set;
}

function cutIntent(text) {
  const t = String(text ?? '').trim();
  if (t.length <= INTENT_MAX) return t;
  return `${t.slice(0, INTENT_MAX - 1).trimEnd()}…`;
}

// bashEditDiff entries the command cannot have written (a merge landing, a
// concurrent agent's edit seen by a polling loop) are not authorship.
const IGNORED_SOURCES = new Set(['bashEditDiff-git', 'bashEditDiff-uncorroborated']);
const TOOL_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function isEditEvent(ev) {
  if (!ev || (ev.type !== 'edit' && ev.type !== 'shell_edit') || !ev.edit || typeof ev.edit.file !== 'string') return false;
  return !IGNORED_SOURCES.has(ev.edit.source);
}

function editSummary(ev) {
  const e = { ts: ev.ts, sessionId: ev.sessionId, tool: ev.edit.tool, toolUseId: ev.toolUseId ?? null };
  if (ev.edit.source) e.source = ev.edit.source;
  if (typeof ev.edit.checkout === 'string' && ev.edit.checkout) e.checkout = ev.edit.checkout;
  return e;
}

function hasToolEdit(recs) {
  return recs.some((r) => TOOL_EDITS.has(r.ev.edit.tool));
}

function byTs(a, b) {
  if (a.ts === b.ts) return a.idx - b.idx;
  return a.ts < b.ts ? -1 : 1;
}

// Event types that are tool calls: a message holding one of these between the text and the edit
// means the agent moved on (ran something, read something, edited something else) and the text
// no longer describes the edit.
const CALL_TYPES = new Set(['edit', 'shell_edit', 'tool', 'run', 'commit']);

function isSay(ev) {
  return ev.type === 'say' && ev.say && typeof ev.say.text === 'string' && ev.say.text.trim() !== '';
}

function withinIntentWindow(sayTs, editTs) {
  const dt = Date.parse(editTs) - Date.parse(sayTs);
  return Number.isFinite(dt) && dt >= 0 && dt <= INTENT_MAX_AGE_MS;
}

function sayKey(ev) {
  return typeof ev.messageId === 'string' && ev.messageId ? `${ev.sessionId ?? ''}|${ev.messageId}` : null;
}

/**
 * Index events once: edit events with their content line sets, per-file lookup, and the intent
 * candidate of each edit.
 *
 * Intent rule (the agent's own words about THIS edit, nothing older):
 *  1. a `say` of the same session in the same assistant message as the edit's tool_use always
 *     qualifies (the same turn), whatever the timestamps;
 *  2. otherwise the last preceding `say` of the same session qualifies when it is at most
 *     INTENT_MAX_AGE_MS before the edit AND no tool call of that session sits between them in a
 *     third message (tool calls in the say's own message or in the edit's own message are fine:
 *     "text, Read, Edit" in one turn, or a text-only turn followed by a tool turn);
 *  3. else null. Events without a messageId (older transcripts, synthetic fixtures) cannot be told
 *     apart by message, so only the time cap applies to them.
 * Array order is file order (chronological); sessions are told apart by sessionId, which the CLI
 * sets to the agentId for subagent transcripts, so a parent's text never lands on a child's edit.
 */
function indexEvents(events) {
  const lastSay = new Map(); // sessionId -> { say: {text, ts, sessionId}, messageId, otherMessages: Set }
  const sayByMessage = new Map(); // `${sessionId}|${messageId}` -> first say of that message
  const edits = []; // { ev, idx, ts, lines, intent, file }
  const byFile = new Map(); // absolute path -> edits[]
  events.forEach((ev, idx) => {
    if (!ev) return;
    if (isSay(ev)) {
      const say = { text: cutIntent(ev.say.text), ts: ev.ts, sessionId: ev.sessionId };
      lastSay.set(ev.sessionId, { say, messageId: ev.messageId ?? null, otherMessages: new Set() });
      const key = sayKey(ev);
      if (key && !sayByMessage.has(key)) sayByMessage.set(key, say);
      return;
    }
    const state = CALL_TYPES.has(ev.type) ? lastSay.get(ev.sessionId) : undefined;
    if (state && (ev.messageId ?? null) !== state.messageId) state.otherMessages.add(ev.messageId ?? null);
    if (!isEditEvent(ev)) return;
    let intent = null;
    if (state && withinIntentWindow(state.say.ts, ev.ts)) {
      // every tool call since the text belongs to this edit's own message: adjacent turns
      let adjacent = true;
      for (const m of state.otherMessages) if (m !== (ev.messageId ?? null)) { adjacent = false; break; }
      if (adjacent) intent = state.say;
    }
    const rec = {
      ev, idx,
      ts: ev.ts ?? '',
      lines: null, // lazy
      intent,
      file: path.resolve(ev.edit.file),
    };
    edits.push(rec);
    if (!byFile.has(rec.file)) byFile.set(rec.file, []);
    byFile.get(rec.file).push(rec);
  });
  // Same-message text wins even when its line was written after the tool_use line.
  for (const rec of edits) {
    const key = sayKey(rec.ev);
    const same = key ? sayByMessage.get(key) : undefined;
    if (same) rec.intent = same;
  }
  return { edits, byFile };
}

function linesOf(rec) {
  if (!rec.lines) rec.lines = editContentLines(rec.ev.edit);
  return rec.lines;
}

/**
 * attributeHunks(hunks, events, { threshold, since }) => AttributedHunk[]
 * - MATCHED: best edit chain (edits on the file within one session) contains >= threshold share of the
 *   hunk's non-empty normalized added lines. Ties go to a chain with an Edit/Write/MultiEdit/NotebookEdit
 *   event, then to the later chain.
 * - FILE_LEVEL: some edit/shell_edit touched the file (or its pre-rename path) but lines did not match
 *   (incl. deletion-only hunks, which have nothing to match on).
 * - UNATTRIBUTED: no edit event touched the file; also a FILE_LEVEL hunk whose every candidate edit
 *   predates `since` (the branch base commit time), with reason 'only edits before the branch base'.
 * `edits` lists every overlapping edit across sessions (MATCHED) or every edit of the file (FILE_LEVEL),
 * sorted by ts, each flagged chain: true when it belongs to the winning chain; `lastEdit` is therefore
 * always the ts of one listed edit. `checkout` is the checkout of that last edit when events carry one.
 * `intent` is the text the agent wrote for the last edit of the winning chain (MATCHED) or the last
 * edit of the file (FILE_LEVEL), under the rule described at indexEvents; null when nothing qualifies.
 */
export function attributeHunks(hunks, events, { threshold = 0.6, since = null } = {}) {
  const { byFile } = indexEvents(Array.isArray(events) ? events : []);
  const out = [];
  for (const hunk of hunks || []) {
    const candidates = [];
    const seen = new Set();
    for (const f of [hunk.file, hunk.oldFile]) {
      if (!f) continue;
      for (const rec of byFile.get(path.resolve(f)) || []) {
        if (seen.has(rec)) continue;
        seen.add(rec);
        candidates.push(rec);
      }
    }
    candidates.sort(byTs);

    const targets = (hunk.addedNormalized || hunk.added?.map(normalizeLine) || []).filter(Boolean);
    const total = targets.length;

    // Per-edit overlap: which target lines does each edit carry?
    const overlap = new Map(); // rec -> count of target lines found
    for (const rec of candidates) {
      if (total === 0) break;
      const ls = linesOf(rec);
      let n = 0;
      for (const t of targets) if (ls.has(t)) n += 1;
      if (n > 0) overlap.set(rec, n);
    }

    // Chains: group candidate edits by session; chain score = share of targets found in the union.
    let best = { score: 0, recs: [], session: null };
    if (total > 0 && overlap.size > 0) {
      const bySession = new Map();
      for (const rec of overlap.keys()) {
        const key = rec.ev.sessionId ?? '';
        if (!bySession.has(key)) bySession.set(key, []);
        bySession.get(key).push(rec);
      }
      for (const [session, recs] of bySession) {
        let found = 0;
        for (const t of targets) if (recs.some((r) => linesOf(r).has(t))) found += 1;
        const score = found / total;
        const lastTs = recs[recs.length - 1].ts;
        const bestLast = best.recs.length ? best.recs[best.recs.length - 1].ts : '';
        let better = score > best.score;
        if (!better && score === best.score && best.recs.length) {
          // same share: a chain with a tool edit (Edit/Write/...) beats one made of shell edits only,
          // then the later chain wins
          const toolHere = hasToolEdit(recs);
          const toolBest = hasToolEdit(best.recs);
          if (toolHere !== toolBest) better = toolHere;
          else better = lastTs > bestLast;
        }
        if (better) best = { score, recs, session };
      }
    }

    const touched = candidates.length > 0;
    let attribution = 'UNATTRIBUTED';
    let reason;
    if (touched && total > 0 && best.score >= threshold) attribution = 'MATCHED';
    else if (touched) attribution = 'FILE_LEVEL';
    if (attribution === 'FILE_LEVEL' && typeof since === 'string' && since && candidates.every((r) => r.ts && r.ts < since)) {
      // the file was only touched before the branch existed: whatever produced these lines left no trace
      attribution = 'UNATTRIBUTED';
      reason = 'only edits before the branch base';
    }

    const overlapping = candidates.filter((r) => overlap.has(r));
    const churn = total === 0 ? candidates.length : overlapping.length;

    let edits = [];
    let anchor = null; // the edit whose preceding `say` becomes the intent
    let lastEdit = null;
    let lastRec = null;
    if (attribution === 'MATCHED') {
      const chain = new Set(best.recs);
      edits = overlapping.map((r) => ({ ...editSummary(r.ev), chain: chain.has(r) }));
      anchor = best.recs[best.recs.length - 1];
      lastRec = overlapping[overlapping.length - 1];
    } else if (attribution === 'FILE_LEVEL') {
      edits = candidates.map((r) => ({ ...editSummary(r.ev), chain: true }));
      anchor = candidates[candidates.length - 1];
      lastRec = anchor;
    }
    if (lastRec) lastEdit = lastRec.ts || null;

    const attributed = {
      ...hunk,
      attribution,
      score: Number(best.score.toFixed(4)),
      edits,
      churn,
      lastEdit,
      intent: anchor && anchor.intent ? { ...anchor.intent } : null,
    };
    if (reason) attributed.reason = reason;
    if (lastRec && typeof lastRec.ev.edit.checkout === 'string' && lastRec.ev.edit.checkout) attributed.checkout = lastRec.ev.edit.checkout;
    out.push(attributed);
  }
  return out;
}
