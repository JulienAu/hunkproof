// HTML renderer: one self-contained file, no CDN, no external fonts, inline CSS + ~40 lines of JS.
// Consumes ONLY an Evidence object (see CONTRACT.md). Byte-identical output for identical evidence.
// Long content folds with <details> (files where every hunk passed, run lists past
// the deciding run and two more, diffs past 40 lines): nothing is dropped from the DOM.

import {
  STATUS_ORDER,
  statusLabel,
  summaryParts,
  summarySentence,
  reproCommand,
  unpricedNote,
  runMarkers,
  lastEditOf,
  lastRunOf,
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

export const REPO_URL = 'https://github.com/JulienAu/hunkproof';
export const TAGLINE = 'Run receipt for an agent-written PR';
export const PASS_LEAD = 'Every line-matched hunk had a run after its last edit.';

// a diff longer than this shows its first DIFF_PREVIEW lines, the rest in <details>
const DIFF_FOLD = 40;
const DIFF_PREVIEW = 20;
// runs listed open under a hunk: the deciding run and this many more
const RUNS_EXTRA = 2;

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
  --bg: #fcfcfb; --bg-2: #f4f4f1; --panel: #ffffff; --ink: #1b1b1a; --ink-2: #4d4d49; --ink-3: #6a6a64;
  --hair: #e3e2dc; --hair-2: #cfcec7; --accent: #2d5bd3; --accent-ink: #ffffff;
  --add-bg: #e6f6ea; --add-ink: #11602b; --add-gutter: #c7ead1;
  --del-bg: #fdeceb; --del-ink: #9b1d1a; --del-gutter: #f3cfcd;
  --pass: #156e30; --pass-bg: #dcf1e2; --fail: #c42b2b; --fail-bg: #fbe2e1;
  --unparsed: #62625d; --unparsed-bg: #ebebe7; --unrun: #b83c14; --unrun-bg: #fde7df;
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
@media (max-width:600px){.wrap{padding:0 16px}}
summary{cursor:pointer}
summary::-webkit-details-marker{display:none}
summary:focus-visible,.chip:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}

header.top{padding:22px 0 16px}
header.top .row{display:flex;flex-wrap:wrap;gap:6px 28px;align-items:baseline;justify-content:space-between}
.brand{display:flex;align-items:baseline;gap:4px 10px;flex-wrap:wrap}
.brand h1{font-size:19px;margin:0;font-weight:650;letter-spacing:-.01em}
.brand h1 a{color:var(--ink)}
.brand .tagline{color:var(--ink-3);font-size:13px}
.brand .pr{color:var(--ink-2);font-size:14px}
.brand .pr a{color:inherit;border-bottom:1px solid var(--hair-2)}
.meta{color:var(--ink-3);font-size:12.5px;display:flex;flex-wrap:wrap;gap:4px 14px}
.meta .mono{font-size:12px}
.lead{display:flex;flex-wrap:wrap;gap:6px 28px;align-items:baseline;margin:18px 0 0}
.fig{display:inline-flex;align-items:baseline;gap:8px;font-size:15px;color:var(--ink-2)}
.fig b{font-size:26px;line-height:1.1;font-weight:650;font-variant-numeric:tabular-nums}
.fig[data-s="UNRUN"] b{color:var(--unrun)}
.fig[data-s="RUN_FAIL"] b{color:var(--fail)}
.fig[data-s="RUN_UNPARSED"] b{color:var(--unparsed)}
p.lead{display:block;font-size:20px;line-height:1.3;font-weight:650;color:var(--ink)}
p.lead.pass{color:var(--pass)}
p.sub{margin:8px 0 0;font-size:13px;font-weight:400;color:var(--ink-2)}
p.sub .sep{color:var(--ink-3);white-space:pre}
p.sub a.term{color:inherit;border-bottom:1px dotted var(--ink-3)}
p.sub a.term:hover{text-decoration:none;border-bottom-style:solid}
@media (max-width:600px){header.top .wrap{display:flex;flex-direction:column}header.top .row{display:contents}header.top .meta{order:3;margin-top:10px}}

.bar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:saturate(1.4) blur(8px);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.bar .wrap{padding-top:8px;padding-bottom:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.chip{appearance:none;border:1px solid var(--hair-2);background:var(--panel);color:var(--ink-2);border-radius:999px;padding:6px 12px;min-height:32px;font:inherit;font-size:13px;line-height:1.3;cursor:pointer;display:inline-flex;gap:6px;align-items:center;white-space:nowrap}
.chip .n{color:var(--ink-3);font-variant-numeric:tabular-nums}
.chip:hover{border-color:var(--ink-3)}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chip[aria-pressed="true"] .n{color:inherit;opacity:.75}
@media (max-width:600px){.chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 16px}.chips::-webkit-scrollbar{display:none}.chips li{flex:none}}

