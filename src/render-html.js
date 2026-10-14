// HTML renderer: one self-contained file, no CDN, no external fonts, inline CSS + ~40 lines of JS.
// Consumes ONLY an Evidence object (see CONTRACT.md). Byte-identical output for identical evidence.

import {
  STATUS_ORDER,
  statusLabel,
  summaryParts,
  reproCommand,
  costLine,
  unpricedNote,
  runMarkers,
  lastEditOf,
  fmtTime,
  fmtDate,
  fmtDateTime,
  fmtInt,
  fmtUSD,
  fmtDuration,
  truncate,
  plural,
  COST_LABEL_FALLBACK,
} from './render-terminal.js';

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escapeHtml;

const LIGHT = `
  --bg: #fcfcfb; --bg-2: #f4f4f1; --panel: #ffffff; --ink: #1b1b1a; --ink-2: #4d4d49; --ink-3: #7b7b75;
  --hair: #e3e2dc; --hair-2: #cfcec7; --accent: #2d5bd3; --accent-ink: #ffffff;
  --add-bg: #e6f6ea; --add-ink: #11602b; --add-gutter: #c7ead1;
  --del-bg: #fdeceb; --del-ink: #9b1d1a; --del-gutter: #f3cfcd;
  --pass: #1a7f37; --pass-bg: #dcf1e2; --fail: #c42b2b; --fail-bg: #fbe2e1;
  --unparsed: #6b6b66; --unparsed-bg: #ebebe7; --unrun: #d0481f; --unrun-bg: #fde7df;
  --unattr: #6b6b66; --unattr-bg: transparent;
  --shadow: 0 1px 0 rgba(0,0,0,.04), 0 6px 20px -12px rgba(0,0,0,.18);`;

const DARK = `
  --bg: #121311; --bg-2: #181917; --panel: #1b1c1a; --ink: #ebeae4; --ink-2: #b4b3ab; --ink-3: #85857d;
  --hair: #2c2d2a; --hair-2: #3a3b37; --accent: #7fa4ff; --accent-ink: #0c1220;
  --add-bg: #15301d; --add-ink: #8fd9a3; --add-gutter: #1d4228;
  --del-bg: #3a1817; --del-ink: #ff9d98; --del-gutter: #52211f;
  --pass: #4fc46f; --pass-bg: #163522; --fail: #ff7b72; --fail-bg: #3d1a1a;
  --unparsed: #a3a39c; --unparsed-bg: #2a2b28; --unrun: #ff8a5b; --unrun-bg: #3f2015;
  --unattr: #a3a39c; --unattr-bg: transparent;
  --shadow: 0 1px 0 rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);`;

function themeCss(theme) {
  if (theme === 'dark') return `:root{${DARK}}`;
  if (theme === 'light') return `:root{${LIGHT}}`;
  return `:root{${LIGHT}}\n@media (prefers-color-scheme: dark){:root{${DARK}}}`;
}

const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-feature-settings:"tnum" 1}
code,pre,kbd,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
@media (max-width:600px){.wrap{padding:0 16px}header.top{padding:18px 16px 12px}}

header.top{padding:22px 20px 14px;display:flex;flex-wrap:wrap;gap:8px 28px;align-items:baseline;justify-content:space-between}
.brand{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.brand h1{font-size:19px;margin:0;font-weight:650;letter-spacing:-.01em}
.brand .pr{color:var(--ink-2);font-size:14px}
.brand .pr a{color:inherit;border-bottom:1px solid var(--hair-2)}
.meta{color:var(--ink-3);font-size:12.5px;display:flex;flex-wrap:wrap;gap:4px 14px}
.meta .mono{font-size:12px}

.bar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:saturate(1.4) blur(8px);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.bar .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;padding-top:9px;padding-bottom:9px}
.bar .sentence{font-size:14px;font-weight:550;margin:0;flex:1 1 420px;min-width:0}
.bar .sentence b{font-weight:650;color:var(--ink)}
.bar .sentence .sep{color:var(--ink-3);font-weight:400;white-space:pre}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.chip{appearance:none;border:1px solid var(--hair-2);background:var(--panel);color:var(--ink-2);border-radius:999px;padding:3px 10px;font:inherit;font-size:12.5px;line-height:1.3;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.chip .n{color:var(--ink-3);font-variant-numeric:tabular-nums}
.chip:hover{border-color:var(--ink-3)}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chip[aria-pressed="true"] .n{color:inherit;opacity:.75}

main{padding:22px 0 40px}
.empty{display:none;padding:28px 0;color:var(--ink-3);text-align:center}
main[data-empty="1"] .empty{display:block}

section.file{margin:0 0 28px;border:1px solid var(--hair);border-radius:8px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden}
section.file[hidden]{display:none}
.filehead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:10px 14px;background:var(--bg-2);border-bottom:1px solid var(--hair)}
.filehead h2{margin:0;font-size:13px;font-weight:600;word-break:break-all}
.filehead .counts{color:var(--ink-3);font-size:12px;margin-left:auto;display:flex;gap:10px;flex-wrap:wrap}
.filehead .counts span b{font-weight:600;color:var(--ink-2)}

