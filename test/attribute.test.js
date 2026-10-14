import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeHunks, applyStructuredPatch, editContentLines } from '../src/attribute.js';
import { parseUnifiedDiff } from '../src/diff.js';

const ROOT = '/repo';
const FILE = `${ROOT}/src/app.js`;

function base(over) {
  return {
    type: 'other', ts: '2026-10-14T10:00:00.000Z', sessionId: 's1', cwd: ROOT, gitBranch: 'feat', version: '2.1.299',
    messageId: null, requestId: null, toolUseId: null, uuid: null, isSidechain: false, ...over,
  };
}
function say(text, over = {}) { return base({ type: 'say', say: { text }, ...over }); }
function write(file, content, over = {}) {
  return base({
    type: 'edit', toolUseId: 'tu-w', ...over,
    edit: { tool: 'Write', file, newContent: content, addedLines: content.split('\n'), ...(over.edit || {}) },
  });
}
function editTool(file, newString, over = {}) {
  return base({
    type: 'edit', toolUseId: 'tu-e', ...over,
    edit: { tool: 'Edit', file, newContent: newString, addedLines: newString.split('\n'), oldString: 'old', ...(over.edit || {}) },
  });
}
function shellEdit(file, hunks, over = {}) {
  return base({
    type: 'shell_edit', toolUseId: 'tu-b', ...over,
    edit: { tool: 'Bash', file, newContent: null, addedLines: [], command: 'cmd', source: 'bashEditDiff', hunks, ...(over.edit || {}) },
  });
}

function hunksFor(diff) { return parseUnifiedDiff(diff, { repoRoot: ROOT }); }

const DIFF_APP = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1..2 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,0 +11,4 @@ function f() {',
  '+  if (a) {',
  '+    return  a;',
  '+  }',
  '+  log("done");',
  '',
].join('\n');

