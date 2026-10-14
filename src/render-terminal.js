// Terminal renderer + small formatting helpers shared by render-md.js and render-html.js.
// Consumes ONLY an Evidence object (see CONTRACT.md). Byte-identical output for identical evidence.

import { decidingRun } from './runs.js';

export const COST_LABEL_FALLBACK = 'what these tokens would cost at Anthropic API list prices; not a bill (subscription plans have no per-token charge)';

export const STATUS_LABEL = {
  RUN_PASS: 'ran, passed',
  RUN_FAIL: 'ran, failed',
  RUN_UNPARSED: 'ran, outcome not parsed',
  UNRUN: 'unrun',
  UNATTRIBUTED: 'unattributed',
};

export const STATUS_ORDER = ['RUN_PASS', 'RUN_FAIL', 'RUN_UNPARSED', 'UNRUN', 'UNATTRIBUTED'];

export function statusLabel(status) {
  return STATUS_LABEL[status] || String(status || 'unknown').toLowerCase();
}

/** 'HH:MM:SS' (UTC) from an ISO timestamp, or '' when missing. Pure string slicing: no timezone, no Date. */
export function fmtTime(ts) {
  if (typeof ts !== 'string' || ts.length < 19) return '';
  return ts.slice(11, 19);
}

/** 'YYYY-MM-DD' from an ISO timestamp, or '' when missing. */
export function fmtDate(ts) {
  if (typeof ts !== 'string' || ts.length < 10) return '';
  return ts.slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS UTC' */
export function fmtDateTime(ts) {
  const d = fmtDate(ts);
  const t = fmtTime(ts);
  if (!d) return '';
  return t ? `${d} ${t} UTC` : d;
}

/** Thousands separator with a plain comma; deterministic across locales. */
export function fmtInt(n) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, v < 0 ? '-' : '');
}

export function fmtUSD(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return `$${n.toFixed(2)}`;
}