article.hunk{border-top:1px solid var(--hair);padding:14px 14px 12px}
article.hunk:first-of-type{border-top:0}
article.hunk[hidden]{display:none}
.hunkhead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:10px}
.range{color:var(--ink-3);font-size:12px}
.range b{color:var(--ink-2);font-weight:600}
.tag{font-size:11.5px;line-height:1.3;padding:2px 7px;border-radius:4px;border:1px solid var(--hair-2);color:var(--ink-2);background:var(--bg-2);white-space:nowrap}
.tag.churn{color:var(--unrun);border-color:var(--unrun);background:var(--unrun-bg)}
.badge{font-size:11.5px;font-weight:600;letter-spacing:.01em;line-height:1.3;padding:2px 8px;border-radius:4px;border:1px solid transparent;white-space:nowrap;margin-left:auto}
.badge::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:currentColor;vertical-align:1px}
.badge[data-s="RUN_PASS"]{color:var(--pass);background:var(--pass-bg);border-color:transparent}
.badge[data-s="RUN_FAIL"]{color:var(--fail);background:var(--fail-bg)}
.badge[data-s="RUN_UNPARSED"]{color:var(--unparsed);background:var(--unparsed-bg)}
.badge[data-s="UNRUN"]{color:var(--unrun);background:var(--unrun-bg)}
.badge[data-s="UNATTRIBUTED"]{color:var(--unattr);background:var(--unattr-bg);border:1px dashed var(--unattr)}
.badge[data-s="UNATTRIBUTED"]::before{background:transparent;border:1.5px dashed currentColor;width:5px;height:5px}

.grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px 18px;align-items:start}
@media (max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}}
pre.code{margin:0;border:1px solid var(--hair);border-radius:6px;overflow-x:auto;background:var(--bg);padding:0;line-height:1.55;tab-size:4}
pre.code .l{display:block;white-space:pre;padding:0 10px 0 0;min-width:max-content}
pre.code .l .g{display:inline-block;width:26px;text-align:center;color:var(--ink-3);user-select:none;border-right:1px solid var(--hair);margin-right:10px}
pre.code .l.add{background:var(--add-bg);color:var(--add-ink)}
pre.code .l.add .g{background:var(--add-gutter);color:var(--add-ink);border-color:transparent}
pre.code .l.del{background:var(--del-bg);color:var(--del-ink)}
pre.code .l.del .g{background:var(--del-gutter);color:var(--del-ink);border-color:transparent}
pre.code .l.ctx{color:var(--ink-3)}

aside.note{color:var(--ink-3);font-size:12.5px;line-height:1.5;border-left:2px solid var(--hair-2);padding:2px 0 2px 12px;margin:0;word-wrap:break-word}
aside.note .who{color:var(--ink-2);font-weight:600}
aside.note .when{display:block;margin-top:4px;font-size:11.5px}
aside.note.none{font-style:italic;border-left-style:dashed}
@media (max-width:900px){aside.note{order:-1;border-left:0;padding:0 0 0 0;border-bottom:1px dashed var(--hair-2);padding-bottom:8px}}

