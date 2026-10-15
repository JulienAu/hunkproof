import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderHtml, escapeHtml, defPart, defIntro, REPO_URL, TAGLINE, PASS_LEAD } from '../src/render-html.js';
import { renderMarkdown, renderTerminal as renderTerminalViaMd, MD_MAX_CHARS } from '../src/render-md.js';
import { renderTerminal, summarySentence, fmtInt, truncate, lastRunCell, runMarkers } from '../src/render-terminal.js';
import { buildEvidence } from '../src/evidence.js';
import { summarizeUsage } from '../src/cost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '..', 'fixtures', 'evidence.sample.json');
const load = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const evidence = load();

const FORBIDDEN = ['tested', 'verified', 'covered', 'proof that it works'];
const LABEL = 'what these tokens would cost at Anthropic API list prices; not a bill (subscription plans have no per-token charge)';
const SENTENCE = '5 of 7 line-matched hunks had a run after their last edit (3 passed, 1 failed, 1 outcome not parsed) · 1 file-level (lines not matched to an edit) · 3 unrun · 1 unattributed · 2 sessions · hunkproof used 0 LLM tokens';

test('fixture: statuses are all present and agree with summary', () => {
  const counts = {};
  for (const h of evidence.hunks) counts[h.status] = (counts[h.status] || 0) + 1;
  assert.deepEqual(counts, { RUN_PASS: 3, RUN_FAIL: 1, RUN_UNPARSED: 1, UNRUN: 3, UNATTRIBUTED: 1 });
  assert.equal(evidence.hunks.length, evidence.summary.hunks);
  assert.equal(counts.UNRUN, evidence.summary.unrun);
  assert.equal(counts.UNATTRIBUTED, evidence.summary.unattributed);
  assert.equal(counts.RUN_PASS + counts.RUN_FAIL + counts.RUN_UNPARSED, evidence.summary.runAfterLastEdit);
  assert.equal(evidence.summary.attributed, evidence.summary.matched, 'attributed = line-matched only');
  assert.equal(evidence.summary.runPass + evidence.summary.runFail + evidence.summary.runUnparsed, evidence.summary.runAfterLastEdit);
  assert.equal(evidence.runs.length, 6);
  assert.equal(evidence.sessions.length, 2);
  assert.equal(new Set(evidence.hunks.map((h) => h.relFile)).size, 3);
  assert.equal(evidence.schema, 'hunkproof/evidence@1');
  for (const h of evidence.hunks) {
    if (h.status === 'UNATTRIBUTED') assert.equal(h.attribution, 'UNATTRIBUTED');
    if (h.status === 'UNRUN') assert.equal(h.runsAfter.length, 0);
    if (h.status.startsWith('RUN_')) {
      const last = h.runsAfter.filter((r) => r.targeted).at(-1) || h.runsAfter.at(-1);
      assert.equal(last.outcome, { RUN_PASS: 'pass', RUN_FAIL: 'fail', RUN_UNPARSED: 'unparsed' }[h.status], h.id);
    }
  }
});

test('summary sentence is the contract sentence', () => {
  assert.equal(summarySentence(evidence), SENTENCE);
});

test('snapshot-stable: identical evidence gives identical strings', () => {
  const a = load();
  const b = load();
  assert.equal(renderHtml(a), renderHtml(b));
  assert.equal(renderMarkdown(a), renderMarkdown(b));
  assert.equal(renderMarkdown(a, { quotes: true, blobBase: 'https://example.invalid/blob/abc' }), renderMarkdown(b, { quotes: true, blobBase: 'https://example.invalid/blob/abc' }));
  assert.equal(renderTerminal(a), renderTerminal(b));
  // rendering twice from the same object must not mutate it
  assert.deepEqual(a, load());
});

test('vocabulary: no forbidden words in any output', () => {
  const outputs = [
    renderHtml(evidence),
    renderHtml(evidence, { theme: 'dark' }),
    renderMarkdown(evidence),
    renderMarkdown(evidence, { quotes: true, blobBase: 'https://example.invalid/blob/abc' }),
    renderTerminal(evidence),
  ];
  for (const out of outputs) {
    const lower = out.toLowerCase();
    for (const w of FORBIDDEN) assert.ok(!lower.includes(w), `output contains forbidden word "${w}"`);
  }
});

