// Markdown renderer for the PR comment. Consumes ONLY an Evidence object (see CONTRACT.md).
// Text-free by default: no intent quotes unless { quotes: true }. Byte-identical output for identical evidence.
//
// The comment is public, so it stays small and quotes as little agent text as
// possible: each hunk shows only the run that decided its status, and the
// deciding runs are listed once (command cut to 100 characters). GitHub rejects
// comments over 65,536 characters; the renderer degrades below `maxChars`
// (default 60,000) by dropping commands, then the per-hunk list.

import {
  renderTerminal,
  statusLabel,
  summarySentence,
  summaryParts,
  reproCommand,
  costLine,
  lastRunOf,
  runMarkers,
  fmtTime,
  fmtDateTime,
  hunkRange,
  truncate,
} from './render-terminal.js';

export { renderTerminal };

export const MD_MAX_CHARS = 60000;
const CMD_MAX = 100;

function mdEscapeCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdCode(s) {
  const str = String(s == null ? '' : s);
  // pick a fence longer than any backtick run inside
  const longest = (str.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(longest + 1);
  const padL = str.startsWith('`') ? ' ' : '';
  const padR = str.endsWith('`') ? ' ' : '';
  return `${fence}${padL}${str}${padR}${fence}`;
}

function mdQuoteLine(s) {
  return '> ' + String(s == null ? '' : s).replace(/\r?\n/g, ' ');
}

function hunkLink(h, blobBase) {
  const label = `${h.relFile || h.file}:${h.newStart}`;
  if (!blobBase) return mdCode(label);
  const base = String(blobBase).replace(/\/+$/, '');
  const rel = String(h.relFile || '').split('/').map(encodeURIComponent).join('/');
  return `[${mdEscapeCell(label)}](${base}/${rel}#L${h.newStart})`;
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s*\r?\n\s*/g, ' ⏎ ');
}

// "HH:MM:SS runner outcome (summary) · targeted · other checkout"
function decidedBy(h, r) {
  const bits = [fmtTime(r.ts), r.runner || 'run', r.outcome || 'unparsed'];
  if (r.summary) bits.push(`(${mdEscapeCell(r.summary)})`);
  const markers = runMarkers(h, r).trim().split(/\)\s*\(/).map((m) => m.replace(/^\(|\)$/g, '')).filter(Boolean);
  for (const m of markers) bits.push(`· ${m}`);
  return bits.join(' ');
}

function runKey(r) {
  return `${r.ts}|${r.command || ''}`;
}