main.wrap{padding-top:20px;padding-bottom:40px}
.empty{display:none;padding:28px 0;color:var(--ink-3);text-align:center}
main[data-empty="1"] .empty{display:block}

section.file{margin:0 0 12px;border:1px solid var(--hair);border-radius:8px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden}
section.file[hidden]{display:none}
.filehead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:10px 14px;background:var(--bg-2);list-style:none}
.filehead::before{content:"";flex:none;width:0;height:0;border:5px solid transparent;border-left:6px solid var(--ink-3);border-right:0;transition:transform .12s}
details[open]>.filehead{border-bottom:1px solid var(--hair)}
details[open]>.filehead::before{transform:rotate(90deg)}
@media (prefers-reduced-motion:reduce){.filehead::before{transition:none}}
.filehead h2{margin:0;font-size:13px;font-weight:600;word-break:break-all}
.filehead .counts{color:var(--ink-3);font-size:12px;margin-left:auto;display:flex;gap:10px;flex-wrap:wrap}
.filehead .counts span b{font-weight:600;color:var(--ink-2)}

article.hunk{border-top:1px solid var(--hair);padding:14px 14px 12px;scroll-margin-top:64px}
article.hunk:first-of-type{border-top:0}
article.hunk[hidden]{display:none}
.hunkhead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:10px}
.range{color:var(--ink-3);font-size:12px}
.range b{color:var(--ink-2);font-weight:600}
.tag{font-size:11.5px;line-height:1.3;padding:2px 7px;border-radius:4px;border:1px solid var(--hair-2);color:var(--ink-2);background:var(--bg-2);white-space:nowrap}
.tag.churn{color:var(--unrun);border-color:var(--unrun);background:var(--unrun-bg)}
.tag.when{border-color:transparent;background:transparent;color:var(--ink-3);padding-left:0}
.badge{font-size:11.5px;font-weight:600;letter-spacing:.01em;line-height:1.3;padding:2px 8px;border-radius:4px;border:1px solid transparent;white-space:nowrap}
.badge::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:currentColor;vertical-align:1px}
a.badge:hover,a.tgt:hover{text-decoration:none}
.badge[data-s="RUN_PASS"]{color:var(--pass);background:var(--pass-bg);border-color:transparent}
.badge[data-s="RUN_FAIL"]{color:var(--fail);background:var(--fail-bg)}
.badge[data-s="RUN_UNPARSED"]{color:var(--unparsed);background:var(--unparsed-bg)}
.badge[data-s="UNRUN"]{color:var(--unrun);background:var(--unrun-bg)}
.badge[data-s="UNATTRIBUTED"]{color:var(--unattr);background:var(--unattr-bg);border:1px dashed var(--unattr)}
.badge[data-s="UNATTRIBUTED"]::before{background:transparent;border:1.5px dashed currentColor;width:5px;height:5px}

.grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px 18px;align-items:start}
.grid.solo{grid-template-columns:minmax(0,1fr)}
@media (max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}}
.diff{min-width:0}
pre.code{margin:0;border:1px solid var(--hair);border-radius:6px;overflow-x:auto;background:var(--bg);padding:0;line-height:1.55;tab-size:4}
pre.code .l{display:block;white-space:pre;padding:0 10px 0 0;min-width:max-content}
pre.code .l .g{display:inline-block;width:26px;text-align:center;color:var(--ink-3);user-select:none;border-right:1px solid var(--hair);margin-right:10px;text-indent:0}
pre.code .l.add{background:var(--add-bg);color:var(--add-ink)}
pre.code .l.add .g{background:var(--add-gutter);color:var(--add-ink);border-color:transparent}
pre.code .l.del{background:var(--del-bg);color:var(--del-ink)}
pre.code .l.del .g{background:var(--del-gutter);color:var(--del-ink);border-color:transparent}
pre.code .l.ctx{color:var(--ink-3)}
.diff details>pre.code{border-top:0;border-radius:0 0 6px 6px}
.diff>pre.code:not(:only-child){border-radius:6px 6px 0 0}
.diff>details:not([open])>summary{border:1px solid var(--hair);border-top:0;border-radius:0 0 6px 6px}
@media (max-width:600px){pre.code .l{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;padding-left:36px;text-indent:-36px}pre.code .l.add{box-shadow:inset 26px 0 var(--add-gutter)}pre.code .l.del{box-shadow:inset 26px 0 var(--del-gutter)}}

