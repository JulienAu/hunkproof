// Cross-module regressions reproduced from real transcripts (rewritten as
// synthetic fixtures): transcript.js -> attribute.js / runs.js end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSession } from '../src/transcript.js';
import { attributeHunks } from '../src/attribute.js';
import { parseUnifiedDiff } from '../src/diff.js';
import { extractRuns, runsForHunk, hunkStatus } from '../src/runs.js';
import { scoreSession } from '../src/discover.js';

let tmp;
const REPO = '/home/dev/proj';
const line = (o) => JSON.stringify(o) + '\n';

function session(sid, cwd, entries) {
  const common = { sessionId: sid, cwd, gitBranch: 'feat', version: '2.1.299', isSidechain: false };
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const out = [];
  let n = 0;
  for (const e of entries) {
    n++;
    if (e.say) {
      out.push(line({ ...common, type: 'assistant', uuid: `${sid}-a${n}`, timestamp: e.ts, requestId: `r${n}`, message: { id: `m${n}`, model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'text', text: e.say }] } }));
      continue;
    }
    out.push(line({ ...common, type: 'assistant', uuid: `${sid}-a${n}`, timestamp: e.ts, requestId: `r${n}`, message: { id: `m${n}`, model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: e.id, name: e.tool, input: e.input }] } }));
    out.push(line({ ...common, type: 'user', uuid: `${sid}-u${n}`, timestamp: e.resultTs || new Date(Date.parse(e.ts) + 1500).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.id, content: e.content || '' }] }, toolUseResult: e.result }));
  }
  return out.join('');
}

