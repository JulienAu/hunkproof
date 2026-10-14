import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COST_LABEL, PRICES, costOf, priceFor, summarizeUsage } from '../src/cost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pricesOnDisk = JSON.parse(readFileSync(path.join(here, '..', 'src', 'prices.json'), 'utf8'));

function usageEvent(over = {}) {
  return {
    type: 'usage',
    ts: '2026-10-14T10:00:00.000Z',
    sessionId: 's1',
    messageId: 'msg_a',
    requestId: 'req_a',
    uuid: 'u1',
    usage: { model: 'claude-opus-5-5', input: 10, output: 5, cacheWrite: 100, cacheRead: 1000 },
    ...over,
  };
}

test('prices.json has a dated list with a source note and null unknown', () => {
  assert.equal(pricesOnDisk.priceListDate, '2026-10-14');
  assert.match(pricesOnDisk.source, /list price/i);
  assert.equal(pricesOnDisk.models.unknown, null);
  for (const [id, row] of Object.entries(pricesOnDisk.models)) {
    if (id === 'unknown') continue;
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) {
      assert.equal(typeof row[k], 'number', `${id}.${k}`);
      assert.ok(row[k] > 0, `${id}.${k} > 0`);
    }
  }
  for (const family of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4']) {
    assert.ok(Object.keys(pricesOnDisk.models).some((k) => k.startsWith(family)), family);
  }
});

test('priceFor matches exact ids, dated suffixes and unknown models', () => {
  assert.deepEqual(priceFor('claude-opus-5-5'), PRICES.models['claude-opus-5-5']);
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), PRICES.models['claude-haiku-4-5']);
  assert.deepEqual(priceFor('claude-opus-5-20260301'), PRICES.models['claude-opus-5']);
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor('unknown'), null);
  assert.equal(priceFor('opus'), null);
  assert.equal(priceFor(null), null);
  // "claude-opus-55" must not be read as "claude-opus-5".
  assert.equal(priceFor('claude-opus-55'), null);
});

test('costOf applies per-million prices to every bucket', () => {
  const p = PRICES.models['claude-sonnet-5-5'];
  const c = costOf('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 });
  assert.equal(c, p.input + p.output + p.cacheWrite + p.cacheRead);
  assert.equal(costOf('mystery-model', { input: 5 }), null);
});

test('costOf bills 1h cache writes at 2x input when cacheWrite1h is provided', () => {
  const p = PRICES.models['claude-opus-5-5'];
  const c = costOf('claude-opus-5-5', { cacheWrite: 2_000_000, cacheWrite1h: 1_000_000 });
  assert.equal(c, p.cacheWrite + p.input * 2);
});

test('summarizeUsage dedupes repeated lines of one API call by messageId|requestId keeping the max', () => {
  const events = [
    usageEvent({ uuid: 'u1', usage: { model: 'claude-opus-5-5', input: 2, output: 5, cacheWrite: 13806, cacheRead: 18916 } }),
    usageEvent({ uuid: 'u2', usage: { model: 'claude-opus-5-5', input: 2, output: 5, cacheWrite: 13806, cacheRead: 18916 } }),
    usageEvent({ uuid: 'u3', usage: { model: 'claude-opus-5-5', input: 2, output: 171, cacheWrite: 13806, cacheRead: 18916 } }),
  ];
  const s = summarizeUsage(events);
  assert.equal(s.totals.messages, 1);
  assert.deepEqual(s.totals, { input: 2, output: 171, cacheWrite: 13806, cacheRead: 18916, messages: 1 });
  assert.deepEqual(Object.keys(s.byModel), ['claude-opus-5-5']);
  assert.equal(s.byModel['claude-opus-5-5'].messages, 1);
});

test('summarizeUsage treats different requestIds with the same messageId as separate calls', () => {
  const s = summarizeUsage([
    usageEvent({ requestId: 'req_a' }),
    usageEvent({ requestId: 'req_b' }),
  ]);
  assert.equal(s.totals.messages, 2);
  assert.equal(s.totals.input, 20);
});

test('summarizeUsage falls back to uuid when messageId and requestId are missing', () => {
  const base = { messageId: null, requestId: null, usage: { model: '<synthetic>', input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
  const s = summarizeUsage([
    usageEvent({ ...base, uuid: 'x1' }),
    usageEvent({ ...base, uuid: 'x1' }),
    usageEvent({ ...base, uuid: 'x2' }),
  ]);
  assert.equal(s.totals.messages, 2);
  assert.deepEqual(s.unpricedModels, ['<synthetic>']);
  assert.equal(s.costByModel['<synthetic>'], null);
});

test('summarizeUsage aggregates by model and prices known models only', () => {
  const s = summarizeUsage([
    usageEvent({ messageId: 'm1', requestId: 'r1', usage: { model: 'claude-opus-5-5', input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 } }),
    usageEvent({ messageId: 'm2', requestId: 'r2', usage: { model: 'claude-haiku-4-5-20251001', input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 0 } }),
    usageEvent({ messageId: 'm3', requestId: 'r3', usage: { model: 'opus', input: 7, output: 7, cacheWrite: 0, cacheRead: 0 } }),
    usageEvent({ messageId: 'm4', requestId: 'r4', usage: { model: null, input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }),
    { type: 'say', say: { text: 'ignored' } },
  ]);
  assert.deepEqual(Object.keys(s.byModel).sort(), ['claude-haiku-4-5-20251001', 'claude-opus-5-5', 'opus', 'unknown']);
  assert.equal(s.totals.messages, 4);
  assert.equal(s.costListUSD, PRICES.models['claude-opus-5-5'].input + PRICES.models['claude-haiku-4-5'].output);
  assert.deepEqual(s.unpricedModels, ['opus', 'unknown']);
  assert.equal(s.priceListDate, pricesOnDisk.priceListDate);
});

test('summarizeUsage of nothing is all zeros', () => {
  const s = summarizeUsage([]);
  assert.deepEqual(s.byModel, {});
  assert.deepEqual(s.totals, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
  assert.equal(s.costListUSD, 0);
  assert.deepEqual(s.unpricedModels, []);
  assert.deepEqual(summarizeUsage(undefined).totals.messages, 0);
});

test('COST_LABEL text matches the contract and the vocabulary rule', () => {
  assert.equal(COST_LABEL, 'what these tokens would cost at Anthropic API list prices; not a bill (subscription plans have no per-token charge)');
  // the label describes the number, never the reader's plan or what they paid
  assert.doesNotMatch(COST_LABEL, /\$0 paid|you paid|your (?:plan|subscription)/i);
  const everything = JSON.stringify(pricesOnDisk) + COST_LABEL;
  assert.doesNotMatch(everything, /\b(tested|verified|covered)\b/i);
  assert.doesNotMatch(everything, /proof that it works/i);
});