details.more>summary{list-style:none;color:var(--accent);font-size:12px;padding:6px 10px;min-height:32px;display:flex;align-items:center;background:var(--bg-2)}
details.more>summary::before{content:"+ ";font-family:ui-monospace,monospace}
details.more[open]>summary::before{content:"- "}
details.more .o{display:none}
details.more[open] .o{display:inline}
details.more[open] .c{display:none}
.runs-wrap details.more>summary{background:transparent;padding:8px 0 4px}

aside.note{color:var(--ink-3);font-size:12.5px;line-height:1.5;border-left:2px solid var(--hair-2);padding:2px 0 2px 12px;margin:0;word-wrap:break-word}
aside.note .who{color:var(--ink-2);font-weight:600}
aside.note .when{display:block;margin-top:4px;font-size:11.5px}
@media (max-width:900px){aside.note{order:-1;border-left:0;padding:0 0 0 0;border-bottom:1px dashed var(--hair-2);padding-bottom:8px}}

.runs-wrap{grid-column:1/-1;margin:10px 0 0;border-top:1px dashed var(--hair);min-width:0}
ol.runs{list-style:none;margin:0;padding:0}
ol.runs li{display:flex;align-items:baseline;gap:4px 10px;padding:6px 0 0;font-size:12.5px;color:var(--ink-2);min-width:0}
ol.runs .t{color:var(--ink-3);font-size:12px;min-width:62px;flex:none}
ol.runs .dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;position:relative;top:0}
ol.runs .dot[data-o="pass"]{background:var(--pass)}
ol.runs .dot[data-o="fail"]{background:var(--fail)}
ol.runs .dot[data-o="unparsed"]{background:transparent;border:1.5px solid var(--unparsed);width:7px;height:7px}
ol.runs .runner{font-weight:600;color:var(--ink);flex:none}
ol.runs .cmd{color:var(--ink-2);flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ol.runs .out{color:var(--ink-3);max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ol.runs .tgt{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);border:1px solid currentColor;border-radius:3px;padding:0 5px;line-height:1.5;flex:none;white-space:nowrap}
ol.runs .tgt.other{color:var(--unrun)}
ol.runs .tgt.dec{color:var(--ink-2)}
ol.runs li.none{color:var(--ink-3);font-style:italic}
ol.runs li.none[data-s="UNRUN"]{color:var(--unrun);font-style:normal}
@media (max-width:600px){ol.runs li{flex-wrap:wrap;padding-top:8px}ol.runs .cmd{flex:1 1 100%;order:9}ol.runs .out{max-width:none;flex:1 1 100%;order:10}ol.runs .cmd,ol.runs .out{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}}

footer{border-top:1px solid var(--hair);padding:22px 0 40px;color:var(--ink-2);font-size:13px}
footer h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin:18px 0 8px;font-weight:600}
footer .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 36px}
footer details.defs>summary{list-style:none}
footer details.defs>summary h3{display:inline-block}
footer details.defs>summary::after{content:" show";color:var(--accent);font-size:12px}
footer details.defs[open]>summary::after{content:" hide"}
footer dl{margin:0}
footer dt{font-weight:600;color:var(--ink);margin-top:8px;scroll-margin-top:64px}
footer dt:target{color:var(--accent)}
footer dd{margin:2px 0 0}
footer .receipt{border:1px solid var(--hair);border-radius:6px;background:var(--panel);padding:12px 14px;margin-top:6px}
footer .receipt .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dashed var(--hair)}
footer .receipt .row:last-child{border-bottom:0}
footer .receipt .row span:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
footer .receipt .total{font-weight:650;color:var(--ink)}
footer .receipt .label{color:var(--ink-3);font-size:12px;margin-top:8px}
footer .receipt .noprice{color:var(--unrun);font-size:12px}
footer .repro{display:inline-block;background:var(--ink);color:var(--bg);padding:6px 10px;border-radius:5px;margin-top:4px;user-select:all;word-break:break-all}
footer .scroll{overflow-x:auto;max-width:100%}
footer table{border-collapse:collapse;width:100%;font-size:12.5px}
footer td,footer th{text-align:left;padding:5px 8px 5px 0;border-bottom:1px solid var(--hair);vertical-align:top}
footer th{color:var(--ink-3);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em}
footer td.mono{overflow-wrap:anywhere}
footer .fine{color:var(--ink-3);font-size:12px;margin-top:22px}
@media (max-width:600px){footer .receipt .row{flex-wrap:wrap}footer .receipt .row span:last-child{white-space:normal;text-align:left}footer .path{display:none}}
`;

// Filter chips. Kept small on purpose: no framework, no fetch, no storage.
// A filter other than "all" opens every closed file that holds a match and marks
// it (data-auto); "all" closes only the files a filter opened, so a file the
// visitor opened stays open. A link to a definition or a hunk opens the
// <details> around its target (Chromium does this itself, other browsers do not).
const JS = `
(function(){
  var chips=document.querySelectorAll('.chip');
  var hunks=document.querySelectorAll('article.hunk');
  var files=document.querySelectorAll('section.file');
  var main=document.querySelector('main');
  var empty=document.querySelector('main .empty');
  var want={unrun:'UNRUN',fail:'RUN_FAIL',unparsed:'RUN_UNPARSED',unattributed:'UNATTRIBUTED'};
  function apply(f,click){
    var shown=0;
    for(var i=0;i<hunks.length;i++){
      var ok=f==='all'||hunks[i].getAttribute('data-status')===want[f];
      hunks[i].hidden=!ok; if(ok)shown++;
    }
    for(var j=0;j<files.length;j++){
      var hit=!!files[j].querySelector('article.hunk:not([hidden])');
      files[j].hidden=!hit;
      var d=files[j].querySelector('details');
      if(!d)continue;
      if(f==='all'){if(d.hasAttribute('data-auto')){d.open=false;d.removeAttribute('data-auto');}}
      else if(hit&&!d.open){d.open=true;d.setAttribute('data-auto','1');}
    }
    for(var k=0;k<chips.length;k++){
      var on=chips[k].getAttribute('data-filter')===f;
      chips[k].setAttribute('aria-pressed',on?'true':'false');
      if(on&&empty)empty.textContent=chips[k].getAttribute('data-none');
    }
    main.setAttribute('data-empty',shown?'0':'1');
    if(!click)return;
    if(history.replaceState)history.replaceState(null,'',f==='all'?location.pathname:'#'+f);
    var top=main.offsetTop-document.querySelector('.bar').offsetHeight;
    if(scrollY>top)scrollTo(0,top);
  }
  for(var c=0;c<chips.length;c++)chips[c].addEventListener('click',function(e){apply(e.currentTarget.getAttribute('data-filter'),true);});
  function reveal(){
    var t=document.getElementById(location.hash.slice(1)),d=t&&t.closest('details');
    if(d&&!d.open){d.open=true;t.scrollIntoView();}
  }
  addEventListener('hashchange',reveal);
  var h=(location.hash||'').slice(1);
  apply(want[h]?h:'all');
  reveal();
})();
`;

function defMarks(text) {
  const keys = /\b[A-Z][A-Z_]{3,}(?: \([^)]*\))?: /g;
  const marks = [];
  let m;
  while ((m = keys.exec(text))) marks.push({ at: m.index, key: m[0].replace(/(?: \([^)]*\))?: $/, '') });
  return marks;
}

/**
 * One entry of a definition that lists its cases as `KEY: text` (definitions.status,
 * definitions.attribution). With `intro`, the sentence before the first case goes in
 * front. '' when the text or the key is absent.
 */
export function defPart(text, key, { intro = false, label = '' } = {}) {
  if (typeof text !== 'string' || !text) return '';
  const marks = defMarks(text);
  const i = marks.findIndex((x) => x.key === key);
  if (i < 0) return '';
  let part = text.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : text.length).trim();
  // `label`: the word the page shows instead of the case key ("ran, passed: ..." for "RUN_PASS: ...")
  if (label) part = part.replace(/^[A-Z][A-Z_]{3,}(?: \([^)]*\))?: /, `${label}: `);
  const head = intro ? defIntro(text) : '';
  return head ? `${head} ${part}` : part;
}

/** The sentence(s) of a definition before its first `KEY:` case ('' when it starts with one). */
export function defIntro(text) {
  if (typeof text !== 'string' || !text) return '';
  const marks = defMarks(text);
  return (marks.length ? text.slice(0, marks[0].at) : text).trim();
}

const titleAttr = (t) => (t ? ` title="${esc(t)}"` : '');
const firstSentence = (t) => (typeof t === 'string' ? t.replace(/^(.*?\.)\s.*$/s, '$1') : '');

// One status definition, worded with the label the page shows ("ran, passed: ...")
// and the rule that decides it in front, so the case has a subject. Used wherever a
// status is named: badges, chips, lead figures, the "decides status" pill.
function statusTitle(defs, status) {
  const part = defPart(defs.status, status, { intro: true, label: statusLabel(status) });
  return part ? `Status: ${part}` : defs.status || '';
}

const ATTRIBUTION_LABEL = { MATCHED: 'line-matched', FILE_LEVEL: 'file-level', UNATTRIBUTED: 'unattributed' };
function attributionTitle(defs, key) {
  return defPart(defs.attribution, key, { label: ATTRIBUTION_LABEL[key] });
}

// a term that links to its definition in the footer: the tooltip on a desktop,
// a tap that opens the definitions on a phone (where a title never shows)
function defLink(key, text, title) {
  return `<a class="term" href="#def-${key}"${titleAttr(title)}>${esc(text)}</a>`;
}

// Lead: the decisive figures (unrun, failed, outcome not parsed, each when there
// is any) or, when all three are zero, one sentence. The counts come from the
// hunks, the same way the chips count, so a figure and its chip always agree.
// The other numbers go to the sub-line.
function leadHtml(ev, defs) {
  const p = summaryParts(ev);
  const list = Array.isArray(ev.hunks) ? ev.hunks : [];
  const of = (status, attribution) => list.filter((h) => h.status === status && (!attribution || h.attribution === attribution)).length;
  const unrun = of('UNRUN');
  const fail = of('RUN_FAIL');
  const unparsed = of('RUN_UNPARSED');
  let lead;
  if (!unrun && !fail && !unparsed) {
    if (p.matched) lead = `<p class="lead pass">${esc(PASS_LEAD)}</p>`;
    else if (p.fileLevel) lead = `<p class="lead">No hunk matched an agent edit line by line; ${p.fileLevel} matched at file level.</p>`;
    else lead = `<p class="lead">${list.length ? 'No hunk in this diff matched an agent edit.' : 'No hunks in this diff.'}</p>`;
  } else {
    const figs = [];
    if (unrun) {
      const fileLevel = of('UNRUN', 'FILE_LEVEL');
      const split = fileLevel === unrun ? ' (file-level)' : fileLevel ? ` (${unrun - fileLevel} line-matched, ${fileLevel} file-level)` : '';
      figs.push(`<span class="fig" data-s="UNRUN"${titleAttr(statusTitle(defs, 'UNRUN'))}><b>${unrun}</b>unrun ${plural(unrun, 'hunk')}${split}</span>`);
    }
    if (fail) figs.push(`<span class="fig" data-s="RUN_FAIL"${titleAttr(statusTitle(defs, 'RUN_FAIL'))}><b>${fail}</b>${plural(fail, 'hunk')} ran, failed</span>`);
    if (unparsed) figs.push(`<span class="fig" data-s="RUN_UNPARSED"${titleAttr(statusTitle(defs, 'RUN_UNPARSED'))}><b>${unparsed}</b>${plural(unparsed, 'hunk')} ran, outcome not parsed</span>`);
    lead = `<div class="lead">${figs.join('')}</div>`;
  }
  const sep = '<span class="sep"> · </span>';
  const bits = [
    `${p.ran} of ${p.matched} ${defLink('attribution', p.matchedWord, attributionTitle(defs, 'MATCHED'))} had a run after their last edit (${esc(p.outcomes)})`,
    `${p.fileLevel} ${defLink('attribution', 'file-level', attributionTitle(defs, 'FILE_LEVEL'))}`,
    `${p.unattributed} ${defLink('attribution', 'unattributed', attributionTitle(defs, 'UNATTRIBUTED'))}`,
    `${p.sessions} ${esc(p.sessionsWord)}`,
    `hunkproof used ${p.tokens} LLM tokens`,
  ];
  return `${lead}\n<p class="sub">${bits.join(sep)}</p>`;
}

function chipsHtml(hunks, defs) {
  const count = (pred) => hunks.filter(pred).length;
  const chips = [
    ['all', 'All', hunks.length, defs.hunk, 'No hunks in this diff.'],
    ['unrun', 'Unrun', count((h) => h.status === 'UNRUN'), statusTitle(defs, 'UNRUN'), 'No unrun hunks.'],
    ['fail', 'Ran, failed', count((h) => h.status === 'RUN_FAIL'), statusTitle(defs, 'RUN_FAIL'), 'No hunk ran and failed.'],
    ['unparsed', 'Outcome not parsed', count((h) => h.status === 'RUN_UNPARSED'), statusTitle(defs, 'RUN_UNPARSED'), 'No hunk with an outcome not parsed.'],
    ['unattributed', 'Unattributed', count((h) => h.status === 'UNATTRIBUTED'), statusTitle(defs, 'UNATTRIBUTED'), 'No unattributed hunks.'],
  ];
  return `<ul class="chips" aria-label="Filter hunks">${chips
    .map(([f, label, n, title, none]) => `<li><button type="button" class="chip" data-filter="${f}" data-none="${esc(none)}" aria-pressed="${f === 'all' ? 'true' : 'false'}"${titleAttr(title)}>${esc(label)}<span class="n">${n}</span></button></li>`)
    .join('')}</ul>`;
}

function codeHtml(h) {
  const removed = Array.isArray(h.removed) ? h.removed : [];
  const added = Array.isArray(h.added) ? h.added : [];
  const lines = [];
  for (const l of removed) lines.push(`<span class="l del"><span class="g">-</span>${esc(l)}</span>`);
  for (const l of added) lines.push(`<span class="l add"><span class="g">+</span>${esc(l)}</span>`);
  if (!lines.length) lines.push('<span class="l ctx"><span class="g"> </span>(no line content in diff)</span>');
  if (lines.length <= DIFF_FOLD) return `<div class="diff"><pre class="code" aria-label="diff lines">${lines.join('')}</pre></div>`;
  const rest = lines.length - DIFF_PREVIEW;
  return `<div class="diff"><pre class="code" aria-label="diff lines">${lines.slice(0, DIFF_PREVIEW).join('')}</pre><details class="more"><summary><span class="c">show all ${lines.length} lines (${rest} more)</span><span class="o">fold the ${rest} lines below</span></summary><pre class="code">${lines.slice(DIFF_PREVIEW).join('')}</pre></details></div>`;
}

function noteHtml(h) {
  // no agent text (or no edit at all): nothing, the grid takes the full width
  if (h.status === 'UNATTRIBUTED' || !h.intent || !h.intent.text) return '';
  const i = h.intent;
  const when = i.ts ? `<span class="when">${esc(fmtTime(i.ts))} UTC · session ${esc(String(i.sessionId || '').slice(0, 8))}</span>` : '';
  return `<aside class="note mono"><span class="who">agent:</span> ${esc(i.text)}${when}</aside>`;
}

const MARKER_TITLE = {
  'other checkout': 'made in another checkout than the edit (a git worktree): it never decides the status',
  'other session': 'made in another session than the last edit of these lines',
};

// `explain`: the row is listed open, its pills carry the definition as a tooltip;
// folded rows repeat the same pills hundreds of times on a large PR, so they do not.
function runRow(h, r, defs, deciding, explain) {
  const outcome = r.outcome || 'unparsed';
  const out = r.summary ? esc(r.summary) : (outcome === 'unparsed' ? 'outcome not parsed' : outcome);
  const markers = runMarkers(h, r).trim().split(/\)\s*\(/).map((m) => m.replace(/^\(|\)$/g, '')).filter(Boolean);
  const tags = markers.map((m) => `<span class="tgt${m === 'targeted' ? '' : ' other'}"${explain ? titleAttr(m === 'targeted' ? firstSentence(defs.targeted) : MARKER_TITLE[m]) : ''}>${esc(m)}</span>`);
  if (deciding) {
    const rule = defIntro(defs.status);
    tags.unshift(`<a class="tgt dec" href="#def-status"${titleAttr(rule ? `Status: ${rule}` : '')}>decides status</a>`);
  }
  const outTitle = r.summary && r.summary.length > 32 ? ` title="${esc(r.summary)}"` : '';
  return `<li${deciding ? ' class="dec"' : ''}><span class="t mono">${esc(fmtTime(r.ts))}</span><span class="dot" data-o="${esc(outcome)}" title="${esc(outcome)}"></span><span class="runner">${esc(r.runner || 'run')}</span>${tags.join('')}<code class="cmd" title="${esc(r.command || '')}">${esc(truncate(r.command || '', 72))}</code><span class="out"${outTitle}>${out}</span></li>`;
}

function runsHtml(h, defs) {
  const runs = Array.isArray(h.runsAfter) ? h.runsAfter : [];
  if (!runs.length) {
    const msg = h.status === 'UNATTRIBUTED'
      ? 'no agent edit matched this hunk, so there is no edit to count runs from'
      : `no run after the last edit${h.lastEdit ? ` (${esc(fmtTime(h.lastEdit))} UTC)` : ''}`;
    return `<div class="runs-wrap"><ol class="runs"><li class="none" data-s="${esc(h.status)}">${msg}</li></ol></div>`;
  }
  // open: the run that decided the status and the RUNS_EXTRA latest others, in time order
  const dec = runs.indexOf(lastRunOf(h));
  const open = new Set(dec >= 0 ? [dec] : []);
  for (let i = runs.length - 1; i >= 0 && open.size < RUNS_EXTRA + (dec >= 0 ? 1 : 0); i--) open.add(i);
  const shown = [];
  const folded = [];
  // the pill only marks a run whose parsed outcome set the status: with no parsed
  // outcome (or a run from another checkout) the run is listed, nothing is decided by it
  const decRun = dec >= 0 ? runs[dec] : null;
  const pill = Boolean(decRun && (decRun.outcome === 'pass' || decRun.outcome === 'fail') && decRun.otherCheckout !== true);
  runs.forEach((r, i) => (open.has(i) ? shown : folded).push(runRow(h, r, defs, pill && i === dec, open.has(i))));
  const more = folded.length
    ? `<details class="more"><summary><span class="c">${folded.length} more ${plural(folded.length, 'run')} after the last edit</span><span class="o">fold ${folded.length} ${plural(folded.length, 'run')}</span></summary><ol class="runs">${folded.join('')}</ol></details>`
    : '';
  return `<div class="runs-wrap"><ol class="runs" aria-label="runs after last edit">${shown.join('')}</ol>${more}</div>`;
}

function hunkHtml(h, defs) {
  const churn = h.churn ?? 0;
  const oldPart = `-${h.oldStart ?? 0}${(h.oldLines ?? 0) === 1 ? '' : `,${h.oldLines ?? 0}`}`;
  const newPart = `+${h.newStart ?? 0}${(h.newLines ?? 0) === 1 ? '' : `,${h.newLines ?? 0}`}`;
  const tags = [];
  if (churn >= 2) tags.push(`<span class="tag churn">rewritten ${churn} times</span>`);
  if (h.attribution === 'FILE_LEVEL') tags.push(`<span class="tag"${titleAttr(attributionTitle(defs, 'FILE_LEVEL') || 'the file matched an agent edit, the lines did not')}>file-level match</span>`);
  if (h.status === 'UNATTRIBUTED' && h.reason) tags.push(`<span class="tag" title="why no edit is attributed">${esc(h.reason)}</span>`);
  if (h.lastEdit) {
    const e = lastEditOf(h);
    const who = e && e.sessionId ? ` · session ${String(e.sessionId).slice(0, 8)}${e.tool ? ` · ${e.tool}` : ''}` : '';
    tags.push(`<span class="tag when mono" title="${esc(`last agent edit of these lines: ${fmtTime(h.lastEdit)} UTC${who}`)}">edited ${esc(fmtTime(h.lastEdit))}</span>`);
  }
  const note = noteHtml(h);
  return `<article class="hunk" id="${esc(anchorId(h))}" data-status="${esc(h.status)}">