export function fmtDuration(sec) {
  const s = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

export function plural(n, word, pluralWord = `${word}s`) {
  return n === 1 ? word : pluralWord;
}

/** The pieces of the one-sentence summary, so HTML can wrap the numbers. */
export function summaryParts(evidence) {
  const s = (evidence && evidence.summary) || {};
  const matched = s.matched ?? s.attributed ?? 0;
  const sessions = s.sessions ?? 0;
  return {
    ran: s.runAfterLastEdit ?? 0,
    matched,
    matchedWord: `line-matched ${plural(matched, 'hunk')}`,
    outcomes: `${s.runPass ?? 0} passed, ${s.runFail ?? 0} failed, ${s.runUnparsed ?? 0} outcome not parsed`,
    fileLevel: s.fileLevel ?? 0,
    unrun: s.unrun ?? 0,
    unattributed: s.unattributed ?? 0,
    sessions,
    sessionsWord: plural(sessions, 'session'),
    tokens: s.llmTokensUsedByHunkproof ?? 0,
  };
}

/** The one-sentence summary used by every renderer. */
export function summarySentence(evidence) {
  const p = summaryParts(evidence);
  return `${p.ran} of ${p.matched} ${p.matchedWord} had a run after their last edit (${p.outcomes}) · ${p.fileLevel} file-level (lines not matched to an edit) · ${p.unrun} unrun · ${p.unattributed} unattributed · ${p.sessions} ${p.sessionsWord} · hunkproof used ${p.tokens} LLM tokens`;
}

export function reproCommand(evidence) {
  // the refs are always printed: a receipt made with --pr N --base X --head Y
  // is not the one `--pr N` alone would make (the PR's merge range differs)
  const repo = (evidence && evidence.repo) || {};
  const parts = ['npx hunkproof'];
  if (Number.isInteger(repo.prNumber)) parts.push(`--pr ${repo.prNumber}`);
  if (repo.base) parts.push(`--base ${repo.base}`);
  if (repo.head) parts.push(`--head ${repo.head}`);
  return parts.join(' ');
}

/** Models whose tokens are in the counts but not in the dollar figure (no price entry). */
export function unpricedNote(evidence) {
  const u = (evidence && evidence.usage) || {};
  const list = Array.isArray(u.unpricedModels) ? u.unpricedModels.filter(Boolean) : [];
  if (!list.length) return '';
  return `${list.length} ${plural(list.length, 'model')} without a price entry excluded from the total (${list.join(', ')})`;
}

export function costLine(evidence) {
  const u = (evidence && evidence.usage) || {};
  const t = u.totals || {};
  const label = u.label || COST_LABEL_FALLBACK;
  const tokens = `${fmtInt(t.input || 0)} in · ${fmtInt(t.output || 0)} out · ${fmtInt(t.cacheWrite || 0)} cache write · ${fmtInt(t.cacheRead || 0)} cache read`;
  const unpriced = unpricedNote(evidence);
  return `Agent sessions: ${tokens} ≈ ${fmtUSD(u.costListUSD)} (${label}${u.priceListDate ? `, prices of ${u.priceListDate}` : ''})${unpriced ? ` · ${unpriced}` : ''}. Hunkproof itself: 0 LLM tokens.`;
}

export function hunkRange(h) {
  const nl = h.newLines ?? 0;
  return `+${h.newStart}${nl === 1 ? '' : `,${nl}`}`;
}

/** The run that decided the hunk's status (src/runs.js decidingRun), or null. */
export function lastRunOf(h) {
  const runs = Array.isArray(h.runsAfter) ? h.runsAfter : [];
  return decidingRun(runs);
}

/** The edit record that defines lastEdit (same ts), else the last listed edit. */
export function lastEditOf(h) {
  const edits = Array.isArray(h && h.edits) ? h.edits : [];
  if (!edits.length) return null;
  return edits.find((e) => e && e.ts === h.lastEdit) || edits[edits.length - 1];
}

/** Session id of the edit that defines lastEdit, else of the intent, else null. */
export function editSessionOf(h) {
  const e = lastEditOf(h);
  if (e && e.sessionId) return e.sessionId;
  return h && h.intent && h.intent.sessionId ? h.intent.sessionId : null;
}

/** ' (targeted)', ' (other checkout)', ' (other session)' markers of a run relative to a hunk. */
export function runMarkers(h, r) {
  const bits = [];
  if (r.targeted) bits.push('(targeted)');
  if (r.otherCheckout) bits.push('(other checkout)');
  const es = editSessionOf(h);
  if (es && r.sessionId && r.sessionId !== es) bits.push('(other session)');
  return bits.length ? ` ${bits.join(' ')}` : '';
}

/** HH:MM:SS when `ts` falls on the report's date, else the full UTC date and time. */
export function fmtWhen(ts, generatedAt) {
  if (generatedAt && fmtDate(ts) && fmtDate(ts) !== fmtDate(generatedAt)) return `${fmtDate(ts)} ${fmtTime(ts)}`;
  return fmtTime(ts);
}

export function lastRunCell(h, generatedAt = null) {
  const r = lastRunOf(h);
  if (!r) {
    if (h.status === 'UNATTRIBUTED') return h.reason ? `no agent edit matched (${h.reason})` : 'no agent edit matched';
    return h.lastEdit ? `none after edit at ${fmtWhen(h.lastEdit, generatedAt)}` : 'none';
  }
  return `${fmtWhen(r.ts, generatedAt)} ${r.runner || 'run'} ${r.outcome || 'unparsed'}${runMarkers(h, r)}`;
}

function pad(s, w) {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}

/** One headline line + a compact table (file, hunk, status, last run). Plain text, no ANSI. */
export function renderTerminal(evidence) {
  const ev = evidence || {};
  const repo = ev.repo || {};
  const where = Number.isInteger(repo.prNumber) ? `PR #${repo.prNumber}` : `${repo.base || '?'}...${repo.head || 'HEAD'}`;
  const headline = `hunkproof · ${where} · ${summarySentence(ev)}`;

  const hunks = Array.isArray(ev.hunks) ? ev.hunks : [];
  const status = (h) => `${statusLabel(h.status)}${h.attribution === 'FILE_LEVEL' ? ' (file-level)' : ''}`;
  const rows = hunks.map((h) => [h.relFile || h.file || '?', hunkRange(h), status(h), lastRunCell(h, ev.generatedAt)]);
  const header = ['file', 'hunk', 'status', 'last run (UTC)'];
  const widths = header.map((hd, i) => Math.max(hd.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]))).join('  ').trimEnd();
  const out = [headline, '', line(header), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(r));
  if (!rows.length) out.push('(no hunks in diff)');
  out.push('');
  out.push(costLine(ev));
  out.push(`Reproduce: ${reproCommand(ev)}`);
  return out.join('\n') + '\n';
}