test('html: self-contained, no external resources', () => {
  const html = renderHtml(evidence);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<link\b/i.test(html), 'no <link> at all');
  assert.ok(!/<(script|img|iframe|video|audio|source)\b[^>]*\bsrc=/i.test(html), 'no src= on any element');
  assert.ok(!/@import/i.test(html));
  assert.ok(!/url\(\s*['"]?https?:/i.test(html));
  assert.ok(!/@font-face/i.test(html), 'no web fonts');
  // the only http occurrences allowed are the brand link and the PR link anchor
  const httpHits = html.match(/https?:\/\/[^\s"'<)]+/g) || [];
  assert.deepEqual([...new Set(httpHits)], [REPO_URL, evidence.repo.prUrl]);
  assert.ok(html.includes(`<h1><a href="${REPO_URL}" rel="noopener">hunkproof</a></h1><span class="tagline">${TAGLINE}</span>`));
  assert.ok(html.includes('<style>') && html.includes('<script>'));
});

test('html: theme handling', () => {
  const auto = renderHtml(evidence);
  assert.ok(auto.includes('@media (prefers-color-scheme: dark)'));
  assert.ok(auto.includes('color-scheme" content="light dark"'));
  const dark = renderHtml(evidence, { theme: 'dark' });
  assert.ok(!dark.includes('prefers-color-scheme'));
  assert.ok(dark.includes('data-theme="dark"'));
  const light = renderHtml(evidence, { theme: 'light' });
  assert.ok(!light.includes('prefers-color-scheme'));
});

test('html: layout pieces are present', () => {
  const html = renderHtml(evidence);
  const sentenceText = html.replace(/<[^>]+>/g, '');
  assert.ok(sentenceText.includes(SENTENCE), 'summary sentence (tags stripped)');
  for (const f of ['all', 'unrun', 'fail', 'unparsed', 'unattributed']) assert.ok(html.includes(`data-filter="${f}"`), `chip ${f}`);
  for (const h of evidence.hunks) {
    assert.ok(html.includes(`data-status="${h.status}"`));
    assert.ok(html.includes(`<b>+${h.newStart}`), `range for ${h.id}`);
  }
  for (const f of ['src/invoice.js', 'src/tax.js', 'test/invoice.test.js']) assert.ok(html.includes(`data-file="${f}"`));
  assert.equal((html.match(/<section class="file"/g) || []).length, 3);
  assert.equal((html.match(/<article class="hunk"/g) || []).length, 9);
  assert.ok(html.includes('rewritten 3 times'));
  assert.ok(html.includes('rewritten 2 times'));
  assert.ok(!html.includes('rewritten 1 times'));
  assert.ok(html.includes('class="who">agent:</span>'));
  assert.match(html, /class="tgt" title="A run is targeted when[^"]*">targeted<\/span>/, 'targeted pill with its definition as tooltip');
  assert.ok(html.includes('npx hunkproof --pr 42 --base main --head feat/tax-rate-table'));
  assert.ok(html.includes('<span>written 20'), 'the header says written, not generated');
  assert.ok(!/\bgenerated\b/.test(html), 'the HTML has no "generated"');
  assert.ok(html.includes(LABEL));
  assert.ok(html.includes('At API list prices'));
  assert.ok(!html.includes('List-price equivalent'));
  // the edit tag shows the time; session and tool of the edit that defines lastEdit go in its tooltip
  assert.ok(html.includes('title="last agent edit of these lines: 09:25:19 UTC · session 5b1c7d2e · Bash">edited 09:25:19</span>'), 'edit tag with session and tool in the title');
  // the status badge comes first in the hunk header, links to the status definition,
  // and its tooltip names the status by its label, with the rule that decides it in front
  assert.match(html, /<div class="hunkhead"><a class="badge" href="#def-status" data-s="UNRUN" title="[^"]+">unrun<\/a><span class="range mono">/);
  for (const k of Object.keys(evidence.definitions)) assert.ok(html.includes(`<dt id="def-${k}">${k}</dt>`));
  for (const s of ['RUN_PASS', 'RUN_FAIL', 'RUN_UNPARSED', 'UNRUN', 'UNATTRIBUTED']) assert.ok(html.includes(`<a class="badge" href="#def-status" data-s="${s}"`));
  assert.ok(!/title="[^"]*\b(RUN_PASS|RUN_FAIL|RUN_UNPARSED|UNRUN|MATCHED|FILE_LEVEL):/.test(html), 'no tooltip shows a case key');
  assert.ok(html.includes('ran, failed') && html.includes('ran, outcome not parsed') && html.includes('ran, passed'));
  // added/removed lines land in coloured spans
  assert.ok(html.includes('<span class="l add"><span class="g">+</span>'));
  assert.ok(html.includes('<span class="l del"><span class="g">-</span>'));
  // inline JS stays small
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.ok(js.split('\n').length <= 45, `inline JS is ${js.split('\n').length} lines`);
});

test('html: everything coming from evidence is escaped', () => {
  const ev = load();
  const h = ev.hunks[0];
  h.intent.text = '<script>alert(1)</script> & "quotes" <b>';
  h.added[0] = '<img src=x onerror=alert(1)> & <';
  h.runsAfter[0].command = 'npm test -- "<script>" & co';
  h.runsAfter[0].summary = '<b>1</b> & 2';
  ev.repo.remote = 'git@github.com:acme/"bad".git';
  ev.definitions.hunk = '<em>def</em>';
  ev.sessions[0].path = '~/<x>/y.jsonl';
  const html = renderHtml(ev);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &lt;b&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;'));
  assert.ok(!html.includes('<em>def</em>') && html.includes('&lt;em&gt;def&lt;/em&gt;'));
  assert.ok(html.includes('~/&lt;x&gt;/y.jsonl'));
  assert.ok(!html.includes('<b>1</b> &'));
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  // only one script tag: ours
  assert.equal((html.match(/<script/gi) || []).length, 1);
});

test('markdown: text-free by default, quotes only on request', () => {
  const md = renderMarkdown(evidence);
  for (const h of evidence.hunks) if (h.intent) assert.ok(!md.includes(h.intent.text), `intent leaked for ${h.id}`);
  assert.ok(!md.includes('agent:'));
  const withQuotes = renderMarkdown(evidence, { quotes: true });
  for (const h of evidence.hunks) if (h.intent) assert.ok(withQuotes.includes(h.intent.text), `intent missing for ${h.id}`);
  assert.ok(withQuotes.includes('> agent: '));
});

test('markdown: summary, unrun table, details, definitions, reproduction', () => {
  const md = renderMarkdown(evidence);
  assert.ok(md.includes(`**${SENTENCE}**`));
  assert.ok(md.includes('| Hunk | Lines | Last edit (UTC) | Rewrites | Attribution |'));
  const unrunRows = md.split('\n').filter((l) => l.startsWith('| `') && l.includes(' | +'));
  assert.equal(unrunRows.length, 3);
  for (const h of evidence.hunks.filter((x) => x.status === 'UNRUN')) assert.ok(md.includes(`\`${h.relFile}:${h.newStart}\``));
  assert.equal((md.match(/<details>/g) || []).length, 3);
  assert.equal((md.match(/<\/details>/g) || []).length, 3);
  assert.ok(md.includes('<summary>All 9 hunks with the run that decided their status</summary>'));
  assert.ok(md.includes('<summary>Deciding runs · 3 distinct of 6 runs recorded</summary>'));
  assert.ok(md.includes('<summary>Definitions</summary>'));
  for (const k of Object.keys(evidence.definitions)) assert.ok(md.includes(`- **${k}**: `));
  assert.ok(md.includes('`npx hunkproof --pr 42 --base main --head feat/tax-rate-table`'));
  assert.ok(md.includes('rewritten 3 times'));
  assert.ok(md.includes('ran, failed'));
  assert.ok(md.includes('· targeted'));
  assert.ok(md.includes(LABEL));
  // the fail hunk names the run that decided it; the command appears once, in the deciding-runs list
  assert.ok(md.includes(': ran, failed · rewritten 3 times · 2 runs after last edit (09:25:19 UTC) · decided by 09:31:17 node --test fail (tests 13, pass 11, fail 2) · targeted'));
  assert.ok(md.includes('- 09:31:17 node --test fail `node --test test/invoice.test.js` (tests 13, pass 11, fail 2)'));
  assert.equal((md.match(/node --test test\/invoice\.test\.js/g) || []).length, 1, 'commands are not repeated under every hunk');
  assert.ok(md.includes('agent commands are quoted verbatim'));
});

test('markdown: stays under the GitHub comment limit on a huge diff by degrading', () => {
  const ev = load();
  const base = ev.hunks.find((h) => h.status === 'RUN_PASS');
  const big = [];
  for (let i = 0; i < 3000; i++) {
    big.push({ ...base, id: `src/gen${i % 50}.js:${i}`, relFile: `src/gen${i % 50}.js`, file: `/home/dev/acme-billing/src/gen${i % 50}.js`, newStart: i, runsAfter: base.runsAfter.map((r) => ({ ...r, command: `node --test test/gen${i}.test.js # ${'x'.repeat(300)}` })) });
  }
  ev.hunks = big;
  ev.summary.hunks = big.length;
  const md = renderMarkdown(ev);
  assert.ok(md.length <= MD_MAX_CHARS, `comment is ${md.length} chars`);
  assert.ok(md.length < 65536);
  assert.ok(md.includes('### hunkproof · PR #42'));
  assert.ok(md.includes('<summary>Definitions</summary>'));
  assert.ok(md.includes('Reproduce locally:'));
  assert.ok(md.includes('not listed here: the comment would exceed GitHub'));
  // a medium diff keeps the hunk list but drops the commands first
  ev.hunks = big.slice(0, 150);
  const full = renderMarkdown(ev);
  assert.ok(full.length <= MD_MAX_CHARS && full.includes('xxxxxxxxxx'), `fits with commands at ${full.length} chars`);
  const mid = renderMarkdown(ev, { maxChars: 45000 });
  assert.ok(mid.length <= 45000, `comment is ${mid.length} chars`);
  assert.ok(mid.includes('All 150 hunks with the run that decided their status'), `level-1 output is ${mid.length} chars`);
  assert.ok(!mid.includes('xxxxxxxxxx'), 'long commands dropped at the first degradation level');
  // custom cap
  assert.ok(renderMarkdown(load(), { maxChars: 2000 }).includes('not listed here'));
});

test('markdown and html: other-checkout and other-session runs are marked; terminal shows them too', () => {
  const ev = load();
  const h = ev.hunks.find((x) => x.status === 'RUN_PASS');
  h.runsAfter = [
    { ...h.runsAfter[0], sessionId: 'zzzz9999-0000-4000-8000-000000000000', targeted: false, otherCheckout: true },
    { ...h.runsAfter[1], sessionId: h.edits[0].sessionId },
  ];
  const md = renderMarkdown(ev);
  assert.ok(md.includes('other checkout') === false, 'the deciding run is the same-checkout one');
  const html = renderHtml(ev);
  assert.match(html, /<span class="tgt other"(?: title="[^"]*")?>other checkout<\/span>/);
  assert.match(html, /<span class="tgt other"(?: title="[^"]*")?>other session<\/span>/);
  assert.equal(runMarkers(h, h.runsAfter[0]), ' (other checkout) (other session)');
  assert.equal(runMarkers(h, h.runsAfter[1]), ' (targeted)');
  // only an other-checkout run after the edit: the status cell says so
  h.runsAfter = [h.runsAfter[0]];
  h.status = 'RUN_UNPARSED';
  assert.equal(lastRunCell(h, ev.generatedAt), '10:09:40 eslint pass (other checkout) (other session)');
  assert.ok(renderMarkdown(ev).includes('decided by 10:09:40 eslint pass (0 problems) · other checkout · other session'));
});

test('terminal: runs on another day than the report carry their date; the header says UTC', () => {
  const ev = load();
  const h = ev.hunks.find((x) => x.status === 'RUN_FAIL');
  assert.equal(lastRunCell(h, ev.generatedAt), '09:31:17 node --test fail (targeted)');
  assert.equal(lastRunCell(h, '2026-10-14T08:00:00.000Z'), '2026-10-13 09:31:17 node --test fail (targeted)');
  const unrun = ev.hunks.find((x) => x.status === 'UNRUN');
  assert.equal(lastRunCell(unrun, '2026-10-14T08:00:00.000Z'), `none after edit at 2026-10-13 ${unrun.lastEdit.slice(11, 19)}`);
  const out = renderTerminal(ev);
  assert.match(out, /^file\s+hunk\s+status\s+last run \(UTC\)$/m);
  assert.ok(out.includes('unrun (file-level)'));
  assert.ok(out.includes('Agent sessions: 19,630 in'));
  // the last-run cell shows the deciding run (targeted pass), not a later untargeted one
  const h2 = { ...h, status: 'RUN_PASS', runsAfter: [{ ...h.runsAfter[0], outcome: 'pass', targeted: true }, { ...h.runsAfter[0], ts: '2026-10-13T09:40:00.000Z', outcome: 'pass', targeted: false }] };
  assert.equal(lastRunCell(h2, ev.generatedAt), '09:31:17 node --test pass (targeted)');
  const unattr = { status: 'UNATTRIBUTED', reason: 'only edits before the branch base', runsAfter: [] };
  assert.equal(lastRunCell(unattr), 'no agent edit matched (only edits before the branch base)');
});

test('models without a price entry are called out next to every dollar figure', () => {
  const ev = load();
  ev.usage.unpricedModels = ['claude-x-experimental'];
  ev.usage.byModel['claude-x-experimental'] = { input: 5, output: 5, cacheWrite: 0, cacheRead: 0, messages: 1 };
  ev.usage.costByModel = { ...(ev.usage.costByModel || {}), 'claude-x-experimental': null };
  const note = '1 model without a price entry excluded from the total (claude-x-experimental)';
  assert.ok(renderTerminal(ev).includes(note));
  assert.ok(renderMarkdown(ev).includes(note));
  const html = renderHtml(ev);
  assert.ok(html.includes(note));
  assert.ok(html.includes('<span class="noprice">no price entry</span>'));
  assert.ok(!renderTerminal(load()).includes('without a price entry'));
});

test('vocabulary: tool strings stay clean when every data field is a sentinel', () => {
  const DATA = 'DATA';
  const run = { ts: '2026-10-14T10:05:00.000Z', sessionId: DATA, toolUseId: DATA, command: DATA, runner: DATA, outcome: 'pass', summary: DATA, isError: false, targets: [DATA], targeted: true };
  const hunk = (id, attribution, status, runsAfter, extra = {}) => ({
    id, file: `/repo/${DATA}`, relFile: DATA, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, added: [DATA], removed: [DATA], addedNormalized: [DATA],
    attribution, status, runsAfter, churn: 2, lastEdit: '2026-10-14T10:00:00.000Z', score: 1,
    edits: [{ ts: '2026-10-14T10:00:00.000Z', sessionId: DATA, tool: 'Edit', toolUseId: DATA, chain: true }],
    intent: { text: DATA, ts: '2026-10-14T09:59:00.000Z', sessionId: DATA }, ...extra,
  });
  const ev = buildEvidence({
    repo: { root: `/repo/${DATA}`, remote: `git@github.com:${DATA}/${DATA}.git`, base: DATA, head: DATA, prNumber: 7, prUrl: `https://github.com/${DATA}/${DATA}/pull/7` },
    sessions: [{ sessionId: DATA, path: `/home/x/${DATA}.jsonl`, firstTs: '2026-10-14T09:00:00.000Z', lastTs: '2026-10-14T10:30:00.000Z', versions: [DATA], models: [DATA], toolCalls: 1, edits: 1, shellEdits: 1, runs: 1 }],
    hunks: [
      // 5 runs and 45 lines: the folded run list and the folded diff render too
      hunk('a', 'MATCHED', 'RUN_PASS', Array.from({ length: 5 }, () => run), { added: Array.from({ length: 45 }, () => DATA) }),
      hunk('b', 'MATCHED', 'RUN_FAIL', [{ ...run, outcome: 'fail' }]),
      hunk('c', 'MATCHED', 'RUN_UNPARSED', [{ ...run, outcome: 'unparsed', summary: null, otherCheckout: true, targeted: false }]),
      hunk('d', 'FILE_LEVEL', 'UNRUN', []),
      hunk('e', 'UNATTRIBUTED', 'UNATTRIBUTED', [], { edits: [], intent: null, lastEdit: null, reason: 'only edits before the branch base' }),
    ],
    runs: [run],
    usage: { ...summarizeUsage([{ type: 'usage', messageId: 'm', requestId: 'r', usage: { model: DATA, input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }]) },
    generatedAt: '2026-10-14T11:00:00.000Z', version: '0.1.0', home: '/home/x',
  });
  // the same diff with every hunk passed renders the pass lead
  const allPass = { ...ev, hunks: ev.hunks.map((h) => (h.status === 'UNATTRIBUTED' ? h : { ...h, status: 'RUN_PASS' })) };
  const outputs = [renderHtml(ev), renderHtml(ev, { theme: 'dark' }), renderHtml(allPass), renderMarkdown(ev), renderMarkdown(ev, { quotes: true, blobBase: 'https://example.invalid/b' }), renderTerminal(ev)];
  assert.ok(outputs[0].includes('more runs after the last edit') && outputs[0].includes('show all 46 lines'), 'the fold strings are rendered');
  assert.ok(outputs[2].includes(PASS_LEAD), 'the pass lead is rendered');
  const re = /\b(tested|verified|covered)\b|proof that it works/i;
  for (const out of outputs) {
    assert.doesNotMatch(out, re);
    assert.ok(out.includes(DATA));
  }
});

test('markdown: file:line links when blobBase is given, none otherwise', () => {
  const plain = renderMarkdown(evidence);
  assert.ok(!plain.includes('](https://'));
  const linked = renderMarkdown(evidence, { blobBase: 'https://github.com/acme/billing/blob/abc123/' });
  assert.ok(linked.includes('[src/invoice.js:77](https://github.com/acme/billing/blob/abc123/src/invoice.js#L77)'));
  assert.ok(linked.includes('[test/invoice.test.js:30](https://github.com/acme/billing/blob/abc123/test/invoice.test.js#L30)'));
  assert.ok(!linked.includes('abc123//'));
});

test('markdown: pipes and newlines in evidence do not break tables', () => {
  const ev = load();
  const h = ev.hunks.find((x) => x.status === 'UNRUN');
  h.attribution = 'A|B\nC';
  const md = renderMarkdown(ev);
  assert.ok(md.includes('A\\|B C'));
});

test('terminal: headline + table, one row per hunk', () => {
  const out = renderTerminal(evidence);
  const lines = out.split('\n');
  assert.equal(lines[0], `hunkproof · PR #42 · ${SENTENCE}`);
  assert.equal(lines[1], '');
  assert.ok(lines[2].startsWith('file') && lines[2].includes('hunk') && lines[2].includes('status') && lines[2].includes('last run'));
  for (const h of evidence.hunks) {
    const row = lines.find((l) => l.startsWith(h.relFile) && l.includes(`+${h.newStart}`));
    assert.ok(row, `row for ${h.id}`);
  }
  assert.ok(out.includes('ran, failed') && out.includes('unrun') && out.includes('unattributed'));
  assert.ok(out.includes('09:31:17 node --test fail (targeted)'));
  assert.ok(out.includes('no agent edit matched'));
  assert.ok(out.endsWith('Reproduce: npx hunkproof --pr 42 --base main --head feat/tax-rate-table\n'));
  assert.ok(!/\x1b\[/.test(out), 'no ANSI escapes');
  assert.equal(renderTerminalViaMd, renderTerminal, 'render-md re-exports renderTerminal');
});

test('renderers tolerate an empty diff-only evidence', () => {
  const ev = {
    schema: 'hunkproof/evidence@1',
    generatedAt: '2026-10-13T10:31:52.000Z',
    tool: { name: 'hunkproof', version: '0.1.0' },
    repo: { root: '/r', remote: null, base: 'main', head: 'HEAD', prNumber: null, prUrl: null },
    sessions: [],
    hunks: [],
    runs: [],
    usage: { byModel: {}, totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 }, costListUSD: 0, priceListDate: null, label: LABEL },
    summary: { hunks: 0, attributed: 0, matched: 0, fileLevel: 0, unattributed: 0, runAfterLastEdit: 0, runPass: 0, runFail: 0, runUnparsed: 0, unrun: 0, strictRunAfterLastEdit: 0, sessions: 0, durationSec: 0, toolCalls: 0, llmTokensUsedByHunkproof: 0, elapsedMs: 1 },
    definitions: {},
  };
  const html = renderHtml(ev);
  assert.ok(html.includes('0 of 0'));
  assert.ok(!/https?:\/\//.test(html.split(REPO_URL).join('')), 'no URL but the brand link');
  assert.ok(html.includes('<p class="lead">No hunks in this diff.</p>'));
  const md = renderMarkdown(ev);
  assert.ok(md.includes('No unrun hunks'));
  assert.ok(md.includes('`npx hunkproof --base main --head HEAD`'));
  const term = renderTerminal(ev);
  assert.ok(term.includes('main...HEAD'));
  assert.ok(term.includes('(no hunks in diff)'));
});

test('html: the lead shows unrun first, then failed, as figures; the rest goes to the sub-line', () => {
  const html = renderHtml(evidence);
  const lead = html.slice(html.indexOf('<div class="lead">'), html.indexOf('<p class="sub">'));
  // the unrun figure splits line-matched from file-level, so it adds up with the sub-line
  assert.match(lead, /^<div class="lead"><span class="fig" data-s="UNRUN" title="[^"]*"><b>3<\/b>unrun hunks \(2 line-matched, 1 file-level\)<\/span><span class="fig" data-s="RUN_FAIL" title="[^"]*"><b>1<\/b>hunk ran, failed<\/span><span class="fig" data-s="RUN_UNPARSED" title="[^"]*"><b>1<\/b>hunk ran, outcome not parsed<\/span><\/div>/);
  const sub = html.slice(html.indexOf('<p class="sub">'), html.indexOf('</p>', html.indexOf('<p class="sub">')));
  assert.ok(!sub.includes('<b>'), 'only the lead figures are bold');
  // one term for the matched count on every line: line-matched
  for (const bit of ['5 of 7 <a class="term" href="#def-attribution"', '>line-matched hunks</a>', '(3 passed, 1 failed, 1 outcome not parsed)', '>file-level</a>', '>unattributed</a>', '2 sessions', 'hunkproof used 0 LLM tokens']) assert.ok(sub.includes(bit), bit);
  assert.ok(!html.includes(PASS_LEAD));
  // the full contract sentence stays in the footer
  assert.ok(html.includes(`<p class="fine">Headline: ${escapeHtml(SENTENCE)}.</p>`));
});

test('html: no unrun, failed or unparsed hunk gives the one-line pass lead', () => {
  const ev = load();
  const set = (pred, status) => { for (const h of ev.hunks) if (pred(h)) h.status = status; };
  set((h) => ['UNRUN', 'RUN_FAIL', 'RUN_UNPARSED'].includes(h.status), 'RUN_PASS');
  const html = renderHtml(ev);
  assert.ok(html.includes(`<p class="lead pass">${PASS_LEAD}</p>`));
  assert.ok(!html.includes('<span class="fig"'));
  // failed alone leads with the failed figure: no "0 unrun" in the warning colour
  const failOnly = load();
  for (const h of failOnly.hunks) if (h.status === 'UNRUN' || h.status === 'RUN_UNPARSED') h.status = 'RUN_PASS';
  const f = renderHtml(failOnly);
  assert.match(f, /<div class="lead"><span class="fig" data-s="RUN_FAIL"[^>]*><b>1<\/b>hunk ran, failed<\/span><\/div>/);
  assert.ok(!f.includes('class="fig" data-s="UNRUN"') && !f.includes('<b>0</b>'));
  // a FILE_LEVEL hunk that ran and failed counts in the figure, as it does in the chip
  const fl = load();
  for (const h of fl.hunks) if (h.status !== 'UNATTRIBUTED') h.status = 'RUN_PASS';
  fl.hunks.find((h) => h.attribution === 'FILE_LEVEL').status = 'RUN_FAIL';
  fl.summary = { ...fl.summary, unrun: 0, runFail: 0, runUnparsed: 0 };
  const flHtml = renderHtml(fl);
  assert.ok(!flHtml.includes(PASS_LEAD));
  assert.ok(flHtml.includes('<b>1</b>hunk ran, failed</span>') && flHtml.includes('Ran, failed<span class="n">1</span>'));
});

test('html: outcomes not parsed are never good news', () => {
  const ev = load();
  for (const h of ev.hunks) if (h.status !== 'UNATTRIBUTED') h.status = 'RUN_UNPARSED';
  const html = renderHtml(ev);
  assert.ok(!html.includes(PASS_LEAD));
  assert.match(html, /<div class="lead"><span class="fig" data-s="RUN_UNPARSED"[^>]*><b>8<\/b>hunks ran, outcome not parsed<\/span><\/div>/);
  // one unparsed among passes still blocks the pass lead
  const one = load();
  for (const h of one.hunks) if (h.status === 'UNRUN' || h.status === 'RUN_FAIL') h.status = 'RUN_PASS';
  assert.ok(!renderHtml(one).includes(PASS_LEAD));
});

test('html: a diff with only file-level matches says so, not "no hunk matched"', () => {
  const ev = load();
  ev.hunks = ev.hunks.filter((h) => h.attribution === 'FILE_LEVEL').map((h) => ({ ...h, status: 'RUN_PASS' }));
  ev.summary = { ...ev.summary, matched: 0, attributed: 0, fileLevel: ev.hunks.length, unrun: 0, runFail: 0, runUnparsed: 0 };
  const html = renderHtml(ev);
  assert.ok(html.includes('<p class="lead">No hunk matched an agent edit line by line; 1 matched at file level.</p>'));
  ev.hunks = ev.hunks.map((h) => ({ ...h, status: 'UNRUN', runsAfter: [] }));
  assert.match(renderHtml(ev), /<b>1<\/b>unrun hunk \(file-level\)<\/span>/);
});

test('html: tooltips name statuses and attributions by their label, terms link to the footer', () => {
  const ev = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'unrun-example', 'evidence.json'), 'utf8'));
  const html = renderHtml(ev);
  assert.match(html, /<a class="badge" href="#def-status" data-s="UNRUN" title="Status: Decided by [^"]+ unrun: no run at all after the last edit\.">unrun<\/a>/);
  assert.match(html, /<a class="badge" href="#def-status" data-s="RUN_PASS" title="Status: [^"]+ ran, passed: that run passed\.">/);
  assert.match(html, /title="line-matched: most of the added lines[^"]*">line-matched hunks<\/a>/);
  assert.ok(!/title="[^"]*\b(RUN_PASS|RUN_FAIL|RUN_UNPARSED|UNRUN|MATCHED|FILE_LEVEL|UNATTRIBUTED)[ :(]/.test(html), 'no tooltip shows a case key');
  for (const k of ['attribution', 'status']) assert.ok(html.includes(`<dt id="def-${k}">`), k);
  assert.ok(html.includes('<a class="tgt dec" href="#def-status" title="Status: Decided by'));
  // 6 unrun = 3 line-matched + 3 file-level, next to "20 of 23 line-matched hunks"
  assert.ok(html.includes('<b>6</b>unrun hunks (3 line-matched, 3 file-level)</span>'));
  assert.ok(html.includes('20 of 23 <a class="term" href="#def-attribution"'));
});

test('html: a run from another checkout or without a parsed outcome never carries "decides status"', () => {
  const ev = load();
  const h = ev.hunks.find((x) => x.status === 'RUN_PASS');
  const base = h.runsAfter[0];
  h.runsAfter = [{ ...base, otherCheckout: true, targeted: false, outcome: 'pass' }];
  h.status = 'RUN_UNPARSED';
  const u = ev.hunks.find((x) => x.id === 'src/tax.js:22');
  const html = renderHtml(ev);
  const art = (id) => { const a = html.slice(html.indexOf(`id="h-${id.replace(/[^A-Za-z0-9_-]+/g, '-')}"`)); return a.slice(0, a.indexOf('</article>')); };
  assert.ok(!art(h.id).includes('decides status'));
  assert.ok(art(h.id).includes('other checkout'));
  assert.ok(!art(u.id).includes('decides status'), 'an unparsed run lists, it does not decide');
  assert.ok(art(ev.hunks.find((x) => x.status === 'RUN_FAIL').id).includes('decides status'));
});

test('html: defPart and defIntro cut the KEY: cases out of a definition', () => {
  const status = 'Decided by the last run. RUN_PASS: that run passed. RUN_FAIL: it failed ("ran, failed"). UNRUN: no run at all after the last edit.';
  assert.equal(defIntro(status), 'Decided by the last run.');
  assert.equal(defPart(status, 'RUN_FAIL'), 'RUN_FAIL: it failed ("ran, failed").');
  assert.equal(defPart(status, 'UNRUN', { intro: true }), 'Decided by the last run. UNRUN: no run at all after the last edit.');
  assert.equal(defPart(status, 'UNATTRIBUTED'), '');
  const attribution = 'MATCHED (line-matched): most lines appear. FILE_LEVEL: the file only.';
  assert.equal(defPart(attribution, 'MATCHED'), 'MATCHED (line-matched): most lines appear.');
  assert.equal(defPart(attribution, 'FILE_LEVEL'), 'FILE_LEVEL: the file only.');
  assert.equal(defIntro(attribution), '');
  assert.equal(defPart(undefined, 'X'), '');
  assert.equal(defIntro(null), '');
});

test('html: files, run lists and long diffs fold with <details> and keep every row', () => {
  const ev = load();
  const fail = ev.hunks.find((h) => h.status === 'RUN_FAIL');
  const base = fail.runsAfter[0];
  fail.runsAfter = Array.from({ length: 7 }, (_, i) => ({ ...base, ts: `2026-10-13T09:4${i}:00.000Z`, outcome: i === 2 ? 'fail' : 'pass', targeted: i === 2, summary: `run ${i}` }));
  fail.added = Array.from({ length: 45 }, (_, i) => `line ${i}`);
  fail.removed = [];
  const html = renderHtml(ev);
  const art = html.slice(html.indexOf(`id="h-${fail.id.replace(/[^A-Za-z0-9_-]+/g, '-')}"`));
  const one = art.slice(0, art.indexOf('</article>'));
  // the deciding run (the targeted fail, index 2) and the two latest others are open, in time order
  const open = one.slice(one.indexOf('<ol class="runs" aria-label'), one.indexOf('</ol>'));
  assert.deepEqual([...open.matchAll(/>run (\d)</g)].map((m) => m[1]), ['2', '5', '6']);
  assert.ok(open.includes('<li class="dec">') && open.includes('decides status'));
  assert.ok(one.includes('<details class="more"><summary><span class="c">4 more runs after the last edit</span>'));
  assert.equal((one.match(/<li[ >]/g) || []).length, 7, 'every run stays in the page');
  // 45 lines: 20 open, 25 folded, none lost
  assert.ok(one.includes('show all 45 lines (25 more)'));
  assert.equal((one.match(/<span class="l add">/g) || []).length, 45);
  // a file whose hunks all passed starts closed, the others open
  const sections = [...html.matchAll(/<section class="file" data-file="([^"]+)" data-open="([01])"><details( open)?>/g)];
  assert.equal(sections.length, 3);
  for (const [, file, flag, openAttr] of sections) {
    const statuses = ev.hunks.filter((h) => h.relFile === file).map((h) => h.status);
    const allPass = statuses.every((s) => s === 'RUN_PASS');
    assert.equal(flag, allPass ? '0' : '1', file);
    assert.equal(Boolean(openAttr), !allPass, file);
  }
  assert.doesNotMatch(html, /\b(tested|verified|covered)\b|proof that it works/i);
  // short run lists and short diffs do not fold
  assert.equal((renderHtml(load()).match(/<details class="more">/g) || []).length, 0);
});

test('html: no empty intent note, chips explain themselves, footer folds its definitions', () => {
  const html = renderHtml(evidence);
  assert.ok(!html.includes('no agent text in this turn'));
  assert.ok(!html.includes('aside class="note none'));
  const notes = evidence.hunks.filter((h) => h.status !== 'UNATTRIBUTED' && h.intent && h.intent.text).length;
  assert.equal((html.match(/<aside class="note mono">/g) || []).length, notes);
  assert.equal((html.match(/<div class="grid solo">/g) || []).length, evidence.hunks.length - notes);
  for (const [f, none] of [['all', 'No hunks in this diff.'], ['unrun', 'No unrun hunks.'], ['fail', 'No hunk ran and failed.'], ['unparsed', 'No hunk with an outcome not parsed.'], ['unattributed', 'No unattributed hunks.']]) {
    assert.match(html, new RegExp(`data-filter="${f}" data-none="${none.replace(/\./g, '\\.')}" aria-pressed="(true|false)" title="[^"]+"`), f);
  }
  assert.ok(html.includes('<details class="defs"><summary><h3>Definitions</h3></summary><dl>'));
  assert.ok(!html.includes('Agent sessions: '), 'the cost line is not repeated under the receipt');
  assert.ok(html.includes('<th class="path">transcript</th>'));
});

test('helpers', () => {
  assert.equal(fmtInt(612300), '612,300');
  assert.equal(fmtInt(0), '0');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});