function render(ev, { quotes, blobBase, level }) {
  const repo = ev.repo || {};
  const hunks = Array.isArray(ev.hunks) ? ev.hunks : [];
  const defs = ev.definitions || {};
  const where = Number.isInteger(repo.prNumber) ? `PR #${repo.prNumber}` : `${repo.base || '?'}...${repo.head || 'HEAD'}`;
  const parts = summaryParts(ev);
  const out = [];

  out.push(`### hunkproof · ${where}`);
  out.push('');
  out.push(`**${summarySentence(ev)}**`);
  out.push('');

  const unrun = hunks.filter((h) => h.status === 'UNRUN');
  if (unrun.length) {
    out.push(`**Unrun hunks** · edited by the agent, no run after the last edit`);
    out.push('');
    out.push('| Hunk | Lines | Last edit (UTC) | Rewrites | Attribution |');
    out.push('|---|---|---|---|---|');
    const shown = level >= 2 ? unrun.slice(0, 200) : unrun;
    for (const h of shown) {
      out.push(`| ${hunkLink(h, blobBase)} | ${hunkRange(h)} | ${fmtDateTime(h.lastEdit)} | ${h.churn ?? 0} | ${mdEscapeCell(h.attribution || '')} |`);
    }
    if (shown.length < unrun.length) out.push(`| … ${unrun.length - shown.length} more unrun hunks | | | | |`);
    out.push('');
  } else {
    out.push(`No unrun hunks: every attributed hunk had a run after its last edit (${parts.outcomes}).`);
    out.push('');
  }

  const unattributed = hunks.filter((h) => h.status === 'UNATTRIBUTED');
  if (unattributed.length) {
    const list = level >= 2 ? unattributed.slice(0, 50) : unattributed;
    const more = unattributed.length - list.length;
    out.push(`**Unattributed hunks** · ${unattributed.length}, no agent edit matched: ${list.map((h) => hunkLink(h, blobBase)).join(', ')}${more ? `, … ${more} more` : ''}`);
    out.push('');
  }

  const deciding = new Map(); // key -> run
  if (level < 2) {
    out.push('<details>');
    out.push(`<summary>All ${hunks.length} hunks with the run that decided their status</summary>`);
    out.push('');
    const byFile = new Map();
    for (const h of hunks) {
      const key = h.relFile || h.file || '?';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(h);
    }
    for (const [file, list] of byFile) {
      out.push(`**${mdCode(file)}**`);
      out.push('');
      for (const h of list) {
        const runs = Array.isArray(h.runsAfter) ? h.runsAfter : [];
        let head = `- ${hunkLink(h, blobBase)} ${hunkRange(h)}: ${statusLabel(h.status)}`;
        if ((h.churn ?? 0) >= 2) head += ` · rewritten ${h.churn} times`;
        if (h.attribution === 'FILE_LEVEL') head += ' · file-level match';
        if (h.status === 'UNATTRIBUTED') head += h.reason ? ` · no agent edit matched (${h.reason})` : ' · no agent edit matched';
        else if (!runs.length) head += ` · last edit ${fmtTime(h.lastEdit)} UTC`;
        else {
          head += ` · ${runs.length} ${runs.length === 1 ? 'run' : 'runs'} after last edit (${fmtTime(h.lastEdit)} UTC)`;
          const r = lastRunOf(h);
          if (r) {
            head += ` · decided by ${decidedBy(h, r)}`;
            if (!deciding.has(runKey(r))) deciding.set(runKey(r), r);
          }
        }
        out.push(head);
        if (quotes && h.intent && h.intent.text) {
          out.push('');
          out.push(`  ${mdQuoteLine(`agent: ${h.intent.text}`)}`);
          out.push('');
        }
      }
      out.push('');
    }
    out.push('</details>');
    out.push('');

    if (deciding.size) {
      const total = Array.isArray(ev.runs) ? ev.runs.length : null;
      out.push('<details>');
      out.push(`<summary>Deciding runs · ${deciding.size} distinct${total !== null ? ` of ${total} ${total === 1 ? 'run' : 'runs'} recorded` : ''}</summary>`);
      out.push('');
      for (const r of [...deciding.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
        const bits = [`- ${fmtTime(r.ts)}`, r.runner || 'run', r.outcome || 'unparsed'];
        if (level < 1 && r.command) bits.push(mdCode(truncate(oneLine(r.command), CMD_MAX)));
        if (r.summary) bits.push(`(${mdEscapeCell(r.summary)})`);
        out.push(bits.join(' '));
      }
      out.push('');
      out.push('</details>');
      out.push('');
    }
  } else {
    out.push(`_${hunks.length} hunks not listed here: the comment would exceed GitHub's size limit. Open hunkproof.html locally or run ${mdCode(reproCommand(ev))}._`);
    out.push('');
  }

  out.push('<details>');
  out.push('<summary>Definitions</summary>');
  out.push('');
  for (const key of ['hunk', 'attribution', 'run', 'status', 'targeted', 'cost']) {
    if (defs[key]) out.push(`- **${key}**: ${String(defs[key]).replace(/\r?\n/g, ' ')}`);
  }
  out.push('');
  out.push('</details>');
  out.push('');

  const sessions = Array.isArray(ev.sessions) ? ev.sessions : [];
  const sessionBits = sessions.length
    ? `${sessions.length} Claude Code ${sessions.length === 1 ? 'session' : 'sessions'} (${sessions.map((s) => String(s.sessionId || '').slice(0, 8)).join(', ')})`
    : 'no Claude Code session matched';
  out.push(`Reproduce locally: ${mdCode(reproCommand(ev))} · ${sessionBits} · ${costLine(ev)}`);
  out.push('');
  out.push(`<sub>hunkproof ${(ev.tool && ev.tool.version) || ''} · written ${fmtDateTime(ev.generatedAt)} · transcripts stay on the machine; this comment was redacted before posting; agent commands are quoted verbatim${ev.redaction && ev.redaction.note ? `, with one exception: ${ev.redaction.note}` : '.'}</sub>`);
  out.push('');
  return out.join('\n');
}

export function renderMarkdown(evidence, { quotes = false, blobBase = null, maxChars = MD_MAX_CHARS } = {}) {
  const ev = evidence || {};
  for (let level = 0; level <= 2; level++) {
    const md = render(ev, { quotes, blobBase, level });
    if (md.length <= maxChars || level === 2) return md;
  }
  return render(ev, { quotes, blobBase, level: 2 });
}