test('MATCHED when a Write carries all added lines; whitespace differences ignored', () => {
  const events = [
    say('I will add the guard.', { ts: '2026-10-14T10:00:00.000Z' }),
    write(FILE, 'function f() {\n\tif (a) {\n\t\treturn a;\n\t}\n\tlog("done");\n}\n', { ts: '2026-10-14T10:00:05.000Z' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.score, 1);
  assert.deepEqual(h.edits, [{ ts: '2026-10-14T10:00:05.000Z', sessionId: 's1', tool: 'Write', toolUseId: 'tu-w', chain: true }]);
  assert.equal(h.churn, 1);
  assert.equal(h.lastEdit, '2026-10-14T10:00:05.000Z');
  assert.equal(h.reason, undefined);
  assert.equal(h.checkout, undefined);
  assert.deepEqual(h.intent, { text: 'I will add the guard.', ts: '2026-10-14T10:00:00.000Z', sessionId: 's1' });
  // Hunk fields are preserved
  assert.equal(h.id, 'src/app.js:11');
  assert.deepEqual(h.addedNormalized, ['if (a) {', 'return a;', '}', 'log("done");']);
});

test('UNATTRIBUTED when no edit touched the file', () => {
  const events = [say('hello'), write(`${ROOT}/other.js`, 'if (a) {\nreturn a;\n}\nlog("done");\n')];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'UNATTRIBUTED');
  assert.equal(h.score, 0);
  assert.deepEqual(h.edits, []);
  assert.equal(h.churn, 0);
  assert.equal(h.lastEdit, null);
  assert.equal(h.intent, null);
});

test('FILE_LEVEL when the file was touched but lines do not reach the threshold', () => {
  const events = [
    say('tweak'),
    editTool(FILE, 'log("done");', { ts: '2026-10-14T10:01:00.000Z' }), // 1 of 4 lines
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'FILE_LEVEL');
  assert.equal(h.score, 0.25);
  assert.equal(h.edits.length, 1);
  assert.equal(h.churn, 1);
  assert.equal(h.lastEdit, '2026-10-14T10:01:00.000Z');
  assert.equal(h.intent.text, 'tweak');
});

test('threshold option: the same evidence flips between FILE_LEVEL and MATCHED', () => {
  const events = [editTool(FILE, 'if (a) {\n  return a;\n}')]; // 3 of 4 = 0.75
  assert.equal(attributeHunks(hunksFor(DIFF_APP), events)[0].attribution, 'MATCHED');
  assert.equal(attributeHunks(hunksFor(DIFF_APP), events, { threshold: 0.8 })[0].attribution, 'FILE_LEVEL');
  assert.equal(attributeHunks(hunksFor(DIFF_APP), events, { threshold: 0.75 })[0].attribution, 'MATCHED');
});

test('edit chain: several edits in one session add up to a match', () => {
  const events = [
    say('first half', { ts: '2026-10-14T10:00:00.000Z' }),
    editTool(FILE, 'if (a) {\n  return a;', { ts: '2026-10-14T10:00:10.000Z', toolUseId: 'e1' }),
    say('second half', { ts: '2026-10-14T10:00:20.000Z' }),
    editTool(FILE, '}\nlog("done");', { ts: '2026-10-14T10:00:30.000Z', toolUseId: 'e2' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.score, 1);
  assert.deepEqual(h.edits.map((e) => e.toolUseId), ['e1', 'e2']);
  assert.equal(h.churn, 2);
  assert.equal(h.lastEdit, '2026-10-14T10:00:30.000Z');
  assert.equal(h.intent.text, 'second half', 'intent is the say preceding the last matched edit');
});

test('best chain wins across sessions; edits list every overlapping edit with the winning chain flagged, churn counts them all', () => {
  const events = [
    say('session one', { sessionId: 'sA', ts: '2026-10-14T09:00:00.000Z' }),
    editTool(FILE, 'log("done");', { sessionId: 'sA', ts: '2026-10-14T09:00:01.000Z', toolUseId: 'a1' }),
    say('session two', { sessionId: 'sB', ts: '2026-10-14T09:30:00.000Z' }),
    editTool(FILE, 'if (a) {\n  return a;\n}', { sessionId: 'sB', ts: '2026-10-14T09:30:01.000Z', toolUseId: 'b1' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.score, 0.75);
  assert.deepEqual(h.edits.map((e) => [e.toolUseId, e.chain]), [['a1', false], ['b1', true]]);
  assert.equal(h.churn, 2);
  assert.equal(h.intent.text, 'session two');
  assert.equal(h.intent.sessionId, 'sB');
});

test('lastEdit is always the ts of a listed edit, even when it comes from another session than the chain', () => {
  const events = [
    editTool(FILE, 'if (a) {\n  return a;\n}\nlog("done");', { sessionId: 'sA', ts: '2026-10-14T09:00:01.000Z', toolUseId: 'a1' }),
    editTool(FILE, 'log("done");', { sessionId: 'sB', ts: '2026-10-14T11:09:41.000Z', toolUseId: 'b1' }), // later touch by another agent
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.deepEqual(h.edits.map((e) => [e.toolUseId, e.chain]), [['a1', true], ['b1', false]]);
  assert.equal(h.lastEdit, '2026-10-14T11:09:41.000Z');
  assert.ok(h.edits.some((e) => e.ts === h.lastEdit), 'the edit that defines lastEdit is listed');
  assert.equal(h.edits.find((e) => e.ts === h.lastEdit).sessionId, 'sB');
});

test('tie between chains goes to the most recent edit', () => {
  const events = [
    editTool(FILE, 'if (a) {\n  return a;\n}', { sessionId: 'sA', ts: '2026-10-14T09:00:01.000Z', toolUseId: 'a1' }),
    editTool(FILE, 'if (a) {\n  return a;\n}', { sessionId: 'sB', ts: '2026-10-14T09:30:01.000Z', toolUseId: 'b1' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.deepEqual(h.edits.map((e) => [e.toolUseId, e.chain]), [['a1', false], ['b1', true]]);
  assert.equal(h.lastEdit, '2026-10-14T09:30:01.000Z');
});

test('tie between chains prefers the one with an Edit/Write over a shell edit, even when the shell edit is later', () => {
  const lines = [{ oldStart: 10, oldLines: 0, newStart: 11, newLines: 4, lines: ['+  if (a) {', '+    return a;', '+  }', '+  log("done");'] }];
  const events = [
    say('writing the guard', { sessionId: 'sA', ts: '2026-10-14T10:29:00.000Z' }),
    write(FILE, 'function f() {\n  if (a) {\n    return a;\n  }\n  log("done");\n}\n', { sessionId: 'sA', ts: '2026-10-14T10:29:55.000Z', toolUseId: 'w1' }),
    say('assembling the video', { sessionId: 'sB', ts: '2026-10-14T10:31:00.000Z' }),
    shellEdit(FILE, lines, { sessionId: 'sB', ts: '2026-10-14T10:31:20.000Z', toolUseId: 'b1', edit: { source: 'bashEditDiff', command: 'cat > /tmp/x.py <<EOF\nprint(1)\nEOF' } }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.deepEqual(h.edits.map((e) => [e.toolUseId, e.chain]), [['w1', true], ['b1', false]]);
  assert.equal(h.intent.text, 'writing the guard');
  assert.equal(h.intent.sessionId, 'sA');
});

test('bashEditDiff entries tagged git plumbing or uncorroborated are not edits at all', () => {
  const lines = [{ oldStart: 10, oldLines: 0, newStart: 11, newLines: 4, lines: ['+  if (a) {', '+    return a;', '+  }', '+  log("done");'] }];
  const phantoms = [
    shellEdit(FILE, lines, { sessionId: 'sB', ts: '2026-10-14T10:31:20.000Z', toolUseId: 'b1', edit: { source: 'bashEditDiff-uncorroborated', command: 'until gh pr view 1; do sleep 5; done' } }),
    shellEdit(FILE, lines, { sessionId: 'sC', ts: '2026-10-14T10:40:00.000Z', toolUseId: 'c1', edit: { source: 'bashEditDiff-git', command: 'git pull -q' } }),
  ];
  const [alone] = attributeHunks(hunksFor(DIFF_APP), phantoms);
  assert.equal(alone.attribution, 'UNATTRIBUTED');
  assert.deepEqual(alone.edits, []);
  assert.equal(alone.churn, 0);

  const real = write(FILE, 'function f() {\n  if (a) {\n    return a;\n  }\n  log("done");\n}\n', { sessionId: 'sA', ts: '2026-10-14T10:29:55.000Z', toolUseId: 'w1' });
  const [h] = attributeHunks(hunksFor(DIFF_APP), [real, ...phantoms]);
  assert.equal(h.attribution, 'MATCHED');
  assert.deepEqual(h.edits.map((e) => e.toolUseId), ['w1']);
  assert.equal(h.lastEdit, '2026-10-14T10:29:55.000Z', 'the later phantom does not move lastEdit');
  assert.equal(h.churn, 1);
});

test('since: a FILE_LEVEL hunk whose only edits predate the branch base is UNATTRIBUTED with a reason', () => {
  const events = [
    say('bootstrap'),
    shellEdit(FILE, [], { ts: '2026-10-14T10:20:37.000Z', edit: { source: 'regex', command: 'cat > src/app.js <<EOF\nx\nEOF' } }),
  ];
  const [fl] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(fl.attribution, 'FILE_LEVEL');
  const [h] = attributeHunks(hunksFor(DIFF_APP), events, { since: '2026-10-14T10:20:58.000Z' });
  assert.equal(h.attribution, 'UNATTRIBUTED');
  assert.equal(h.reason, 'only edits before the branch base');
  assert.deepEqual(h.edits, []);
  assert.equal(h.lastEdit, null);
  // one edit after the base keeps FILE_LEVEL
  const later = [...events, shellEdit(FILE, [], { ts: '2026-10-14T10:21:00.000Z', toolUseId: 'tu-b2', edit: { source: 'regex', command: 'sed -i s/a/b/ src/app.js' } })];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), later, { since: '2026-10-14T10:20:58.000Z' })[0].attribution, 'FILE_LEVEL');
  // MATCHED hunks are never downgraded by since
  const matched = [write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n', { ts: '2026-10-14T10:00:00.000Z' })];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), matched, { since: '2026-10-14T10:20:58.000Z' })[0].attribution, 'MATCHED');
});

test('checkout of the last edit is carried onto the hunk', () => {
  const events = [
    write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n', { ts: '2026-10-14T10:00:00.000Z', edit: { checkout: '/repo/.claude/worktrees/feat' } }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.checkout, '/repo/.claude/worktrees/feat');
  assert.equal(h.edits[0].checkout, '/repo/.claude/worktrees/feat');
});

test('deletion-only hunk: FILE_LEVEL by file touch, churn = edits on the file, lastEdit = last edit', () => {
  const diff = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 4..0',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-del1',
    '-del2',
    '',
  ].join('\n');
  const events = [
    say('removing the file', { ts: '2026-10-14T10:00:00.000Z' }),
    shellEdit(`${ROOT}/gone.txt`, [], { ts: '2026-10-14T10:00:01.000Z', edit: { source: 'regex', command: 'rm gone.txt' } }),
    shellEdit(`${ROOT}/gone.txt`, [], { ts: '2026-10-14T10:00:02.000Z', edit: { source: 'regex', command: 'git rm gone.txt' }, toolUseId: 'tu-b2' }),
  ];
  const [h] = attributeHunks(hunksFor(diff), events);
  assert.equal(h.attribution, 'FILE_LEVEL');
  assert.equal(h.score, 0);
  assert.equal(h.churn, 2);
  assert.equal(h.lastEdit, '2026-10-14T10:00:02.000Z');
  assert.equal(h.edits.length, 2);
  assert.equal(h.edits[0].source, 'regex');
  assert.equal(h.intent.text, 'removing the file');

  const [u] = attributeHunks(hunksFor(diff), [say('nothing')]);
  assert.equal(u.attribution, 'UNATTRIBUTED');
});

test('renamed file: edits made under the old path still attribute', () => {
  const diff = [
    'diff --git a/old.txt b/lib/renamed.txt',
    'similarity index 66%',
    'rename from old.txt',
    'rename to lib/renamed.txt',
    'index 7..8 100644',
    '--- a/old.txt',
    '+++ b/lib/renamed.txt',
    '@@ -2,0 +3 @@ y',
    '+z',
    '',
  ].join('\n');
  const events = [write(`${ROOT}/old.txt`, 'x\ny\nz\n')];
  const [h] = attributeHunks(hunksFor(diff), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.file, `${ROOT}/lib/renamed.txt`);
});

test('shell_edit: "+" lines of bashEditDiff hunks count as new content, source is reported', () => {
  const events = [
    say('patch via sed'),
    shellEdit(FILE, [
      { oldStart: 10, oldLines: 1, newStart: 11, newLines: 4, lines: [' context', '+  if (a) {', '+    return a;', '+  }', '+  log("done");', '-removed'] },
    ], { edit: { source: 'bashEditDiff', command: 'sed -i ...' } }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.score, 1);
  assert.deepEqual(h.edits, [{ ts: events[1].ts, sessionId: 's1', tool: 'Bash', toolUseId: 'tu-b', source: 'bashEditDiff', chain: true }]);
});

test('context (" ") and removed ("-") shell hunk lines do not count as new content', () => {
  const events = [
    shellEdit(FILE, [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' if (a) {', ' return a;', ' }', '-log("done");', '+log("later");'] }]),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'FILE_LEVEL');
  assert.equal(h.score, 0);
  assert.equal(h.churn, 0);
});

test('applyStructuredPatch rebuilds the post-edit file', () => {
  const original = 'a\nb\nc\nd\n';
  const patch = [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, lines: ['-b', '+B', '+B2'] },
    { oldStart: 4, oldLines: 1, newStart: 5, newLines: 1, lines: [' d'] },
  ];
  assert.deepEqual(applyStructuredPatch(original, patch), ['a', 'B', 'B2', 'c', 'd', '']);
  assert.equal(applyStructuredPatch(null, patch), null);
  assert.equal(applyStructuredPatch(original, []), null);
  // overlapping hunks are rejected
  assert.equal(applyStructuredPatch(original, [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', ' b', ' c'] },
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+x'] },
  ]), null);
});

test('originalFile + structuredPatch: unchanged lines from the original count toward the match', () => {
  // The hunk adds four lines versus base; the Edit only changed the log line, the other three were already there.
  const original = 'function f() {\n  if (a) {\n    return a;\n  }\n  log("todo");\n}\n';
  const events = [
    editTool(FILE, 'log("done");', {
      edit: {
        originalFile: original,
        structuredPatch: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-  log("todo");', '+  log("done");'] }],
      },
    }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.score, 1);

  const lines = editContentLines(events[0].edit);
  assert.ok(lines.has('if (a) {'));
  assert.ok(lines.has('log("done");'));
  assert.ok(!lines.has('log("todo");'));
});

test('editContentLines: empty lines are dropped, all sources merge', () => {
  const lines = editContentLines({
    newContent: 'a\n\n  b  ',
    addedLines: ['c', '   '],
    hunks: [{ lines: ['+d', '-e', ' f'] }],
    structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+g'] }],
    originalFile: null, // unusable: fall back to the "+"/" " lines of structuredPatch
  });
  assert.deepEqual([...lines].sort(), ['a', 'b', 'c', 'd', 'g']);
  assert.equal(editContentLines(null).size, 0);
});

test('intent: nearest preceding say in the same session only; cut to 200 chars with an ellipsis', () => {
  const long = 'x'.repeat(260);
  const events = [
    say('other session talk', { sessionId: 'sZ', ts: '2026-10-14T10:00:00.000Z' }),
    say(`  ${long}  `, { sessionId: 's1', ts: '2026-10-14T10:00:01.000Z' }),
    say('later, after the edit', { sessionId: 's1', ts: '2026-10-14T10:00:03.000Z' }),
  ];
  // insert the edit between the two s1 says, in array order
  events.splice(2, 0, write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n', { ts: '2026-10-14T10:00:02.000Z' }));
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.intent.sessionId, 's1');
  assert.equal(h.intent.ts, '2026-10-14T10:00:01.000Z');
  assert.equal(h.intent.text.length, 200);
  assert.ok(h.intent.text.endsWith('…'));
  assert.equal(h.intent.text, `${'x'.repeat(199)}…`);
});

test('intent is null when the edit has no preceding say in its session', () => {
  const events = [say('wrong session', { sessionId: 'sZ' }), write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n')];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.intent, null);
});

test('say events with only whitespace are ignored for intent', () => {
  const events = [say('real words'), say('   \n  '), write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n')];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.intent.text, 'real words');
});

// Intent rule with real-shaped transcripts: messageId groups the text block and the tool_use blocks
// of one assistant message; a `tool` event is any other tool call (Read, Bash, ...).
const CONTENT = 'if (a) {\nreturn a;\n}\nlog("done");\n';
function tool(name, over = {}) { return base({ type: 'tool', tool: { name, input: {}, result: null }, ...over }); }

test('intent: text of another session is ignored even when it is the nearest in time', () => {
  const events = [
    say('mine, a while ago', { sessionId: 's1', messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    say('parent session talking right before', { sessionId: 'parent', messageId: 'p1', ts: '2026-10-14T10:00:04.000Z' }),
    write(FILE, CONTENT, { sessionId: 's1', messageId: 'm2', ts: '2026-10-14T10:00:05.000Z' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.deepEqual(h.intent, { text: 'mine, a while ago', ts: '2026-10-14T10:00:00.000Z', sessionId: 's1' });
});

test('intent: text older than 15 minutes does not qualify, 15 minutes exactly does', () => {
  const tooOld = [
    say('plan from before lunch', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    write(FILE, CONTENT, { messageId: 'm2', ts: '2026-10-14T10:15:00.001Z' }),
  ];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), tooOld)[0].intent, null);
  const atCap = [
    say('plan from before lunch', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    write(FILE, CONTENT, { messageId: 'm2', ts: '2026-10-14T10:15:00.000Z' }),
  ];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), atCap)[0].intent.text, 'plan from before lunch');
});

test('intent: null when a tool call in a third message separates the text from the edit', () => {
  // text + edits of other files in m1, a run in m2 (thinking only), then the edit in m3: the m1 text
  // is about m1, not about an edit made after reading the run output
  const events = [
    say('Now the attribute tests, then new regression tests.', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    write(`${ROOT}/test/x.test.js`, 'x', { messageId: 'm1', ts: '2026-10-14T10:00:05.000Z', toolUseId: 'w0' }),
    tool('Bash', { messageId: 'm2', ts: '2026-10-14T10:01:00.000Z', toolUseId: 'b1' }),
    write(FILE, CONTENT, { messageId: 'm3', ts: '2026-10-14T10:02:00.000Z', toolUseId: 'w1' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.equal(h.intent, null);
  // a single intervening edit of another file, in its own message, is enough
  const oneEdit = [
    say('Fixing the guard.', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    write(`${ROOT}/other.js`, 'y', { messageId: 'm2', ts: '2026-10-14T10:00:30.000Z', toolUseId: 'w0' }),
    write(FILE, CONTENT, { messageId: 'm3', ts: '2026-10-14T10:01:00.000Z', toolUseId: 'w1' }),
  ];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), oneEdit)[0].intent, null);
});

test('intent: tool calls in the text message or in the edit message itself do not separate them', () => {
  // "text, Read, Edit" in one turn, then a thinking-only turn that reads again and edits
  const events = [
    say('Adding the guard after a look at the callers.', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    tool('Read', { messageId: 'm1', ts: '2026-10-14T10:00:01.000Z', toolUseId: 'r1' }),
    tool('Grep', { messageId: 'm2', ts: '2026-10-14T10:00:10.000Z', toolUseId: 'r2' }),
    write(FILE, CONTENT, { messageId: 'm2', ts: '2026-10-14T10:00:12.000Z', toolUseId: 'w1' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.intent.text, 'Adding the guard after a look at the callers.');
  // a text-only turn, a user reply, then the tool turn
  const approved = [
    say('I will add the guard, ok?', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    base({ type: 'other', messageId: null, ts: '2026-10-14T10:03:00.000Z' }),
    write(FILE, CONTENT, { messageId: 'm2', ts: '2026-10-14T10:03:05.000Z', toolUseId: 'w1' }),
  ];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), approved)[0].intent.text, 'I will add the guard, ok?');
});

test('intent: text in the same message as the edit is preferred over an older qualifying text', () => {
  const events = [
    say('earlier turn, still adjacent', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    say('this very edit', { messageId: 'm2', ts: '2026-10-14T10:00:30.000Z' }),
    write(FILE, CONTENT, { messageId: 'm2', ts: '2026-10-14T10:00:31.000Z', toolUseId: 'w1' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.deepEqual(h.intent, { text: 'this very edit', ts: '2026-10-14T10:00:30.000Z', sessionId: 's1' });
  // same-message text is the same turn: it qualifies even when slow tool calls spread the message over 15 min
  const slow = [
    say('long turn', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    tool('Bash', { messageId: 'm1', ts: '2026-10-14T10:00:01.000Z', toolUseId: 'b1' }),
    write(FILE, CONTENT, { messageId: 'm1', ts: '2026-10-14T10:20:00.000Z', toolUseId: 'w1' }),
  ];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), slow)[0].intent.text, 'long turn');
});

test('intent: FILE_LEVEL hunks take the intent of their last edit under the same rule', () => {
  const partial = 'log("done");'; // 1 of 4 lines: FILE_LEVEL
  const stale = [
    say('Now the attribute tests.', { messageId: 'm1', ts: '2026-10-14T10:00:00.000Z' }),
    editTool(FILE, partial, { messageId: 'm1', ts: '2026-10-14T10:00:05.000Z', toolUseId: 'e1' }),
    tool('Bash', { messageId: 'm2', ts: '2026-10-14T10:01:00.000Z', toolUseId: 'b1' }),
    editTool(FILE, partial, { messageId: 'm3', ts: '2026-10-14T10:02:00.000Z', toolUseId: 'e2' }),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), stale);
  assert.equal(h.attribution, 'FILE_LEVEL');
  assert.equal(h.lastEdit, '2026-10-14T10:02:00.000Z');
  assert.equal(h.intent, null, 'the last edit has no text of its own; the first edit\'s text is not borrowed');
  const fresh = [...stale, say('Renaming the log call.', { messageId: 'm4', ts: '2026-10-14T10:03:00.000Z' }), editTool(FILE, partial, { messageId: 'm4', ts: '2026-10-14T10:03:02.000Z', toolUseId: 'e3' })];
  assert.equal(attributeHunks(hunksFor(DIFF_APP), fresh)[0].intent.text, 'Renaming the log call.');
});

test('multiple hunks are attributed independently and keep order', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1..2 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1 +1 @@',
    '-old',
    '+new header',
    '@@ -10,0 +11,2 @@',
    '+if (a) {',
    '+}',
    'diff --git a/README.md b/README.md',
    'index 1..2 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -0,0 +1 @@',
    '+# Title',
    '',
  ].join('\n');
  const events = [editTool(FILE, 'if (a) {\n}')];
  const out = attributeHunks(hunksFor(diff), events);
  assert.deepEqual(out.map((h) => [h.id, h.attribution]), [
    ['src/app.js:1', 'FILE_LEVEL'],
    ['src/app.js:11', 'MATCHED'],
    ['README.md:1', 'UNATTRIBUTED'],
  ]);
});

test('non-edit events and malformed entries are ignored safely', () => {
  const events = [
    null,
    base({ type: 'tool', tool: { name: 'Read', input: {}, result: null } }),
    base({ type: 'edit' }), // missing edit payload
    base({ type: 'edit', edit: { tool: 'Write', file: null, newContent: 'x', addedLines: ['x'] } }),
    write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n'),
  ];
  const [h] = attributeHunks(hunksFor(DIFF_APP), events);
  assert.equal(h.attribution, 'MATCHED');
  assert.deepEqual(attributeHunks([], events), []);
  assert.equal(attributeHunks(hunksFor(DIFF_APP), undefined)[0].attribution, 'UNATTRIBUTED');
});

test('output strings respect the vocabulary rule', () => {
  const events = [say('ok'), write(FILE, 'if (a) {\nreturn a;\n}\nlog("done");\n')];
  const text = JSON.stringify(attributeHunks(hunksFor(DIFF_APP), events));
  for (const banned of ['tested', 'verified', 'covered', 'proof that it works']) {
    assert.equal(text.includes(banned), false, banned);
  }
});