<div class="hunkhead"><a class="badge" href="#def-status" data-s="${esc(h.status)}"${titleAttr(statusTitle(defs, h.status))}>${esc(statusLabel(h.status))}</a><span class="range mono">@@ ${esc(oldPart)} <b>${esc(newPart)}</b> @@</span>${tags.join('')}</div>
<div class="grid${note ? '' : ' solo'}">${codeHtml(h)}${note}${runsHtml(h, defs)}</div>
</article>`;
}

function anchorId(h) {
  return 'h-' + String(h.id || `${h.relFile}:${h.newStart}`).replace(/[^A-Za-z0-9_-]+/g, '-');
}

function fileSectionHtml(file, list, defs) {
  const counts = {};
  for (const h of list) counts[h.status] = (counts[h.status] || 0) + 1;
  const countBits = STATUS_ORDER.filter((s) => counts[s]).map((s) => `<span><b>${counts[s]}</b> ${esc(statusLabel(s))}</span>`);
  // a file where every hunk passed starts closed; any other status keeps it open
  const open = counts.RUN_PASS !== list.length;
  return `<section class="file" data-file="${esc(file)}" data-open="${open ? '1' : '0'}"><details${open ? ' open' : ''}>
<summary class="filehead"><h2 class="mono">${esc(file)}</h2><span class="counts"><span><b>${list.length}</b> ${plural(list.length, 'hunk')}</span>${countBits.join('')}</span></summary>
${list.map((h) => hunkHtml(h, defs)).join('\n')}
</details></section>`;
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
  rows.push(`<div class="row"><span>Cache</span><span>${fmtInt(t.cacheWrite || 0)} write · ${fmtInt(t.cacheRead || 0)} read</span></div>`);
  rows.push(`<div class="row total"><span>At API list prices${u.priceListDate ? ` (prices of ${esc(u.priceListDate)})` : ''}</span><span>${esc(fmtUSD(u.costListUSD))}</span></div>`);
  const note = unpricedNote(evidence);
  if (note) rows.push(`<div class="row"><span class="noprice">${esc(note)}</span><span></span></div>`);
  rows.push(`<div class="row total"><span>Hunkproof itself</span><span>0 LLM tokens · $0.00</span></div>`);
  return `<div class="receipt">${rows.join('')}<div class="label">${esc(u.label || COST_LABEL_FALLBACK)}</div></div>`;
}

function sessionsHtml(sessions) {
  if (!sessions.length) return '<p class="fine">No Claude Code session matched this diff; every hunk is unattributed.</p>';
  const rows = sessions.map((s) => `<tr><td class="mono">${esc(String(s.sessionId || '').slice(0, 8))}</td><td>${esc(fmtDateTime(s.firstTs))}<br>${esc(fmtDuration((Date.parse(s.lastTs) - Date.parse(s.firstTs)) / 1000))}</td><td>${esc(s.edits ?? 0)} + ${esc(s.shellEdits ?? 0)} shell</td><td>${esc(s.runs ?? 0)}</td><td class="mono">${esc((s.versions || []).join(', '))}<br>${esc((s.models || []).join(', '))}</td><td class="mono path">${esc(s.path || '')}</td></tr>`);
  return `<div class="scroll"><table><thead><tr><th>session</th><th>start · length</th><th>edits</th><th>runs</th><th>claude code · models</th><th class="path">transcript</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
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
  const defsHtml = defOrder.filter((k) => defs[k]).map((k) => `<dt id="def-${k}">${esc(k)}</dt><dd>${esc(defs[k])}</dd>`).join('');

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
<header class="top"><div class="wrap">
<div class="row"><div class="brand"><h1><a href="${REPO_URL}" rel="noopener">hunkproof</a></h1><span class="tagline">${esc(TAGLINE)}</span>${prHtml ? `<span class="pr">${prHtml}</span>` : ''}${repoName ? `<span class="pr mono">${esc(repoName)}</span>` : ''}</div>
<div class="meta"><span class="mono">${esc(repo.base || '?')}...${esc(repo.head || 'HEAD')}</span><span>${hunks.length} ${plural(hunks.length, 'hunk')} in ${byFile.size} ${plural(byFile.size, 'file')}</span><span>written ${esc(fmtDateTime(ev.generatedAt))}</span></div></div>
${leadHtml(ev, defs)}
</div></header>
<div class="bar"><div class="wrap">${chipsHtml(hunks, defs)}</div></div>
<main class="wrap" data-empty="0">
${[...byFile].map(([file, list]) => fileSectionHtml(file, list, defs)).join('\n')}
<p class="empty" role="status">No hunks in this diff.</p>
</main>
<footer><div class="wrap">
<div class="cols">
<div>
<h3>Reproduce</h3>
<code class="repro">${esc(reproCommand(ev))}</code>
<p class="fine">Runs on the Claude Code transcripts already on this machine. ${esc(fmtDate(ev.generatedAt))} · ${esc(fmtInt(s.toolCalls ?? 0))} tool calls over ${esc(fmtDuration(s.durationSec ?? 0))} of agent time · report built in ${esc(fmtInt(s.elapsedMs ?? 0))} ms.</p>
${defsHtml ? `<details class="defs"><summary><h3>Definitions</h3></summary><dl>${defsHtml}</dl></details>` : ''}
</div>
<div>
<h3>Cost</h3>
${receiptHtml(ev)}
</div>
</div>
<h3>Sessions</h3>
${sessionsHtml(sessions)}
<p class="fine">Headline: ${esc(summarySentence(ev))}.</p>
<p class="fine">${esc((ev.tool && ev.tool.name) || 'hunkproof')} ${esc((ev.tool && ev.tool.version) || '')} · schema ${esc(ev.schema || '')} · strict count (targeted run after last edit): ${esc(s.strictRunAfterLastEdit ?? 0)} of ${esc(s.matched ?? 0)} line-matched · ${esc(s.fileLevel ?? 0)} file-level. Agent commands and diff lines are shown verbatim${ev.redaction && ev.redaction.note ? `, with one exception. ${esc(ev.redaction.note)}` : '.'}</p>
</div></footer>
<script>${JS}</script>
</body>
</html>
`;
}