const A_CONTENT = 'export function add(a, b) {\n  return a + b;\n}\n';
const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'new file mode 100644',
  'index 0..1',
  '--- /dev/null',
  '+++ b/src/a.js',
  '@@ -0,0 +1,3 @@',
  '+export function add(a, b) {',
  '+  return a + b;',
  '+}',
  '',
].join('\n');

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkproof-regress-'));
  // Session A (a worker agent): Writes src/a.js at 10:29:55, then runs the tests.
  fs.writeFileSync(path.join(tmp, 'a.jsonl'), session('aaaaaaaa-0000-4000-8000-000000000001', REPO, [
    { ts: '2026-10-14T10:29:50.000Z', say: 'Adding the add() helper.' },
    { ts: '2026-10-14T10:29:55.778Z', id: 'toolu_write_a', tool: 'Write', input: { file_path: `${REPO}/src/a.js`, content: A_CONTENT }, result: { type: 'create', filePath: `${REPO}/src/a.js`, content: A_CONTENT, structuredPatch: [], originalFile: null, userModified: false } },
    { ts: '2026-10-14T10:30:10.000Z', id: 'toolu_test_a', tool: 'Bash', input: { command: 'node --test test/' }, result: { stdout: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n', stderr: '', interrupted: false, isImage: false } },
  ]));
  // Session B (the orchestrator, cwd elsewhere): assembles a video in a scratch
  // dir while A's Write lands; Claude Code reports A's file in B's bashEditDiff.
  fs.writeFileSync(path.join(tmp, 'b.jsonl'), session('bbbbbbbb-0000-4000-8000-000000000002', '/home/dev', [
    { ts: '2026-10-14T10:31:00.000Z', say: 'The scenes are rendered, assembling the clip.' },
    {
      ts: '2026-10-14T10:31:20.252Z', id: 'toolu_bash_b', tool: 'Bash',
      input: { command: "cd /tmp/scratch/video && cat > assemble.py <<'EOF'\nimport subprocess\nsubprocess.run(['ffmpeg', '-y', 'out.mp4'])\nEOF\npython3 assemble.py" },
      content: 'done',
      result: { stdout: 'done', stderr: '', interrupted: false, isImage: false, bashEditDiff: { files: [{ filePath: `${REPO}/src/a.js`, created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+export function add(a, b) {', '+  return a + b;', '+}'] }] }], moreFiles: 0 } },
    },
    // later, B polls GitHub while the branch merges elsewhere: README changes show up in its diff
    {
      ts: '2026-10-14T10:40:00.000Z', id: 'toolu_poll_b', tool: 'Bash',
      input: { command: 'until gh pr view 1 --json state -q .state | grep -q MERGED; do sleep 30; done; echo merged' },
      content: 'merged',
      result: { stdout: 'merged', stderr: '', interrupted: false, isImage: false, bashEditDiff: { files: [{ filePath: `${REPO}/src/a.js`, hunks: [{ oldStart: 3, oldLines: 0, newStart: 4, newLines: 1, lines: ['+// merged'] }] }], moreFiles: 0 } },
    },
  ]));
});

after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('a bashEditDiff that lists another session\'s Write does not steal the attribution', async () => {
  const a = await readSession(path.join(tmp, 'a.jsonl'));
  const b = await readSession(path.join(tmp, 'b.jsonl'));
  const bEdits = b.events.filter((e) => e.type === 'shell_edit');
  assert.equal(bEdits.length, 2);
  assert.deepEqual(bEdits.map((e) => e.edit.source), ['bashEditDiff-uncorroborated', 'bashEditDiff-uncorroborated']);

  const events = [...a.events, ...b.events].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  const hunks = parseUnifiedDiff(DIFF, { repoRoot: REPO });
  const [h] = attributeHunks(hunks, events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.score, 1);
  assert.deepEqual(h.edits.map((e) => [e.sessionId.slice(0, 8), e.tool, e.toolUseId, e.chain]), [['aaaaaaaa', 'Write', 'toolu_write_a', true]]);
  assert.equal(h.lastEdit, '2026-10-14T10:29:55.778Z', 'the phantom 10:31:20 and 10:40:00 edits do not move lastEdit');
  assert.equal(h.intent.text, 'Adding the add() helper.');
  assert.equal(h.intent.sessionId.slice(0, 8), 'aaaaaaaa');
  assert.equal(h.churn, 1);

  // A's run after its Write is kept and decides the status
  const runs = extractRuns(events.filter((e) => e.type === 'tool'), { repoRoot: REPO });
  assert.deepEqual(runs.map((r) => r.toolUseId), ['toolu_test_a']);
  const after = runsForHunk(h, runs);
  assert.equal(hunkStatus(h, after), 'RUN_PASS');

  // discovery scoring does not credit B with edits of the diff file either
  const sb = scoreSession(b, { repoRoot: REPO, prNumber: null, prRepository: null, headRef: null, diffFiles: [`${REPO}/src/a.js`], timeWindow: null });
  assert.equal(sb.fileHits, 0);
  const sa = scoreSession(a, { repoRoot: REPO, prNumber: null, prRepository: null, headRef: null, diffFiles: [`${REPO}/src/a.js`], timeWindow: null });
  assert.equal(sa.fileHits, 1);
});

test('a real shell write still attributes through bashEditDiff', async () => {
  fs.writeFileSync(path.join(tmp, 'c.jsonl'), session('cccccccc-0000-4000-8000-000000000003', REPO, [
    { ts: '2026-10-14T11:00:00.000Z', say: 'Writing it with a heredoc.' },
    {
      ts: '2026-10-14T11:00:05.000Z', id: 'toolu_heredoc_c', tool: 'Bash',
      input: { command: "cat > src/a.js <<'EOF'\nexport function add(a, b) {\n  return a + b;\n}\nEOF" },
      result: { stdout: '', stderr: '', interrupted: false, isImage: false, bashEditDiff: { files: [{ filePath: `${REPO}/src/a.js`, created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+export function add(a, b) {', '+  return a + b;', '+}'] }] }], moreFiles: 0 } },
    },
  ]));
  const c = await readSession(path.join(tmp, 'c.jsonl'));
  const [h] = attributeHunks(parseUnifiedDiff(DIFF, { repoRoot: REPO }), c.events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.edits[0].source, 'bashEditDiff');
  assert.equal(h.intent.text, 'Writing it with a heredoc.');
});