ol.runs{list-style:none;margin:10px 0 0;padding:0;border-top:1px dashed var(--hair);grid-column:1/-1}
ol.runs li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 0 0;font-size:12.5px;color:var(--ink-2)}
ol.runs .t{color:var(--ink-3);font-size:12px;min-width:62px}
ol.runs .dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;position:relative;top:0}
ol.runs .dot[data-o="pass"]{background:var(--pass)}
ol.runs .dot[data-o="fail"]{background:var(--fail)}
ol.runs .dot[data-o="unparsed"]{background:transparent;border:1.5px solid var(--unparsed);width:7px;height:7px}
ol.runs .runner{font-weight:600;color:var(--ink)}
ol.runs .cmd{color:var(--ink-2);word-break:break-all}
ol.runs .out{color:var(--ink-3)}
ol.runs .tgt{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);border:1px solid currentColor;border-radius:3px;padding:0 5px;line-height:1.5}
ol.runs .tgt.other{color:var(--unrun)}
footer .receipt .noprice{color:var(--unrun);font-size:12px}
ol.runs li.none{color:var(--ink-3);font-style:italic}
ol.runs li.none[data-s="UNRUN"]{color:var(--unrun);font-style:normal}

footer{border-top:1px solid var(--hair);padding:22px 0 40px;color:var(--ink-2);font-size:13px}
footer h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin:18px 0 8px;font-weight:600}
footer .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 36px}
footer dl{margin:0}
footer dt{font-weight:600;color:var(--ink);margin-top:8px}
footer dd{margin:2px 0 0}
footer .receipt{border:1px solid var(--hair);border-radius:6px;background:var(--panel);padding:12px 14px;margin-top:6px}
footer .receipt .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dashed var(--hair)}
footer .receipt .row:last-child{border-bottom:0}
footer .receipt .row span:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
footer .receipt .total{font-weight:650;color:var(--ink)}
footer .receipt .label{color:var(--ink-3);font-size:12px;margin-top:8px}
footer .repro{display:inline-block;background:var(--ink);color:var(--bg);padding:6px 10px;border-radius:5px;margin-top:4px;user-select:all}
footer .scroll{overflow-x:auto;max-width:100%}
footer table{border-collapse:collapse;width:100%;font-size:12.5px}
@media (max-width:600px){footer .receipt .row{flex-wrap:wrap}footer .receipt .row span:last-child{white-space:normal;text-align:left}}
footer td,footer th{text-align:left;padding:5px 8px 5px 0;border-bottom:1px solid var(--hair);vertical-align:top}
footer th{color:var(--ink-3);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em}
footer td.mono{word-break:break-all}
footer .fine{color:var(--ink-3);font-size:12px;margin-top:22px}
`;

// Filter chips. Kept small on purpose: no framework, no fetch, no storage.
const JS = `
(function(){
  var chips=document.querySelectorAll('.chip');
  var hunks=document.querySelectorAll('article.hunk');
  var files=document.querySelectorAll('section.file');
  var main=document.querySelector('main');
  function matches(status,f){
    if(f==='all')return true;
    if(f==='unrun')return status==='UNRUN';
    if(f==='fail')return status==='RUN_FAIL';
    if(f==='unparsed')return status==='RUN_UNPARSED';
    if(f==='unattributed')return status==='UNATTRIBUTED';
    return true;
  }
  function apply(f){
    var shown=0;
    for(var i=0;i<hunks.length;i++){
      var ok=matches(hunks[i].getAttribute('data-status'),f);
      hunks[i].hidden=!ok; if(ok)shown++;
    }
    for(var j=0;j<files.length;j++){
      files[j].hidden=!files[j].querySelector('article.hunk:not([hidden])');
    }
    for(var k=0;k<chips.length;k++){
      chips[k].setAttribute('aria-pressed',chips[k].getAttribute('data-filter')===f?'true':'false');
    }
    main.setAttribute('data-empty',shown?'0':'1');
    if(history.replaceState){history.replaceState(null,'',f==='all'?location.pathname:'#'+f);}
  }
  for(var c=0;c<chips.length;c++){
    chips[c].addEventListener('click',function(e){apply(e.currentTarget.getAttribute('data-filter'));});
  }
  var h=(location.hash||'').slice(1);
  apply(/^(unrun|fail|unparsed|unattributed)$/.test(h)?h:'all');
})();
`;

// Same words as summarySentence(), with the numbers wrapped in <b>.
function sentenceHtml(evidence) {
  const p = summaryParts(evidence);
  const sep = '<span class="sep"> · </span>';
  return `<b>${p.ran} of ${p.matched}</b> ${esc(p.matchedWord)} had a run after their last edit (${esc(p.outcomes)})${sep}<b>${p.fileLevel}</b> file-level (lines not matched to an edit)${sep}<b>${p.unrun}</b> unrun${sep}<b>${p.unattributed}</b> unattributed${sep}<b>${p.sessions}</b> ${esc(p.sessionsWord)}${sep}hunkproof used <b>${p.tokens}</b> LLM tokens`;
}

function chipsHtml(hunks) {
  const count = (pred) => hunks.filter(pred).length;
  const chips = [
    ['all', 'All', hunks.length],
    ['unrun', 'Unrun', count((h) => h.status === 'UNRUN')],
    ['fail', 'Ran, failed', count((h) => h.status === 'RUN_FAIL')],
    ['unparsed', 'Outcome not parsed', count((h) => h.status === 'RUN_UNPARSED')],
    ['unattributed', 'Unattributed', count((h) => h.status === 'UNATTRIBUTED')],
  ];
  return `<ul class="chips" aria-label="Filter hunks">${chips
    .map(([f, label, n]) => `<li><button type="button" class="chip" data-filter="${f}" aria-pressed="${f === 'all' ? 'true' : 'false'}">${esc(label)}<span class="n">${n}</span></button></li>`)
    .join('')}</ul>`;
}

function codeHtml(h) {
  const removed = Array.isArray(h.removed) ? h.removed : [];
  const added = Array.isArray(h.added) ? h.added : [];
  const lines = [];
  for (const l of removed) lines.push(`<span class="l del"><span class="g">-</span>${esc(l)}</span>`);
  for (const l of added) lines.push(`<span class="l add"><span class="g">+</span>${esc(l)}</span>`);
  if (!lines.length) lines.push('<span class="l ctx"><span class="g"> </span>(no line content in diff)</span>');
  return `<pre class="code" aria-label="diff lines">${lines.join('')}</pre>`;
}

function noteHtml(h) {
  if (h.status === 'UNATTRIBUTED' || !h.intent || !h.intent.text) {
    const why = h.status === 'UNATTRIBUTED' ? 'no agent edit matched this hunk' : 'no agent text in this turn';
    return `<aside class="note none mono">${esc(why)}</aside>`;
  }
  const i = h.intent;
  const when = i.ts ? `<span class="when">${esc(fmtTime(i.ts))} UTC · session ${esc(String(i.sessionId || '').slice(0, 8))}</span>` : '';
  return `<aside class="note mono"><span class="who">agent:</span> ${esc(i.text)}${when}</aside>`;
}

function runsHtml(h) {
  const runs = Array.isArray(h.runsAfter) ? h.runsAfter : [];
  if (!runs.length) {
    const msg = h.status === 'UNATTRIBUTED'
      ? 'no agent edit matched this hunk, so there is no edit to count runs from'
      : `no run after the last edit${h.lastEdit ? ` (${esc(fmtTime(h.lastEdit))} UTC)` : ''}`;
    return `<ol class="runs"><li class="none" data-s="${esc(h.status)}">${msg}</li></ol>`;
  }
  const items = runs.map((r) => {
    const outcome = r.outcome || 'unparsed';
    const out = r.summary ? esc(r.summary) : (outcome === 'unparsed' ? 'outcome not parsed' : outcome);
    const markers = runMarkers(h, r).trim().split(/\)\s*\(/).map((m) => m.replace(/^\(|\)$/g, '')).filter(Boolean);
    const tags = markers.map((m) => `<span class="tgt${m === 'targeted' ? '' : ' other'}">${esc(m)}</span>`).join('');
    return `<li><span class="t mono">${esc(fmtTime(r.ts))}</span><span class="dot" data-o="${esc(outcome)}" title="${esc(outcome)}"></span><span class="runner">${esc(r.runner || 'run')}</span><code class="cmd" title="${esc(r.command || '')}">${esc(truncate(r.command || '', 72))}</code><span class="out">${out}</span>${tags}</li>`;
  });
  return `<ol class="runs" aria-label="runs after last edit">${items.join('')}</ol>`;
}

function hunkHtml(h) {
  const churn = h.churn ?? 0;
  const oldPart = `-${h.oldStart ?? 0}${(h.oldLines ?? 0) === 1 ? '' : `,${h.oldLines ?? 0}`}`;
  const newPart = `+${h.newStart ?? 0}${(h.newLines ?? 0) === 1 ? '' : `,${h.newLines ?? 0}`}`;
  const tags = [];
  if (churn >= 2) tags.push(`<span class="tag churn">rewritten ${churn} times</span>`);
  if (h.attribution === 'FILE_LEVEL') tags.push('<span class="tag" title="the file matched an agent edit, the lines did not">file-level match</span>');
  if (h.status === 'UNATTRIBUTED' && h.reason) tags.push(`<span class="tag" title="why no edit is attributed">${esc(h.reason)}</span>`);
  if (h.lastEdit) {
    const e = lastEditOf(h);
    const who = e && e.sessionId ? ` · ${esc(String(e.sessionId).slice(0, 8))}${e.tool ? ` ${esc(e.tool)}` : ''}` : '';
    tags.push(`<span class="tag mono" title="last agent edit of these lines: time UTC · session · tool">edit ${esc(fmtTime(h.lastEdit))}${who}</span>`);
  }
  return `<article class="hunk" id="${esc(anchorId(h))}" data-status="${esc(h.status)}">
<div class="hunkhead"><span class="range mono">@@ ${esc(oldPart)} <b>${esc(newPart)}</b> @@</span>${tags.join('')}<span class="badge" data-s="${esc(h.status)}">${esc(statusLabel(h.status))}</span></div>
<div class="grid">${codeHtml(h)}${noteHtml(h)}${runsHtml(h)}</div>
</article>`;
}

function anchorId(h) {
  return 'h-' + String(h.id || `${h.relFile}:${h.newStart}`).replace(/[^A-Za-z0-9_-]+/g, '-');
}

function fileSectionHtml(file, list) {
  const counts = {};
  for (const h of list) counts[h.status] = (counts[h.status] || 0) + 1;
  const countBits = STATUS_ORDER.filter((s) => counts[s]).map((s) => `<span><b>${counts[s]}</b> ${esc(statusLabel(s))}</span>`);
  return `<section class="file" data-file="${esc(file)}">
<div class="filehead"><h2 class="mono">${esc(file)}</h2><div class="counts"><span><b>${list.length}</b> ${plural(list.length, 'hunk')}</span>${countBits.join('')}</div></div>
${list.map(hunkHtml).join('\n')}
</section>`;
}

function receiptHtml(evidence) {
  const u = evidence.usage || {};
  const byModel = u.byModel || {};
  const t = u.totals || {};
  const costByModel = u.costByModel || {};
  const unpriced = new Set(Array.isArray(u.unpricedModels) ? u.unpricedModels : []);
  const rows = Object.keys(byModel).sort().map((m) => {
    const x = byModel[m] || {};
    const noPrice = unpriced.has(m) || costByModel[m] === null;
    return `<div class="row"><span class="mono">${esc(m)}${noPrice ? ' <span class="noprice">no price entry</span>' : ''}</span><span>${fmtInt(x.input || 0)} in · ${fmtInt(x.output || 0)} out · ${fmtInt((x.cacheWrite || 0) + (x.cacheRead || 0))} cache</span></div>`;
  });
  rows.push(`<div class="row"><span>Agent sessions, ${fmtInt(t.messages || 0)} API ${plural(t.messages || 0, 'message')}</span><span>${fmtInt(t.input || 0)} in · ${fmtInt(t.output || 0)} out</span></div>`);
  rows.push(`<div class="row total"><span>At API list prices${u.priceListDate ? ` (prices of ${esc(u.priceListDate)})` : ''}</span><span>${esc(fmtUSD(u.costListUSD))}</span></div>`);
  const note = unpricedNote(evidence);
  if (note) rows.push(`<div class="row"><span class="noprice">${esc(note)}</span><span></span></div>`);
  rows.push(`<div class="row total"><span>Hunkproof itself</span><span>0 LLM tokens · $0.00</span></div>`);
  return `<div class="receipt">${rows.join('')}<div class="label">${esc(u.label || COST_LABEL_FALLBACK)}</div></div>`;
}

function sessionsHtml(sessions) {
  if (!sessions.length) return '<p class="fine">No Claude Code session matched this diff; every hunk is unattributed.</p>';
  const rows = sessions.map((s) => `<tr><td class="mono">${esc(String(s.sessionId || '').slice(0, 8))}</td><td>${esc(fmtDateTime(s.firstTs))}<br>${esc(fmtDuration((Date.parse(s.lastTs) - Date.parse(s.firstTs)) / 1000))}</td><td>${esc(s.edits ?? 0)} + ${esc(s.shellEdits ?? 0)} shell</td><td>${esc(s.runs ?? 0)}</td><td class="mono">${esc((s.versions || []).join(', '))}<br>${esc((s.models || []).join(', '))}</td><td class="mono">${esc(s.path || '')}</td></tr>`);
  return `<div class="scroll"><table><thead><tr><th>session</th><th>start · length</th><th>edits</th><th>runs</th><th>claude code · models</th><th>transcript</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export function renderHtml(evidence, { theme = 'auto' } = {}) {
  const ev = evidence || {};
  const repo = ev.repo || {};
  const hunks = Array.isArray(ev.hunks) ? ev.hunks : [];
  const sessions = Array.isArray(ev.sessions) ? ev.sessions : [];
  const defs = ev.definitions || {};
  const s = ev.summary || {};

  const byFile = new Map();
  for (const h of hunks) {
    const key = h.relFile || h.file || '?';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(h);
  }

  const prText = Number.isInteger(repo.prNumber) ? `PR #${repo.prNumber}` : null;
  const repoName = repo.remote ? String(repo.remote).replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1') : (repo.root || '');
  const title = `hunkproof · ${prText || `${repo.base || '?'}...${repo.head || 'HEAD'}`}${repoName ? ` · ${repoName}` : ''}`;
  const prHtml = prText
    ? (repo.prUrl ? `<a href="${esc(repo.prUrl)}" rel="noopener">${esc(prText)}</a>` : esc(prText))
    : '';

  const defOrder = ['hunk', 'attribution', 'run', 'status', 'targeted', 'cost'];
  const defsHtml = defOrder.filter((k) => defs[k]).map((k) => `<dt>${esc(k)}</dt><dd>${esc(defs[k])}</dd>`).join('');

  return `<!doctype html>
<html lang="en"${theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'light dark'}">
<title>${esc(title)}</title>
<style>${themeCss(theme)}${CSS}</style>
</head>
<body>
<header class="top wrap">
<div class="brand"><h1>hunkproof</h1>${prHtml ? `<span class="pr">${prHtml}</span>` : ''}${repoName ? `<span class="pr mono">${esc(repoName)}</span>` : ''}</div>
<div class="meta"><span class="mono">${esc(repo.base || '?')}...${esc(repo.head || 'HEAD')}</span><span>${hunks.length} ${plural(hunks.length, 'hunk')} in ${byFile.size} ${plural(byFile.size, 'file')}</span><span>written ${esc(fmtDateTime(ev.generatedAt))}</span></div>
</header>
<div class="bar"><div class="wrap"><p class="sentence">${sentenceHtml(ev)}</p>${chipsHtml(hunks)}</div></div>
<main class="wrap" data-empty="0">
${[...byFile].map(([file, list]) => fileSectionHtml(file, list)).join('\n')}
<p class="empty">No hunk matches this filter.</p>
</main>
<footer><div class="wrap">
<div class="cols">
<div>
<h3>Definitions</h3>
<dl>${defsHtml}</dl>
<h3>Reproduce</h3>
<code class="repro">${esc(reproCommand(ev))}</code>
<p class="fine">Runs on the Claude Code transcripts already on this machine. ${esc(fmtDate(ev.generatedAt))} · ${esc(fmtInt(s.toolCalls ?? 0))} tool calls over ${esc(fmtDuration(s.durationSec ?? 0))} of agent time · report built in ${esc(fmtInt(s.elapsedMs ?? 0))} ms.</p>
</div>
<div>
<h3>Cost</h3>
${receiptHtml(ev)}
<p class="fine">${esc(costLine(ev))}</p>
</div>
</div>
<h3>Sessions</h3>
${sessionsHtml(sessions)}
<p class="fine">${esc((ev.tool && ev.tool.name) || 'hunkproof')} ${esc((ev.tool && ev.tool.version) || '')} · schema ${esc(ev.schema || '')} · strict count (targeted run after last edit): ${esc(s.strictRunAfterLastEdit ?? 0)} of ${esc(s.matched ?? 0)} line-matched · ${esc(s.fileLevel ?? 0)} file-level. Agent commands and diff lines are shown verbatim${ev.redaction && ev.redaction.note ? `, with one exception. ${esc(ev.redaction.note)}` : '.'}</p>
</div></footer>
<script>${JS}</script>
</body>
</html>
`;
}
